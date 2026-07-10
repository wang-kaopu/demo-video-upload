import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomUUID, sign as signEcdsa } from "node:crypto";
import { open, readFile, stat, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import axios, { AxiosHeaders, type AxiosInstance } from "axios";
import CRC32 from "crc-32";
import pLimit from "p-limit";
import type { BrowserWindow, Cookie, Event as ElectronEvent, IpcRenderer, Session } from "electron";

import {
  emitLog,
  installAxiosLogger,
  serializeAxiosResponse,
  type LogEvent,
  type Logger,
  type SerializedAxiosResponse,
} from "./logger.js";
import type { Video, VideoDependencies } from "./video.js";

export const DOUYIN_SERVICE_PROTOCOL_VERSION = 1;
const SERVICE_PROTOCOL_VERSION = DOUYIN_SERVICE_PROTOCOL_VERSION;
const RUNTIME_ARGUMENT = "--service-douyin-runtime=";
const OPTIONS_ARGUMENT = "--service-douyin-options=";
const CREATOR_ORIGIN = "https://creator.douyin.com";
const CREATOR_HOME = `${CREATOR_ORIGIN}/creator-micro/home`;
const CREATOR_REFERER = `${CREATOR_ORIGIN}/creator-micro/content/publish?enter_from=publish_page`;
const VOD_ENDPOINT = "https://vod.bytedanceapi.com/";
const IMAGEX_ENDPOINT = "https://imagex.bytedanceapi.com";
const CHUNK_CONCURRENCY = 3;
const REQUEST_TIMEOUT = 10 * 60 * 1000;
const BDMS_READY_TIMEOUT = 60_000;
const SIGNING_TIMEOUT = 30_000;

export interface DouyinVideoOptions {
  coverPath: string;
  electronMainPath?: string;
  electronRendererPath?: string;
  profileRoot: string;
  sourcePartition: string;
  textPath: string;
  videoPath: string;
  visibility?: DouyinVisibility;
}

interface DouyinWorkerOptions {
  coverPath: string;
  electronRendererPath: string;
  profileRoot: string;
  sourcePartition: string;
  textPath: string;
  videoPath: string;
  visibility: DouyinVisibility;
}

export interface DouyinPreparedContext {
  bodyText: string;
  chunkDescriptors: ChunkDescriptor[];
  commonParams: CommonParams;
  cookieHeader: string;
  coverDimensions: { height: number; width: number };
  coverUrl: string;
  credentials: DouyinUploadCredentials;
  csrfToken: string;
  httpResponses: SerializedAxiosResponse[];
  imageUri: string;
  imageNode: DouyinUploadNode;
  msToken: string;
  payload: Record<string, unknown>;
  profile: MachineProfile;
  publishText: PublishText;
  signed: DouyinSigningResult;
  topics: PublishTopic[];
  uid: string;
  unsignedUrl: string;
  uploadId?: string;
  video: DouyinUploadedVideo;
  videoFile: { modifiedAt: number; name: string; size: number };
  visibility: DouyinVisibility;
  videoNode: DouyinUploadNode;
  videoUploadUrl: string;
  workerId: string;
}

export interface DouyinPublishResponse {
  itemId: string;
  response: SerializedAxiosResponse;
}

interface SecurityStorage {
  cryptSdk: string | null;
  signData: string | null;
  xmst: string | null;
}

interface MainSigningResult {
  signedUrl: string;
  ticketHeaders: Record<string, string>;
}

interface WorkerEnvelope {
  error?: string;
  event?: LogEvent;
  kind: string;
  payload?: unknown;
  requestId?: string;
  version: number;
}

interface WorkerHandle {
  child: ChildProcess;
  exit: Promise<void>;
  id: string;
  pending: Map<string, { reject(error: Error): void; resolve(value: unknown): void }>;
  ready: Promise<void>;
}

let MAIN_ELECTRON: typeof import("electron");
let HTTP: AxiosInstance;
let RENDERER_HTTP: AxiosInstance;
let RENDERER_IPC: IpcRenderer;
let RENDERER_LOGGER: Logger;
let RENDERER_RESPONSES: SerializedAxiosResponse[];

/**
 * 校验父进程与 Electron worker 的结构化消息协议版本。
 *
 * @param actual - 对端消息携带的协议版本
 */
export function assertDouyinProtocolVersion(actual: number): void {
  if (actual !== DOUYIN_SERVICE_PROTOCOL_VERSION) {
    throw new Error(
      `Douyin worker 协议版本不一致：期望 ${DOUYIN_SERVICE_PROTOCOL_VERSION}，实际 ${actual}`,
    );
  }
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DEFAULT_SIGNED_HEADER_NAMES = new Set(["host", "x-amz-date", "x-amz-security-token"]);
const IGNORED_HEADER_NAMES = new Set([
  "authorization",
  "content-length",
  "content-type",
  "expect",
  "presigned-expires",
  "user-agent",
]);

export type SignatureQueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

export interface DouyinV4SignatureInput {
  accessKeyId: string;
  amzDate: string;
  bodyText?: string;
  headers: Record<string, string | undefined>;
  method: "GET" | "POST";
  needSignHeaderKeys?: string[];
  pathName?: string;
  query: Record<string, SignatureQueryValue>;
  region: string;
  secretAccessKey: string;
  serviceName: string;
}

export interface DouyinV4SignatureResult {
  authorization: string;
  canonicalQuery: string;
  canonicalRequest: string;
  payloadHash: string;
  signedHeaders: string;
  signature: string;
  stringToSign: string;
}

/**
 * 按原包 RFC3986 规则编码 V4 Query 的键和值。
 *
 * @param value - 待编码的 Query 片段
 * @returns 空格编码为 `%20` 且保留字符规则稳定的字符串
 */
export function escapeV4QueryComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 将 Query 按原包字典序和数组规则序列化为 Canonical Query。
 *
 * @param query - V4 请求 Query
 * @returns 可同时用于签名和最终请求 URL 的 Query 字符串
 */
export function serializeV4Query(query: Record<string, SignatureQueryValue>): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === null || value === undefined) {
      continue;
    }

    const encodedKey = escapeV4QueryComponent(key);
    const values = Array.isArray(value) ? value : [value];
    const encodedValues = values.map((item) => escapeV4QueryComponent(String(item))).sort();
    for (const encodedValue of encodedValues) {
      pairs.push(`${encodedKey}=${encodedValue}`);
    }
  }

  return pairs.join("&");
}

/**
 * 生成原包使用的 UTC `X-Amz-Date`。
 *
 * @param date - 签名时间
 * @returns `YYYYMMDDTHHMMSSZ` 格式时间
 */
export function formatAmzDate(date = new Date()): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

/**
 * 计算小写十六进制 SHA256。
 *
 * @param value - UTF-8 字符串或原始字节
 * @returns SHA256 十六进制摘要
 */
function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 执行 V4 密钥派生所需的 HMAC-SHA256。
 *
 * @param key - HMAC 密钥
 * @param value - UTF-8 输入
 * @returns 原始 HMAC 字节
 */
function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/**
 * 选择并规范化原包实际参与签名的 Header。
 *
 * @param headers - 请求签名前的 Header
 * @param extraHeaderNames - POST Commit 额外签入的 Header 名
 * @returns Canonical Headers 和分号分隔的 SignedHeaders
 */
function buildCanonicalHeaders(
  headers: Record<string, string | undefined>,
  extraHeaderNames: string[] = [],
): { canonicalHeaders: string; signedHeaders: string } {
  const candidates = new Set(DEFAULT_SIGNED_HEADER_NAMES);
  for (const name of extraHeaderNames) {
    candidates.add(name.toLowerCase());
  }

  const selected = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      rawValue !== undefined &&
      candidates.has(name) &&
      !IGNORED_HEADER_NAMES.has(name)
    ) {
      selected.set(name, rawValue.trim().replace(/\s+/gu, " "));
    }
  }

  const names = [...selected.keys()].sort();
  if (names.length === 0) {
    throw new Error("V4 签名没有可用的 SignedHeaders");
  }

  return {
    canonicalHeaders: names.map((name) => `${name}:${selected.get(name)}\n`).join(""),
    signedHeaders: names.join(";"),
  };
}

/**
 * 按恢复出的 NewBand AWS4 变体为 VOD/ImageX 控制面请求签名。
 *
 * 原包不会自动签入 Host；POST Body 必须在调用前只序列化一次，并将同一个字符串发送出去。
 *
 * @param input - 临时密钥、请求参数、Header 和原始 Body 字符串
 * @returns Authorization、Canonical Query 和用于测试的中间结果
 */
