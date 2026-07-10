import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import axios, {
  AxiosHeaders,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { createFile, type Movie } from "mp4box";
import pLimit from "p-limit";
import sharp from "sharp";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BAIJIAHAO_ORIGIN = "https://baijiahao.baidu.com";
const APP_INFO_URL = `${BAIJIAHAO_ORIGIN}/builder/app/appinfo`;
const PREUPLOAD_URL = `${BAIJIAHAO_ORIGIN}/materialui/video/preuploadvideo`;
const CHUNK_UPLOAD_URL = "https://rsbjh10.baidu.com/materialui/video/uploadvideo";
const COMPLETE_UPLOAD_URL = `${BAIJIAHAO_ORIGIN}/materialui/video/compuploadvideo`;
const COVER_UPLOAD_URL = `${BAIJIAHAO_ORIGIN}/pcui/picture/processproxy`;
const TOPIC_SEARCH_URL = `${BAIJIAHAO_ORIGIN}/pcui/pcpublisher/searchtopic`;
const PUBLISH_URL = `${BAIJIAHAO_ORIGIN}/pcui/article/publish`;
const CHUNK_SIZE = 2 * 1024 * 1024;
const CHUNK_CONCURRENCY = 3;
const MP4_READ_SIZE = 1024 * 1024;
const BINARY_LOG_PREVIEW_LENGTH = 100;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const HTTP = createHttpClient();

const IMAGE_EDIT_POINT = [
  {
    img_type: "cover",
    img_num: { template: 0, font: 0, filter: 0, paster: 0, cut: 0, any: 0 },
  },
  {
    img_type: "body",
    img_num: { template: 0, font: 0, filter: 0, paster: 0, cut: 0, any: 0 },
  },
] as const;

const HORIZONTAL_PUBLISH_DEFAULTS: Record<string, unknown> = {
  type: "video",
  title: "",
  vertical_cover: "",
  desc: "",
  bjhtopic_id: "",
  bjhtopic_info: "",
  cover_image_source: {
    wide_cover_image_source: "video_cut",
    vertical_cover_image_source: "video_cut",
  },
  ducut_info: "",
  content: [{ title: "", mediaId: "", videoName: "", local: 1, desc: "" }],
  video_duration: 0,
  nryx_mount_list: "",
  activity_list: [{ id: "aigc_bjh_status", is_checked: 0 }],
  source_reprinted_allow: 0,
  is_auto_optimize_cover: 1,
  bjh_video_finger_printing: { s2l: null, s2game: null, bjh: { duration: 35 } },
  fe_from: "BJH_CMS_PC",
  auto_mount_goods: 0,
  is_consultant_card: 0,
  usingImgFilter: false,
  cover_layout: "one",
  cover_images: [{ src: "", isLegal: 0, cover_source_tag: "smart_recommend" }],
  _cover_images_map: [],
  cover_source: "upload",
  clue: "",
  bjhmt: "",
  order_id: "",
  BJH_FE_NOUNCE: "",
  aigc_rebuild: "",
  pub_source_from: "pc_faburukou",
  image_edit_point: JSON.stringify(IMAGE_EDIT_POINT),
};

const VERTICAL_PUBLISH_DEFAULTS: Record<string, unknown> = {
  type: "ugc_video",
  title: "",
  bjhtopic_id: "",
  bjhtopic_info: "",
  cover_image_source: {
    wide_cover_image_source: "video_cut",
    vertical_cover_image_source: "video_cut",
  },
  ducut_info: "",
  content: [{ title: "", mediaId: "" }],
  video_duration: 0,
  nryx_mount_list: "",
  vertical_cover_images: [
    {
      content_original: "",
      src: "",
      cropData: { x: 0, y: 155, width: 608, height: 810 },
      isLegal: 0,
      cover_source_tag: "video_cut",
    },
  ],
  size: 0,
  width_in_pixel: 1920,
  height_in_pixel: 1080,
  cover_layout: "one",
  cover_images: [
    {
      source: "local",
      src: "",
      cropData: { x: 0, y: 421, width: 608, height: 342 },
      isLegal: 0,
      cover_source_tag: "video_cut",
    },
  ],
  _cover_images_map: [{ src: "", origin_src: "" }],
  cover_source: "upload",
  activity_list: [{ id: "aigc_bjh_status", is_checked: 0 }],
  source_reprinted_allow: 0,
  is_auto_optimize_cover: 1,
  loadComplete: true,
  fe_from: "BJH_CMS_PC",
  auto_mount_goods: 0,
  is_consultant_card: 0,
  clue: "",
  bjhmt: "",
  order_id: "",
  BJH_FE_NOUNCE: "",
  aigc_rebuild: "",
  pub_source_from: "pc_faburukou",
  image_edit_point: JSON.stringify(IMAGE_EDIT_POINT),
};

const BAIJIAHAO_ERROR_MESSAGES: Record<string, string> = {
  "您所在网络环境异常，请完成验证":
    "出现验证码了，请先前往多开面板使用该账号发布一条内容，发布成功后即可继续在一键发布中操作",
  "您的点击太快啦，还在努力处理中": "发布频率过快，请5分钟后重试",
  "账号状态异常": "账号状态异常！请前往官方后台查看",
  "需要验证通过才可发文":
    "出现验证码了，请先前往多开面板使用该账号发布一条内容，发布成功后即可继续在一键发布中操作",
};

export interface StoredCookie {
  domain: string;
  expires: number;
  name: string;
  path: string;
  value: string;
}

export interface PublicationText {
  description: string;
  title: string;
  topicNames: string[];
}

export interface VideoMetadata {
  duration: number;
  height: number;
  size: number;
  videoType: "horizontal" | "vertical";
  width: number;
}

export interface ChunkDescriptor {
  end: number;
  index: number;
  partNumber: number;
  size: number;
  start: number;
}

export interface GeneratedCovers {
  horizontal: Buffer;
  vertical: Buffer;
}

export interface BaijiahaoTopic {
  cover?: unknown;
  guide?: unknown;
  id?: unknown;
  sv_small_images?: { https?: unknown };
  title?: unknown;
  [key: string]: unknown;
}

export interface PublishPayloadInput {
  description: string;
  duration: number;
  height: number;
  horizontalCoverUrl: string;
  mediaId: string;
  size: number;
  title: string;
  topic?: BaijiahaoTopic;
  verticalCoverOriginalUrl: string;
  verticalCoverUrl: string;
  videoName: string;
  videoType: "horizontal" | "vertical";
  width: number;
}

export interface BaijiahaoCliOptions {
  cookiesPath: string;
  coverPath: string;
  textPath: string;
  upload: boolean;
  videoPath: string;
}

interface AppInfoResponse {
  data?: { user?: { app_id?: string | number } };
  errno?: number;
  errmsg?: string;
}

interface PreUploadResponse {
  error_code?: number;
  error_msg?: string;
  mediaId?: string | number;
  upload_key?: string;
}

interface BasicUploadResponse {
  error_code?: number;
  error_msg?: string;
}

interface CoverUploadResponse {
  errno?: number;
  errmsg?: string;
  ret?: { original_url?: string; url?: string };
}

interface TopicSearchResponse {
  data?: { hot?: BaijiahaoTopic[]; recommend?: BaijiahaoTopic[] };
  errno?: number;
  errmsg?: string;
}

interface PublishResponse {
  errno?: number;
  errmsg?: string;
  error_msg?: string;
  ret?: { nid?: string | number };
}

interface UploadedCover {
  originalUrl: string;
  token: string;
  url: string;
}

interface RunContext {
  appId: string;
  cookieHeader: string;
  fileMd5: string;
  fileModifiedAt: number;
  metadata: VideoMetadata;
  publication: PublicationText;
  videoName: string;
}

type Sleep = (milliseconds: number) => Promise<void>;

/**
 * 创建百家号 HTTP 客户端，并安装完整的敏感请求和响应日志。
 *
 * @returns 配置好超时、大小限制和日志拦截器的 Axios 实例
 */
function createHttpClient(): AxiosInstance {
  const client = axios.create({
    maxBodyLength: Number.POSITIVE_INFINITY,
    maxContentLength: Number.POSITIVE_INFINITY,
    timeout: 120_000,
  });
  client.interceptors.request.use(logHttpRequest);
  client.interceptors.response.use(logHttpResponse, logHttpError);
  return client;
}

/**
 * 把二进制日志限制为 100 个 Base64 字符，并保留原始长度信息。
 *
 * @param base64 - 完整 Base64 字符串
 * @param metadata - 二进制类型、字节数等附加信息
 * @returns 最多包含 100 个 Base64 字符的日志结构
 */
function serializeBinaryPreview(base64: string, metadata: Record<string, unknown>): Record<string, unknown> {
  const omittedCharacters = Math.max(0, base64.length - BINARY_LOG_PREVIEW_LENGTH);
  return {
    base64: base64.slice(0, BINARY_LOG_PREVIEW_LENGTH),
    base64Length: base64.length,
    base64Truncated: omittedCharacters > 0,
    ...metadata,
    omittedCharacters,
  };
}

/**
 * 把 HTTP body 转成可打印的结构，二进制值仅保留前 100 个 Base64 字符。
 *
 * @param value - Axios 请求或响应中的数据
 * @returns 可交给 JSON.stringify 的日志值
 */
export async function serializeHttpValue(value: unknown): Promise<unknown> {
  if (Buffer.isBuffer(value)) {
    return serializeBinaryPreview(value.toString("base64"), { byteLength: value.byteLength, type: "Buffer" });
  }
  if (value instanceof ArrayBuffer) {
    const buffer = Buffer.from(value);
    return serializeBinaryPreview(buffer.toString("base64"), {
      byteLength: buffer.byteLength,
      type: "ArrayBuffer",
    });
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return serializeBinaryPreview(buffer.toString("base64"), {
      byteLength: buffer.byteLength,
      type: value.constructor.name,
    });
  }
  if (value instanceof Blob) {
    const buffer = Buffer.from(await value.arrayBuffer());
    const fileName = "name" in value && typeof value.name === "string" ? value.name : undefined;
    return serializeBinaryPreview(buffer.toString("base64"), {
      byteLength: buffer.byteLength,
      ...(fileName ? { fileName } : {}),
      mime: value.type,
      type: value.constructor.name,
    });
  }
  if (value instanceof FormData) {
    const entries: Array<{ name: string; value: unknown }> = [];
    for (const [name, entryValue] of value.entries()) {
      const serialized =
        name === "base64" && typeof entryValue === "string"
          ? serializeBinaryPreview(entryValue, { type: "Base64FormField" })
          : await serializeHttpValue(entryValue);
      entries.push({ name, value: serialized });
    }
    return { entries, type: "FormData" };
  }
  if (value instanceof URLSearchParams) {
    return value.toString();
  }
  return value;
}

/**
 * 将 Axios headers 完整转换为普通对象。
 *
 * @param headers - Axios 请求或响应 headers
 * @returns 可序列化的 headers
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
 * 完整打印未脱敏凭据和普通正文，二进制内容只保留前 100 个 Base64 字符。
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
 * 完整打印成功 HTTP 响应。
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
 * 完整打印失败 HTTP 响应或 Axios 网络错误。
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
  throw error;
}

/**
 * 从 Playwright storage-state 构造原包风格的全量百度 Cookie Header。
 *
 * @param cookies - storage-state 中的 Cookie 数组
 * @param nowSeconds - 用于判断过期时间的 Unix 秒数
 * @returns 保留原顺序和同名项的 Cookie Header
 */
export function buildBaijiahaoCookieHeader(cookies: StoredCookie[], nowSeconds = Date.now() / 1_000): string {
  const values: string[] = [];
  for (const cookie of cookies) {
    const domain = cookie.domain.trim().replace(/^\.+/u, "").toLowerCase();
    const isBaiduCookie = domain === "baidu.com" || domain.endsWith(".baidu.com");
    const isUnexpired = cookie.expires === -1 || cookie.expires > nowSeconds;
    if (isBaiduCookie && isUnexpired && cookie.name.length > 0 && cookie.value.length > 0) {
      values.push(`${cookie.name}=${cookie.value}`);
    }
  }
  if (values.length === 0) {
    throw new Error("Cookie 文件中没有可用的 baidu.com Cookie");
  }
  return values.join("; ");
}

/**
 * 读取 Playwright storage-state 并生成百家号 Cookie Header。
 *
 * @param cookiesPath - storage-state JSON 路径
 * @returns 可直接发送给百家号接口的 Cookie Header
 */
async function loadCookieHeader(cookiesPath: string): Promise<string> {
  const parsed = JSON.parse(await readFile(cookiesPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || !("cookies" in parsed) || !Array.isArray(parsed.cookies)) {
    throw new Error("Cookie 文件必须是包含 cookies 数组的 Playwright storage-state JSON");
  }
  return buildBaijiahaoCookieHeader(parsed.cookies as StoredCookie[]);
}

/**
 * 按首个非空行标题、剩余行描述的规则解析发布文案。
 *
 * @param source - UTF-8 文案内容
 * @returns 标题、移除 hashtag 后的描述和去重话题名
 */
export function parsePublicationText(source: string): PublicationText {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex < 0) {
    throw new Error("文案文件缺少非空标题");
  }
  const title = lines[titleIndex]?.trim() ?? "";
  const rawDescription = lines.slice(titleIndex + 1).join("\n").trim();
  const topicPattern = /#([^#\s]+)(?=\s|#|$)/gu;
  const topicNames: string[] = [];
  const seenTopics = new Set<string>();
  for (const match of rawDescription.matchAll(topicPattern)) {
    const name = match[1];
    if (name !== undefined && !seenTopics.has(name)) {
      seenTopics.add(name);
      topicNames.push(name);
    }
  }
  const description = rawDescription.replace(topicPattern, "").trim() || title;
  return { description, title, topicNames };
}

/**
 * 按固定的 2 MiB 大小切分视频范围。
 *
 * @param fileSize - 视频总字节数
 * @param chunkSize - 测试时可覆盖的分片大小
 * @returns 使用零基索引和一基 partNumber 的分片列表
 */
export function splitVideoChunks(fileSize: number, chunkSize = CHUNK_SIZE): ChunkDescriptor[] {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("视频文件大小必须是正整数");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("分片大小必须是正整数");
  }
  const chunks: ChunkDescriptor[] = [];
  for (let start = 0, index = 0; start < fileSize; start += chunkSize, index += 1) {
    const end = Math.min(start + chunkSize, fileSize);
    chunks.push({ end, index, partNumber: index + 1, size: end - start, start });
  }
  return chunks;
}

