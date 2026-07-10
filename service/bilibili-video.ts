import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import axios, { type AxiosError, type AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { fileTypeFromBuffer } from "file-type";
import pLimit from "p-limit";

import {
  emitLog,
  installAxiosLogger,
  serializeAxiosResponse,
  type Logger,
  type SerializedAxiosResponse,
} from "./logger.js";
import type { Video, VideoDependencies } from "./video.js";

const BILIBILI_REFERER = "https://member.bilibili.com/platform/upload/video/frame";
const PREUPLOAD_URL = "https://member.bilibili.com/preupload";
const COVER_UPLOAD_URL = "https://member.bilibili.com/x/vu/web/cover/up";
const HUMAN_TYPE_URL = "https://member.bilibili.com/x/vupre/web/archive/human/type2/list";
const PUBLISH_URL = "https://member.bilibili.com/x/vu/web/add/v3";
const CHUNK_SIZE = 10 * 1024 * 1024;

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

export interface BilibiliUploadContext {
  auth: string;
  bizId: number;
  uploadId: string;
  uploadUrl: string;
  videoKey: string;
}

export interface BilibiliUploadedResources extends BilibiliUploadContext {
  coverUrl: string;
}

interface PublishPayloadInput {
  coverUrl: string;
  humanTypeId: number;
  publication: PublicationText;
  upload: BilibiliUploadContext;
}

export interface BilibiliVideoOptions {
  cookiesPath: string;
  coverPath: string;
  humanTypeId: number;
  textPath: string;
  videoPath: string;
}

export interface BilibiliPreparedContext {
  cookie: CookieContext;
  httpResponses: SerializedAxiosResponse[];
  humanType: HumanType;
  payload: Record<string, unknown>;
  publication: PublicationText;
  uploaded: BilibiliUploadedResources;
}

export interface BilibiliPublishResponse {
  bvid: string;
  response: SerializedAxiosResponse;
}

/**
 * 创建 Axios 客户端，并只为安全的探测请求和分片 PUT 启用重试。
 *
 * @param retryEnabled - 是否启用网络错误、429 和 5xx 响应重试
 * @returns 配置好超时和请求体大小限制的 Axios 客户端
 */
function createHttpClient(
  retryEnabled: boolean,
  logger: Logger,
  responses: SerializedAxiosResponse[],
): AxiosInstance {
  const client = axios.create({
    maxBodyLength: Number.POSITIVE_INFINITY,
    maxContentLength: Number.POSITIVE_INFINITY,
    timeout: 120_000,
  });
  installAxiosLogger(client, logger, responses);
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
async function fetchHumanTypes(cookie: CookieContext, http: AxiosInstance): Promise<HumanType[]> {
  const response = await http.get(HUMAN_TYPE_URL, {
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
 * 查询当前 Bilibili 账号可用于投稿的新分区列表。
 *
 * @param cookiesPath - Playwright storage-state Cookie 文件路径
 * @param dependencies - 视频服务运行时依赖
 * @returns 可写入 human_type2 的数字 ID 和显示名称
 */
export async function getBilibiliHumanTypes(
  cookiesPath: string,
  dependencies: VideoDependencies,
): Promise<HumanType[]> {
  const http = createHttpClient(true, dependencies.logger, []);
  const cookie = await loadCookieContext(resolveInputPath(cookiesPath));
  return fetchHumanTypes(cookie, http);
}

/**
 * 获取 meta 文件或视频的 UPOS 预上传信息。
 *
 * @param cookie - B 站 Cookie 上下文
 * @param params - 文档约定的 preupload 查询参数
 * @returns B 站 UPOS 预上传响应
 */
async function probeUpload(
  cookie: CookieContext,
  params: Record<string, string | number>,
  http: AxiosInstance,
): Promise<UploadProbe> {
  const response = await http.get<UploadProbe>(PREUPLOAD_URL, {
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
async function initializeVideoUpload(
  cookie: CookieContext,
  videoPath: string,
  retryableHttp: AxiosInstance,
  nonRetryableHttp: AxiosInstance,
  logger: Logger,
): Promise<BilibiliUploadContext> {
  const videoInfo = await stat(videoPath);
  if (!videoInfo.isFile() || videoInfo.size <= 0) {
    throw new Error("视频路径必须指向非空文件");
  }

  const videoName = videoPath.split(/[\\/]/u).at(-1) ?? "video.mp4";
  await emitLog(logger, { message: "[1/4] 获取 meta 上传信息", type: "info" });
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
  }, retryableHttp);
  if (!metaProbe.upos_uri) {
    throw new Error("meta preupload 未返回 upos_uri");
  }

  await emitLog(logger, { message: "[2/4] 获取视频上传信息并初始化 multipart", type: "info" });
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
  }, retryableHttp);
  if (!videoProbe.auth || !videoProbe.endpoint || !videoProbe.upos_uri || !videoProbe.biz_id) {
    throw new Error("视频 preupload 缺少 auth、endpoint、upos_uri 或 biz_id");
  }

  const endpoint = videoProbe.endpoint.startsWith("//") ? `https:${videoProbe.endpoint}` : videoProbe.endpoint;
  const objectPath = videoProbe.upos_uri.replace(/^upos:\/\//u, "").replace(/^\/+/, "");
  const uploadUrl = `${endpoint.replace(/\/$/u, "")}/${objectPath}`;
  const multipartResponse = await nonRetryableHttp.post<MultipartResult>(uploadUrl, null, {
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
async function uploadAndCompleteVideo(
  upload: BilibiliUploadContext,
  videoPath: string,
  retryableHttp: AxiosInstance,
  nonRetryableHttp: AxiosInstance,
  logger: Logger,
): Promise<void> {
  const videoInfo = await stat(videoPath);
  const videoName = videoPath.split(/[\\/]/u).at(-1) ?? "video.mp4";
  const chunks = createChunkDescriptors(videoInfo.size);
  const limit = pLimit(2);
  const file = await open(videoPath, "r");
  let completed = 0;

  await emitLog(logger, { message: `[3/4] 上传 ${chunks.length} 个视频分片（并发 2）`, type: "info" });
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

          await retryableHttp.put(upload.uploadUrl, buffer, {
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
          await emitLog(logger, { message: `      分片进度 ${completed}/${chunks.length}`, type: "info" });
          return { eTag: "etag", partNumber: chunk.partNumber };
        }),
      );
    }

    const parts = await Promise.all(tasks);
    const completeResponse = await nonRetryableHttp.post<{ OK?: number }>(
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
async function uploadCover(
  cookie: CookieContext,
  coverPath: string,
  http: AxiosInstance,
  logger: Logger,
): Promise<string> {
  const cover = await readFile(coverPath);
  const coverDataUri = await createCoverDataUri(cover);
  const form = new FormData();
  form.append("cover", coverDataUri);
  form.append("csrf", cookie.csrf);

  await emitLog(logger, { message: "[4/4] 上传封面", type: "info" });
  const response = await http.post(COVER_UPLOAD_URL, form, {
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
 * 将显式输入路径解析为绝对路径。
 *
 * @param value - 调用方传入路径
 * @returns 基于当前工作目录的绝对路径
 */
function resolveInputPath(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/**
 * 独立执行 Bilibili 视频素材准备和最终投稿。
 */
export class BilibiliVideo implements Video<BilibiliPreparedContext, BilibiliPublishResponse> {
  private readonly logger: Logger;
  private readonly nonRetryableHttp: AxiosInstance;
  private readonly options: BilibiliVideoOptions;
  private readonly responses: SerializedAxiosResponse[] = [];
  private readonly retryableHttp: AxiosInstance;

  /**
   * 创建 Bilibili 视频服务。
   *
   * @param options - 素材、账号和新分区
   * @param dependencies - 视频服务运行时依赖
   */
  public constructor(options: BilibiliVideoOptions, dependencies: VideoDependencies) {
    this.logger = dependencies.logger;
    this.options = {
      ...options,
      cookiesPath: resolveInputPath(options.cookiesPath),
      coverPath: resolveInputPath(options.coverPath),
      textPath: resolveInputPath(options.textPath),
      videoPath: resolveInputPath(options.videoPath),
    };
    this.retryableHttp = createHttpClient(true, this.logger, this.responses);
    this.nonRetryableHttp = createHttpClient(false, this.logger, this.responses);
  }

  /**
   * 校验新分区并完成视频、分片合并和封面上传。
   *
   * @returns 最终投稿所需的完整上下文
   */
  public async prepare(): Promise<BilibiliPreparedContext> {
    if (!Number.isSafeInteger(this.options.humanTypeId) || this.options.humanTypeId <= 0) {
      throw new Error("humanTypeId 必须是大于 0 的数字 ID");
    }
    const responseStart = this.responses.length;
    const cookie = await loadCookieContext(this.options.cookiesPath);
    const humanTypes = await fetchHumanTypes(cookie, this.retryableHttp);
    const humanType = humanTypes.find((type) => type.id === this.options.humanTypeId);
    if (!humanType) {
      throw new Error(`human_type2=${this.options.humanTypeId} 不在当前账号返回的新分区列表中`);
    }
    await emitLog(this.logger, {
      message: `已校验投稿分区：${humanType.id} ${humanType.name}`,
      type: "info",
    });

    const publication = parsePublicationText(await readFile(this.options.textPath, "utf8"));
    const upload = await initializeVideoUpload(
      cookie,
      this.options.videoPath,
      this.retryableHttp,
      this.nonRetryableHttp,
      this.logger,
    );
    await uploadAndCompleteVideo(
      upload,
      this.options.videoPath,
      this.retryableHttp,
      this.nonRetryableHttp,
      this.logger,
    );
    const uploaded: BilibiliUploadedResources = {
      ...upload,
      coverUrl: await uploadCover(cookie, this.options.coverPath, this.nonRetryableHttp, this.logger),
    };
    const payload = buildPublishPayload({
      coverUrl: uploaded.coverUrl,
      humanTypeId: this.options.humanTypeId,
      publication,
      upload: uploaded,
    });
    return {
      cookie,
      httpResponses: this.responses.slice(responseStart),
      humanType,
      payload,
      publication,
      uploaded,
    };
  }

  /**
   * 使用准备结果执行最终投稿。
   *
   * @param prepared - prepare 返回的完整投稿上下文
  * @returns BV 号和完整可序列化 Axios 响应
  */
  public async publish(prepared: BilibiliPreparedContext): Promise<BilibiliPublishResponse> {
    const response = await this.nonRetryableHttp.post(PUBLISH_URL, prepared.payload, {
      headers: { Cookie: prepared.cookie.header, Referer: BILIBILI_REFERER },
      params: {
        b_wet: "",
        csrf: prepared.cookie.csrf,
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
    return { bvid: body.data.bvid, response: await serializeAxiosResponse(response) };
  }

  /**
   * Bilibili 实现没有需要常驻的运行时资源。
   */
  public async dispose(): Promise<void> {
    await Promise.resolve();
  }
}