export function signDouyinV4(input: DouyinV4SignatureInput): DouyinV4SignatureResult {
  if (!/^\d{8}T\d{6}Z$/u.test(input.amzDate)) {
    throw new Error("X-Amz-Date 必须使用 YYYYMMDDTHHMMSSZ 格式");
  }
  if (!input.accessKeyId || !input.secretAccessKey) {
    throw new Error("V4 签名缺少 AccessKeyID 或 SecretAccessKey");
  }

  const canonicalQuery = serializeV4Query(input.query);
  const { canonicalHeaders, signedHeaders } = buildCanonicalHeaders(
    input.headers,
    input.needSignHeaderKeys,
  );
  const payloadHash = input.bodyText === undefined ? EMPTY_SHA256 : sha256(input.bodyText);
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.pathName ?? "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const shortDate = input.amzDate.slice(0, 8);
  const credentialScope = `${shortDate}/${input.region}/${input.serviceName}/aws4_request`;
  const stringToSign = [ALGORITHM, input.amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, shortDate);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, input.serviceName);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization =
    `${ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    canonicalQuery,
    canonicalRequest,
    payloadHash,
    signedHeaders,
    signature,
    stringToSign,
  };
}

export const DOUYIN_CHUNK_SIZE = 5 * 1024 * 1024;

export interface MachineProfile {
  language: "zh-CN";
  platform: "MacIntel" | "Win32";
  screenHeight: number;
  screenWidth: number;
  timezone: "Asia/Shanghai";
  userAgent: string;
}

export interface CommonParams {
  aid: 1128;
  browser_language: string;
  browser_name: string;
  browser_online: true;
  browser_platform: string;
  browser_version: string;
  cookie_enabled: true;
  screen_height: number;
  screen_width: number;
  support_h265: 1;
  timezone_name: string;
}

export interface ChunkDescriptor {
  end: number;
  partNumber: number;
  size: number;
  start: number;
}

/**
 * 根据当前操作系统选择 UA、平台、语言和屏幕尺寸相互一致的设备配置。
 *
 * @param platform - Node.js 平台标识
 * @returns macOS 或 Windows 的固定 Chrome 138 配置
 */
export function createMachineProfile(platform: NodeJS.Platform = process.platform): MachineProfile {
  const shared = {
    language: "zh-CN" as const,
    screenHeight: 1080,
    screenWidth: 1920,
    timezone: "Asia/Shanghai" as const,
  };

  if (platform === "darwin") {
    return {
      ...shared,
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/138.0.0.0 Safari/537.36",
    };
  }
  if (platform === "win32") {
    return {
      ...shared,
      platform: "Win32",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/138.0.0.0 Safari/537.36",
    };
  }
  throw new Error(`当前系统 ${platform} 不支持抖音本机发布 Service`);
}

/**
 * 从设备配置构造创作者中心公共 Query 参数。
 *
 * @param profile - 与请求 User-Agent 一致的设备配置
 * @returns Creator API 公共参数
 */
export function buildCommonParams(profile: MachineProfile): CommonParams {
  const slashIndex = profile.userAgent.indexOf("/");
  if (slashIndex <= 0) {
    throw new Error("设备 User-Agent 缺少浏览器名称分隔符");
  }

  return {
    cookie_enabled: true,
    screen_width: profile.screenWidth,
    screen_height: profile.screenHeight,
    browser_language: profile.language,
    browser_platform: profile.platform,
    browser_name: profile.userAgent.slice(0, slashIndex),
    browser_version: profile.userAgent.slice(slashIndex + 1),
    browser_online: true,
    timezone_name: profile.timezone,
    aid: 1128,
    support_h265: 1,
  };
}

/**
 * 计算视频和封面上传协议要求的 CRC-32/IEEE 字符串。
 *
 * @param bytes - 上传的原始字节
 * @returns 无符号、不补零的小写十六进制 CRC32
 */
export function calculateCrc32(bytes: Uint8Array): string {
  return (CRC32.buf(bytes) >>> 0).toString(16);
}

/**
 * 按 5 MiB 生成从 1 开始编号的视频分片描述。
 *
 * @param fileSize - 视频字节数
 * @param chunkSize - 单片字节上限
 * @returns 保持文件顺序的分片列表
 */
export function createChunkDescriptors(
  fileSize: number,
  chunkSize = DOUYIN_CHUNK_SIZE,
): ChunkDescriptor[] {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("视频文件必须是非空且大小可安全表示的文件");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("分片大小必须是正整数");
  }

  const descriptors: ChunkDescriptor[] = [];
  for (let start = 0, partNumber = 1; start < fileSize; start += chunkSize, partNumber += 1) {
    const end = Math.min(fileSize, start + chunkSize);
    descriptors.push({ end, partNumber, size: end - start, start });
  }
  return descriptors;
}

/**
 * 从文案中提取最多五个去重井号话题。
 *
 * @param text - UTF-8 发布文案
 * @returns 不含井号的话题名称
 */
export function extractTopicNames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/#([^#\s]+)(?=\s|#|$)/gu)) {
    const name = match[1]?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    if (names.length === 5) {
      break;
    }
  }
  return names;
}

export type DouyinVisibility = "friends" | "public" | "self";

export interface PublishText {
  description: string;
  title: string;
}

export interface PublishTopic {
  id: string;
  name: string;
}

export interface BuildPublishPayloadInput {
  coverHeight: number;
  coverUri: string;
  coverUrl: string;
  coverWidth: number;
  description: string;
  now?: number;
  topics: PublishTopic[];
  title: string;
  videoId: string;
  visibility: DouyinVisibility;
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

const VISIBILITY_VALUES: Record<DouyinVisibility, 0 | 1 | 2> = {
  friends: 2,
  public: 0,
  self: 1,
};

/**
 * 将命令行可见性名称转换为 create_v2 使用的数字枚举。
 *
 * @param visibility - self、friends 或 public
 * @returns 抖音发布接口可见性枚举
 */
export function getVisibilityValue(visibility: DouyinVisibility): 0 | 1 | 2 {
  return VISIBILITY_VALUES[visibility];
}

/**
 * 校验并解析命令行可见性。
 *
 * @param value - 命令行原始值；缺省时仅自己可见
 * @returns 经过校验的可见性
 */
export function parseVisibility(value: string | undefined): DouyinVisibility {
  const visibility = value ?? "self";
  if (visibility === "self" || visibility === "friends" || visibility === "public") {
    return visibility;
  }
  throw new Error("--visibility 只支持 self、friends 或 public");
}

/**
 * 将发布文案拆成首行标题和后续描述。
 *
 * @param text - UTF-8 文案全文
 * @returns 发布标题与描述
 */
export function parsePublishText(text: string): PublishText {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIndex < 0) {
    throw new Error("文案至少需要一行非空标题");
  }

  const title = lines[firstNonEmptyIndex]?.trim() ?? "";
  if ([...title].length > 20) {
    throw new Error("文案首行标题不能超过 20 个字符");
  }

  return {
    description: lines.slice(firstNonEmptyIndex + 1).join("\n").trim(),
    title,
  };
}

/**
 * 按插入顺序序列化普通 Creator Query，每个值只编码一次。
 *
 * @param params - Query 参数
 * @returns 稳定的查询字符串
 */
export function serializeQuery(params: QueryParams): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number | boolean] =>
      entry[1] !== null && entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/**
 * 删除已经转换成结构化话题的 hashtag，未匹配话题保留原文。
 *
 * @param description - 原始描述
 * @param topics - 搜索成功的话题
 * @returns 移除已匹配 hashtag 后的描述
 */
export function removeMatchedHashtags(description: string, topics: PublishTopic[]): string {
  const matched = new Set(topics.map(({ name }) => name));
  return description
    .replace(/#([^#\s]+)(?=\s|#|$)/gu, (full, name: string) => matched.has(name) ? "" : full)
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/^[ \t]+|[ \t]+$/gmu, "")
    .trim();
}

/**
 * 构造原包双封面编辑日志。
 *
 * @returns create_v2 cover_tools_info 使用的编辑日志
 */
function buildCoverEditLog(): Record<string, unknown> {
  return {
    video_cover_source: "pic_adjust",
    cover_timestamp: 0,
    recommend_timestamp: "0",
    is_cover_edit: "true",
    is_cover_template: 0,
    cover_template_id: "",
    is_text_template: 0,
    text_template_id: "",
    text_template_content: "",
    is_text: 0,
    text_num: 0,
    text_content: "",
    is_use_sticker: 0,
    sticker_id: "",
    sticker_tab_name: "",
    is_use_filter: 0,
    filter_id: "",
    cover_tab_name: "",
    filter_tab_name: "",
    is_cover_modify: 0,
    to_status: "portrait",
    tab_name: "",
    is_setting_double_cover: 1,
    second_cover_details: JSON.stringify({
      video_cover_source_landscape: "pic_adjust",
      cover_timestamp_landscape: 0,
      recommend_timestamp_landscape: "0",
      is_cover_edit_landscape: true,
      is_cover_template_landscape: 0,
      cover_template_id_landscape: "",
      is_text_template_landscape: 0,
      text_template_id_landscape: "",
      text_template_content_landscape: "",
      is_text_landscape: 0,
      text_num_landscape: 0,
      text_content_landscape: "",
      is_use_sticker_landscape: 0,
      sticker_id_landscape: "",
      sticker_tab_name_landscape: "",
      is_use_filter_landscape: 0,
      filter_id_landscape: "",
      cover_tab_name_landscape: "",
      filter_tab_name_landscape: "",
      is_cover_modify_landscape: 0,
      to_status_landscape: "portrait",
      tab_name_landscape: "",
    }),
  };
}

/**
 * 构造 create_v2 使用的完整封面编辑扩展信息。
 *
 * @param input - 封面 URI、URL 和尺寸
 * @returns JSON 字符串形式的封面扩展信息
 */
function buildCoverToolsExtendInfo(input: {
  height: number;
  uri: string;
  url: string;
  width: number;
}): string {
  const editLog = buildCoverEditLog();
  const coverInfo = {
    videoName: "",
    verticalLocalEditorCoverData: 1,
    horizontalLocalEditorCoverData: 1,
    coverEditLogInfo: editLog,
    posterDelay: 0,
    uri: input.uri,
    customCoverImageHeight: input.height,
    customCoverImageWidth: input.width,
    edited: true,
    coverText: "",
    type: 2,
    defaultUri: input.uri,
    horizontalDefaultUri: input.uri,
    cropedUri: input.uri,
    aiGenCoverId: "",
    url: input.url,
  };

  return JSON.stringify({
    recommendServerInfo: { res: [], times: [] },
    recommendCoverList: [],
    recommendCoverInfo: {
      isFromRecommend: true,
      isDefaultSelect: false,
      isRecommendClickFrom: "",
      selectInfo: {},
      editingInfo: {},
    },
    recommendCoverTime: 0,
    coverInfo,
    coverUrl: input.url,
    coverHorizontalInfo: {
      ...coverInfo,
      horizontalDefaultUri: undefined,
    },
    coverHorizontalUrl: input.url,
    pasterInfo: {},
    stateInfo: null,
    croppedCoverInfo: null,
    uploadBackgroundInfo: null,
    uploadPasterInfo: null,
    uploadCoverStateInfo: null,
    xiguaCoverInfo: { posterDelay: 0 },
    xiguaPasterInfo: null,
    xiguaStateInfo: null,
    xiguaUploadCoverStateInfo: null,
    xiguaUploadBackgroundInfo: null,
    xiguaUploadPasterInfo: null,
    editXigua: false,
    coverSource: "",
    previewVideoList: [{ isCurrent: true }],
  });
}

/**
 * 构造 create_v2 使用的封面工具摘要。
 *
 * @param input - 封面 URI 和尺寸
 * @returns JSON 字符串形式的工具摘要
 */
function buildCoverToolsInfo(input: { height: number; uri: string; width: number }): string {
  return JSON.stringify({
    video_cover_source: "pic_adjust",
    cover_timestamp: 0,
    recommend_timestamp: "{0}",
    is_cover_edit: true,
    is_cover_template: 0,
    is_text_template: 0,
    is_text: 0,
    text_num: 0,
    text_content: "",
    text_template_content: "",
    is_use_sticker: 0,
    sticker_id: "",
    sticker_tab_name: "",
    is_use_filter: 0,
    filter_id: "",
    cover_template_id: "",
    cover_tab_name: "",
    filter_tab_name: "",
    tab_name: "",
    is_cover_modify: 0,
    to_status: "portrait",
    is_use_cover_edit: 1,
    cover_type: 1,
    initial_cover_uri: input.uri,
    cut_coordinate: "[0.0000,0.0000,1.0000,1.0000]",
    cover_width: input.width,
    cover_height: input.height,
  });
}

/**
 * 构造抖音 create_v2 的完整发布 Payload。
 *
 * @param input - 视频、封面、文案、话题和可见性
 * @returns 保持原包字段插入顺序的发布对象
 */
export function buildPublishPayload(input: BuildPublishPayloadInput): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const description = removeMatchedHashtags(input.description, input.topics);
  let text = input.title ? `${input.title} ` : "";
  let cursor = text.length;
  text += description;
  cursor += description.length;
  const textExtra: Array<Record<string, unknown>> = [];
  const challenges: number[] = [];

  for (const topic of input.topics) {
    const start = cursor + 1;
    const end = start + topic.name.length + 1;
    const id = Number(topic.id);
    textExtra.push({
      start,
      end,
      type: 1,
      hashtag_name: topic.name,
      hashtag_id: id,
      user_id: "",
      caption_start: start,
      caption_end: end,
    });
    text += ` #${topic.name}`;
    cursor = end;
    if (Number.isFinite(id) && id > 0) {
      challenges.push(id);
    }
  }

  const chapter = {
    chapter_abstract: "",
    chapter_details: [],
    chapter_type: 0,
    chapter_tools_info: {
      chapter_recommend_detail: [],
      chapter_recommend_abstract: "",
      chapter_source: 2,
      chapter_recommend_type: -2,
      create_date: Math.floor(now / 1_000),
      is_pc: "1",
      is_pre_generated: "0",
      is_syn: "1",
    },
  };

  return {
    item: {
      common: {
        text,
        caption: input.title ? text.slice(input.title.length) : text,
        item_title: input.title,
        activity: "[]",
        text_extra: JSON.stringify(textExtra),
        challenges: JSON.stringify(challenges),
        mentions: "[]",
        hashtag_source: "",
        hot_sentence: "",
        interaction_stickers: "[]",
        visibility_type: getVisibilityValue(input.visibility),
        download: 1,
        timing: 0,
        creation_id: Math.random().toString(36).slice(-8) + now,
        media_type: 4,
        video_id: input.videoId,
        music_source: 0,
        music_id: null,
      },
      cover: {
        poster: input.coverUri,
        poster_delay: 0,
        custom_cover_image_height: input.coverHeight,
        custom_cover_image_width: input.coverWidth,
        cover_tools_extend_info: buildCoverToolsExtendInfo({
          height: input.coverHeight,
          uri: input.coverUri,
          url: input.coverUrl,
          width: input.coverWidth,
        }),
        cover_tools_info: buildCoverToolsInfo({
          height: input.coverHeight,
          uri: input.coverUri,
          width: input.coverWidth,
        }),
        horizontal_custom_cover_image_uri: input.coverUri,
        horizontal_cover_tsp: 0,
        horizontal_custom_cover_image_height: input.coverHeight,
        horizontal_custom_cover_image_width: input.coverWidth,
      },
      mix: {},
      selected_member: { is_selected_member_video: false },
      chapter: { chapter: JSON.stringify(chapter) },
      anchor: {},
      sync: {
        dx_upgraded: 1,
        xg_user_id: "",
        should_sync: false,
        sync_to_toutiao: 0,
      },
      open_platform: {},
      aigc: { meta: "{}", ContentPropagator: "", PropagateID: "", ReservedCode2: "{}" },
      assistant: { is_preview: 0, is_post_assistant: 1 },
      declare: { user_declare_info: "{}" },
    },
  };
}