/**
 * 使用 MP4Box 渐进解析 MP4 元数据，不保留媒体数据。
 *
 * @param videoPath - MP4 文件路径
 * @returns 时长、尺寸、大小和横竖版判断
 */
export async function inspectMp4(videoPath: string): Promise<VideoMetadata> {
  const fileStats = await stat(videoPath);
  if (!fileStats.isFile() || fileStats.size <= 0) {
    throw new Error("视频路径不是非空文件");
  }
  const mp4File = createFile(false);
  let movie: Movie | undefined;
  let parserError: string | undefined;
  mp4File.onReady = (info) => {
    movie = info;
  };
  mp4File.onError = (message) => {
    parserError = String(message);
  };

  const handle = await open(videoPath, "r");
  try {
    for (let offset = 0; offset < fileStats.size && movie === undefined; offset += MP4_READ_SIZE) {
      const length = Math.min(MP4_READ_SIZE, fileStats.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) as ArrayBuffer & {
        fileStart: number;
      };
      arrayBuffer.fileStart = offset;
      mp4File.appendBuffer(arrayBuffer);
      if (parserError) break;
    }
    if (movie === undefined && !parserError) {
      mp4File.flush();
    }
  } finally {
    await handle.close();
  }

  if (parserError) {
    throw new Error(`MP4 解析失败：${parserError}`);
  }
  if (!movie) {
    throw new Error("MP4 解析失败：未找到 moov 元数据");
  }
  const videoTrack = movie.tracks.find((track) => track.video !== undefined);
  const width = videoTrack?.video?.width ?? videoTrack?.track_width;
  const height = videoTrack?.video?.height ?? videoTrack?.track_height;
  const duration = movie.timescale > 0 ? movie.duration / movie.timescale : 0;
  if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("MP4 缺少有效的视频尺寸或时长");
  }
  return {
    duration,
    height,
    size: fileStats.size,
    videoType: width >= height ? "horizontal" : "vertical",
    width,
  };
}

