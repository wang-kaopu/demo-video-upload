import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCookieContext,
  buildPublishPayload,
  createChunkDescriptors,
  createCoverDataUri,
  extractVideoKey,
  parsePublicationText,
} from "./bilibili-upload.js";

const REPOSITORY_ROOT = join(import.meta.dirname, "..");

/**
 * 验证 Cookie 解析会过滤非 B 站与已过期凭证，并提取 CSRF。
 */
test("buildCookieContext filters cookies and extracts bili_jct", () => {
  const context = buildCookieContext(
    [
      { domain: ".bilibili.com", expires: 2_000, name: "SESSDATA", path: "/", value: "session" },
      { domain: ".bilibili.com", expires: 2_000, name: "bili_jct", path: "/", value: "csrf" },
      { domain: ".bilibili.com", expires: 500, name: "expired", path: "/", value: "old" },
      { domain: ".example.com", expires: 2_000, name: "foreign", path: "/", value: "ignored" },
    ],
    1_000,
  );

  assert.equal(context.csrf, "csrf");
  assert.equal(context.header, "SESSDATA=session; bili_jct=csrf");
});

/**
 * 验证 Demo 文案按首行和井号话题生成投稿字段。
 */
test("parsePublicationText maps title, description, dynamic and tags", () => {
  const result = parsePublicationText("一个标题\n#标签一 #标签二 #标签一\n");

  assert.equal(result.title, "一个标题");
  assert.equal(result.dynamic, "一个标题");
  assert.equal(result.description, "一个标题\n#标签一 #标签二 #标签一");
  assert.deepEqual(result.tags, ["标签一", "标签二"]);
});

/**
 * 验证整分片和尾分片都使用正确的半开字节区间。
 */
test("createChunkDescriptors handles exact and partial chunks", () => {
  assert.deepEqual(createChunkDescriptors(20, 10), [
    { end: 10, index: 0, partNumber: 1, size: 10, start: 0 },
    { end: 20, index: 1, partNumber: 2, size: 10, start: 10 },
  ]);
  assert.deepEqual(createChunkDescriptors(21, 10).at(-1), {
    end: 21,
    index: 2,
    partNumber: 3,
    size: 1,
    start: 20,
  });
});

/**
 * 验证 multipart key 会转换成投稿接口需要的视频 filename。
 */
test("extractVideoKey removes leading slash and extension", () => {
  assert.equal(extractVideoKey("/ugcfx/example.mp4"), "ugcfx/example");
});

/**
 * 验证扩展名为 PNG、实际为 JPEG 的 Demo 封面按真实类型编码。
 */
test("createCoverDataUri detects the real JPEG content", async () => {
  const cover = await readFile(join(REPOSITORY_ROOT, "assets/demo.png"));
  const dataUri = await createCoverDataUri(cover);
  assert.match(dataUri, /^data:image\/jpeg;base64,/u);
});

/**
 * 验证新分区 ID 与旧 tid 分别写入最终投稿参数。
 */
test("buildPublishPayload keeps human_type2 separate from tid", () => {
  const payload = buildPublishPayload({
    coverUrl: "https://example.test/cover.jpg",
    humanTypeId: 123,
    publication: {
      description: "简介",
      dynamic: "动态",
      tags: ["标签"],
      title: "标题",
    },
    upload: {
      auth: "secret",
      bizId: 456,
      uploadId: "upload",
      uploadUrl: "https://example.test/upload",
      videoKey: "ugc/video",
    },
  });

  assert.equal(payload.human_type2, 123);
  assert.equal(payload.tid, 221);
  assert.equal(payload.tag, "标签");
});
