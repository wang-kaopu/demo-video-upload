import assert from "node:assert/strict";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import axios, { type AxiosInstance } from "axios";
import CRC32 from "crc-32";
import pLimit from "p-limit";

import {
  formatAmzDate,
  signDouyinV4,
  type SignatureQueryValue,
} from "./douyin-signature.js";

const CREATOR_ORIGIN = "https://creator.douyin.com";
const CREATOR_REFERER = `${CREATOR_ORIGIN}/creator-micro/content/publish?enter_from=publish_page`;
const VOD_ENDPOINT = "https://vod.bytedanceapi.com/";
const IMAGEX_ENDPOINT = "https://imagex.bytedanceapi.com";
const CHUNK_SIZE = 5 * 1024 * 1024;
const CHUNK_CONCURRENCY = 3;
const REQUEST_TIMEOUT = 10 * 60 * 1000;
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HTTP = createHttpClient();

export interface PlaywrightCookie {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite?: "Strict" | "Lax" | "None" | null;
  secure: boolean;
  value: string;
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins: Array<{
    localStorage: Array<{ name: string; value: string }>;
    origin: string;
  }>;
}

export interface AdaptedDouyinState {
  cookie: string;
  msToken: string;
  token: string;
}

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

export interface TopicMatch {
  id: string;
  name: string;
}

interface ElectronCookie {
  domain: string;
  expirationDate?: number;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite: "strict" | "lax" | "no_restriction" | "unspecified";
  secure: boolean;
  session: boolean;
  value: string;
}

interface UploadCredentials {
  AccessKeyID: string;
  SecretAccessKey: string;
  SessionToken: string;
}

interface UploadNode {
  SessionKey: string;
  StoreInfos: Array<{ Auth: string; StoreUri: string }>;
  UploadHost: string;
}

interface UploadedVideo {
  posterUri?: string;
  videoId: string;
}

interface UploadedCover {
  coverUrl: string;
  uri: string;
}

interface MultipartPartResult {
  crc32: string;
  part_number: number;
}

interface CliOptions {
  cookiesPath: string;
  coverPath: string;
  textPath: string;
  videoPath: string;
}

type QueryParams = Record<string, string | number | boolean | null | undefined>;

/**
 * 创建抖音 Demo 使用的 Axios 客户端。
 *
 * 请求日志只输出步骤进度，避免 Cookie、token、临时密钥和二进制素材进入终端记录。
 *
 * @returns 支持大文件和十分钟超时的 HTTP 客户端
 */
function createHttpClient(): AxiosInstance {
  return axios.create({
    maxBodyLength: Number.POSITIVE_INFINITY,
    maxContentLength: Number.POSITIVE_INFINITY,
    timeout: REQUEST_TIMEOUT,
  });
}

/**
 * 将 Playwright storage-state 转换为 NewBand 账号存储和本机发布需要的三种状态。
 *
 * @param state - Playwright 导出的完整 storage-state
 * @returns Electron Cookie JSON、编码 token JSON 和原始 msToken
 */
export function adaptDouyinStorageState(state: PlaywrightStorageState): AdaptedDouyinState {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new Error("storage-state 必须包含 cookies 和 origins 数组");
  }

  const creatorState = state.origins.find(({ origin }) => origin === CREATOR_ORIGIN);
  if (!creatorState || !Array.isArray(creatorState.localStorage)) {
    throw new Error("storage-state 缺少 creator.douyin.com localStorage");
  }

  const selectedStorage = creatorState.localStorage.filter(
    ({ name }) => name === "xmst" || name.includes("security-sdk"),
  );
  const xmst = selectedStorage.find(({ name }) => name === "xmst")?.value;
  const cookieMsToken = [...state.cookies]
    .reverse()
    .find(({ name }) => name === "msToken")?.value;
  const msToken = xmst || cookieMsToken;
  if (!msToken) {
    throw new Error("storage-state 缺少 xmst 和 msToken");
  }

  const tokenEntries = selectedStorage.map(({ name, value }) => ({
    expirationDate: 255033043504,
    name,
    session: false,
    value: encodeURIComponent(value),
  }));
  const cookies: ElectronCookie[] = state.cookies.map(({ expires, sameSite, ...cookie }) => ({
    ...cookie,
    sameSite: sameSite === "None"
      ? "no_restriction"
      : sameSite
        ? sameSite.toLowerCase() as "strict" | "lax"
        : "unspecified",
    session: expires < 0,
    ...(expires >= 0 ? { expirationDate: expires } : {}),
  }));

  return {
    cookie: JSON.stringify(cookies),
    msToken,
    token: JSON.stringify(tokenEntries),
  };
}

