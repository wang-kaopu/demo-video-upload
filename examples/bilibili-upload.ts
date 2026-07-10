import assert from "node:assert/strict";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import axios, {
  AxiosHeaders,
  type AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import axiosRetry from "axios-retry";
import { fileTypeFromBuffer } from "file-type";
import pLimit from "p-limit";

const BILIBILI_REFERER = "https://member.bilibili.com/platform/upload/video/frame";
const PREUPLOAD_URL = "https://member.bilibili.com/preupload";
const COVER_UPLOAD_URL = "https://member.bilibili.com/x/vu/web/cover/up";
const HUMAN_TYPE_URL = "https://member.bilibili.com/x/vupre/web/archive/human/type2/list";
const PUBLISH_URL = "https://member.bilibili.com/x/vu/web/add/v3";
const CHUNK_SIZE = 10 * 1024 * 1024;
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RETRYABLE_HTTP = createHttpClient(true);
const NON_RETRYABLE_HTTP = createHttpClient(false);

export interface StoredCookie {
  domain: string;
  expires: number;
  name: string;
  path: string;
  value: string;
}

export interface CookieContext {
  csrf: string;
  header: string;
}

export interface PublicationText {
  description: string;
  dynamic: string;
  tags: string[];
  title: string;
}

export interface ChunkDescriptor {
  end: number;
  index: number;
  partNumber: number;
  size: number;
  start: number;
}

export interface HumanType {
  id: number;
  name: string;
}

interface UploadProbe {
  OK?: number;
  auth?: string;
  biz_id?: number;
  endpoint?: string;
  upos_uri?: string;
}

interface MultipartResult {
  OK?: number;
  key?: string;
  upload_id?: string;
}

interface UploadContext {
  auth: string;
  bizId: number;
  uploadId: string;
  uploadUrl: string;
  videoKey: string;
}

interface UploadedResources extends UploadContext {
  coverUrl: string;
}

interface PublishPayloadInput {
  coverUrl: string;
  humanTypeId: number;
  publication: PublicationText;
  upload: UploadContext;
}

interface CliOptions {
  cookiesPath: string;
  coverPath: string;
  humanTypeId?: number;
  listTypes: boolean;
  publish: boolean;
  textPath: string;
  videoPath: string;
}

/**
 * 创建 Axios 客户端，并只为安全的探测请求和分片 PUT 启用重试。
 *
 * @param retryEnabled - 是否启用网络错误、429 和 5xx 响应重试
 * @returns 配置好超时和请求体大小限制的 Axios 客户端
 */
function createHttpClient(retryEnabled: boolean): AxiosInstance {
  const client = axios.create({
    maxBodyLength: Number.POSITIVE_INFINITY,
    maxContentLength: Number.POSITIVE_INFINITY,
    timeout: 120_000,
  });

  // 日志拦截器先注册，确保重试前的失败响应也会被完整打印
  client.interceptors.request.use(logHttpRequest);
  client.interceptors.response.use(logHttpResponse, logHttpError);

  if (retryEnabled) {
    axiosRetry(client, {
      retries: 3,
      retryCondition: shouldRetryRequest,
      retryDelay: (retryCount, error) => axiosRetry.exponentialDelay(retryCount, error),
    });
  }

  return client;
}

/**
 * 将 HTTP body 转成可完整打印的值，二进制内容使用 Base64 表示。
 *
 * @param value - Axios 请求或响应中的数据
 * @returns 可交给 JSON.stringify 的完整日志值
 */
async function serializeHttpValue(value: unknown): Promise<unknown> {
  if (Buffer.isBuffer(value)) {
    return {
      base64: value.toString("base64"),
      byteLength: value.byteLength,
      type: "Buffer",
    };
  }

  if (value instanceof ArrayBuffer) {
    const buffer = Buffer.from(value);
    return {
      base64: buffer.toString("base64"),
      byteLength: buffer.byteLength,
      type: "ArrayBuffer",
    };
  }

  if (ArrayBuffer.isView(value)) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      base64: buffer.toString("base64"),
      byteLength: buffer.byteLength,
      type: value.constructor.name,
    };
  }

  if (value instanceof Blob) {
    const buffer = Buffer.from(await value.arrayBuffer());
    return {
      base64: buffer.toString("base64"),
      byteLength: buffer.byteLength,
      mime: value.type,
      type: value.constructor.name,
    };
  }

  if (value instanceof FormData) {
    const entries: Array<{ name: string; value: unknown }> = [];
    for (const [name, entryValue] of value.entries()) {
      entries.push({ name, value: await serializeHttpValue(entryValue) });
    }
    return { entries, type: "FormData" };
  }

  if (value instanceof URLSearchParams) {
    return value.toString();
  }

  return value;
}