export interface DouyinTopicMatch {
  id: string;
  name: string;
}

export interface DouyinUploadCredentials {
  AccessKeyID: string;
  SecretAccessKey: string;
  SessionToken: string;
}

export interface DouyinUploadNode {
  SessionKey: string;
  StoreInfos: Array<{ Auth: string; StoreUri: string }>;
  UploadHost: string;
}

export interface DouyinUploadedVideo {
  posterUri?: string;
  videoId: string;
}

interface MultipartPartResult {
  crc32: string;
  part_number: number;
}

export interface DouyinSessionState {
  cookieHeader: string;
  msToken: string;
}

export interface DouyinSigningResult {
  signedUrl: string;
  ticketHeaders: Record<string, string>;
}

/**
 * 创建抖音 Service 使用的 Axios 客户端。
 *
 * 请求日志只输出步骤进度，避免 Cookie、token、临时密钥和二进制素材进入终端记录。
 *
 * @returns 支持大文件和十分钟超时的 HTTP 客户端
 */
function createRendererHttpClient(logger: Logger, responses: SerializedAxiosResponse[]): AxiosInstance {
  const client = axios.create({
    adapter: "xhr",
    maxBodyLength: Number.POSITIVE_INFINITY,
    maxContentLength: Number.POSITIVE_INFINITY,
    timeout: REQUEST_TIMEOUT,
  });
  installAxiosLogger(client, logger, responses);
  client.interceptors.request.use((config) => {
    const headers = AxiosHeaders.from(config.headers);
    const bridged: Record<string, string> = {};
    for (const name of ["Cookie", "Host", "Origin", "Referer", "User-Agent"]) {
      const value = headers.get(name);
      if (typeof value === "string") {
        bridged[name] = value;
        headers.delete(name);
      }
    }
    if (Object.keys(bridged).length > 0) {
      headers.set("_setRequestHeaders", JSON.stringify(bridged));
    }
    config.headers = headers;
    return config;
  });
  return client;
}

/**
 * 把 V4 密钥计算交给 Electron 主进程，避免临时密钥进入页面网络环境。
 *
 * @param input - VOD 或 ImageX V4 签名输入
 * @returns Authorization、Canonical Query 和 Body 摘要
 */
async function signV4(input: DouyinV4SignatureInput): Promise<DouyinV4SignatureResult> {
  return RENDERER_IPC.invoke("douyin:sign-v4", input) as Promise<DouyinV4SignatureResult>;
}

/**
 * 为普通 Creator API 拼接稳定 Query。
 *
 * @param baseUrl - 不含 Query 的接口地址
 * @param params - 待序列化参数
 * @returns 最终 URL
 */
function withQuery(baseUrl: string, params: QueryParams): string {
  const query = serializeQuery(params);
  return query ? `${baseUrl}?${query}` : baseUrl;
}


/**
 * 从 VOD/ImageX Apply 响应选择当前链路使用的上传节点。
 *
 * @param body - ApplyUploadInner 或 ApplyImageUpload 响应
 * @returns 含 host、store、auth 和 SessionKey 的节点
 */
function pickDouyinUploadNode(body: unknown): DouyinUploadNode {
  const typed = body as {
    Result?: { InnerUploadAddress?: { DouyinUploadNodes?: DouyinUploadNode[] } };
  };
  const node = typed.Result?.InnerUploadAddress?.DouyinUploadNodes?.[0];
  if (
    !node?.UploadHost ||
    !node.SessionKey ||
    !node.StoreInfos?.[0]?.StoreUri ||
    !node.StoreInfos[0].Auth
  ) {
    throw new Error("上传凭证响应缺少 UploadHost、StoreUri、Auth 或 SessionKey");
  }
  return node;
}

/**
 * 构造 VOD/ImageX 二进制上传 URL。
 *
 * @param node - Apply 响应中的上传节点
 * @returns `/upload/v1/{StoreUri}` 地址
 */
function buildBinaryUploadUrl(node: DouyinUploadNode): string {
  return `https://${node.UploadHost}/upload/v1/${node.StoreInfos[0]?.StoreUri}`;
}

/**
 * 生成只包含键名和数据类型的响应结构摘要，避免诊断日志泄露远端值。
 *
 * @param value - HTTP 响应 Body
 * @param depth - 允许递归的最大层数
 * @returns 不包含原始值的结构说明
 */
function describeResponseShape(value: unknown, depth = 0): unknown {
  if (depth >= 4) {
    return Array.isArray(value) ? "array" : typeof value;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [describeResponseShape(value[0], depth + 1)];
  }
  if (!value || typeof value !== "object") {
    return typeof value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, describeResponseShape(nested, depth + 1)]),
  );
}

/**
 * 获取创作者中心 CSRF Token。
 *
 * @param cookieHeader - creator.douyin.com Cookie Header
 * @param userAgent - 当前设备 User-Agent
 * @returns `X-Secsdk-Csrf-Token` 值
 */
async function getCsrfToken(cookieHeader: string, userAgent: string): Promise<string> {
  const response = await HTTP.head(`${CREATOR_ORIGIN}/web/api/media/anchor/search`, {
    headers: {
      Cookie: cookieHeader,
      Referer: `${CREATOR_ORIGIN}/creator-micro/content/publish`,
      "User-Agent": userAgent,
      "X-Secsdk-Csrf-Request": "1",
      "X-Secsdk-Csrf-Version": "1.2.22",
    },
  });
  const raw: unknown = response.headers["x-ware-csrf-token"] as unknown;
  const csrfToken = typeof raw === "string" ? raw.split(",").at(-1)?.trim() : undefined;
  if (!csrfToken) {
    throw new Error("CSRF 请求未返回 x-ware-csrf-token");
  }
  return csrfToken;
}

/**
 * 获取当前抖音账号 UID。
 *
 * @param cookieHeader - creator.douyin.com Cookie Header
 * @param msToken - 原始 xmst/msToken
 * @param userAgent - 当前设备 User-Agent
 * @returns VOD 请求需要的 uid
 */
async function getAccountUid(cookieHeader: string, msToken: string, userAgent: string): Promise<string> {
  const response = await HTTP.get(
    withQuery(`${CREATOR_ORIGIN}/web/api/media/user/info/`, { a_bogus: "", msToken }),
    { headers: { Cookie: cookieHeader, "User-Agent": userAgent } },
  );
  const body = response.data as {
    status_code?: number;
    status_msg?: string;
    user?: { uid?: string };
  };
  if (!body.user?.uid) {
    throw new Error(
      `账号信息响应缺少 user.uid：status_code=${body.status_code ?? "缺失"}，` +
      `${body.status_msg || "无状态说明"}，结构=${JSON.stringify(describeResponseShape(response.data))}`,
    );
  }
  return body.user.uid;
}

/**
 * 获取 VOD/ImageX 临时密钥。
 *
 * @param input - Cookie、CSRF、设备参数和原始 msToken
 * @returns 三段临时上传凭证
 */
async function getDouyinUploadCredentials(input: {
  commonParams: CommonParams;
  cookieHeader: string;
  csrfToken: string;
  msToken: string;
  userAgent: string;
}): Promise<DouyinUploadCredentials> {
  const response = await HTTP.get(
    withQuery(`${CREATOR_ORIGIN}/web/api/media/upload/auth/v5/`, {
      ...input.commonParams,
      msToken: input.msToken,
    }),
    {
      headers: {
        Cookie: input.cookieHeader,
        Referer: CREATOR_REFERER,
        "User-Agent": input.userAgent,
        "X-Secsdk-Csrf-Token": input.csrfToken,
      },
    },
  );
  const body = response.data as { auth?: string };
  if (!body.auth) {
    throw new Error("上传授权响应缺少 auth");
  }

  const credentials = JSON.parse(body.auth) as Partial<DouyinUploadCredentials>;
  if (!credentials.AccessKeyID || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("auth 缺少 AccessKeyID、SecretAccessKey 或 SessionToken");
  }
  return credentials as DouyinUploadCredentials;
}