/**
 * 流式计算视频文件 MD5，供百家号预上传和分片接口复用。
 *
 * @param videoPath - 视频文件路径
 * @returns 小写十六进制 MD5
 */
async function calculateFileMd5(videoPath: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(videoPath) as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * 从单个源封面生成固定尺寸的横版和竖版 JPEG Buffer。
 *
 * @param coverPath - 任意 Sharp 支持的源图片路径
 * @returns 1280×720 横版和 1080×1440 竖版封面
 */
export async function generateCovers(coverPath: string): Promise<GeneratedCovers> {
  const source = await readFile(coverPath);
  const image = sharp(source).rotate();
  const [horizontal, vertical] = await Promise.all([
    image
      .clone()
      .resize(1280, 720, { fit: "cover", position: sharp.strategy.attention, withoutEnlargement: false })
      .jpeg({ chromaSubsampling: "4:4:4", quality: 90 })
      .toBuffer(),
    image
      .clone()
      .resize(1080, 1440, { fit: "cover", position: sharp.strategy.attention, withoutEnlargement: false })
      .jpeg({ chromaSubsampling: "4:4:4", quality: 90 })
      .toBuffer(),
  ]);
  return { horizontal, vertical };
}

/**
 * 按原包协议构造横版或竖版发布参数。
 *
 * @param input - 已上传资源、视频信息、文案和可选话题
 * @returns 尚未 URL 编码的发布字段
 */
export function buildPublishPayload(input: PublishPayloadInput): Record<string, unknown> {
  const duration = Math.ceil(input.duration);
  const payload: Record<string, unknown> = structuredClone(
    input.videoType === "horizontal" ? HORIZONTAL_PUBLISH_DEFAULTS : VERTICAL_PUBLISH_DEFAULTS,
  );

  if (input.videoType === "horizontal") {
    payload.desc = input.description;
    payload.vertical_cover = input.verticalCoverUrl;
    payload.content = JSON.stringify([
      {
        title: input.title,
        mediaId: input.mediaId,
        videoName: input.videoName,
        local: 1,
        desc: input.description,
      },
    ]);
    payload.bjh_video_finger_printing = JSON.stringify({
      s2l: null,
      s2game: null,
      bjh: { duration },
    });
    payload.cover_images = JSON.stringify([
      { src: input.horizontalCoverUrl, isLegal: 0, cover_source_tag: "video_cut" },
    ]);
    payload._cover_images_map = JSON.stringify([]);
    if (input.topic) {
      payload.bjhtopic_id = input.topic.id;
      payload.bjhtopic_info = [
        {
          id: input.topic.id,
          title: input.topic.title,
          guide: "",
          cover: input.topic.sv_small_images?.https,
        },
      ];
    }
  } else {
    const cropData = { x: 0, y: 0, width: 1080, height: 1440 };
    payload.content = JSON.stringify([{ title: input.title, mediaId: input.mediaId }]);
    payload.vertical_cover_images = JSON.stringify([
      {
        content_original: input.verticalCoverOriginalUrl,
        src: input.verticalCoverUrl,
        cropData,
        isLegal: 0,
        cover_source_tag: "video_cut",
      },
    ]);
    payload.size = input.size;
    payload.width_in_pixel = input.width;
    payload.height_in_pixel = input.height;
    payload.cover_images = JSON.stringify([
      {
        source: "local",
        src: input.verticalCoverUrl,
        cropData,
        isLegal: 0,
        cover_source_tag: "video_cut",
      },
    ]);
    payload._cover_images_map = JSON.stringify([
      { src: input.verticalCoverUrl, origin_src: input.verticalCoverOriginalUrl },
    ]);
    if (input.topic) {
      payload.bjhtopic_id = input.topic.id;
      payload.bjhtopic_info = [input.topic];
    }
  }

  payload.title = input.description;
  payload.video_duration = duration;
  payload.publish_statement = 0;
  payload.publish_statement_sub = 0;
  payload.activity_list = [{ id: "aigc_bjh_status", is_checked: 0 }];
  payload.bjh_video_finger_printing = JSON.stringify({
    s2l: null,
    s2game: null,
    bjh: { duration },
  });
  return payload;
}

/**
 * 把发布字段稳定转换成 application/x-www-form-urlencoded 正文。
 *
 * @param payload - 横版或竖版发布字段
 * @returns 最终发送且不再二次转换的 URL-encoded 字符串
 */
export function serializePublishPayload(payload: Record<string, unknown>): string {
  const form = axios.toFormData(payload, new URLSearchParams()) as URLSearchParams;
  return form.toString();
}

/**
 * 按固定 1、2、4 秒退避重试单个视频分片。
 *
 * @param operation - 单次分片上传操作
 * @param sleep - 测试时可替换的等待函数
 * @returns 最后一次成功操作的结果
 */
export async function retryVideoChunk<T>(operation: () => Promise<T>, sleep: Sleep = delay): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const wait = RETRY_DELAYS_MS[attempt];
      if (wait === undefined) break;
      await sleep(wait);
    }
  }
  throw lastError;
}