/**
 * 将 Axios headers 完整转换为普通对象，保留所有实际发送或返回的字段。
 *
 * @param headers - Axios 请求或响应 headers
 * @returns 可完整打印的 headers 值
 */
function serializeHttpHeaders(headers: unknown): unknown {
  if (headers instanceof AxiosHeaders) {
    return headers.toJSON();
  }
  if (!headers || typeof headers !== "object") {
    return headers;
  }

  const serialized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && typeof value !== "function") {
      serialized[name] = value;
    }
  }
  return serialized;
}

/**
 * 完整打印每次 HTTP 请求，包括未脱敏的凭证、参数与请求体。
 *
 * @param config - Axios 最终请求配置
 * @returns 原请求配置
 */
async function logHttpRequest(config: InternalAxiosRequestConfig): Promise<InternalAxiosRequestConfig> {
  console.log("\n========== HTTP REQUEST ==========");
  console.log(
    JSON.stringify(
      {
        body: await serializeHttpValue(config.data),
        headers: serializeHttpHeaders(config.headers),
        method: config.method?.toUpperCase(),
        params: await serializeHttpValue(config.params),
        url: axios.getUri(config),
      },
      null,
      2,
    ),
  );
  return config;
}

/**
 * 完整打印成功 HTTP 响应的状态、headers 与响应体。
 *
 * @param response - Axios 成功响应
 * @returns 原响应
 */
async function logHttpResponse<T>(response: AxiosResponse<T>): Promise<AxiosResponse<T>> {
  console.log("========== HTTP RESPONSE ==========");
  console.log(
    JSON.stringify(
      {
        body: await serializeHttpValue(response.data),
        headers: serializeHttpHeaders(response.headers),
        status: response.status,
        statusText: response.statusText,
        url: axios.getUri(response.config),
      },
      null,
      2,
    ),
  );
  return response;
}

/**
 * 完整打印失败 HTTP 响应；没有响应时打印 Axios 网络错误信息。
 *
 * @param error - Axios 拒绝原因
 * @returns 永远以原错误拒绝
 */