/**
 * 申请视频上传节点。
 *
 * @param input - 视频大小、账号 UID 和临时密钥
 * @returns VOD 上传节点
 */
async function applyVideoUpload(input: {
  credentials: DouyinUploadCredentials;
  fileSize: number;
  uid: string;
}): Promise<DouyinUploadNode> {
  const query: Record<string, SignatureQueryValue> = {
    Action: "ApplyUploadInner",
    FileSize: input.fileSize,
    FileType: "video",
    IsInner: 1,
    SpaceName: "aweme",
    Version: "2020-11-19",
    app_id: 2906,
    s: Math.random().toString(36).slice(2),
    user_id: input.uid,
  };
  const amzDate = formatAmzDate();
  const signingHeaders = {
    "X-Amz-Date": amzDate,
    "X-Amz-Security-Token": input.credentials.SessionToken,
  };
  const signed = await signV4({
    accessKeyId: input.credentials.AccessKeyID,
    amzDate,
    headers: signingHeaders,
    method: "GET",
    query,
    region: "cn-north-1",
    secretAccessKey: input.credentials.SecretAccessKey,
    serviceName: "vod",
  });
  const response = await HTTP.get(`${VOD_ENDPOINT}?${signed.canonicalQuery}`, {
    headers: {
      ...signingHeaders,
      Authorization: signed.authorization,
      Origin: CREATOR_ORIGIN,
      Referer: `${CREATOR_ORIGIN}/`,
    },
  });
  return pickDouyinUploadNode(response.data);
}

/**
 * 初始化大于 5 MiB 视频的 multipart 会话。
 *
 * @param uploadUrl - 视频二进制上传 URL
 * @param headers - VOD 节点授权 Header
 * @returns uploadid
 */
async function initializeMultipart(uploadUrl: string, headers: Record<string, string>): Promise<string> {
  const response = await HTTP.post(uploadUrl, new FormData(), {
    headers,
    params: { phase: "init", uploadmode: "part" },
  });
  const body = response.data as { code?: number; data?: { uploadid?: string }; message?: string };
  if (body.code !== 2000 || !body.data?.uploadid) {
    throw new Error(body.message || "multipart 初始化未返回 code=2000 和 uploadid");
  }
  return body.data.uploadid;
}

/**
 * 读取一个视频分片并校验读取长度。
 *
 * @param file - 已打开的视频文件
 * @param descriptor - 分片字节范围
 * @returns 分片 Buffer
 */
async function readChunk(
  file: Awaited<ReturnType<typeof open>>,
  descriptor: ChunkDescriptor,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(descriptor.size);
  const result = await file.read(buffer, 0, descriptor.size, descriptor.start);
  if (result.bytesRead !== descriptor.size) {
    throw new Error(`读取视频分片 ${descriptor.partNumber} 时字节数不足`);
  }
  return buffer;
}

/**
 * 按原包 1/2/4 秒策略重试单个视频分片。
 *
 * @param task - 单次上传任务
 * @param partNumber - 用于错误信息的分片编号
 * @returns 服务端返回的 part_number 和 crc32
 */
async function uploadChunkWithRetry(
  task: () => Promise<MultipartPartResult>,
  partNumber: number,
): Promise<MultipartPartResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
      }
    }
  }
  throw new Error(`视频分片 ${partNumber} 上传四次后仍失败`, { cause: lastError });
}

/**
 * 上传全部视频分片，并在 multipart 场景通知服务端合并。
 *
 * @param input - 视频路径、上传节点、URL、UID 和可选 uploadid
 */
async function uploadVideoChunks(input: {
  descriptors: ChunkDescriptor[];
  node: DouyinUploadNode;
  uid: string;
  uploadId?: string;
  uploadUrl: string;
  videoPath: string;
}): Promise<void> {
  const store = input.node.StoreInfos[0];
  assert(store);
  const commonHeaders = {
    Authorization: store.Auth,
    Host: input.node.UploadHost,
    "X-Storage-U": input.uid,
  };
  const file = await open(input.videoPath, "r");
  const limit = pLimit(CHUNK_CONCURRENCY);
  let completed = 0;

  try {
    const tasks = input.descriptors.map((descriptor) =>
      limit(() =>
        uploadChunkWithRetry(async () => {
          const buffer = await readChunk(file, descriptor);
          const crc32 = calculateCrc32(buffer);
          const response = await HTTP.post(input.uploadUrl, buffer, {
            headers: {
              ...commonHeaders,
              "Content-Crc32": crc32,
              "Content-Disposition": 'attachment; filename="undefined"',
              "Content-Type": "application/octet-stream",
            },
            ...(input.uploadId
              ? {
                  params: {
                    part_number: descriptor.partNumber,
                    part_offset: descriptor.start,
                    phase: "transfer",
                    uploadid: input.uploadId,
                  },
                }
              : {}),
          });
          const body = response.data as {
            code?: number;
            data?: Partial<MultipartPartResult>;
            message?: string;
          };
          if (body.code !== 2000 || !body.data) {
            throw new Error(body.message || `视频分片 ${descriptor.partNumber} 未返回 code=2000`);
          }
          if (!input.uploadId) {
            completed += 1;
            await emitLog(RENDERER_LOGGER, { message: `      视频分片进度 ${completed}/${input.descriptors.length}`, type: "info" });
            return { crc32, part_number: descriptor.partNumber };
          }
          if (!body.data.part_number || !body.data.crc32) {
            throw new Error(`视频分片 ${descriptor.partNumber} 响应缺少 part_number 或 crc32`);
          }
          completed += 1;
          await emitLog(RENDERER_LOGGER, { message: `      视频分片进度 ${completed}/${input.descriptors.length}`, type: "info" });
          return { crc32: body.data.crc32, part_number: body.data.part_number };
        }, descriptor.partNumber),
      ),
    );
    const settled = await Promise.allSettled(tasks);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) {
      throw rejected.reason;
    }
    const results = settled.map((result) => (result as PromiseFulfilledResult<MultipartPartResult>).value);

    if (input.uploadId) {
      const finishBody = results.map(({ part_number, crc32 }) => `${part_number}:${crc32}`).join(",");
      const response = await HTTP.post(input.uploadUrl, finishBody, {
        headers: {
          ...commonHeaders,
          "Content-Type": "text/plain;charset=UTF-8",
        },
        params: { phase: "finish", uploadid: input.uploadId, uploadmode: "partial" },
      });
      const body = response.data as { code?: number; message?: string };
      if (body.code !== undefined && body.code !== 2000) {
        throw new Error(body.message || "multipart finish 未返回 code=2000");
      }
    }
  } finally {
    await file.close();
  }
}

/**
 * 提交 VOD 上传会话并取得 Vid 和 PosterUri。
 *
 * @param input - 上传节点、UID 和临时密钥
 * @returns 已提交的视频标识
 */
async function commitVideoUpload(input: {
  credentials: DouyinUploadCredentials;
  node: DouyinUploadNode;
  uid: string;
}): Promise<DouyinUploadedVideo> {
  const query: Record<string, SignatureQueryValue> = {
    Action: "CommitUploadInner",
    SpaceName: "aweme",
    Version: "2020-11-19",
    app_id: 2906,
    user_id: input.uid,
  };
  const bodyText = JSON.stringify({
    SessionKey: input.node.SessionKey,
    Functions: [
      { name: "GetMeta" },
      { name: "Snapshot", input: { SnapshotTime: 0 } },
    ],
  });
  const amzDate = formatAmzDate();
  const signingHeaders = {
    "X-Amz-Content-Sha256": "",
    "X-Amz-Date": amzDate,
    "X-Amz-Security-Token": input.credentials.SessionToken,
  };
  const preSigned = await signV4({
    accessKeyId: input.credentials.AccessKeyID,
    amzDate,
    bodyText,
    headers: signingHeaders,
    method: "POST",
    needSignHeaderKeys: ["x-amz-content-sha256"],
    query,
    region: "cn-north-1",
    secretAccessKey: input.credentials.SecretAccessKey,
    serviceName: "vod",
  });
  signingHeaders["X-Amz-Content-Sha256"] = preSigned.payloadHash;
  const signed = await signV4({
    accessKeyId: input.credentials.AccessKeyID,
    amzDate,
    bodyText,
    headers: signingHeaders,
    method: "POST",
    needSignHeaderKeys: ["x-amz-content-sha256"],
    query,
    region: "cn-north-1",
    secretAccessKey: input.credentials.SecretAccessKey,
    serviceName: "vod",
  });
  const response = await HTTP.post(`${VOD_ENDPOINT}?${signed.canonicalQuery}`, bodyText, {
    headers: {
      ...signingHeaders,
      Authorization: signed.authorization,
      "Content-Type": "application/json",
      Origin: CREATOR_ORIGIN,
      Referer: `${CREATOR_ORIGIN}/`,
    },
    transformRequest: [() => bodyText],
  });
  const body = response.data as {
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
    Result?: { Results?: Array<{ PosterUri?: string; Vid?: string }> };
  };
  if (body.ResponseMetadata?.Error) {
    throw new Error(
      `CommitUploadInner 失败：${body.ResponseMetadata.Error.Code ?? "未知"} ` +
      `${body.ResponseMetadata.Error.Message ?? "未知错误"}`,
    );
  }
  const result = body.Result?.Results?.[0];
  if (!result?.Vid) {
    throw new Error(
      `CommitUploadInner 响应缺少 Vid；结构=${JSON.stringify(describeResponseShape(response.data))}`,
    );
  }
  return {
    ...(result.PosterUri ? { posterUri: result.PosterUri } : {}),
    videoId: result.Vid,
  };
}

/**
 * 按原包顺序各调用一次 enable 和 transend，不解释响应 Body。
 *
 * @param input - Cookie、CSRF、公共参数、msToken、UA 和 Vid
 */
async function verifyVideo(input: {
  commonParams: CommonParams;
  cookieHeader: string;
  csrfToken: string;
  msToken: string;
  userAgent: string;
  videoId: string;
}): Promise<void> {
  const query = {
    ...input.commonParams,
    msToken: input.msToken,
    video_id: input.videoId,
  };
  const headers = {
    Cookie: input.cookieHeader,
    Referer: CREATOR_REFERER,
    "User-Agent": input.userAgent,
    "X-Secsdk-Csrf-Token": input.csrfToken,
  };
  await HTTP.get(withQuery(`${CREATOR_ORIGIN}/web/api/media/video/enable/`, query), { headers });
  await HTTP.get(withQuery(`${CREATOR_ORIGIN}/web/api/media/video/transend/`, query), { headers });
}

/**
 * 申请 ImageX 封面上传节点。
 *
 * @param credentials - 临时 VOD/ImageX 凭证
 * @returns ImageX 上传节点
 */