/**
 * 使用固定上限并发执行视频分片任务，并保持所有分片都被等待。
 *
 * @param chunks - 待处理的视频分片
 * @param task - 单个分片任务
 * @param concurrency - 测试时可覆盖的并发上限
 */
export async function runChunkPool(
  chunks: ChunkDescriptor[],
  task: (chunk: ChunkDescriptor) => Promise<void>,
  concurrency = CHUNK_CONCURRENCY,
): Promise<void> {
  const limit = pLimit(concurrency);
  const settled = await Promise.allSettled(chunks.map((chunk) => limit(() => task(chunk))));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}

/**
 * 等待指定毫秒数。
 *
 * @param milliseconds - 等待时长
 */
async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * 获取当前账号的百家号 app_id。
 *
 * @param cookieHeader - 全量百度 Cookie Header
 * @returns 后续上传接口使用的 app_id
 */
async function fetchAppId(cookieHeader: string): Promise<string> {
  const response = await HTTP.get<AppInfoResponse>(APP_INFO_URL, {
    headers: { Cookie: cookieHeader },
  });
  const appId = response.data.data?.user?.app_id;
  if (appId === undefined || String(appId).length === 0) {
    throw new Error(response.data.errmsg || "用户信息获取失败：响应缺少 data.user.app_id");
  }
  return String(appId);
}

