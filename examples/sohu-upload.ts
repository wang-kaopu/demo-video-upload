import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import axios, {
  AxiosHeaders,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import pLimit from "p-limit";
import sharp from "sharp";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOHU_ORIGIN = "https://mp.sohu.com";
const REFERER = `${SOHU_ORIGIN}/mpfe/v4/contentManagement/news/addvideo`;
const CREATE_VIDEO_URL = `${SOHU_ORIGIN}/commons/mp/createVideo`;
const COMPLETE_VIDEO_URL = `${SOHU_ORIGIN}/commons/mp/chunkUploadDone`;
const COVER_UPLOAD_URL = `${SOHU_ORIGIN}/commons/front/outerUpload/image/file`;
const COVER_COMPRESS_URL = `${SOHU_ORIGIN}/commons/front/outerUpload/image/thumbnail/url`;
const CHANNELS_URL = `${SOHU_ORIGIN}/mpbp/bp/account/common/channels-data-api`;
const VIDEO_CHANNELS_URL = `${SOHU_ORIGIN}/mpbp/bp/news/v4/videoChannels`;
const PUBLISH_LIMIT_URL = `${SOHU_ORIGIN}/mpbp/bp/news/v4/news/publishLimit`;
const PUBLISH_URL = `${SOHU_ORIGIN}/mpbp/bp/news/v4/news/publishVideo/v2`;
const CHUNK_SIZE = 512 * 1024;
const CHUNK_CONCURRENCY = 3;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export interface StoredCookie {
  domain: string;
  expires: number;
  name: string;
  value: string;
}

interface StorageState {
  cookies: StoredCookie[];
  origins?: Array<{
    localStorage: Array<{ name: string; value: string }>;
    origin: string;
  }>;
}

export interface SohuCliOptions {
  channelId: number | undefined;
  cookiesPath: string;
  coverPath: string;
  payloadOutputPath: string;
  publish: boolean;
  publishPayloadPath: string | undefined;
  textPath: string;
  videoChannelId: number | undefined;
  videoPath: string;
}

export interface PublicationText {
  description: string;
  title: string;
}

export interface VideoChunk {
  end: number;
  partNumber: number;
  start: number;
}

interface SohuResponse<T = unknown> {
  code?: number;
  data?: T;
  detail?: string;
  message?: string;
  msg?: string;
  success?: boolean;
}

interface AccountContext {
  accountId: string;
  channelId: number | undefined;
  cookieHeader: string;
  dvId: string;
  mpCv: string | undefined;
  spCm: string;
}

interface CreateVideoData {
  id?: string | number;
  token?: string;
  vto?: string;
}

interface CompleteVideoData {
  code?: number;
  id?: string | number;
  videoHtml?: string;
}

interface Channel {
  id?: number;
  name?: string;
}

interface VideoChannel {
  channelId?: number;
  id?: number;
  name?: string;
}

export interface SohuPublishPayloadInput {
  accountId: string;
  channelId: number;
  cover: string;
  description: string;
  title: string;
  videoChannelId: number;
  videoHtml: string;
  videoId: string;
}

/**
 * 将 Axios headers 转换为适合日志输出的普通对象，并隐藏认证凭据。
 *
 * @param headers - Axios 请求或响应 headers
 * @returns 可序列化且已隐藏 Cookie 的 headers
 */
function serializeHeaders(headers: unknown): unknown {
  const values = headers instanceof AxiosHeaders ? headers.toJSON() : headers;
  if (!values || typeof values !== "object") {
    return values;
  }

  const serialized: Record<string, unknown> = {};
  const sensitiveHeaders = new Set(["cookie", "set-cookie", "dv-id", "sp-cm", "mp-cv"]);
  for (const [name, value] of Object.entries(values)) {
    serialized[name] = sensitiveHeaders.has(name.toLowerCase()) ? "<redacted>" : value;
  }
  return serialized;
}

/**
 * 创建搜狐号 HTTP 客户端，并记录实际请求参数和响应。
 *
 * @param account - 从浏览器 storage-state 恢复的账号与客户端校验信息
 * @returns 配置好认证、超时和日志拦截器的 Axios 客户端
 */
function createHttpClient(account: AccountContext): AxiosInstance {
  const client = axios.create({
    headers: {
      Cookie: account.cookieHeader,
      Referer: REFERER,
      "User-Agent": USER_AGENT,
      "dv-id": account.dvId,
      "sp-cm": account.spCm,
      ...(account.mpCv ? { "mp-cv": account.mpCv } : {}),
    },
    maxBodyLength: Number.POSITIVE_INFINITY,
    maxContentLength: Number.POSITIVE_INFINITY,
    timeout: 120_000,
  });

  client.interceptors.request.use(logHttpRequest);
  client.interceptors.response.use(logHttpResponse, (error: unknown) => {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        logHttpResponse(error.response);
      }
      throw new Error(
        `HTTP 请求失败：${error.config?.method?.toUpperCase()} ${error.config?.url} - ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  });
  return client;
}

/**
 * 输出搜狐号 HTTP 请求的 URL、参数、headers 和非二进制请求体。
 *
 * @param config - Axios 最终请求配置
 * @returns 原请求配置
 */
function logHttpRequest(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  let body: unknown = config.data as unknown;
  if (body instanceof FormData) {
    body = Array.from(body.entries()).map(([name, value]) => ({
      name,
      value:
        value instanceof Blob
          ? { byteLength: value.size, mime: value.type, type: "Blob" }
          : value,
    }));
  } else if (body instanceof URLSearchParams) {
    body = body.toString();
  }

  console.log("\n========== HTTP REQUEST ==========");
  console.log(
    JSON.stringify(
      {
        body,
        headers: serializeHeaders(config.headers),
        method: config.method?.toUpperCase(),
        params: config.params as unknown,
        url: axios.getUri(config),
      },
      null,
      2,
    ),
  );
  return config;
}

/**
 * 输出搜狐号 HTTP 响应的状态、headers 和响应体。
 *
 * @param response - Axios 响应
 * @returns 原响应
 */
function logHttpResponse<T>(response: AxiosResponse<T>): AxiosResponse<T> {
  console.log("\n========== HTTP RESPONSE ==========");
  console.log(
    JSON.stringify(
      {
        body: response.data,
        headers: serializeHeaders(response.headers),
        status: response.status,
        url: response.config.url,
      },
      null,
      2,
    ),
  );
  return response;
}

/**
 * 从 Playwright storage-state 中读取有效搜狐 Cookie 和账号信息。
 *
 * @param cookiesPath - storage-state JSON 路径
 * @returns 账号 ID、默认频道、Cookie 和搜狐客户端校验 headers
 */
export async function loadAccountContext(cookiesPath: string): Promise<AccountContext> {
  const state = JSON.parse(await readFile(cookiesPath, "utf8")) as StorageState;
  const now = Date.now() / 1_000;
  const cookies = state.cookies.filter(
    (cookie) =>
      (cookie.domain === "sohu.com" ||
        cookie.domain === ".sohu.com" ||
        cookie.domain === "mp.sohu.com") &&
      (cookie.expires === -1 || cookie.expires > now),
  );
  if (cookies.length === 0) {
    throw new Error("storage-state 中没有可用的搜狐 Cookie");
  }

  const origin = state.origins?.find((item) => item.origin === SOHU_ORIGIN);
  const vuexValue = origin?.localStorage.find((item) => item.name === "vuex")?.value;
  if (!vuexValue) {
    throw new Error("storage-state 中缺少 mp.sohu.com 的 vuex 账号信息");
  }

  const vuex = JSON.parse(vuexValue) as {
    app?: {
      UandAStatus?: { userCode?: string };
      userInfo?: { channelId?: number; id?: string | number };
    };
  };
  const userInfo = vuex.app?.userInfo;
  if (!userInfo?.id) {
    throw new Error("vuex 账号信息中缺少搜狐号 accountId");
  }

  const localStorage = new Map(
    origin?.localStorage.map((item) => [item.name, item.value]) ?? [],
  );
  const userCode = vuex.app?.UandAStatus?.userCode;
  const spCm =
    (userCode ? localStorage.get(`${userCode}-sp-cm`) : undefined) ??
    localStorage.get("preview-sp-cm") ??
    cookies.find((cookie) => cookie.name === "mp-cv")?.value;
  if (!spCm) {
    throw new Error("storage-state 中缺少搜狐客户端标识 sp-cm");
  }

  const dvId = localStorage.get("preview-dv-id");
  if (!dvId) {
    throw new Error("storage-state 中缺少搜狐设备指纹 dv-id");
  }

  return {
    accountId: String(userInfo.id),
    channelId: userInfo.channelId,
    cookieHeader: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    dvId,
    mpCv: cookies.find((cookie) => cookie.name === "mp-cv")?.value,
    spCm,
  };
}

/**
 * 生成搜狐号视频任务接口要求的时效校验串。
 *
 * @param accountId - 搜狐号账号 ID
 * @param timestamp - 毫秒时间戳
 * @returns `<timestamp>_<md5>` 格式的 authKey
 */
export function createAuthKey(accountId: string, timestamp = Date.now()): string {
  const digest = createHash("md5").update(`sohu-mp-${accountId}-${timestamp}`).digest("hex");
  return `${timestamp}_${digest}`;
}

/**
 * 按搜狐号 512 KiB 规则生成视频分片边界。
 *
 * @param size - 视频字节数
 * @returns 从 1 开始编号的分片列表
 */
export function createVideoChunks(size: number): VideoChunk[] {
  const chunks: VideoChunk[] = [];
  for (let start = 0, partNumber = 1; start < size; start += CHUNK_SIZE, partNumber += 1) {
    chunks.push({ end: Math.min(start + CHUNK_SIZE, size), partNumber, start });
  }
  return chunks;
}

/**
 * 解析 demo 文案，首个非空行作为标题，全文作为视频简介。
 *
 * @param text - UTF-8 文案
 * @returns 搜狐号标题和简介
 */
export function parsePublicationText(text: string): PublicationText {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error("文案不能为空");
  }
  const title = lines[0]!;
  const description = lines.join("\n");
  if (title.length < 5 || title.length > 72) {
    throw new Error("搜狐号标题长度必须为 5～72 个字符");
  }
  if (description.length < 5 || description.length > 200) {
    throw new Error("搜狐号视频简介长度必须为 5～200 个字符");
  }
  return { description, title };
}

/**
 * 构造搜狐号最终视频发布 JSON。
 *
 * @param input - 已上传资源、频道和文案
 * @returns `/publishVideo/v2` 请求体
 */
export function createPublishPayload(input: SohuPublishPayloadInput): Record<string, unknown> {
  return {
    accountId: input.accountId,
    brief: input.description,
    channelId: input.channelId,
    columnNewsIds: [],
    content: input.videoHtml,
    cover: input.cover,
    headImage: "",
    id: 0,
    infoResource: 0,
    mobileTitle: "",
    modelId: "",
    sourceUrl: "",
    title: input.title,
    topicIds: [],
    userColumnId: 0,
    userLabels: "[]",
    videoChannelId: input.videoChannelId,
    videoId: input.videoId,
  };
}

/**
 * 断言搜狐号接口返回指定业务成功码。
 *
 * @param response - 搜狐号响应体
 * @param expectedCodes - 当前接口允许的成功码
 * @param operation - 错误信息中的操作名
 */
function assertSohuSuccess(
  response: SohuResponse,
  expectedCodes: readonly number[],
  operation: string,
): void {
  if (!expectedCodes.includes(response.code ?? Number.NaN)) {
    throw new Error(
      `${operation}失败：code=${response.code ?? "unknown"} ${response.msg ?? response.message ?? response.detail ?? ""}`,
    );
  }
}

/**
 * 将请求对象编码为搜狐号表单接口使用的 URLSearchParams。
 *
 * @param values - 表单字段
 * @returns URL encoded 请求体
 */
function toUrlEncoded(values: Record<string, string | number | boolean>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    body.set(name, String(value));
  }
  return body;
}

/**
 * 创建视频任务、上传全部分片并合并为发布资源。
 *
 * @param http - 已认证搜狐号客户端
 * @param accountId - 搜狐号账号 ID
 * @param videoPath - 本地视频路径
 * @returns 视频 ID 与发布所需 embed HTML
 */
async function uploadVideo(
  http: AxiosInstance,
  accountId: string,
  videoPath: string,
): Promise<{ videoHtml: string; videoId: string }> {
  const video = await readFile(videoPath);
  const videoName = basename(videoPath);
  const nameMd5 = createHash("md5").update(`${videoName}_${video.byteLength}`).digest("hex");
  const createResponse = await http.post<SohuResponse<CreateVideoData>>(
    CREATE_VIDEO_URL,
    toUrlEncoded({
      accountId,
      authKey: createAuthKey(accountId),
      cateCode: 329,
      delayAudit: true,
      nameMd5,
      title: "",
      uploadFrom: 277,
      uploadSource: "mp",
      uploadType: 2,
      videoName,
      videoSize: video.byteLength,
    }),
    { params: { accountId } },
  );
  assertSohuSuccess(createResponse.data, [2_000_000], "创建视频任务");
  const videoId = String(createResponse.data.data?.id ?? "");
  const uploadUrl = createResponse.data.data?.vto;
  const token = createResponse.data.data?.token;
  if (!videoId || !uploadUrl || !token) {
    throw new Error("创建视频任务响应缺少 id、vto 或 token");
  }

  const chunks = createVideoChunks(video.byteLength);
  const limit = pLimit(CHUNK_CONCURRENCY);
  await Promise.all(
    chunks.map((chunk) =>
      limit(async () => {
        const body = new FormData();
        body.append(
          "file",
          new Blob([video.subarray(chunk.start, chunk.end)], { type: "application/octet-stream" }),
          videoName,
        );
        const separator = uploadUrl.includes("?") ? "&" : "?";
        const url =
          `${uploadUrl}${separator}id=${encodeURIComponent(videoId)}` +
          `&type=6&partNo=${chunk.partNumber}&outType=3&partsize=${CHUNK_SIZE}`;
        const response = await http.post<SohuResponse>(url, body, { params: { accountId } });
        assertSohuSuccess(response.data, [100], `上传视频分片 ${chunk.partNumber}`);
      }),
    ),
  );

  const completeResponse = await http.post<SohuResponse<CompleteVideoData>>(
    COMPLETE_VIDEO_URL,
    toUrlEncoded({
      accountId,
      authKey: createAuthKey(accountId),
      token,
      vid: videoId,
      videoName,
      videoSize: video.byteLength,
      vto: uploadUrl,
    }),
    { params: { accountId } },
  );
  assertSohuSuccess(completeResponse.data, [2_000_000], "合并视频分片");
  const videoHtml = completeResponse.data.data?.videoHtml;
  if (!videoHtml) {
    throw new Error("合并视频响应缺少 videoHtml");
  }
  return { videoHtml: videoHtml.replace(/[\r\n]/g, ""), videoId };
}

/**
 * 上传封面并生成搜狐号发布使用的 3:2 压缩裁剪 URL。
 *
 * @param http - 已认证搜狐号客户端
 * @param accountId - 搜狐号账号 ID
 * @param coverPath - 本地封面路径
 * @returns 最终封面 URL
 */
async function uploadCover(
  http: AxiosInstance,
  accountId: string,
  coverPath: string,
): Promise<string> {
  const input = await readFile(coverPath);
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height || metadata.width < 450 || metadata.height < 300) {
    throw new Error("搜狐号封面尺寸必须大于等于 450×300");
  }

  const cover = await sharp(input).jpeg({ quality: 90 }).toBuffer();
  const body = new FormData();
  body.append("accountId", accountId);
  body.append("file", new Blob([cover], { type: "image/jpeg" }), "cover.jpg");
  const uploadResponse = await http.post<SohuResponse<{ url?: string }> & { url?: string }>(
    COVER_UPLOAD_URL,
    body,
  );
  const originalUrl = uploadResponse.data.url ?? uploadResponse.data.data?.url;
  if (!originalUrl) {
    throw new Error(
      `上传封面失败：${uploadResponse.data.msg ?? uploadResponse.data.message ?? "响应缺少 url"}`,
    );
  }

  const ratio = metadata.width / metadata.height;
  const cropHeight = ratio > 1.5 ? metadata.height : Math.floor((metadata.width * 2) / 3);
  const cropWidth = ratio > 1.5 ? Math.floor(metadata.height * 1.5) : metadata.width;
  const x = ratio > 1.5 ? Math.floor((metadata.width - cropWidth) / 2) : 0;
  const y = ratio > 1.5 ? 0 : Math.floor((metadata.height - cropHeight) / 2);
  const normalized = originalUrl.startsWith("http") ? originalUrl : `https:${originalUrl}`;
  const parsed = new URL(normalized);
  const transformedUrl =
    `//${parsed.hostname}/a_auto,c_cut,q_70,x_${x},y_${y},w_${cropWidth},h_${cropHeight}` +
    parsed.pathname;
  const compressedResponse = await http.post<SohuResponse<{ url?: string }> & { url?: string }>(
    COVER_COMPRESS_URL,
    toUrlEncoded({ accountId, url: transformedUrl }),
  );
  const coverUrl = compressedResponse.data.url ?? compressedResponse.data.data?.url;
  if (!coverUrl) {
    throw new Error(
      `生成封面失败：${compressedResponse.data.msg ?? compressedResponse.data.message ?? "响应缺少 url"}`,
    );
  }
  return coverUrl;
}

/**
 * 查询账号可用频道，并解析最终发布需要的一级和二级频道 ID。
 *
 * @param http - 已认证搜狐号客户端
 * @param accountId - 搜狐号账号 ID
 * @param preferredChannelId - CLI 显式频道或账号默认频道
 * @param preferredVideoChannelId - CLI 显式二级频道
 * @returns 发布使用的频道 ID
 */
async function resolveChannels(
  http: AxiosInstance,
  accountId: string,
  preferredChannelId?: number,
  preferredVideoChannelId?: number,
): Promise<{ channelId: number; videoChannelId: number }> {
  const [channelsResponse, videoChannelsResponse] = await Promise.all([
    http.get<SohuResponse<Channel[]> | Channel[]>(CHANNELS_URL, {
      params: { accountId, status: 1 },
    }),
    http.get<SohuResponse<VideoChannel[]>>(VIDEO_CHANNELS_URL, { params: { accountId } }),
  ]);
  const channels = Array.isArray(channelsResponse.data)
    ? channelsResponse.data
    : (channelsResponse.data.data ?? []);
  const videoChannels = videoChannelsResponse.data.data ?? [];
  const channelId =
    preferredChannelId ?? channels.find((channel) => channel.name === "娱乐")?.id ?? channels[0]?.id;
  if (channelId === undefined) {
    throw new Error("账号没有可用的搜狐号一级频道");
  }
  const matchingVideoChannels = videoChannels.filter((channel) => channel.channelId === channelId);
  const videoChannelId = preferredVideoChannelId ?? matchingVideoChannels[0]?.id ?? 0;
  return { channelId, videoChannelId };
}

/**
 * 解析搜狐号 CLI 参数，默认使用仓库 demo 素材且不提交发布。
 *
 * @param argv - 命令行参数
 * @returns 标准化后的路径、频道和发布开关
 */
export function parseCliOptions(argv: string[]): SohuCliOptions {
  const parsed = parseArgs({
    args: argv,
    options: {
      "channel-id": { type: "string" },
      cookies: { type: "string" },
      cover: { type: "string" },
      help: { short: "h", type: "boolean" },
      "payload-output": { type: "string" },
      publish: { type: "boolean" },
      "publish-payload": { type: "string" },
      text: { type: "string" },
      "video-channel-id": { type: "string" },
      video: { type: "string" },
    },
    strict: true,
  });
  if (parsed.values.help) {
    console.log(
      "Usage: npm run example:sohu -- [--publish] [--channel-id <id>] " +
        "[--video-channel-id <id>] [--cookies <path>] [--video <path>] " +
        "[--cover <path>] [--text <path>] [--payload-output <path>] " +
        "[--publish-payload <path>]",
    );
    process.exit(0);
  }

  const parseOptionalId = (value: string | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0) {
      throw new Error(`${name} 必须是非负整数`);
    }
    return id;
  };

  if (parsed.values.publish && parsed.values["publish-payload"]) {
    throw new Error("--publish 与 --publish-payload 不能同时使用");
  }

  return {
    channelId: parseOptionalId(parsed.values["channel-id"], "--channel-id"),
    cookiesPath: resolve(REPOSITORY_ROOT, parsed.values.cookies ?? "assets/133_sohu.json"),
    coverPath: resolve(REPOSITORY_ROOT, parsed.values.cover ?? "assets/demo.png"),
    payloadOutputPath: resolve(
      REPOSITORY_ROOT,
      parsed.values["payload-output"] ?? "assets/sohu-publish-payload.json",
    ),
    publish: parsed.values.publish ?? false,
    publishPayloadPath: parsed.values["publish-payload"]
      ? resolve(REPOSITORY_ROOT, parsed.values["publish-payload"])
      : undefined,
    textPath: resolve(REPOSITORY_ROOT, parsed.values.text ?? "assets/demo.txt"),
    videoChannelId: parseOptionalId(
      parsed.values["video-channel-id"],
      "--video-channel-id",
    ),
    videoPath: resolve(REPOSITORY_ROOT, parsed.values.video ?? "assets/demo.mp4"),
  };
}

/**
 * 对已经准备好的 Payload 执行额度校验和最终发布，且不重试发布请求。
 *
 * @param http - 已认证搜狐号客户端
 * @param accountId - 当前登录搜狐号账号 ID
 * @param payload - 已上传资源对应的最终发布请求体
 * @returns 搜狐号最终发布响应
 */
async function publishPreparedPayload(
  http: AxiosInstance,
  accountId: string,
  payload: Record<string, unknown>,
): Promise<SohuResponse> {
  const limitResponse = await http.get<SohuResponse<Record<string, number>>>(PUBLISH_LIMIT_URL, {
    params: { accountId, type: 3 },
  });
  assertSohuSuccess(limitResponse.data, [2_000_000], "查询发布额度");
  if ((limitResponse.data.data?.[3] ?? limitResponse.data.data?.["3"] ?? 0) <= 0) {
    throw new Error("搜狐号今日视频发布额度已用完");
  }

  console.log("提交视频发布");
  const publishResponse = await http.post<SohuResponse>(
    `${PUBLISH_URL}?accountId=${encodeURIComponent(accountId)}`,
    payload,
    { headers: { "Content-Type": "application/json" } },
  );
  assertSohuSuccess(publishResponse.data, [2_000_000], "发布视频");
  return publishResponse.data;
}

/**
 * 执行搜狐号真实上传，并仅在显式启用时提交最终发布请求。
 *
 * @param options - CLI 路径、频道和发布配置
 * @returns 最终发布响应；未发布时返回构造好的 Payload
 */
export async function runSohuUpload(
  options: SohuCliOptions,
): Promise<SohuResponse | Record<string, unknown>> {
  await stat(options.cookiesPath);
  const account = await loadAccountContext(options.cookiesPath);
  const http = createHttpClient(account);

  console.log(`[1/5] 验证搜狐号账号 ${account.accountId}`);
  const authResponse = await http.get<SohuResponse>(
    `${SOHU_ORIGIN}/mpbp/bp/account/check/user`,
    { params: { accountId: account.accountId } },
  );
  assertSohuSuccess(authResponse.data, [2_000_000], "验证账号");

  if (options.publishPayloadPath) {
    const payload = JSON.parse(
      await readFile(options.publishPayloadPath, "utf8"),
    ) as Record<string, unknown>;
    const payloadAccountId = payload.accountId;
    if (
      (typeof payloadAccountId !== "string" && typeof payloadAccountId !== "number") ||
      String(payloadAccountId) !== account.accountId
    ) {
      throw new Error("待发布 Payload 的 accountId 与当前登录账号不一致");
    }
    console.log(`[2/2] 从 ${options.publishPayloadPath} 发布已上传资源`);
    return publishPreparedPayload(http, account.accountId, payload);
  }

  await Promise.all([
    stat(options.coverPath),
    stat(options.textPath),
    stat(options.videoPath),
  ]);
  const publication = parsePublicationText(await readFile(options.textPath, "utf8"));

  console.log("[2/5] 创建任务、上传分片并合并视频");
  const uploadedVideo = await uploadVideo(http, account.accountId, options.videoPath);
  console.log("[3/5] 上传并生成封面");
  const cover = await uploadCover(http, account.accountId, options.coverPath);
  console.log("[4/5] 查询发布频道并构造 Payload");
  const channels = await resolveChannels(
    http,
    account.accountId,
    options.channelId ?? account.channelId,
    options.videoChannelId,
  );
  const payload = createPublishPayload({
    accountId: account.accountId,
    channelId: channels.channelId,
    cover,
    description: publication.description,
    title: publication.title,
    videoChannelId: channels.videoChannelId,
    videoHtml: uploadedVideo.videoHtml,
    videoId: uploadedVideo.videoId,
  });
  await writeFile(options.payloadOutputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`待发布 Payload 已保存到 ${options.payloadOutputPath}`);

  if (!options.publish) {
    console.log("[5/5] 未传 --publish，跳过最终发布请求");
    console.log(JSON.stringify({ payload }, null, 2));
    return payload;
  }

  console.log("[5/5] 提交视频发布");
  return publishPreparedPayload(http, account.accountId, payload);
}

/**
 * 运行搜狐号 CLI，并向终端报告失败原因。
 */
async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  await runSohuUpload(options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