async function applyImageUpload(credentials: DouyinUploadCredentials): Promise<DouyinUploadNode> {
  const query: Record<string, SignatureQueryValue> = {
    Action: "ApplyImageUpload",
    ServiceId: "jm8ajry58r",
    Version: "2018-08-01",
    app_id: 2906,
    s: Math.random().toString(36).slice(2),
    user_id: "",
  };
  const amzDate = formatAmzDate();
  const signingHeaders = {
    "X-Amz-Date": amzDate,
    "X-Amz-Security-Token": credentials.SessionToken,
  };
  const signed = await signV4({
    accessKeyId: credentials.AccessKeyID,
    amzDate,
    headers: signingHeaders,
    method: "GET",
    query,
    region: "cn-north-1",
    secretAccessKey: credentials.SecretAccessKey,
    serviceName: "imagex",
  });
  const response = await HTTP.get(`${IMAGEX_ENDPOINT}?${signed.canonicalQuery}`, {
    headers: {
      ...signingHeaders,
      Authorization: signed.authorization,
      Origin: CREATOR_ORIGIN,
      Referer: `${CREATOR_ORIGIN}/`,
    },
  });
  return pickDouyinUploadNode(response.data);
}

/**
 * 上传本地封面二进制。
 *
 * @param node - ImageX 上传节点
 * @param coverPath - 本地封面路径
 */
async function uploadCoverBinary(node: DouyinUploadNode, coverPath: string): Promise<void> {
  const cover = await readFile(coverPath);
  if (cover.byteLength === 0) {
    throw new Error("封面文件不能为空");
  }
  const store = node.StoreInfos[0];
  assert(store);
  const response = await HTTP.post(buildBinaryUploadUrl(node), cover, {
    headers: {
      Authorization: store.Auth,
      "Content-Crc32": calculateCrc32(cover),
      "Content-Type": "application/octet-stream",
      Origin: CREATOR_ORIGIN,
      Referer: `${CREATOR_ORIGIN}/`,
    },
  });
  const body = response.data as { code?: number; message?: string };
  if (body.code !== 2000) {
    throw new Error(body.message || "封面上传未返回 code=2000");
  }
}

/**
 * 提交 ImageX 上传会话并取得封面 Uri。
 *
 * @param credentials - 临时 VOD/ImageX 凭证
 * @param node - 已上传封面的 ImageX 节点
 * @returns 发布接口使用的 ImageX Uri
 */
async function commitImageUpload(credentials: DouyinUploadCredentials, node: DouyinUploadNode): Promise<string> {
  const query: Record<string, SignatureQueryValue> = {
    Action: "CommitImageUpload",
    ServiceId: "jm8ajry58r",
    Version: "2018-08-01",
    app_id: 2906,
    user_id: "",
  };
  const bodyText = JSON.stringify({ SessionKey: node.SessionKey });
  const amzDate = formatAmzDate();
  const signingHeaders = {
    "X-Amz-Content-Sha256": "",
    "X-Amz-Date": amzDate,
    "X-Amz-Security-Token": credentials.SessionToken,
  };
  const preSigned = await signV4({
    accessKeyId: credentials.AccessKeyID,
    amzDate,
    bodyText,
    headers: signingHeaders,
    method: "POST",
    needSignHeaderKeys: ["x-amz-content-sha256"],
    query,
    region: "cn-north-1",
    secretAccessKey: credentials.SecretAccessKey,
    serviceName: "imagex",
  });
  signingHeaders["X-Amz-Content-Sha256"] = preSigned.payloadHash;
  const signed = await signV4({
    accessKeyId: credentials.AccessKeyID,
    amzDate,
    bodyText,
    headers: signingHeaders,
    method: "POST",
    needSignHeaderKeys: ["x-amz-content-sha256"],
    query,
    region: "cn-north-1",
    secretAccessKey: credentials.SecretAccessKey,
    serviceName: "imagex",
  });
  const response = await HTTP.post(`${IMAGEX_ENDPOINT}?${signed.canonicalQuery}`, bodyText, {
    headers: {
      ...signingHeaders,
      Authorization: signed.authorization,
      "Content-Type": "application/json",
      Origin: CREATOR_ORIGIN,
      Referer: `${CREATOR_ORIGIN}/`,
    },
    transformRequest: [() => bodyText],
  });
  const result = (response.data as {
    Result?: { Results?: Array<{ Uri?: string; UriStatus?: number }> };
  }).Result?.Results?.[0];
  if (result?.UriStatus !== 2000 || !result.Uri) {
    throw new Error("CommitImageUpload 响应缺少成功 Uri");
  }
  return result.Uri;
}

/**
 * 把 ImageX Uri 换成访问 URL；业务失败按原包返回空字符串。
 *
 * @param input - Cookie、公共参数、UA 和 ImageX Uri
 * @returns 成功 URL；状态非零或缺失时为空字符串
 */
async function getImageUrl(input: {
  commonParams: CommonParams;
  cookieHeader: string;
  uri: string;
  userAgent: string;
}): Promise<string> {
  const response = await HTTP.get(
    withQuery(`${CREATOR_ORIGIN}/aweme/v1/creator/get/url/`, {
      ...input.commonParams,
      uri: input.uri,
    }),
    {
      headers: {
        Cookie: input.cookieHeader,
        Origin: CREATOR_ORIGIN,
        Referer: `${CREATOR_ORIGIN}/`,
        "User-Agent": input.userAgent,
      },
    },
  );
  const body = response.data as { status_code?: number; url?: string };
  return body.status_code === 0 && body.url ? body.url : "";
}

/**
 * 搜索文案中的话题；单个请求失败或无完全匹配时不阻断上传。
 *
 * @param input - Cookie、公共参数、文案和 UA
 * @returns 最多五个完全匹配的话题 ID
 */
async function searchTopics(input: {
  commonParams: CommonParams;
  cookieHeader: string;
  text: string;
  userAgent: string;
}): Promise<DouyinTopicMatch[]> {
  const names = extractTopicNames(input.text);
  const settled = await Promise.allSettled(
    names.map(async (name) => {
      const response = await HTTP.get(
        withQuery(`${CREATOR_ORIGIN}/aweme/v1/search/challengesug/`, {
          ...input.commonParams,
          aid: 2906,
          keyword: name,
          source: "challenge_create",
        }),
        {
          headers: {
            Cookie: input.cookieHeader,
            Referer: CREATOR_REFERER,
            "User-Agent": input.userAgent,
          },
        },
      );
      const body = response.data as {
        status_code?: number;
        sug_list?: Array<{ cha_name?: string; challenge_id?: string | number; cid?: string | number }>;
      };
      const match = body.status_code === 0
        ? body.sug_list?.find(({ cha_name }) => cha_name === name)
        : undefined;
      const id = match?.cid ?? match?.challenge_id;
      return id === undefined ? null : { id: String(id), name };
    }),
  );

  const topics: DouyinTopicMatch[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      topics.push(result.value);
    }
  }
  return topics;
}

/**
 * 读取本地封面尺寸，供 create_v2 的纵向与横向封面字段复用。
 *
 * @param coverPath - 本地封面绝对路径
 * @returns 图片原始像素尺寸
 */
async function readCoverDimensions(coverPath: string): Promise<{ height: number; width: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ height: image.naturalHeight, width: image.naturalWidth });
    image.onerror = () => reject(new Error("无法读取封面图片尺寸"));
    image.src = pathToFileURL(coverPath).href;
  });
}


async function prepareInRenderer(options: DouyinWorkerOptions): Promise<DouyinPreparedContext> {
  const responseStart = RENDERER_RESPONSES.length;
  const profile = createMachineProfile();
  const commonParams = buildCommonParams(profile);
  const state = await RENDERER_IPC.invoke("douyin:get-session-state") as DouyinSessionState;
  const { cookieHeader, msToken } = state;
  if (!cookieHeader || !msToken) {
    throw new Error("Electron Session 未返回 Cookie 或 msToken");
  }

  const videoInfo = await stat(options.videoPath);
  if (!videoInfo.isFile() || videoInfo.size <= 0) {
    throw new Error("视频路径必须指向非空文件");
  }
  const coverInfo = await stat(options.coverPath);
  if (!coverInfo.isFile() || coverInfo.size <= 0) {
    throw new Error("封面路径必须指向非空文件");
  }
  const publishText = parsePublishText(await readFile(options.textPath, "utf8"));
  const coverDimensions = await readCoverDimensions(options.coverPath);

  await emitLog(RENDERER_LOGGER, { message: "[1/17] 获取 CSRF Token", type: "info" });
  const csrfToken = await getCsrfToken(cookieHeader, profile.userAgent);
  await emitLog(RENDERER_LOGGER, { message: "[2/17] 获取账号信息", type: "info" });
  const uid = await getAccountUid(cookieHeader, msToken, profile.userAgent);
  await emitLog(RENDERER_LOGGER, { message: "[3/17] 获取 VOD/ImageX 临时密钥", type: "info" });
  const credentials = await getDouyinUploadCredentials({
    commonParams,
    cookieHeader,
    csrfToken,
    msToken,
    userAgent: profile.userAgent,
  });

  await emitLog(RENDERER_LOGGER, { message: "[4/17] 申请视频上传节点", type: "info" });
  const videoNode = await applyVideoUpload({ credentials, fileSize: videoInfo.size, uid });
  const videoUploadUrl = buildBinaryUploadUrl(videoNode);
  const descriptors = createChunkDescriptors(videoInfo.size);
  let uploadId: string | undefined;
  if (descriptors.length > 1) {
    await emitLog(RENDERER_LOGGER, { message: "[5/17] 初始化 multipart 视频上传", type: "info" });
    const store = videoNode.StoreInfos[0];
    assert(store);
    uploadId = await initializeMultipart(videoUploadUrl, {
      Authorization: store.Auth,
      Host: videoNode.UploadHost,
      "X-Storage-U": uid,
    });
  } else {
    await emitLog(RENDERER_LOGGER, { message: "[5/17] 视频不超过 5 MiB，跳过 multipart 初始化", type: "info" });
  }
  await emitLog(RENDERER_LOGGER, { message: `[6/17] 上传 ${descriptors.length} 个视频分片（并发 ${CHUNK_CONCURRENCY}）`, type: "info" });
  await uploadVideoChunks({
    descriptors,
    node: videoNode,
    uid,
    ...(uploadId ? { uploadId } : {}),
    uploadUrl: videoUploadUrl,
    videoPath: options.videoPath,
  });
  await emitLog(RENDERER_LOGGER, { message: uploadId ? "[7/17] multipart 视频已完成合并" : "[7/17] 单分片视频无需 finish", type: "info" });

  await emitLog(RENDERER_LOGGER, { message: "[8/17] 提交 VOD 上传会话", type: "info" });
  const video = await commitVideoUpload({ credentials, node: videoNode, uid });
  await emitLog(RENDERER_LOGGER, { message: "[9/17] 调用 video/enable", type: "info" });
  await emitLog(RENDERER_LOGGER, { message: "[10/17] 调用 video/transend", type: "info" });
  await verifyVideo({
    commonParams,
    cookieHeader,
    csrfToken,
    msToken,
    userAgent: profile.userAgent,
    videoId: video.videoId,
  });

  await emitLog(RENDERER_LOGGER, { message: "[11/17] 申请 ImageX 封面上传节点", type: "info" });
  const imageNode = await applyImageUpload(credentials);
  await emitLog(RENDERER_LOGGER, { message: "[12/17] 上传封面二进制", type: "info" });
  await uploadCoverBinary(imageNode, options.coverPath);
  await emitLog(RENDERER_LOGGER, { message: "[13/17] 提交 ImageX 上传会话", type: "info" });
  const imageUri = await commitImageUpload(credentials, imageNode);
  await emitLog(RENDERER_LOGGER, { message: "[14/17] 获取封面访问 URL", type: "info" });
  const coverUrl = await getImageUrl({
    commonParams,
    cookieHeader,
    uri: imageUri,
    userAgent: profile.userAgent,
  });
  await emitLog(RENDERER_LOGGER, { message: "[15/17] 搜索文案话题", type: "info" });
  const topics = await searchTopics({
    commonParams,
    cookieHeader,
    text: publishText.description,
    userAgent: profile.userAgent,
  });

  const publishPayload = buildPublishPayload({
    coverHeight: coverDimensions.height,
    coverUri: imageUri,
    coverUrl,
    coverWidth: coverDimensions.width,
    description: publishText.description,
    title: publishText.title,
    topics,
    videoId: video.videoId,
    visibility: options.visibility,
  });
  const bodyText = JSON.stringify(publishPayload);
  const queryString = serializeQuery({
    ...commonParams,
    read_aid: 2906,
    msToken,
  });
  const unsignedUrl = `${CREATOR_ORIGIN}/web/api/media/aweme/create_v2/?${queryString}`;

  await emitLog(RENDERER_LOGGER, { message: "[16/17] 使用 Creator 官方 BDMS 生成 a_bogus", type: "info" });
  const signed = await RENDERER_IPC.invoke("douyin:sign-create-v2", {
    bodyText,
    csrfToken,
    unsignedUrl,
  }) as DouyinSigningResult;

  return {
    bodyText,
    chunkDescriptors: descriptors,
    commonParams,
    cookieHeader,
    coverDimensions,
    coverUrl,
    credentials,
    csrfToken,
    httpResponses: RENDERER_RESPONSES.slice(responseStart),
    imageUri,
    imageNode,
    msToken,
    payload: publishPayload,
    profile,
    publishText,
    signed,
    topics,
    uid,
    unsignedUrl,
    ...(uploadId ? { uploadId } : {}),
    video,
    videoFile: {
      modifiedAt: videoInfo.mtimeMs,
      name: options.videoPath.split(/[\\/]/u).at(-1) ?? "video.mp4",
      size: videoInfo.size,
    },
    visibility: options.visibility,
    videoNode,
    videoUploadUrl,
    workerId: "",
  };
}

