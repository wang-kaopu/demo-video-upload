import { createHash, createHmac } from "node:crypto";

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