/**
 * 读取并适配磁盘上的 Playwright storage-state。
 *
 * @param cookiesPath - storage-state JSON 路径
 * @returns 本机发布使用的账号状态
 */
async function loadDouyinState(cookiesPath: string): Promise<AdaptedDouyinState> {
  const parsed: unknown = JSON.parse(await readFile(cookiesPath, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("storage-state JSON 顶层必须是对象");
  }
  return adaptDouyinStorageState(parsed as PlaywrightStorageState);
}

/**
 * 判断 Cookie domain 是否适用于目标主机。
 *
 * @param hostname - 请求主机名
 * @param domain - Cookie domain
 * @returns 目标主机可以携带该 Cookie 时返回 true
 */
function domainMatches(hostname: string, domain: string): boolean {
  const normalizedDomain = domain.replace(/^\./u, "").toLowerCase();
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`);
}

/**
 * 从账号 Cookie JSON 生成指定 URL 可发送的 Cookie Header。
 *
 * 更具体的 domain/path 排在前面，并保留浏览器允许的同名 Cookie。
 *
 * @param cookieJson - 适配器输出的 Electron Cookie JSON
 * @param targetUrl - 即将请求的 URL
 * @param nowSeconds - 判断过期时间使用的 Unix 秒
 * @returns `name=value` 形式的 Cookie Header
 */
export function buildCookieHeader(
  cookieJson: string,
  targetUrl: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const parsed: unknown = JSON.parse(cookieJson);
  if (!Array.isArray(parsed)) {
    throw new Error("账号 cookie 必须是 JSON 数组");
  }

  const url = new URL(targetUrl);
  const cookies = (parsed as ElectronCookie[])
    .filter((cookie) => {
      const path = cookie.path || "/";
      const unexpired = cookie.session || cookie.expirationDate === undefined || cookie.expirationDate > nowSeconds;
      return Boolean(
        cookie.name &&
        cookie.value &&
        domainMatches(url.hostname, cookie.domain) &&
        url.pathname.startsWith(path) &&
        (!cookie.secure || url.protocol === "https:") &&
        unexpired,
      );
    })
    .sort((left, right) => {
      const pathDifference = (right.path || "/").length - (left.path || "/").length;
      return pathDifference || right.domain.replace(/^\./u, "").length - left.domain.replace(/^\./u, "").length;
    });

  if (cookies.length === 0) {
    throw new Error(`storage-state 没有适用于 ${url.hostname} 的有效 Cookie`);
  }
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

/**
 * 根据当前操作系统选择内部一致的设备配置。
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
  throw new Error(`当前系统 ${platform} 不支持抖音本机发布 Demo`);
}

/**
 * 从设备配置构造创作者中心公共 Query 参数。
 *
 * @param profile - 与请求 User-Agent 一致的设备配置
 * @returns 第 3、9、10、14、15 步复用的参数
 */
export function buildCommonParams(profile: MachineProfile): CommonParams {
  const slashIndex = profile.userAgent.indexOf("/");
  if (slashIndex <= 0) {
    throw new Error("设备 User-Agent 缺少浏览器名称分隔符");
  }

  return {
    aid: 1128,
    browser_language: profile.language,
    browser_name: profile.userAgent.slice(0, slashIndex),
    browser_online: true,
    browser_platform: profile.platform,
    browser_version: profile.userAgent.slice(slashIndex + 1),
    cookie_enabled: true,
    screen_height: profile.screenHeight,
    screen_width: profile.screenWidth,
    support_h265: 1,
    timezone_name: profile.timezone,
  };
}

/**
 * 按插入顺序序列化普通创作者中心 Query。
 *
 * @param params - 不需要 V4 排序的 Query 参数
 * @returns 每个值只执行一次 encodeURIComponent 的 Query
 */
export function serializeQuery(params: QueryParams): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== null && entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
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
export function createChunkDescriptors(fileSize: number, chunkSize = CHUNK_SIZE): ChunkDescriptor[] {
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

/**
 * 从 VOD/ImageX Apply 响应选择当前链路使用的上传节点。
 *
 * @param body - ApplyUploadInner 或 ApplyImageUpload 响应
 * @returns 含 host、store、auth 和 SessionKey 的节点
 */
function pickUploadNode(body: unknown): UploadNode {
  const typed = body as {
    Result?: { InnerUploadAddress?: { UploadNodes?: UploadNode[] } };
  };
  const node = typed.Result?.InnerUploadAddress?.UploadNodes?.[0];
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
function buildBinaryUploadUrl(node: UploadNode): string {
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
  const body = response.data as { user?: { uid?: string } };
  if (!body.user?.uid) {
    throw new Error("账号信息响应缺少 user.uid");
  }
  return body.user.uid;
}

/**
 * 获取 VOD/ImageX 临时密钥。
 *
 * @param input - Cookie、CSRF、设备参数和原始 msToken
 * @returns 三段临时上传凭证
 */
async function getUploadCredentials(input: {
  commonParams: CommonParams;
  cookieHeader: string;
  csrfToken: string;
  msToken: string;
  userAgent: string;
}): Promise<UploadCredentials> {
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

  const credentials = JSON.parse(body.auth) as Partial<UploadCredentials>;
  if (!credentials.AccessKeyID || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("auth 缺少 AccessKeyID、SecretAccessKey 或 SessionToken");
  }
  return credentials as UploadCredentials;
}

/**
 * 申请视频上传节点。
 *
 * @param input - 视频大小、账号 UID 和临时密钥
 * @returns VOD 上传节点
 */
async function applyVideoUpload(input: {
  credentials: UploadCredentials;
  fileSize: number;
  uid: string;
}): Promise<UploadNode> {
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
  const signed = signDouyinV4({
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
  return pickUploadNode(response.data);
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
  node: UploadNode;
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
            console.log(`      视频分片进度 ${completed}/${input.descriptors.length}`);
            return { crc32, part_number: descriptor.partNumber };
          }
          if (!body.data.part_number || !body.data.crc32) {
            throw new Error(`视频分片 ${descriptor.partNumber} 响应缺少 part_number 或 crc32`);
          }
          completed += 1;
          console.log(`      视频分片进度 ${completed}/${input.descriptors.length}`);
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
  credentials: UploadCredentials;
  node: UploadNode;
  uid: string;
}): Promise<UploadedVideo> {
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
  const preSigned = signDouyinV4({
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
  const signed = signDouyinV4({
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
async function applyImageUpload(credentials: UploadCredentials): Promise<UploadNode> {
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
  const signed = signDouyinV4({
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
  return pickUploadNode(response.data);
}

/**
 * 上传本地封面二进制。
 *
 * @param node - ImageX 上传节点
 * @param coverPath - 本地封面路径
 */
async function uploadCoverBinary(node: UploadNode, coverPath: string): Promise<void> {
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
async function commitImageUpload(credentials: UploadCredentials, node: UploadNode): Promise<string> {
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
  const preSigned = signDouyinV4({
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
  const signed = signDouyinV4({
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
}): Promise<TopicMatch[]> {
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

  const topics: TopicMatch[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      topics.push(result.value);
    }
  }
  return topics;
}

/**
 * 上传视频、校验视频、上传封面并执行发布前话题搜索。
 *
 * 本函数只执行文档第 1～15 步，不计算 a_bogus，也不会调用 create_v2 正式发布。
 *
 * @param options - Cookie、视频、封面和文案路径
 */
async function runUpload(options: CliOptions): Promise<void> {
  const profile = createMachineProfile();
  const commonParams = buildCommonParams(profile);
  const state = await loadDouyinState(options.cookiesPath);
  const cookieHeader = buildCookieHeader(state.cookie, CREATOR_ORIGIN);
  const videoInfo = await stat(options.videoPath);
  if (!videoInfo.isFile() || videoInfo.size <= 0) {
    throw new Error("视频路径必须指向非空文件");
  }
  const coverInfo = await stat(options.coverPath);
  if (!coverInfo.isFile() || coverInfo.size <= 0) {
    throw new Error("封面路径必须指向非空文件");
  }
  const text = await readFile(options.textPath, "utf8");

  console.log("[1/15] 获取 CSRF Token");
  const csrfToken = await getCsrfToken(cookieHeader, profile.userAgent);
  console.log("[2/15] 获取账号信息");
  const uid = await getAccountUid(cookieHeader, state.msToken, profile.userAgent);
  console.log("[3/15] 获取 VOD/ImageX 临时密钥");
  const credentials = await getUploadCredentials({
    commonParams,
    cookieHeader,
    csrfToken,
    msToken: state.msToken,
    userAgent: profile.userAgent,
  });

  console.log("[4/15] 申请视频上传节点");
  const videoNode = await applyVideoUpload({ credentials, fileSize: videoInfo.size, uid });
  const videoUploadUrl = buildBinaryUploadUrl(videoNode);
  const descriptors = createChunkDescriptors(videoInfo.size);
  let uploadId: string | undefined;
  if (descriptors.length > 1) {
    console.log("[5/15] 初始化 multipart 视频上传");
    const store = videoNode.StoreInfos[0];
    assert(store);
    uploadId = await initializeMultipart(videoUploadUrl, {
      Authorization: store.Auth,
      Host: videoNode.UploadHost,
      "X-Storage-U": uid,
    });
  } else {
    console.log("[5/15] 视频不超过 5 MiB，跳过 multipart 初始化");
  }
  console.log(`[6/15] 上传 ${descriptors.length} 个视频分片（并发 ${CHUNK_CONCURRENCY}）`);
  await uploadVideoChunks({
    descriptors,
    node: videoNode,
    uid,
    ...(uploadId ? { uploadId } : {}),
    uploadUrl: videoUploadUrl,
    videoPath: options.videoPath,
  });
  console.log(uploadId ? "[7/15] multipart 视频已完成合并" : "[7/15] 单分片视频无需 finish");

  console.log("[8/15] 提交 VOD 上传会话");
  const video = await commitVideoUpload({ credentials, node: videoNode, uid });
  console.log("[9/15] 调用 video/enable");
  console.log("[10/15] 调用 video/transend");
  await verifyVideo({
    commonParams,
    cookieHeader,
    csrfToken,
    msToken: state.msToken,
    userAgent: profile.userAgent,
    videoId: video.videoId,
  });

  console.log("[11/15] 申请 ImageX 封面上传节点");
  const imageNode = await applyImageUpload(credentials);
  console.log("[12/15] 上传封面二进制");
  await uploadCoverBinary(imageNode, options.coverPath);
  console.log("[13/15] 提交 ImageX 上传会话");
  const imageUri = await commitImageUpload(credentials, imageNode);
  console.log("[14/15] 获取封面访问 URL");
  const coverUrl = await getImageUrl({
    commonParams,
    cookieHeader,
    uri: imageUri,
    userAgent: profile.userAgent,
  });
  console.log("[15/15] 搜索文案话题");
  const topics = await searchTopics({ commonParams, cookieHeader, text, userAgent: profile.userAgent });

  const uploaded: UploadedCover = { coverUrl, uri: imageUri };
  assert(uploaded.uri);
  console.log(`上传验证成功：视频、封面和 ${topics.length} 个匹配话题已完成发布前准备。`);
  console.log("未计算 a_bogus，未调用 create_v2，作品尚未正式发布。");
}

/**
 * 解析命令行路径参数，默认使用仓库 assets 中的抖音 Demo 素材。
 *
 * @returns 运行选项；显示帮助时返回 undefined
 */
function parseCliOptions(): CliOptions | undefined {
  const parsed = parseArgs({
    allowPositionals: false,
    options: {
      cookies: { type: "string" },
      cover: { type: "string" },
      help: { short: "h", type: "boolean" },
      text: { type: "string" },
      video: { type: "string" },
    },
    strict: true,
  });
  if (parsed.values.help) {
    printHelp();
    return undefined;
  }

  return {
    cookiesPath: parsed.values.cookies ?? join(REPOSITORY_ROOT, "assets/124_douyin.json"),
    coverPath: parsed.values.cover ?? join(REPOSITORY_ROOT, "assets/demo.png"),
    textPath: parsed.values.text ?? join(REPOSITORY_ROOT, "assets/demo.txt"),
    videoPath: parsed.values.video ?? join(REPOSITORY_ROOT, "assets/demo.mp4"),
  };
}

/**
 * 输出抖音 Demo 命令行说明和真实上传警告。
 */
function printHelp(): void {
  console.log(`Douyin 视频上传 Demo

用法：npm run example:douyin -- [选项]

  --cookies <path>   Playwright storage-state JSON
  --video <path>     视频文件
  --cover <path>     封面文件
  --text <path>      包含可选 #话题 的 UTF-8 文案
  -h, --help         显示帮助

默认命令会真实执行第 1～15 步，在抖音远端留下未发布的视频和封面素材。
当前版本不会计算 a_bogus，也不会调用 create_v2 正式发布。
`);
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
 * 判断当前模块是否由命令行直接执行。
 *
 * @returns 直接执行时返回 true
 */
function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  const options = parseCliOptions();
  if (options) {
    runUpload(options).catch((error: unknown) => {
      console.error(`执行失败：${formatError(error)}`);
      process.exitCode = 1;
    });
  }
}