/**
 * 在当前 Electron renderer 中执行最终 create_v2 请求。
 *
 * @param prepared - prepare 生成的完整签名上下文
 * @returns item_id 和完整响应
 */
async function publishInRenderer(prepared: DouyinPreparedContext): Promise<DouyinPublishResponse> {
  await emitLog(RENDERER_LOGGER, {
    message: `[17/17] 提交发布（可见性：${prepared.visibility}）`,
    type: "info",
  });
  const response = await RENDERER_HTTP.post(prepared.signed.signedUrl, prepared.bodyText, {
    headers: {
      ...prepared.signed.ticketHeaders,
      Cookie: prepared.cookieHeader,
      "Content-Type": "application/json",
      Referer: CREATOR_REFERER,
      "User-Agent": prepared.profile.userAgent,
      "X-Secsdk-Csrf-Token": prepared.csrfToken,
    },
    transformRequest: [() => prepared.bodyText],
  });
  const result = response.data as {
    item_id?: string | number;
    status_code?: number;
    status_msg?: string;
  };
  if (result.status_code !== 0 || !result.item_id) {
    throw new Error(
      `create_v2 失败：status_code=${result.status_code ?? "缺失"}，` +
      `${result.status_msg || "响应缺少成功 item_id"}，` +
      `结构=${JSON.stringify(describeResponseShape(response.data))}`,
    );
  }
  await emitLog(RENDERER_LOGGER, { message: `发布成功，作品 ID：${result.item_id}`, type: "info" });
  return { itemId: String(result.item_id), response: await serializeAxiosResponse(response) };
}

/**
 * 生成与固定 Chrome 138 UA 一致的 Client Hints。
 *
 * @returns Chromium 请求使用的 Client Hint Headers
 */
function createClientHintHeaders(): Record<string, string> {
  return {
    "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": process.platform === "darwin" ? '"macOS"' : '"Windows"',
  };
}

/**
 * 查找不区分大小写的请求 Header 名。
 *
 * @param headers - Electron 请求 Header
 * @param expected - 目标 Header 名
 * @returns 实际 Header 名；不存在时返回 undefined
 */
function findHeaderName(headers: Record<string, string>, expected: string): string | undefined {
  return Object.keys(headers).find((name) => name.toLowerCase() === expected.toLowerCase());
}

/**
 * 安装原包 `_setRequestHeaders` 还原逻辑，只处理 Service renderer 主动标记的请求。
 *
 * @param accountSession - 两个隐藏窗口共享的账号 Session
 */
function installRequestHeaderBridge(accountSession: Session): void {
  accountSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    const markerName = findHeaderName(headers, "_setRequestHeaders");
    if (!markerName) {
      callback({ cancel: false, requestHeaders: details.requestHeaders });
      return;
    }

    try {
      const desired = JSON.parse(headers[markerName] ?? "{}") as Record<string, string>;
      delete headers[markerName];
      for (const [name, value] of Object.entries(desired)) {
        headers[name] = value;
      }
      Object.assign(headers, createClientHintHeaders());
      callback({ cancel: false, requestHeaders: headers });
    } catch {
      callback({ cancel: true });
    }
  });
}

/**
 * 等待 Creator 页面安全 SDK 完成初始化。
 *
 * @param window - Creator 签名窗口
 */
async function waitForBdms(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + BDMS_READY_TIMEOUT;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      "document.readyState === 'complete' && Boolean(window.bdms) && Boolean(window._SdkGlueInit)",
      true,
    ) as boolean;
    if (ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 Creator BDMS 初始化超时");
}

/**
 * 从 Creator origin 读取本次运行需要的 localStorage 字段。
 *
 * @param signerWindow - 已加载 Creator 页面且完成 BDMS 初始化的窗口
 * @returns 原始 xmst 与 security-sdk 字符串
 */
async function readSecurityStorage(signerWindow: BrowserWindow): Promise<SecurityStorage> {
  return signerWindow.webContents.executeJavaScript(`({
    xmst: localStorage.getItem("xmst"),
    signData: localStorage.getItem("security-sdk/s_sdk_sign_data_key/web_protect"),
    cryptSdk: localStorage.getItem("security-sdk/s_sdk_crypt_sdk"),
  })`, true) as Promise<SecurityStorage>;
}

/**
 * 等待 ticket-guard 的签名数据与私钥完成异步恢复。
 *
 * BDMS 可用只表示请求拦截链已经安装，不能保证 security-sdk 的两个 localStorage 键已同时写入。
 *
 * @param signerWindow - 已加载 Creator 页面的签名窗口
 * @returns 同时包含 sign data 和 crypt SDK 的安全状态
 */
async function waitForTicketSecurityStorage(
  signerWindow: BrowserWindow,
): Promise<SecurityStorage & { cryptSdk: string; signData: string }> {
  const deadline = Date.now() + BDMS_READY_TIMEOUT;
  while (Date.now() < deadline) {
    const storage = await readSecurityStorage(signerWindow);
    if (storage.signData && storage.cryptSdk) {
      return { ...storage, cryptSdk: storage.cryptSdk, signData: storage.signData };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 Creator ticket-guard security-sdk 数据超时");
}

/**
 * 解开 security-sdk 使用的 URI 编码与嵌套 JSON data 包装。
 *
 * @param raw - localStorage 原始字符串
 * @returns 最内层对象
 */
function unwrapSecurityValue(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof value === "string") {
      value = JSON.parse(value) as unknown;
      continue;
    }
    if (value && typeof value === "object" && "data" in value) {
      value = value.data;
      continue;
    }
    break;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("security-sdk localStorage 格式无效");
  }
  return value as Record<string, unknown>;
}

/**
 * 将 Electron Session Cookie 拼成 Creator Axios 使用的 Cookie Header。
 *
 * @param cookies - 当前 Creator URL 可用 Cookie
 * @returns 分号分隔的 Cookie Header
 */
function stringifyCookies(cookies: Cookie[]): string {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

/**
 * 按原包 `_ae/CIt` 逻辑生成 create_v2 ticket-guard Header 集。
 *
 * @param accountSession - 当前账号 Session
 * @param signerWindow - 可读取 Creator localStorage 的窗口
 * @returns 动态签名 Header 和 Cookie 中的四个版本 Header
 */
async function createTicketGuardHeaders(
  accountSession: Session,
  signerWindow: BrowserWindow,
): Promise<Record<string, string>> {
  const storage = await waitForTicketSecurityStorage(signerWindow);
  const signData = unwrapSecurityValue(storage.signData);
  const cryptSdk = unwrapSecurityValue(storage.cryptSdk);
  const ticket = typeof signData.ticket === "string" ? signData.ticket.trim() : "";
  const tsSign = typeof signData.ts_sign === "string" ? signData.ts_sign : "";
  const privateKey = typeof cryptSdk.ec_privateKey === "string" ? cryptSdk.ec_privateKey : "";
  if (!ticket || !tsSign || !privateKey) {
    throw new Error("ticket-guard 数据缺少 ticket、ts_sign 或 ec_privateKey");
  }

  const timestamp = Math.floor(Date.now() / 1_000);
  const content =
    `ticket=${ticket}&path=/web/api/media/aweme/create_v2/&timestamp=${timestamp}`;
  const signature = signEcdsa("sha256", Buffer.from(content, "utf8"), {
    dsaEncoding: "der",
    key: privateKey,
  }).toString("base64");
  const dynamicHeader = Buffer.from(JSON.stringify({
    ts_sign: tsSign,
    req_content: "ticket,path,timestamp",
    req_sign: signature,
    timestamp,
  }), "utf8").toString("base64");

  const ticketCookies = await accountSession.cookies.get({ name: "bd_ticket_guard_client_data" });
  const ticketCookie = ticketCookies[0]?.value;
  if (!ticketCookie) {
    throw new Error("Creator partition 缺少 bd_ticket_guard_client_data Cookie");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(decodeURIComponent(ticketCookie), "base64").toString("utf8"));
  } catch {
    throw new Error("bd_ticket_guard_client_data Cookie 格式无效");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("bd_ticket_guard_client_data Cookie 内容无效");
  }

  const staticHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(decoded as Record<string, unknown>)) {
    staticHeaders[name] = String(value);
  }
  return {
    "bd-ticket-guard-client-data": dynamicHeader,
    ...staticHeaders,
  };
}