/**
 * 创建百家号视频上传任务。
 *
 * @param context - app_id、MD5 和视频元数据
 * @returns 上传密钥和发布使用的 mediaId
 */
async function preUploadVideo(context: RunContext): Promise<{ mediaId: string; uploadKey: string }> {
  const videoType = context.metadata.videoType === "horizontal" ? "short" : "tiny";
  const response = await HTTP.post<PreUploadResponse>(
    PREUPLOAD_URL,
    {
      app_id: context.appId,
      md5: context.fileMd5,
      is_pay_column: "0",
      video_type: videoType,
      column_videotype: "",
      size: String(context.metadata.size),
      org_file_name: context.videoName,
    },
    {
      headers: { Cookie: context.cookieHeader },
      params: { app_id: context.appId },
    },
  );
  const { error_code: errorCode, mediaId, upload_key: uploadKey } = response.data;
  if (errorCode !== 20_000 || mediaId === undefined || !uploadKey) {
    throw new Error(
      `预上传结果错误（error_code=${String(errorCode)}）：${response.data.error_msg ?? "缺少 upload_key 或 mediaId"}`,
    );
  }
  return { mediaId: String(mediaId), uploadKey };
}

/**
 * 上传单张百家号封面并提取 URL 与响应 token。
 *
 * @param cookieHeader - 全量百度 Cookie Header
 * @param image - JPEG 封面 Buffer
 * @returns 封面原图 URL、处理后 URL 和发布 token
 */
