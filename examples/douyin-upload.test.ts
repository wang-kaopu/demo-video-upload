import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublishPayload,
  getVisibilityValue,
  parsePublishText,
  serializeQuery,
} from "./douyin-publish.js";
import {
  buildCommonParams,
  calculateCrc32,
  createChunkDescriptors,
  createMachineProfile,
  extractTopicNames,
} from "./douyin-runtime-core.js";
import { parseCliOptions } from "./douyin-upload.js";

/**
 * 验证操作系统检测只生成 macOS/Windows 内部一致配置。
 */
test("createMachineProfile selects a matching platform and UA", () => {
  const mac = createMachineProfile("darwin");
  const windows = createMachineProfile("win32");

  assert.equal(mac.platform, "MacIntel");
  assert.match(mac.userAgent, /Macintosh/u);
  assert.equal(windows.platform, "Win32");
  assert.match(windows.userAgent, /Windows NT/u);
  assert.throws(() => createMachineProfile("linux"), /不支持/u);
});

/**
 * 验证公共参数完全从选中的设备配置派生。
 */
test("buildCommonParams derives browser fields from the selected profile", () => {
  const params = buildCommonParams(createMachineProfile("darwin"));

  assert.deepEqual(Object.keys(params), [
    "cookie_enabled",
    "screen_width",
    "screen_height",
    "browser_language",
    "browser_platform",
    "browser_name",
    "browser_version",
    "browser_online",
    "timezone_name",
    "aid",
    "support_h265",
  ]);
  assert.equal(params.browser_name, "Mozilla");
  assert.match(params.browser_version, /^5\.0 \(Macintosh/u);
  assert.equal(params.browser_platform, "MacIntel");
  assert.equal(params.screen_width, 1920);
});

/**
 * 验证普通 Query 保持插入顺序并只编码一次原始 msToken。
 */
test("serializeQuery encodes a raw msToken exactly once", () => {
  assert.equal(
    serializeQuery({ first: 1, msToken: "raw token/%", empty: "", skip: undefined }),
    "first=1&msToken=raw%20token%2F%25&empty=",
  );
});

/**
 * 验证恰好 5 MiB 是单分片，多一个字节才进入 multipart。
 */
test("createChunkDescriptors uses the recovered 5 MiB boundary", () => {
  const fiveMiB = 5 * 1024 * 1024;
  assert.equal(createChunkDescriptors(fiveMiB).length, 1);
  assert.deepEqual(createChunkDescriptors(fiveMiB + 1), [
    { end: fiveMiB, partNumber: 1, size: fiveMiB, start: 0 },
    { end: fiveMiB + 1, partNumber: 2, size: 1, start: fiveMiB },
  ]);
});

/**
 * 验证 crc-32@1.2.2 使用标准 CRC-32/IEEE 小写十六进制结果。
 */
test("calculateCrc32 matches the standard CRC-32/IEEE vector", () => {
  assert.equal(calculateCrc32(Buffer.from("123456789", "ascii")), "cbf43926");
});

/**
 * 验证话题提取去重并限制为前五个。
 */
test("extractTopicNames returns at most five unique hashtags", () => {
  assert.deepEqual(
    extractTopicNames("正文 #一 #二 #一 #三 #四 #五 #六"),
    ["一", "二", "三", "四", "五"],
  );
});

/**
 * 验证首个非空行是标题，并且后续行保持为描述。
 */
test("parsePublishText separates title and description", () => {
  assert.deepEqual(parsePublishText("\n演示标题\n第一行\n第二行 #话题\n"), {
    description: "第一行\n第二行 #话题",
    title: "演示标题",
  });
  assert.throws(() => parsePublishText("这是一个超过二十个汉字的标题用于触发明确校验错误"), /20/u);
});

/**
 * 验证发布 Payload 使用已恢复的可见性枚举和结构化话题。
 */
test("buildPublishPayload creates a self-visible create_v2 body", () => {
  const payload = buildPublishPayload({
    coverHeight: 1280,
    coverUri: "cover-uri",
    coverUrl: "https://example.test/cover.png",
    coverWidth: 720,
    description: "描述 #演示",
    now: 1_700_000_000_000,
    title: "标题",
    topics: [{ id: "123", name: "演示" }],
    videoId: "video-id",
    visibility: "self",
  });
  const common = (payload.item as { common: Record<string, unknown> }).common;

  assert.equal(common.visibility_type, 1);
  assert.equal(common.video_id, "video-id");
  assert.match(String(common.text), /#演示/u);
  assert.equal(getVisibilityValue("public"), 0);
  assert.equal(getVisibilityValue("friends"), 2);
});

/**
 * 验证 CLI 强制选择 partition，默认不发布且仅自己可见。
 */
test("parseCliOptions requires a numeric partition and safe defaults", () => {
  assert.throws(() => parseCliOptions([]), /source-partition/u);
  assert.throws(() => parseCliOptions(["--source-partition", "abc"]), /纯数字/u);

  const options = parseCliOptions(["--source-partition", "1783645517194"]);
  assert.equal(options?.sourcePartition, "1783645517194");
  assert.equal(options?.upload, false);
  assert.equal(options?.visibility, "self");
});