/**
 * 通过 BDMS 发起并在网络前终止 create_v2，取得完整签名 URL。
 *
 * @param signerWindow - Creator 签名窗口
 * @param unsignedUrl - 包含稳定 Query、但不含 a_bogus 的 URL
 * @param bodyText - 唯一序列化的发布 Body
 * @param csrfToken - 当前 Electron Session 的 CSRF Token
 * @returns 原样捕获的最终 URL
 */
async function captureSignedUrl(
  signerWindow: BrowserWindow,
  unsignedUrl: string,
  bodyText: string,
  csrfToken: string,
): Promise<string> {
  const debuggerClient = signerWindow.webContents.debugger;
  if (debuggerClient.isAttached()) {
    debuggerClient.detach();
  }
  debuggerClient.attach("1.3");
  await debuggerClient.sendCommand("Fetch.enable", {
    patterns: [{ requestStage: "Request", urlPattern: "*create_v2*" }],
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("等待 BDMS 签名请求超时"));
        }
      }, SIGNING_TIMEOUT);

      const finish = (error: Error | null, signedUrl?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        debuggerClient.off("message", onMessage);
        if (error) {
          reject(error);
        } else if (signedUrl) {
          resolve(signedUrl);
        }
      };

      const onMessage = (
        _event: ElectronEvent,
        method: string,
        parameters: Record<string, unknown>,
      ): void => {
        if (method !== "Fetch.requestPaused") {
          return;
        }
        const requestId = parameters.requestId;
        const request = parameters.request as {
          method?: string;
          postData?: string;
          url?: string;
        } | undefined;
        if (typeof requestId !== "string" || !request?.url) {
          finish(new Error("CDP Fetch.requestPaused 缺少 requestId 或 URL"));
          return;
        }

        void debuggerClient.sendCommand("Fetch.failRequest", {
          errorReason: "Aborted",
          requestId,
        }).then(() => {
          if (request.method !== "POST") {
            finish(new Error("BDMS 签名请求方法不是 POST"));
            return;
          }
          if (request.postData !== bodyText) {
            finish(new Error("BDMS 签名请求 Body 与最终 bodyText 不一致"));
            return;
          }
          const url = new URL(request.url as string);
          if (url.searchParams.getAll("msToken").length !== 1) {
            finish(new Error("BDMS 签名 URL 中 msToken 数量不是 1"));
            return;
          }
          if (url.searchParams.getAll("a_bogus").length !== 1 || !url.searchParams.get("a_bogus")) {
            finish(new Error("BDMS 未生成 a_bogus"));
            return;
          }
          finish(null, request.url);
        }).catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
      };

      debuggerClient.on("message", onMessage);
      const request = JSON.stringify({
        bodyText,
        csrfToken,
        unsignedUrl,
      });
      void signerWindow.webContents.executeJavaScript(`(() => {
        const input = ${request};
        void window.fetch(input.unsignedUrl, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Referer": ${JSON.stringify(CREATOR_REFERER)},
            "X-Secsdk-Csrf-Token": input.csrfToken,
          },
          body: input.bodyText,
        }).catch(() => undefined);
      })()`, true).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  } finally {
    try {
      await debuggerClient.sendCommand("Fetch.disable");
    } finally {
      if (debuggerClient.isAttached()) {
        debuggerClient.detach();
      }
    }
  }
}

/**
 * 创建只加载官方 Creator 页面的远程签名窗口。
 *
 * @param accountSession - 账号 Session
 * @returns 完成 BDMS 初始化的隐藏窗口
 */
async function createSignerWindow(accountSession: Session): Promise<BrowserWindow> {
  const window = new MAIN_ELECTRON.BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: accountSession,
    },
  });
  window.webContents.setUserAgent(createMachineUserAgent());
  await window.loadURL(CREATOR_HOME);
  await waitForBdms(window);
  return window;
}

/**
 * 返回与当前运行系统匹配的固定 Chrome 138 UA。
 *
 * @returns Windows 或 macOS UA
 */
function createMachineUserAgent(): string {
  if (process.platform === "win32") {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/138.0.0.0 Safari/537.36";
  }
  if (process.platform === "darwin") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/138.0.0.0 Safari/537.36";
  }
  throw new Error(`当前系统 ${process.platform} 不支持抖音本机发布 Service`);
}


/**
 * 创建本地 renderer 窗口并加载独立构建产物。
 *
 * @param accountSession - 与签名窗口共享的 Session
 * @param rendererPath - renderer IIFE 产物
 * @returns renderer 窗口
 */
async function createServiceNetworkWindow(
  accountSession: Session,
  rendererPath: string,
): Promise<BrowserWindow> {
  const window = new MAIN_ELECTRON.BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      additionalArguments: [`${RUNTIME_ARGUMENT}renderer`],
      backgroundThrottling: false,
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      session: accountSession,
      webSecurity: false,
    },
  });
  window.webContents.setUserAgent(createMachineUserAgent());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const scriptUrl = pathToFileURL(rendererPath).href;
  const html = `<!doctype html><html><body><script src="${scriptUrl}"></script></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return window;
}

/**
 * 发送带协议版本的父进程消息。
 *
 * @param envelope - worker 消息
 */
function sendWorkerMessage(envelope: Omit<WorkerEnvelope, "version">): void {
  process.send?.({ ...envelope, version: SERVICE_PROTOCOL_VERSION });
}

/**
 * 启动 Electron main worker，并等待父进程命令。
 */
async function runElectronMain(): Promise<void> {
  MAIN_ELECTRON = createRequire(import.meta.url)("electron") as typeof import("electron");
  const encoded = process.argv.find((value) => value.startsWith(OPTIONS_ARGUMENT))?.slice(OPTIONS_ARGUMENT.length);
  if (!encoded) {
    throw new Error("Douyin worker 缺少运行参数");
  }
  const options = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as DouyinWorkerOptions;
  const accountPath = join(options.profileRoot, options.sourcePartition);
  await Promise.all([
    access(join(options.profileRoot, "Local State")),
    access(accountPath),
    access(options.electronRendererPath),
  ]);

  MAIN_ELECTRON.app.setPath("userData", options.profileRoot);
  MAIN_ELECTRON.app.setPath("sessionData", options.profileRoot);
  MAIN_ELECTRON.app.commandLine.appendSwitch("lang", "zh-CN");
  await MAIN_ELECTRON.app.whenReady();

  const accountSession = MAIN_ELECTRON.session.fromPath(accountPath, { cache: true });
  await accountSession.setProxy({ mode: "direct" });
  accountSession.setUserAgent(createMachineUserAgent(), "zh-CN");
  installRequestHeaderBridge(accountSession);
  const signerWindow = await createSignerWindow(accountSession);

  MAIN_ELECTRON.ipcMain.handle("douyin:get-session-state", async () => {
    const storage = await readSecurityStorage(signerWindow);
    const cookies = await accountSession.cookies.get({ url: CREATOR_ORIGIN });
    const cookieMsToken = [...cookies].reverse().find(({ name }) => name === "msToken")?.value;
    const msToken = storage.xmst || cookieMsToken;
    if (!msToken) {
      throw new Error("Creator partition 缺少 xmst/msToken");
    }
    return { cookieHeader: stringifyCookies(cookies), msToken };
  });
  MAIN_ELECTRON.ipcMain.handle(
    "douyin:sign-v4",
    (_event, input: DouyinV4SignatureInput) => signDouyinV4(input),
  );
  MAIN_ELECTRON.ipcMain.handle(
    "douyin:sign-create-v2",
    async (_event, input: { bodyText: string; csrfToken: string; unsignedUrl: string }): Promise<MainSigningResult> => ({
      signedUrl: await captureSignedUrl(signerWindow, input.unsignedUrl, input.bodyText, input.csrfToken),
      ticketHeaders: await createTicketGuardHeaders(accountSession, signerWindow),
    }),
  );

  let rendererReadyResolve: (() => void) | undefined;
  const rendererReady = new Promise<void>((resolvePromise) => {
    rendererReadyResolve = resolvePromise;
  });
  MAIN_ELECTRON.ipcMain.on("douyin:renderer-ready", (_event, envelope: WorkerEnvelope) => {
    if (envelope.version !== SERVICE_PROTOCOL_VERSION) {
      sendWorkerMessage({
        error: `renderer 协议版本不一致：${envelope.version}`,
        kind: "protocol-error",
      });
      return;
    }
    rendererReadyResolve?.();
  });
  MAIN_ELECTRON.ipcMain.on("douyin:log", (_event, envelope: WorkerEnvelope) => {
    if (envelope.version === SERVICE_PROTOCOL_VERSION && envelope.event) {
      sendWorkerMessage({ event: envelope.event, kind: "log" });
    }
  });
  MAIN_ELECTRON.ipcMain.on("douyin:result", (_event, envelope: WorkerEnvelope) => {
    if (envelope.version !== SERVICE_PROTOCOL_VERSION) {
      sendWorkerMessage({ error: "renderer 协议版本不一致", kind: "protocol-error" });
      return;
    }
    sendWorkerMessage({
      ...(envelope.error ? { error: envelope.error } : {}),
      kind: envelope.kind,
      ...(envelope.payload === undefined ? {} : { payload: envelope.payload }),
      ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
    });
  });

  const networkWindow = await createServiceNetworkWindow(accountSession, options.electronRendererPath);
  await rendererReady;
  sendWorkerMessage({ kind: "ready" });

  await new Promise<void>((resolvePromise) => {
    process.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as WorkerEnvelope;
      if (message.version !== SERVICE_PROTOCOL_VERSION) {
        sendWorkerMessage({ error: `父进程协议版本不一致：${message.version}`, kind: "protocol-error" });
        return;
      }
      if (message.kind === "dispose") {
        resolvePromise();
        return;
      }
      if (message.kind === "prepare" || message.kind === "publish") {
        networkWindow.webContents.send("douyin:command", message);
      }
    });
  });

  accountSession.flushStorageData();
  networkWindow.destroy();
  signerWindow.destroy();
}

/**
 * 启动 Electron renderer 命令处理器。
 */
function runElectronRenderer(): void {
  const rendererRequire = (globalThis as typeof globalThis & { require: NodeRequire }).require;
  const electron: typeof import("electron") = rendererRequire("electron");
  RENDERER_IPC = electron.ipcRenderer;
  RENDERER_RESPONSES = [];
  RENDERER_LOGGER = {
    log(event: LogEvent): void {
      RENDERER_IPC.send("douyin:log", {
        event,
        kind: "log",
        version: SERVICE_PROTOCOL_VERSION,
      } satisfies WorkerEnvelope);
    },
  };
  RENDERER_HTTP = createRendererHttpClient(RENDERER_LOGGER, RENDERER_RESPONSES);
  HTTP = RENDERER_HTTP;
  RENDERER_IPC.on("douyin:command", (_event, message: WorkerEnvelope) => {
    void (async () => {
      try {
        if (message.version !== SERVICE_PROTOCOL_VERSION) {
          throw new Error(`main 协议版本不一致：${message.version}`);
        }
        if (message.kind === "prepare") {
          const prepared = await prepareInRenderer(message.payload as DouyinWorkerOptions);
          RENDERER_IPC.send("douyin:result", {
            kind: "prepared",
            payload: prepared,
            ...(message.requestId ? { requestId: message.requestId } : {}),
            version: SERVICE_PROTOCOL_VERSION,
          } satisfies WorkerEnvelope);
          return;
        }
        if (message.kind === "publish") {
          const published = await publishInRenderer(message.payload as DouyinPreparedContext);
          RENDERER_IPC.send("douyin:result", {
            kind: "published",
            payload: published,
            ...(message.requestId ? { requestId: message.requestId } : {}),
            version: SERVICE_PROTOCOL_VERSION,
          } satisfies WorkerEnvelope);
        }
      } catch (error) {
        RENDERER_IPC.send("douyin:result", {
          error: formatError(error),
          kind: "command-error",
          ...(message.requestId ? { requestId: message.requestId } : {}),
          version: SERVICE_PROTOCOL_VERSION,
        } satisfies WorkerEnvelope);
      }
    })();
  });
  RENDERER_IPC.send("douyin:renderer-ready", {
    kind: "renderer-ready",
    version: SERVICE_PROTOCOL_VERSION,
  } satisfies WorkerEnvelope);
}

/**
 * 将未处理异常压缩为不包含凭据和请求参数的终端摘要。
 *
 * @param error - 未处理异常
 * @returns 安全的错误文本
 */
function formatError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data: unknown = error.response?.data as unknown;
    let serverSummary = "";
    if (data && typeof data === "object") {
      const body = data as {
        ResponseMetadata?: { Error?: { Code?: unknown; Message?: unknown } };
        code?: unknown;
        message?: unknown;
        msg?: unknown;
        status_msg?: unknown;
      };
      const code = body.code ?? body.ResponseMetadata?.Error?.Code;
      const message = body.message ?? body.msg ?? body.status_msg ?? body.ResponseMetadata?.Error?.Message;
      const codeText = typeof code === "string" || typeof code === "number" ? String(code) : "";
      const messageText = typeof message === "string" || typeof message === "number" ? String(message) : "";
      if (codeText || messageText) {
        serverSummary = `，code=${codeText || "未知"}，message=${messageText || "未知"}`;
      }
    }
    return status ? `HTTP ${status}${serverSummary}：${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}