async function uploadCover(cookieHeader: string, image: Buffer): Promise<UploadedCover> {
  const form = new FormData();
  form.append("action[]", "save");
  form.append("base64", image.toString("base64"));
  form.append("videoCover", "frontend");
  const response = await HTTP.post<CoverUploadResponse>(COVER_UPLOAD_URL, form, {
    headers: { Cookie: cookieHeader },
  });
  const rawHeaders = response.headers as unknown as Record<string, unknown>;
  const tokenHeader = rawHeaders["token"] ?? rawHeaders["Token"];
  const token = typeof tokenHeader === "string" ? tokenHeader : undefined;
  const originalUrl = response.data.ret?.original_url;
  const url = response.data.ret?.url;
  if (response.data.errno !== 0 || !originalUrl || !url || !token) {
    throw new Error(`封面上传错误：${response.data.errmsg ?? "响应缺少 URL 或 token"}`);
  }
  return { originalUrl, token: String(token), url };
}

/**
 * 读取并上传一个视频分片；每次重试都会重新创建 multipart Body。
 *
 * @param input - 分片、文件和上传上下文
 */
async function uploadVideoChunk(input: {
  appId: string;
  chunk: ChunkDescriptor;
  chunkBuffer: Buffer;
  cookieHeader: string;
  fileMd5: string;
  fileModifiedAt: number;
  fileSize: number;
  totalChunks: number;
  uploadKey: string;
  videoName: string;
}): Promise<void> {
  await retryVideoChunk(async () => {
    const form = new FormData();
    form.append("app_id", input.appId);
    form.append("md5", input.fileMd5);
    form.append("id", "WU_FILE_0");
    form.append("name", input.videoName);
    form.append("type", "video/mp4");
    form.append("lastModifiedDate", new Date(input.fileModifiedAt).toISOString());
    form.append("size", String(input.fileSize));
    form.append("chunks", String(input.totalChunks));
    form.append("chunk", String(input.chunk.index));
    form.append("upload_key", input.uploadKey);
    // 原包传入裸 ArrayBuffer，经 multipart 序列化后使用默认 blob 文件名和二进制 MIME。
    form.append("file", new Blob([new Uint8Array(input.chunkBuffer)]));
    const response = await HTTP.post<BasicUploadResponse>(CHUNK_UPLOAD_URL, form, {
      headers: { Cookie: input.cookieHeader },
      params: { app_id: input.appId },
    });
    if (response.data.error_code !== 20_000) {
      throw new Error(
        `分片 ${input.chunk.partNumber} 上传失败（error_code=${String(response.data.error_code)}）：${response.data.error_msg ?? "未知错误"}`,
      );
    }
  });
}

/**
 * 以并发数 3 上传全部 2 MiB 视频分片。
 *
 * @param videoPath - MP4 文件路径
 * @param context - 账号、文件和视频上下文
 * @param uploadKey - 预上传返回的上传密钥
 * @returns 成功上传的分片数量
 */
async function uploadVideoChunks(videoPath: string, context: RunContext, uploadKey: string): Promise<number> {
  const chunks = splitVideoChunks(context.metadata.size);
  const handle = await open(videoPath, "r");
  let completed = 0;
  try {
    await runChunkPool(chunks, async (chunk) => {
      const chunkBuffer = Buffer.allocUnsafe(chunk.size);
      const { bytesRead } = await handle.read(chunkBuffer, 0, chunk.size, chunk.start);
      if (bytesRead !== chunk.size) {
        throw new Error(`读取分片 ${chunk.partNumber} 失败：预期 ${chunk.size} 字节，实际 ${bytesRead} 字节`);
      }
      await uploadVideoChunk({
        appId: context.appId,
        chunk,
        chunkBuffer,
        cookieHeader: context.cookieHeader,
        fileMd5: context.fileMd5,
        fileModifiedAt: context.fileModifiedAt,
        fileSize: context.metadata.size,
        totalChunks: chunks.length,
        uploadKey,
        videoName: context.videoName,
      });
      completed += 1;
      console.log(`[视频分片] ${completed}/${chunks.length} 上传成功`);
    });
  } finally {
    await handle.close();
  }
  return chunks.length;
}