async function logHttpError(error: unknown): Promise<never> {
  console.log("========== HTTP RESPONSE ERROR ==========");
  if (axios.isAxiosError(error)) {
    console.log(
      JSON.stringify(
        {
          body: await serializeHttpValue(error.response?.data),
          code: error.code,
          headers: serializeHttpHeaders(error.response?.headers),
          message: error.message,
          status: error.response?.status,
          statusText: error.response?.statusText,
          url: error.config ? axios.getUri(error.config) : undefined,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(error);
  }
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

/**
 * 判断失败请求是否适合自动重试，避免重复初始化、合并、上传封面或投稿。
 *
 * @param error - Axios 请求错误
 * @returns GET/PUT 遇到网络错误、429 或 5xx 时返回 true
 */
function shouldRetryRequest(error: AxiosError): boolean {
  const method = error.config?.method?.toUpperCase();
  if (method !== "GET" && method !== "PUT") {
    return false;
  }

  const status = error.response?.status;
  return status === undefined || status === 429 || status >= 500;
}

/**
 * 从 storage-state Cookie 数组构造 B 站请求头与 CSRF token。
 *
 * @param cookies - Playwright storage-state 中的 Cookie 数组
 * @param nowSeconds - 用于判断 Cookie 是否过期的 Unix 秒数
 * @returns 可直接用于请求的 Cookie 头和 bili_jct
 */
export function buildCookieContext(
  cookies: StoredCookie[],
  nowSeconds = Math.floor(Date.now() / 1000),
): CookieContext {
  const validCookies = new Map<string, string>();

  for (const cookie of cookies) {
    const belongsToBilibili = cookie.domain === "bilibili.com" || cookie.domain.endsWith(".bilibili.com");
    const isUnexpired = cookie.expires === -1 || cookie.expires > nowSeconds;
    if (belongsToBilibili && isUnexpired && cookie.name && cookie.value) {
      validCookies.set(cookie.name, cookie.value);
    }
  }

  const csrf = validCookies.get("bili_jct");
  if (!csrf) {
    throw new Error("Cookie 文件中缺少有效的 bili_jct，无法构造 CSRF 参数");
  }

  const pairs: string[] = [];
  for (const [name, value] of validCookies) {
    pairs.push(`${name}=${value}`);
  }

  if (pairs.length === 0) {
    throw new Error("Cookie 文件中没有可用的 bilibili.com Cookie");
  }

  return { csrf, header: pairs.join("; ") };
}

/**
 * 读取并校验 Playwright storage-state 格式的 B 站 Cookie 文件。
 *
 * @param cookiesPath - storage-state JSON 文件路径
 * @returns 可用于 B 站请求的 Cookie 上下文
 */
async function loadCookieContext(cookiesPath: string): Promise<CookieContext> {
  const raw = await readFile(cookiesPath, "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || !("cookies" in parsed) || !Array.isArray(parsed.cookies)) {
    throw new Error("Cookie 文件必须是包含 cookies 数组的 Playwright storage-state JSON");
  }

  return buildCookieContext(parsed.cookies as StoredCookie[]);
}

/**
 * 把文案文件映射成 B 站标题、简介、动态和普通标签。
 *
 * @param text - 文案文件内容
 * @returns 投稿接口所需的文本字段
 */
export function parsePublicationText(text: string): PublicationText {
  const description = text.trim();
  const title = description.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  if (!title) {
    throw new Error("文案文件至少需要一行非空标题");
  }

  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const match of description.matchAll(/#([^#\s]+)/gu)) {
    const tag = match[1]?.trim();
    if (tag && !seenTags.has(tag)) {
      seenTags.add(tag);
      tags.push(tag);
    }
  }

  return { description, dynamic: title, tags, title };
}

/**
 * 按 10 MiB 上限计算 UPOS 分片的字节范围和请求参数。
 *
 * @param fileSize - 视频文件字节数
 * @param chunkSize - 单个分片的最大字节数
 * @returns 从 1 开始编号的分片描述列表
 */
export function createChunkDescriptors(fileSize: number, chunkSize = CHUNK_SIZE): ChunkDescriptor[] {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("视频文件必须是非空且大小可安全表示的文件");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("分片大小必须是正整数");
  }

  const chunks: ChunkDescriptor[] = [];
  const totalChunks = Math.ceil(fileSize / chunkSize);
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(fileSize, start + chunkSize);
    chunks.push({
      end,
      index,
      partNumber: index + 1,
      size: end - start,
      start,
    });
  }

  return chunks;
}

/**
 * 从 multipart 初始化结果的 key 提取投稿接口需要的视频 filename。
 *
 * @param key - UPOS 返回的对象 key，例如 /ugc/example.mp4
 * @returns 去掉前导斜杠和扩展名的视频 key
 */
export function extractVideoKey(key: string): string {
  const normalized = key.replace(/^\/+/, "");
  const videoKey = normalized.split(".")[0] ?? "";
  if (!videoKey) {
    throw new Error("multipart 初始化结果包含无效的视频 key");
  }
  return videoKey;
}

/**
 * 根据图片实际字节识别封面类型并生成 B 站封面接口需要的 Data URI。
 *
 * @param cover - 封面文件字节
 * @returns JPEG、PNG 或 WebP 格式的 base64 Data URI
 */
export async function createCoverDataUri(cover: Buffer): Promise<string> {
  const detected = await fileTypeFromBuffer(cover);
  const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!detected || !allowedMimeTypes.has(detected.mime)) {
    throw new Error("封面实际格式必须是 JPEG、PNG 或 WebP");
  }
  return `data:${detected.mime};base64,${cover.toString("base64")}`;
}

/**
 * 获取当前账号可用的新分区列表。
 *
 * @param cookie - B 站 Cookie 上下文
 * @returns 可写入 human_type2 的数字 ID 和显示名称
 */
async function fetchHumanTypes(cookie: CookieContext): Promise<HumanType[]> {
  const response = await RETRYABLE_HTTP.get(HUMAN_TYPE_URL, {
    headers: { Cookie: cookie.header, Referer: BILIBILI_REFERER },
  });
  const body = response.data as {
    code?: number;
    data?: { type_list?: unknown[] };
    message?: string;
    type_list?: unknown[];
  };

  if (body.code !== undefined && body.code !== 0) {
    throw new Error(`获取新分区失败（code=${body.code}）：${body.message ?? "未知错误"}`);
  }

  const rawTypes = body.data?.type_list ?? body.type_list;
  if (!Array.isArray(rawTypes)) {
    throw new Error("新分区接口未返回 type_list 数组");
  }

  const types: HumanType[] = [];
  for (const item of rawTypes) {
    if (!item || typeof item !== "object" || !("id" in item) || !("name" in item)) {
      continue;
    }
    const id = Number(item.id);
    const name = String(item.name);
    if (Number.isSafeInteger(id) && id > 0 && name) {
      types.push({ id, name });
    }
  }

  if (types.length === 0) {
    throw new Error("当前账号的新分区列表为空");
  }
  return types;
}

/**
 * 获取 meta 文件或视频的 UPOS 预上传信息。
 *
 * @param cookie - B 站 Cookie 上下文
 * @param params - 文档约定的 preupload 查询参数
 * @returns B 站 UPOS 预上传响应
 */
async function probeUpload(cookie: CookieContext, params: Record<string, string | number>): Promise<UploadProbe> {
  const response = await RETRYABLE_HTTP.get<UploadProbe>(PREUPLOAD_URL, {
    headers: { Cookie: cookie.header, Referer: BILIBILI_REFERER },
    params,
  });
  if (response.data.OK !== 1) {
    throw new Error("preupload 未返回 OK=1");
  }
  return response.data;
}

/**
 * 初始化 UPOS multipart 会话并返回后续上传所需上下文。
 *
 * @param cookie - B 站 Cookie 上下文
 * @param videoPath - 待上传视频路径
 * @returns multipart 上传地址、授权、业务 ID 和视频 key
 */
async function initializeVideoUpload(cookie: CookieContext, videoPath: string): Promise<UploadContext> {
  const videoInfo = await stat(videoPath);
  if (!videoInfo.isFile() || videoInfo.size <= 0) {
    throw new Error("视频路径必须指向非空文件");
  }

  const videoName = videoPath.split(/[\\/]/u).at(-1) ?? "video.mp4";
  console.log("[1/4] 获取 meta 上传信息");
  const metaProbe = await probeUpload(cookie, {
    build: "2140000",
    name: "file_meta.txt",
    probe_version: "20250923",
    profile: "aicovers/bup",
    r: "upos",
    size: 2000,
    ssl: 0,
    threads: 2,
    upcdn: "estx",
    version: "2.14.0.0",
    webVersion: "2.14.0",
    zone: "cs",
  });
  if (!metaProbe.upos_uri) {
    throw new Error("meta preupload 未返回 upos_uri");
  }

  console.log("[2/4] 获取视频上传信息并初始化 multipart");
  const videoProbe = await probeUpload(cookie, {
    build: "2140000",
    name: videoName,
    probe_version: "20250923",
    profile: "ugcfx/bup",
    r: "upos",
    size: videoInfo.size,
    ssl: 0,
    threads: 2,
    upcdn: "estx",
    version: "2.14.0.0",
    webVersion: "2.14.0",
    zone: "cs",
  });
  if (!videoProbe.auth || !videoProbe.endpoint || !videoProbe.upos_uri || !videoProbe.biz_id) {
    throw new Error("视频 preupload 缺少 auth、endpoint、upos_uri 或 biz_id");
  }

  const endpoint = videoProbe.endpoint.startsWith("//") ? `https:${videoProbe.endpoint}` : videoProbe.endpoint;
  const objectPath = videoProbe.upos_uri.replace(/^upos:\/\//u, "").replace(/^\/+/, "");
  const uploadUrl = `${endpoint.replace(/\/$/u, "")}/${objectPath}`;
  const multipartResponse = await NON_RETRYABLE_HTTP.post<MultipartResult>(uploadUrl, null, {
    headers: { Referer: BILIBILI_REFERER, "X-Upos-Auth": videoProbe.auth },
    params: {
      biz_id: videoProbe.biz_id,
      filesize: videoInfo.size,
      meta_upos_uri: metaProbe.upos_uri,
      output: "json",
      partsize: CHUNK_SIZE,
      profile: "ugcfx/bup",
      uploads: "",
    },
  });
  const multipart = multipartResponse.data;
  if (multipart.OK !== 1 || !multipart.upload_id || !multipart.key) {
    throw new Error("multipart 初始化未返回 OK=1、upload_id 和 key");
  }

  return {
    auth: videoProbe.auth,
    bizId: videoProbe.biz_id,
    uploadId: multipart.upload_id,
    uploadUrl,
    videoKey: extractVideoKey(multipart.key),
  };
}

/**
 * 以最多两个并发任务上传视频分片，并通知 UPOS 合并。
 *
 * @param upload - multipart 上传上下文
 * @param videoPath - 待上传视频路径
 */
async function uploadAndCompleteVideo(upload: UploadContext, videoPath: string): Promise<void> {
  const videoInfo = await stat(videoPath);
  const videoName = videoPath.split(/[\\/]/u).at(-1) ?? "video.mp4";
  const chunks = createChunkDescriptors(videoInfo.size);
  const limit = pLimit(2);
  const file = await open(videoPath, "r");
  let completed = 0;

  console.log(`[3/4] 上传 ${chunks.length} 个视频分片（并发 2）`);
  try {
    const tasks: Array<Promise<{ eTag: string; partNumber: number }>> = [];
    for (const chunk of chunks) {
      tasks.push(
        limit(async () => {
          const buffer = Buffer.allocUnsafe(chunk.size);
          const readResult = await file.read(buffer, 0, chunk.size, chunk.start);
          if (readResult.bytesRead !== chunk.size) {
            throw new Error(`读取分片 ${chunk.partNumber} 时字节数不足`);
          }

          await RETRYABLE_HTTP.put(upload.uploadUrl, buffer, {
            headers: {
              "Content-Type": "application/octet-stream",
              Referer: BILIBILI_REFERER,
              "X-Upos-Auth": upload.auth,
            },
            params: {
              chunk: chunk.index,
              chunks: chunks.length,
              end: chunk.end,
              partNumber: chunk.partNumber,
              size: chunk.size,
              start: chunk.start,
              total: videoInfo.size,
              uploadId: upload.uploadId,
            },
          });
          completed += 1;
          console.log(`      分片进度 ${completed}/${chunks.length}`);
          return { eTag: "etag", partNumber: chunk.partNumber };
        }),
      );
    }

    const parts = await Promise.all(tasks);
    const completeResponse = await NON_RETRYABLE_HTTP.post<{ OK?: number }>(
      upload.uploadUrl,
      { parts },
      {
        headers: { Referer: BILIBILI_REFERER, "X-Upos-Auth": upload.auth },
        params: {
          biz_id: upload.bizId,
          name: videoName,
          output: "json",
          profile: "ugcfx/bup",
          uploadId: upload.uploadId,
        },
      },
    );
    if (completeResponse.data.OK !== 1) {
      throw new Error("视频分片合并未返回 OK=1");
    }
  } finally {
    await file.close();
  }
}

/**
 * 上传封面并返回投稿接口需要的远端 URL。
 *
 * @param cookie - B 站 Cookie 上下文
 * @param coverPath - 本地封面文件路径
 * @returns B 站封面 URL
 */
async function uploadCover(cookie: CookieContext, coverPath: string): Promise<string> {
  const cover = await readFile(coverPath);
  const coverDataUri = await createCoverDataUri(cover);
  const form = new FormData();
  form.append("cover", coverDataUri);
  form.append("csrf", cookie.csrf);

  console.log("[4/4] 上传封面");
  const response = await NON_RETRYABLE_HTTP.post(COVER_UPLOAD_URL, form, {
    headers: { Cookie: cookie.header, Referer: BILIBILI_REFERER },
    params: { csrf: cookie.csrf, t: Date.now() },
  });
  const body = response.data as { code?: number; data?: { url?: string }; message?: string };
  if (body.code !== 0 || !body.data?.url) {
    throw new Error(`封面上传失败（code=${String(body.code)}）：${body.message ?? "未知错误"}`);
  }
  return body.data.url;
}

/**
 * 构造文档约定的最终投稿 Body。
 *
 * @param input - 已上传资源、文案和新分区 ID
 * @returns `/x/vu/web/add/v3` 的 JSON 请求体
 */
export function buildPublishPayload(input: PublishPayloadInput): Record<string, unknown> {
  return {
    cover: input.coverUrl,
    cover43: input.coverUrl,
    title: input.publication.title,
    copyright: 3,
    creation_statement: { id: -1 },
    human_type2: input.humanTypeId,
    tid: 221,
    tag: input.publication.tags.join(","),
    desc: input.publication.description,
    dynamic: input.publication.dynamic,
    videos: [
      {
        cid: input.upload.bizId,
        desc: "",
        filename: input.upload.videoKey,
        title: input.publication.title,
      },
    ],
    watermark: { state: 1 },
    subtitle: { lan: "", open: 0 },
  };
}

/**
 * 调用最终投稿接口；该函数不会自动重试，以避免重复投稿。
 *
 * @param cookie - B 站 Cookie 上下文
 * @param payload - 投稿 JSON 请求体
 * @returns 投稿成功后返回的 BV 号
 */
async function publishVideo(cookie: CookieContext, payload: Record<string, unknown>): Promise<string> {
  const response = await NON_RETRYABLE_HTTP.post(PUBLISH_URL, payload, {
    headers: { Cookie: cookie.header, Referer: BILIBILI_REFERER },
    params: {
      b_wet: "",
      csrf: cookie.csrf,
      t: Date.now(),
      web_location: 1,
      w_rid: "",
      wts: 1781077232,
    },
  });
  const body = response.data as { code?: number; data?: { bvid?: string }; message?: string };
  if (body.code !== 0 || !body.data?.bvid) {
    throw new Error(`投稿失败（code=${String(body.code)}）：${body.message ?? "未知错误"}`);
  }
  return body.data.bvid;
}

/**
 * 解析并校验命令行参数，默认指向仓库 assets 中的 Demo 素材。
 *
 * @returns 规范化后的 Demo 运行参数
 */
function parseCliOptions(): CliOptions | undefined {
  const parsed = parseArgs({
    allowPositionals: false,
    options: {
      cookies: { type: "string" },
      cover: { type: "string" },
      help: { short: "h", type: "boolean" },
      "human-type2": { type: "string" },
      "list-types": { type: "boolean" },
      publish: { type: "boolean" },
      text: { type: "string" },
      video: { type: "string" },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printHelp();
    return undefined;
  }

  let humanTypeId: number | undefined;
  if (parsed.values["human-type2"] !== undefined) {
    humanTypeId = Number(parsed.values["human-type2"]);
    if (!Number.isSafeInteger(humanTypeId) || humanTypeId <= 0) {
      throw new Error("--human-type2 必须是大于 0 的数字 ID");
    }
  }

  if (parsed.values.publish && humanTypeId === undefined) {
    throw new Error("使用 --publish 时必须同时提供 --human-type2 <数字ID>");
  }

  return {
    cookiesPath: parsed.values.cookies ?? join(REPOSITORY_ROOT, "assets/122_bilibili.json"),
    coverPath: parsed.values.cover ?? join(REPOSITORY_ROOT, "assets/demo.png"),
    ...(humanTypeId === undefined ? {} : { humanTypeId }),
    listTypes: parsed.values["list-types"] ?? false,
    publish: parsed.values.publish ?? false,
    textPath: parsed.values.text ?? join(REPOSITORY_ROOT, "assets/demo.txt"),
    videoPath: parsed.values.video ?? join(REPOSITORY_ROOT, "assets/demo.mp4"),
  };
}

/**
 * 输出 Demo 命令行参数说明。
 */
function printHelp(): void {
  console.log(`Bilibili 视频上传 Demo

用法：npm run example:bilibili -- [选项]

  --list-types             查询当前账号可用的新分区后退出
  --publish                上传完成后正式提交投稿
  --human-type2 <id>       当前账号新分区列表中的数字 ID
  --cookies <path>         Cookie storage-state JSON
  --video <path>           视频文件
  --cover <path>           封面文件（按实际内容识别格式）
  --text <path>            第一行作为标题的 UTF-8 文案
  -h, --help               显示帮助
`);
}

/**
 * 把当前账号的可用新分区打印为便于复制的 ID 与名称列表。
 *
 * @param types - 当前账号的新分区列表
 */
function printHumanTypes(types: HumanType[]): void {
  console.log("human_type2\tname");
  for (const type of types) {
    console.log(`${type.id}\t${type.name}`);
  }
}

/**
 * 将最终未处理错误压缩为终端摘要；完整请求与响应已由拦截器输出。
 *
 * @param error - 未处理异常
 * @returns 适合输出到终端的错误摘要
 */
function formatError(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const data: unknown = error.response?.data as unknown;
  let serverMessage = "";
  if (data && typeof data === "object") {
    const safeData = data as { code?: unknown; message?: unknown; msg?: unknown };
    const message = safeData.message ?? safeData.msg;
    if (message !== undefined || safeData.code !== undefined) {
      const codeText = typeof safeData.code === "string" || typeof safeData.code === "number"
        ? String(safeData.code)
        : "未知";
      const messageText = typeof message === "string" || typeof message === "number"
        ? String(message)
        : "未知";
      serverMessage = `，code=${codeText}，message=${messageText}`;
    }
  }
  return `${error.message}${error.response?.status ? `（HTTP ${error.response.status}${serverMessage}）` : ""}`;
}

/**
 * 执行分区查询、素材上传以及可选的最终投稿。
 */
async function main(): Promise<void> {
  const options = parseCliOptions();
  if (!options) {
    return;
  }

  const cookie = await loadCookieContext(options.cookiesPath);
  if (options.listTypes) {
    printHumanTypes(await fetchHumanTypes(cookie));
    return;
  }

  if (options.publish) {
    assert(options.humanTypeId !== undefined);
    const humanTypes = await fetchHumanTypes(cookie);
    const selectedType = humanTypes.find((type) => type.id === options.humanTypeId);
    if (!selectedType) {
      throw new Error(`human_type2=${options.humanTypeId} 不在当前账号返回的新分区列表中`);
    }
    console.log(`已校验投稿分区：${selectedType.id} ${selectedType.name}`);
  }

  const publication = parsePublicationText(await readFile(options.textPath, "utf8"));
  const upload = await initializeVideoUpload(cookie, options.videoPath);
  await uploadAndCompleteVideo(upload, options.videoPath);
  const uploaded: UploadedResources = {
    ...upload,
    coverUrl: await uploadCover(cookie, options.coverPath),
  };

  if (!options.publish) {
    console.log("上传验证成功：视频已合并且封面已上传；未调用最终投稿接口。");
    console.log("如需正式投稿，请增加 --publish --human-type2 <数字ID>。");
    return;
  }

  assert(options.humanTypeId !== undefined);
  const bvid = await publishVideo(
    cookie,
    buildPublishPayload({
      coverUrl: uploaded.coverUrl,
      humanTypeId: options.humanTypeId,
      publication,
      upload: uploaded,
    }),
  );
  console.log(`投稿成功：${bvid}`);
}

/**
 * 判断模块是否由命令行直接执行，避免测试导入时自动发起网络请求。
 *
 * @returns 当前模块是入口文件时返回 true
 */
function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    console.error(`执行失败：${formatError(error)}`);
    process.exitCode = 1;
  });
}