/**
 * 将显式输入路径解析为绝对路径。
 *
 * @param value - 调用方传入路径
 * @returns 基于当前工作目录的绝对路径
 */
function resolveServicePath(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/**
 * 解析当前项目的默认抖音构建产物路径。
 *
 * @returns Electron main 和 renderer 默认路径
 */
function getDefaultWorkerPaths(): { mainPath: string; rendererPath: string } {
  const serviceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  return {
    mainPath: join(serviceRoot, "dist/service/douyin-electron-main.mjs"),
    rendererPath: join(serviceRoot, "dist/service/douyin-electron-renderer.js"),
  };
}

/**
 * 从进程参数读取当前构建产物的运行模式。
 *
 * @returns main、renderer 或 undefined
 */
function getRuntimeMode(): "main" | "renderer" | undefined {
  for (let index = process.argv.length - 1; index >= 0; index -= 1) {
    const value = process.argv[index];
    if (value?.startsWith(RUNTIME_ARGUMENT)) {
      const mode = value.slice(RUNTIME_ARGUMENT.length);
      return mode === "main" || mode === "renderer" ? mode : undefined;
    }
  }
  return undefined;
}

/**
 * 创建父进程持有的 Electron worker。
 *
 * @param options - worker 运行参数
 * @param mainPath - Electron main 构建产物
 * @param logger - 注入 Logger
 * @returns 可发送命令的 worker
 */
function createWorker(options: DouyinWorkerOptions, mainPath: string, logger: Logger): WorkerHandle {
  const electronPath = createRequire(import.meta.url)("electron") as string;
  const encodedOptions = Buffer.from(JSON.stringify(options), "utf8").toString("base64url");
  const child = fork(mainPath, [`${RUNTIME_ARGUMENT}main`, `${OPTIONS_ARGUMENT}${encodedOptions}`], {
    execPath: electronPath,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const pending = new Map<string, { reject(error: Error): void; resolve(value: unknown): void }>();
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolvePromise, reject) => {
    readyResolve = resolvePromise;
    readyReject = reject;
  });
  let exitResolve: (() => void) | undefined;
  const exit = new Promise<void>((resolvePromise) => {
    exitResolve = resolvePromise;
  });
  const rejectAll = (error: Error): void => {
    readyReject?.(error);
    for (const command of pending.values()) command.reject(error);
    pending.clear();
  };
  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as WorkerEnvelope;
    if (message.version !== SERVICE_PROTOCOL_VERSION) {
      const error = new Error(`Douyin worker 协议版本不一致：期望 ${SERVICE_PROTOCOL_VERSION}，实际 ${message.version}`);
      rejectAll(error);
      child.kill();
      return;
    }
    if (message.kind === "log" && message.event) {
      void emitLog(logger, message.event);
      return;
    }
    if (message.kind === "ready") {
      readyResolve?.();
      return;
    }
    if (message.kind === "protocol-error") {
      rejectAll(new Error(message.error ?? "Douyin worker 协议错误"));
      return;
    }
    if (!message.requestId) return;
    const command = pending.get(message.requestId);
    if (!command) return;
    pending.delete(message.requestId);
    if (message.error) command.reject(new Error(message.error));
    else command.resolve(message.payload);
  });
  child.once("error", (error) => rejectAll(error));
  child.once("exit", (code, signal) => {
    exitResolve?.();
    rejectAll(new Error(signal ? `Electron 被信号 ${signal} 终止` : `Electron 退出码 ${code ?? "未知"}`));
  });
  return { child, exit, id: randomUUID(), pending, ready };
}

/**
 * 向当前 worker 发送一个关联请求。
 *
 * @param worker - 当前 Electron worker
 * @param kind - prepare 或 publish
 * @param payload - 命令参数
 * @returns worker 返回值
 */
async function sendWorkerCommand<T>(worker: WorkerHandle, kind: "prepare" | "publish", payload: unknown): Promise<T> {
  const requestId = randomUUID();
  const result = new Promise<T>((resolvePromise, reject) => {
    worker.pending.set(requestId, {
      reject,
      resolve: (value) => resolvePromise(value as T),
    });
  });
  worker.child.send({ kind, payload, requestId, version: SERVICE_PROTOCOL_VERSION } satisfies WorkerEnvelope);
  return result;
}

/**
 * Node.js 对外的抖音视频服务，内部维护最新 Electron worker。
 */
export class DouyinVideo implements Video<DouyinPreparedContext, DouyinPublishResponse> {
  private readonly logger: Logger;
  private readonly options: DouyinVideoOptions;
  private worker: WorkerHandle | undefined;

  /**
   * 创建抖音视频服务。
   *
   * @param options - partition、素材和构建产物
   * @param dependencies - 视频服务运行时依赖
   */
  public constructor(options: DouyinVideoOptions, dependencies: VideoDependencies) {
    this.logger = dependencies.logger;
    this.options = {
      ...options,
      coverPath: resolveServicePath(options.coverPath),
      ...(options.electronMainPath ? { electronMainPath: resolveServicePath(options.electronMainPath) } : {}),
      ...(options.electronRendererPath
        ? { electronRendererPath: resolveServicePath(options.electronRendererPath) }
        : {}),
      profileRoot: resolveServicePath(options.profileRoot),
      textPath: resolveServicePath(options.textPath),
      videoPath: resolveServicePath(options.videoPath),
    };
  }

  /**
   * 启动最新 worker 并执行当前第 1～16 步。
   *
   * @returns 最终 create_v2 所需完整上下文
   */
  public async prepare(): Promise<DouyinPreparedContext> {
    await this.dispose();
    const defaults = getDefaultWorkerPaths();
    const mainPath = this.options.electronMainPath ?? defaults.mainPath;
    const rendererPath = this.options.electronRendererPath ?? defaults.rendererPath;
    await Promise.all([
      access(mainPath),
      access(rendererPath),
      access(join(this.options.profileRoot, "Local State")),
      access(join(this.options.profileRoot, this.options.sourcePartition)),
      access(this.options.videoPath),
      access(this.options.coverPath),
      access(this.options.textPath),
    ]).catch((error: unknown) => {
      throw new Error(
        `抖音输入或构建产物不存在；请先执行 npm run build:service：${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const workerOptions: DouyinWorkerOptions = {
      coverPath: this.options.coverPath,
      electronRendererPath: rendererPath,
      profileRoot: this.options.profileRoot,
      sourcePartition: this.options.sourcePartition,
      textPath: this.options.textPath,
      videoPath: this.options.videoPath,
      visibility: parseVisibility(this.options.visibility),
    };
    const worker = createWorker(workerOptions, mainPath, this.logger);
    this.worker = worker;
    await worker.ready;
    const prepared = await sendWorkerCommand<Omit<DouyinPreparedContext, "workerId">>(worker, "prepare", workerOptions);
    return { ...prepared, workerId: worker.id };
  }

  /**
   * 将传入上下文交给最新 worker 执行最终发布。
   *
   * @param prepared - 任意 prepare 返回上下文，不做归属校验
   * @returns item_id 和完整响应
   */
  public async publish(prepared: DouyinPreparedContext): Promise<DouyinPublishResponse> {
    if (!this.worker) {
      throw new Error("当前没有可用的 Douyin Electron worker");
    }
    return sendWorkerCommand<DouyinPublishResponse>(this.worker, "publish", prepared);
  }

  /**
   * 关闭当前最新 worker。
   */
  public async dispose(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    try {
      if (worker.child.connected) {
        worker.child.send({ kind: "dispose", version: SERVICE_PROTOCOL_VERSION } satisfies WorkerEnvelope);
      }
      await worker.exit;
    } catch (error) {
      await emitLog(this.logger, {
        message: `Douyin worker 清理失败：${error instanceof Error ? error.message : String(error)}`,
        type: "info",
      });
      throw error;
    }
  }
}

const runtimeMode = getRuntimeMode();
if (runtimeMode === "main") {
  void runElectronMain().then(() => {
    MAIN_ELECTRON.app.exit(0);
  }).catch((error: unknown) => {
    sendWorkerMessage({ error: error instanceof Error ? error.message : String(error), kind: "worker-error" });
    MAIN_ELECTRON?.app.exit(1);
  });
} else if (runtimeMode === "renderer") {
  void runElectronRenderer();
}