/**
 * 通知百家号所有视频分片已上传完成。
 *
 * @param context - app_id、Cookie 和视频元数据
 * @param uploadKey - 预上传返回的上传密钥
 * @param chunks - 已成功上传的分片数量
 */
async function completeVideoUpload(context: RunContext, uploadKey: string, chunks: number): Promise<void> {
  const form = new FormData();
  form.append("upload_key", uploadKey);
  form.append("chunks", String(chunks));
  form.append("name", context.videoName);
  form.append("size", String(context.metadata.size));
  form.append("is_pay_column", "0");
  form.append("column_videotype", "");
  form.append("type", "video");
  form.append("video_type", context.metadata.videoType === "horizontal" ? "short" : "tiny");
  form.append("duration", String(Math.ceil(context.metadata.duration)));
  const response = await HTTP.post<BasicUploadResponse>(COMPLETE_UPLOAD_URL, form, {
    headers: { Cookie: context.cookieHeader },
    params: { app_id: context.appId },
  });
  if (response.data.error_code !== 0) {
    throw new Error(
      `汇总上传信息失败（error_code=${String(response.data.error_code)}）：${response.data.error_msg ?? "未知错误"}`,
    );
  }
}

/**
 * 查询单个 hashtag，并只接受 recommend 或 hot 中的标题精确匹配。
 *
 * @param cookieHeader - 全量百度 Cookie Header
 * @param topicName - 不含井号的话题名
 * @returns 精确匹配的话题；未命中时返回 undefined
 */
async function searchTopic(cookieHeader: string, topicName: string): Promise<BaijiahaoTopic | undefined> {
  const response = await HTTP.get<TopicSearchResponse>(TOPIC_SEARCH_URL, {
    headers: { Cookie: cookieHeader },
    params: { content: topicName, resource_type: 3, title: "" },
  });
  if (response.data.errno !== 0) {
    return undefined;
  }
  const recommend = response.data.data?.recommend ?? [];
  const candidates = recommend.length > 0 ? recommend : (response.data.data?.hot ?? []);
  return candidates.find((topic) => topic.title === topicName);
}

/**
 * 并发查询全部 hashtag，并选择文案顺序中第一个成功精确匹配的话题。
 *
 * @param cookieHeader - 全量百度 Cookie Header
 * @param topicNames - 已按文案顺序去重的话题名
 * @returns 最终提交的唯一话题
 */
export async function resolveFirstTopic(
  cookieHeader: string,
  topicNames: string[],
): Promise<BaijiahaoTopic | undefined> {
  return resolveTopicsInOrder(topicNames, (name) => searchTopic(cookieHeader, name));
}

/**
 * 并发执行话题查询，并按输入顺序选择第一个成功命中的结果。
 *
 * @param topicNames - 已按文案顺序去重的话题名
 * @param lookup - 单个话题查询操作
 * @returns 第一个成功命中的话题
 */
export async function resolveTopicsInOrder(
  topicNames: string[],
  lookup: (topicName: string) => Promise<BaijiahaoTopic | undefined>,
): Promise<BaijiahaoTopic | undefined> {
  const settled = await Promise.allSettled(topicNames.map(lookup));
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      return result.value;
    }
  }
  return undefined;
}

/**
 * 调用最终发布接口一次，不对失败请求重试。
 *
 * @param cookieHeader - 全量百度 Cookie Header
 * @param coverToken - 横版封面上传响应中的 token
 * @param videoType - 自动识别的横版或竖版类型
 * @param payload - 已构造完成的发布字段
 * @returns 创建成功的百家号 nid
 */
async function publishVideo(
  cookieHeader: string,
  coverToken: string,
  videoType: "horizontal" | "vertical",
  payload: Record<string, unknown>,
): Promise<string> {
  const bodyText = serializePublishPayload(payload);
  const response = await HTTP.post<PublishResponse>(PUBLISH_URL, bodyText, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      token: coverToken,
    },
    params: { callback: "bjhpublish", type: videoType === "horizontal" ? "video" : "ugc_video" },
    transformRequest: [() => bodyText],
  });
  const nid = response.data.ret?.nid;
  if (response.data.errno !== 0 || nid === undefined || String(nid).length === 0) {
    const rawMessage = response.data.errmsg || response.data.error_msg || "发布失败";
    throw new Error(BAIJIAHAO_ERROR_MESSAGES[rawMessage] || rawMessage);
  }
  return String(nid);
}

/**
 * 执行百家号视频素材上传，并按 --upload 决定是否提交作品。
 *
 * @param options - 已解析的 CLI 输入
 */
