import assert from "node:assert/strict";
import { open, readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import axios, { AxiosHeaders, type AxiosInstance } from "axios";
import { ipcRenderer } from "electron";
import pLimit from "p-limit";

import {
  formatAmzDate,
  type DouyinV4SignatureInput,
  type DouyinV4SignatureResult,
  type SignatureQueryValue,
} from "./douyin-signature.js";
import {
  buildPublishPayload,
  parsePublishText,
  serializeQuery,
  type DouyinVisibility,
} from "./douyin-publish.js";
import {
  buildCommonParams,
  calculateCrc32,
  createChunkDescriptors,
  createMachineProfile,
  extractTopicNames,
  type ChunkDescriptor,
  type CommonParams,
} from "./douyin-runtime-core.js";

const CREATOR_ORIGIN = "https://creator.douyin.com";
const CREATOR_REFERER = `${CREATOR_ORIGIN}/creator-micro/content/publish?enter_from=publish_page`;
const VOD_ENDPOINT = "https://vod.bytedanceapi.com/";
const IMAGEX_ENDPOINT = "https://imagex.bytedanceapi.com";
const CHUNK_CONCURRENCY = 3;
const REQUEST_TIMEOUT = 10 * 60 * 1000;
const HTTP = createHttpClient();

interface TopicMatch {
  id: string;
  name: string;
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

interface MultipartPartResult {
  crc32: string;
  part_number: number;
}

interface CliOptions {
  coverPath: string;
  publish: boolean;
  textPath: string;
  videoPath: string;
  visibility: DouyinVisibility;
}

interface SessionState {
  cookieHeader: string;
  msToken: string;
}

interface CreateV2SigningResult {
  signedUrl: string;
  ticketHeaders: Record<string, string>;
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
  const client = axios.create({
    adapter: "xhr",
    maxBodyLength: Number.POSITIVE_INFINITY,
    maxContentLength: Number.POSITIVE_INFINITY,
    timeout: REQUEST_TIMEOUT,
  });
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
  return ipcRenderer.invoke("douyin:sign-v4", input) as Promise<DouyinV4SignatureResult>;
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

/**
 * 完成视频和封面上传，使用官方 BDMS 生成签名，并按开关决定是否提交作品。
 *
 * @param options - 素材、可见性和正式发布开关
 */
async function runUpload(options: CliOptions): Promise<void> {
  const profile = createMachineProfile();
  const commonParams = buildCommonParams(profile);
  const state = await ipcRenderer.invoke("douyin:get-session-state") as SessionState;
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

  console.log("[1/17] 获取 CSRF Token");
  const csrfToken = await getCsrfToken(cookieHeader, profile.userAgent);
  console.log("[2/17] 获取账号信息");
  const uid = await getAccountUid(cookieHeader, msToken, profile.userAgent);
  console.log("[3/17] 获取 VOD/ImageX 临时密钥");
  const credentials = await getUploadCredentials({
    commonParams,
    cookieHeader,
    csrfToken,
    msToken,
    userAgent: profile.userAgent,
  });

  console.log("[4/17] 申请视频上传节点");
  const videoNode = await applyVideoUpload({ credentials, fileSize: videoInfo.size, uid });
  const videoUploadUrl = buildBinaryUploadUrl(videoNode);
  const descriptors = createChunkDescriptors(videoInfo.size);
  let uploadId: string | undefined;
  if (descriptors.length > 1) {
    console.log("[5/17] 初始化 multipart 视频上传");
    const store = videoNode.StoreInfos[0];
    assert(store);
    uploadId = await initializeMultipart(videoUploadUrl, {
      Authorization: store.Auth,
      Host: videoNode.UploadHost,
      "X-Storage-U": uid,
    });
  } else {
    console.log("[5/17] 视频不超过 5 MiB，跳过 multipart 初始化");
  }
  console.log(`[6/17] 上传 ${descriptors.length} 个视频分片（并发 ${CHUNK_CONCURRENCY}）`);
  await uploadVideoChunks({
    descriptors,
    node: videoNode,
    uid,
    ...(uploadId ? { uploadId } : {}),
    uploadUrl: videoUploadUrl,
    videoPath: options.videoPath,
  });
  console.log(uploadId ? "[7/17] multipart 视频已完成合并" : "[7/17] 单分片视频无需 finish");

  console.log("[8/17] 提交 VOD 上传会话");
  const video = await commitVideoUpload({ credentials, node: videoNode, uid });
  console.log("[9/17] 调用 video/enable");
  console.log("[10/17] 调用 video/transend");
  await verifyVideo({
    commonParams,
    cookieHeader,
    csrfToken,
    msToken,
    userAgent: profile.userAgent,
    videoId: video.videoId,
  });

  console.log("[11/17] 申请 ImageX 封面上传节点");
  const imageNode = await applyImageUpload(credentials);
  console.log("[12/17] 上传封面二进制");
  await uploadCoverBinary(imageNode, options.coverPath);
  console.log("[13/17] 提交 ImageX 上传会话");
  const imageUri = await commitImageUpload(credentials, imageNode);
  console.log("[14/17] 获取封面访问 URL");
  const coverUrl = await getImageUrl({
    commonParams,
    cookieHeader,
    uri: imageUri,
    userAgent: profile.userAgent,
  });
  console.log("[15/17] 搜索文案话题");
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

  console.log("[16/17] 使用 Creator 官方 BDMS 生成 a_bogus");
  const signed = await ipcRenderer.invoke("douyin:sign-create-v2", {
    bodyText,
    csrfToken,
    unsignedUrl,
  }) as CreateV2SigningResult;

  if (!options.publish) {
    console.log("签名验证成功；未传 --publish，未调用 create_v2，作品尚未正式发布。");
    return;
  }

  console.log(`[17/17] 提交发布（可见性：${options.visibility}）`);
  const response = await HTTP.post(signed.signedUrl, bodyText, {
    headers: {
      ...signed.ticketHeaders,
      Cookie: cookieHeader,
      "Content-Type": "application/json",
      Referer: CREATOR_REFERER,
      "User-Agent": profile.userAgent,
      "X-Secsdk-Csrf-Token": csrfToken,
    },
    transformRequest: [() => bodyText],
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
  console.log(`发布成功，作品 ID：${result.item_id}`);
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
 * 从主进程读取配置并向主进程报告最终状态。
 */
async function start(): Promise<void> {
  try {
    const options = await ipcRenderer.invoke("douyin:get-options") as CliOptions;
    await runUpload(options);
    ipcRenderer.send("douyin:complete", { success: true });
  } catch (error) {
    ipcRenderer.send("douyin:complete", { message: formatError(error), success: false });
  }
}

void start();
