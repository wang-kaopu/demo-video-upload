import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeV4QueryComponent,
  formatAmzDate,
  serializeV4Query,
  signDouyinV4,
} from "./douyin-signature.js";

/**
 * 验证 V4 Query 使用 RFC3986 编码、字典序和重复数组键。
 */
test("serializeV4Query follows recovered canonical ordering", () => {
  assert.equal(escapeV4QueryComponent("a b!*"), "a%20b%21%2A");
  assert.equal(
    serializeV4Query({ z: ["b", "a"], empty: "", skip: undefined, Action: "Apply Upload" }),
    "Action=Apply%20Upload&empty=&z=a&z=b",
  );
});

/**
 * 验证 UTC 时间会转换成原包的 X-Amz-Date 格式。
 */
test("formatAmzDate removes separators and milliseconds", () => {
  assert.equal(formatAmzDate(new Date("2026-07-10T03:04:05.678Z")), "20260710T030405Z");
});

/**
 * 固定全部签名输入，验证 CanonicalRequest、SignedHeaders 和最终签名不会漂移。
 */
test("signDouyinV4 matches the fixed recovered-variant vector", () => {
  const result = signDouyinV4({
    accessKeyId: "AKIDEXAMPLE",
    amzDate: "20260710T030405Z",
    headers: {
      Origin: "https://creator.douyin.com",
      "X-Amz-Date": "20260710T030405Z",
      "X-Amz-Security-Token": "session-token",
    },
    method: "GET",
    query: {
      Action: "ApplyUploadInner",
      FileSize: 988559,
      FileType: "video",
      IsInner: 1,
      SpaceName: "aweme",
      Version: "2020-11-19",
      app_id: 2906,
      s: "fixed-random",
      user_id: "123456",
    },
    region: "cn-north-1",
    secretAccessKey: "SECRETEXAMPLE",
    serviceName: "vod",
  });

  assert.equal(
    result.canonicalQuery,
    "Action=ApplyUploadInner&FileSize=988559&FileType=video&IsInner=1&SpaceName=aweme&" +
      "Version=2020-11-19&app_id=2906&s=fixed-random&user_id=123456",
  );
  assert.equal(result.signedHeaders, "x-amz-date;x-amz-security-token");
  assert.equal(result.signature, "896b5080f3ead063980d7e4ddd5e75fc0f5a250f370fdf6e462500a4be054254");
});

/**
 * 验证 POST Commit 会把固定 Body 摘要和 content hash Header 同时签入。
 */
test("signDouyinV4 signs the exact POST body string", () => {
  const bodyText = '{"SessionKey":"session","Functions":[{"name":"GetMeta"}]}';
  const contentHash = "cc7b16e00553f488109d15770b1c305c57f4069c790fbb197f62ed075d3e0766";
  const result = signDouyinV4({
    accessKeyId: "AKIDEXAMPLE",
    amzDate: "20260710T030405Z",
    bodyText,
    headers: {
      "X-Amz-Content-Sha256": contentHash,
      "X-Amz-Date": "20260710T030405Z",
      "X-Amz-Security-Token": "session-token",
    },
    method: "POST",
    needSignHeaderKeys: ["x-amz-content-sha256"],
    query: { Action: "CommitUploadInner", Version: "2020-11-19" },
    region: "cn-north-1",
    secretAccessKey: "SECRETEXAMPLE",
    serviceName: "vod",
  });

  assert.equal(result.payloadHash, contentHash);
  assert.equal(
    result.signedHeaders,
    "x-amz-content-sha256;x-amz-date;x-amz-security-token",
  );
});