async function runBaijiahaoDemo(options: BaijiahaoCliOptions): Promise<void> {
  const [cookieHeader, publication, metadata, videoStats, fileMd5] = await Promise.all([
    loadCookieHeader(options.cookiesPath),
    readFile(options.textPath, "utf8").then(parsePublicationText),
    inspectMp4(options.videoPath),
    stat(options.videoPath),
    calculateFileMd5(options.videoPath),
  ]);
  await stat(options.coverPath);
  const context: RunContext = {
    appId: "",
    cookieHeader,
    fileMd5,
    fileModifiedAt: videoStats.mtimeMs,
    metadata,
    publication,
    videoName: basename(options.videoPath),
  };

  console.log(`[1/7] 获取账号 app_id（${metadata.width}×${metadata.height}，${metadata.videoType}）`);
  context.appId = await fetchAppId(cookieHeader);
  console.log("[2/7] 创建视频预上传任务");
  const upload = await preUploadVideo(context);

  console.log("[3/7] 从单一封面生成竖版和横版 JPEG，并依次上传");
  const covers = await generateCovers(options.coverPath);
  const verticalCover = await uploadCover(cookieHeader, covers.vertical);
  const horizontalCover = await uploadCover(cookieHeader, covers.horizontal);

  console.log("[4/7] 上传 2 MiB 视频分片");
  const chunks = await uploadVideoChunks(options.videoPath, context, upload.uploadKey);
  console.log("[5/7] 汇总视频上传信息");
  await completeVideoUpload(context, upload.uploadKey, chunks);

  console.log("[6/7] 搜索话题并构造最终发布参数");
  const topic = await resolveFirstTopic(cookieHeader, publication.topicNames);
  const payload = buildPublishPayload({
    description: publication.description,
    duration: metadata.duration,
    height: metadata.height,
    horizontalCoverUrl: horizontalCover.url,
    mediaId: upload.mediaId,
    size: metadata.size,
    title: publication.title,
    ...(topic ? { topic } : {}),
    verticalCoverOriginalUrl: verticalCover.originalUrl,
    verticalCoverUrl: verticalCover.url,
    videoName: context.videoName,
    videoType: metadata.videoType,
    width: metadata.width,
  });
  console.log("========== PUBLISH PAYLOAD ==========");
  console.log(JSON.stringify(payload, null, 2));

  if (!options.upload) {
    console.log("步骤 1～6 已完成；未传 --upload，未调用最终发布接口。远端已保留视频和封面素材。");
    return;
  }
  console.log("[7/7] 提交发布（本步骤不重试）");
  const nid = await publishVideo(cookieHeader, horizontalCover.token, metadata.videoType, payload);
  console.log(`发布提交成功，nid=${nid}，作品仍需经过平台审核。`);
}

/**
 * 将可选 CLI 路径解析为绝对路径，默认素材固定在仓库 assets 中。
 *
 * @param value - 可选命令行路径
 * @param fallback - 仓库内默认路径
 * @returns 绝对路径
 */
function resolveInputPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/**
 * 解析百家号 Demo 命令行参数。
 *
 * @param args - 不含 node 和脚本名的参数
 * @returns 运行选项；显示帮助时返回 undefined
 */
export function parseCliOptions(args: string[]): BaijiahaoCliOptions | undefined {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      cookies: { type: "string" },
      cover: { type: "string" },
      help: { short: "h", type: "boolean" },
      text: { type: "string" },
      upload: { type: "boolean" },
      video: { type: "string" },
    },
    strict: true,
  });
  if (parsed.values.help) {
    printHelp();
    return undefined;
  }
  return {
    cookiesPath: resolveInputPath(parsed.values.cookies, join(REPOSITORY_ROOT, "assets/125_baijiahao.json")),
    coverPath: resolveInputPath(parsed.values.cover, join(REPOSITORY_ROOT, "assets/demo.png")),
    textPath: resolveInputPath(parsed.values.text, join(REPOSITORY_ROOT, "assets/demo.txt")),
    upload: parsed.values.upload ?? false,
    videoPath: resolveInputPath(parsed.values.video, join(REPOSITORY_ROOT, "assets/demo.mp4")),
  };
}

/**
 * 输出百家号 Demo 的命令行帮助。
 */
function printHelp(): void {
  console.log(`百家号视频上传 Demo

用法：npm run example:baijiahao -- [选项]

  --cookies <path>         Playwright storage-state JSON
  --video <path>           MP4 视频文件
  --cover <path>           单一源封面，自动裁剪横版和竖版
  --text <path>            首个非空行标题、后续描述和可选 #话题
  --upload                 执行最终发布；不传时仍真实上传视频和封面
  -h, --help               显示帮助

警告：Demo 会完整打印 Cookie、token、上传密钥和普通请求体；二进制 Base64 只保留前 100 个字符。
`);
}

/**
 * 判断当前模块是否由命令行直接执行。
 *
 * @returns 直接执行时返回 true
 */
function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    if (options) {
      await runBaijiahaoDemo(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
