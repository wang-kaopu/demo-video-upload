import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  buildBaijiahaoCookieHeader,
  buildPublishPayload,
  generateCovers,
  inspectMp4,
  parseCliOptions,
  parsePublicationText,
  resolveTopicsInOrder,
  retryVideoChunk,
  runChunkPool,
  serializeHttpValue,
  serializePublishPayload,
  splitVideoChunks,
  type BaijiahaoTopic,
  type PublishPayloadInput,
} from "./baijiahao-upload.js";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_IMAGE_EDIT_POINT =
  '[{"img_type":"cover","img_num":{"template":0,"font":0,"filter":0,"paster":0,"cut":0,"any":0}},{"img_type":"body","img_num":{"template":0,"font":0,"filter":0,"paster":0,"cut":0,"any":0}}]';

/**
 * 构造横竖版 Payload 测试共享的输入。
 *
 * @returns 一组固定的已上传资源和媒体元数据
 */
function createPayloadInput(): PublishPayloadInput {
  return {
    description: "处理后的描述",
    duration: 3.01,
    height: 720,
    horizontalCoverUrl: "https://img.example/horizontal.jpg",
    mediaId: "media-1",
    size: 1234,
    title: "首行标题",
    topic: {
      id: "topic-1",
      sv_small_images: { https: "https://img.example/topic.jpg" },
      title: "测试话题",
    },
    verticalCoverOriginalUrl: "http://img.example/vertical-original.jpg",
    verticalCoverUrl: "https://img.example/vertical.jpg",
    videoName: "demo.mp4",
    videoType: "horizontal",
    width: 1280,
  };
}

test("buildBaijiahaoCookieHeader preserves every valid Baidu cookie in source order", () => {
  const header = buildBaijiahaoCookieHeader(
    [
      { domain: ".baidu.com", expires: -1, name: "BDUSS", path: "/", value: "parent" },
      { domain: "passport.baidu.com", expires: 2_000, name: "PASS", path: "/", value: "passport" },
      { domain: ".baijiahao.baidu.com", expires: 2_000, name: "same", path: "/", value: "first" },
      { domain: ".baijiahao.baidu.com", expires: 2_000, name: "same", path: "/builder", value: "second" },
      { domain: ".baidu.com", expires: 500, name: "expired", path: "/", value: "old" },
      { domain: ".baidu.com", expires: 2_000, name: "empty", path: "/", value: "" },
      { domain: ".example.com", expires: 2_000, name: "foreign", path: "/", value: "ignored" },
    ],
    1_000,
  );
  assert.equal(header, "BDUSS=parent; PASS=passport; same=first; same=second");
});

test("buildBaijiahaoCookieHeader rejects storage-state without usable Baidu cookies", () => {
  assert.throws(
    () =>
      buildBaijiahaoCookieHeader(
        [{ domain: ".example.com", expires: -1, name: "session", path: "/", value: "foreign" }],
        1_000,
      ),
    /没有可用的 baidu\.com Cookie/u,
  );
});

test("parsePublicationText maps the first non-empty line and removes deduplicated hashtags", () => {
  const publication = parsePublicationText("\n  首行标题  \n正文内容 #话题 #话题\n#第二\n");
  assert.deepEqual(publication, {
    description: "正文内容",
    title: "首行标题",
    topicNames: ["话题", "第二"],
  });
});

test("parsePublicationText falls back to title when removing hashtags empties description", () => {
  assert.deepEqual(parsePublicationText("标题\n#一个 #两个"), {
    description: "标题",
    title: "标题",
    topicNames: ["一个", "两个"],
  });
});

test("splitVideoChunks uses exact 2 MiB boundaries and a final tail", () => {
  assert.deepEqual(splitVideoChunks(5, 2), [
    { end: 2, index: 0, partNumber: 1, size: 2, start: 0 },
    { end: 4, index: 1, partNumber: 2, size: 2, start: 2 },
    { end: 5, index: 2, partNumber: 3, size: 1, start: 4 },
  ]);
  assert.equal(splitVideoChunks(4, 2).length, 2);
});

test("runChunkPool never exceeds the requested concurrency", async () => {
  const chunks = splitVideoChunks(8, 1);
  let active = 0;
  let maximum = 0;
  await runChunkPool(
    chunks,
    async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      active -= 1;
    },
    3,
  );
  assert.equal(maximum, 3);
});

test("runChunkPool waits for queued work before surfacing the first failure", async () => {
  const chunks = splitVideoChunks(3, 1);
  const completed: number[] = [];
  await assert.rejects(
    runChunkPool(chunks, async (chunk) => {
      if (chunk.index === 0) throw new Error("first failed");
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      completed.push(chunk.index);
    }),
    /first failed/u,
  );
  assert.deepEqual(completed, [1, 2]);
});

test("retryVideoChunk performs four attempts with exact 1/2/4 second waits", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retryVideoChunk(
    () => {
      attempts += 1;
      if (attempts < 4) return Promise.reject(new Error("retry"));
      return Promise.resolve("ok");
    },
    (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test("inspectMp4 reads duration and dimensions from the demo MP4", async () => {
  const metadata = await inspectMp4(join(REPOSITORY_ROOT, "assets/demo.mp4"));
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 720);
  assert.equal(metadata.videoType, "horizontal");
  assert.ok(metadata.duration > 3 && metadata.duration < 4);
  assert.ok(metadata.size > 0);
});

test("generateCovers produces fixed JPEG dimensions from one source file", async () => {
  const covers = await generateCovers(join(REPOSITORY_ROOT, "assets/demo.png"));
  const [horizontal, vertical] = await Promise.all([sharp(covers.horizontal).metadata(), sharp(covers.vertical).metadata()]);
  assert.deepEqual(
    { format: horizontal.format, height: horizontal.height, width: horizontal.width },
    { format: "jpeg", height: 720, width: 1280 },
  );
  assert.deepEqual(
    { format: vertical.format, height: vertical.height, width: vertical.width },
    { format: "jpeg", height: 1440, width: 1080 },
  );
});

test("resolveTopicsInOrder ignores failures and selects by original hashtag order", async () => {
  const lookup = async (name: string): Promise<BaijiahaoTopic | undefined> => {
    if (name === "失败") throw new Error("network");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, name === "第一" ? 10 : 1));
    return { id: name, title: name };
  };
  const topic = await resolveTopicsInOrder(["失败", "第一", "第二"], lookup);
  assert.deepEqual(topic, { id: "第一", title: "第一" });
});

test("buildPublishPayload matches the complete recovered horizontal payload", () => {
  const payload = buildPublishPayload(createPayloadInput());
  assert.deepEqual(payload, {
    type: "video",
    title: "处理后的描述",
    vertical_cover: "https://img.example/vertical.jpg",
    desc: "处理后的描述",
    bjhtopic_id: "topic-1",
    bjhtopic_info: [
      {
        id: "topic-1",
        title: "测试话题",
        guide: "",
        cover: "https://img.example/topic.jpg",
      },
    ],
    cover_image_source: {
      wide_cover_image_source: "video_cut",
      vertical_cover_image_source: "video_cut",
    },
    ducut_info: "",
    content:
      '[{"title":"首行标题","mediaId":"media-1","videoName":"demo.mp4","local":1,"desc":"处理后的描述"}]',
    video_duration: 4,
    nryx_mount_list: "",
    activity_list: [{ id: "aigc_bjh_status", is_checked: 0 }],
    source_reprinted_allow: 0,
    is_auto_optimize_cover: 1,
    bjh_video_finger_printing: '{"s2l":null,"s2game":null,"bjh":{"duration":4}}',
    fe_from: "BJH_CMS_PC",
    auto_mount_goods: 0,
    is_consultant_card: 0,
    usingImgFilter: false,
    cover_layout: "one",
    cover_images:
      '[{"src":"https://img.example/horizontal.jpg","isLegal":0,"cover_source_tag":"video_cut"}]',
    _cover_images_map: "[]",
    cover_source: "upload",
    clue: "",
    bjhmt: "",
    order_id: "",
    BJH_FE_NOUNCE: "",
    aigc_rebuild: "",
    pub_source_from: "pc_faburukou",
    image_edit_point: EXPECTED_IMAGE_EDIT_POINT,
    publish_statement: 0,
    publish_statement_sub: 0,
  });
});

test("buildPublishPayload matches the complete recovered vertical payload", () => {
  const payload = buildPublishPayload({
    ...createPayloadInput(),
    height: 1920,
    videoType: "vertical",
    width: 1080,
  });
  assert.deepEqual(payload, {
    type: "ugc_video",
    title: "处理后的描述",
    bjhtopic_id: "topic-1",
    bjhtopic_info: [
      {
        id: "topic-1",
        sv_small_images: { https: "https://img.example/topic.jpg" },
        title: "测试话题",
      },
    ],
    cover_image_source: {
      wide_cover_image_source: "video_cut",
      vertical_cover_image_source: "video_cut",
    },
    ducut_info: "",
    content: '[{"title":"首行标题","mediaId":"media-1"}]',
    video_duration: 4,
    nryx_mount_list: "",
    vertical_cover_images:
      '[{"content_original":"http://img.example/vertical-original.jpg","src":"https://img.example/vertical.jpg","cropData":{"x":0,"y":0,"width":1080,"height":1440},"isLegal":0,"cover_source_tag":"video_cut"}]',
    size: 1234,
    width_in_pixel: 1080,
    height_in_pixel: 1920,
    cover_layout: "one",
    cover_images:
      '[{"source":"local","src":"https://img.example/vertical.jpg","cropData":{"x":0,"y":0,"width":1080,"height":1440},"isLegal":0,"cover_source_tag":"video_cut"}]',
    _cover_images_map:
      '[{"src":"https://img.example/vertical.jpg","origin_src":"http://img.example/vertical-original.jpg"}]',
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
    image_edit_point: EXPECTED_IMAGE_EDIT_POINT,
    publish_statement: 0,
    publish_statement_sub: 0,
    bjh_video_finger_printing: '{"s2l":null,"s2game":null,"bjh":{"duration":4}}',
  });
  assert.equal(Object.hasOwn(payload, "usingImgFilter"), false);
});

test("buildPublishPayload preserves empty topic fields when no topic matches", () => {
  const input = createPayloadInput();
  delete input.topic;
  const horizontal = buildPublishPayload(input);
  const vertical = buildPublishPayload({ ...input, height: 1920, videoType: "vertical", width: 1080 });
  for (const payload of [horizontal, vertical]) {
    assert.equal(payload.bjhtopic_id, "");
    assert.equal(payload.bjhtopic_info, "");
    const bodyText = serializePublishPayload(payload);
    assert.match(bodyText, /(?:^|&)bjhtopic_id=&bjhtopic_info=(?:&|$)/u);
  }
});

test("serializePublishPayload matches the fixed bracket-notation wire vector", () => {
  const bodyText = serializePublishPayload({
    cover_image_source: { wide_cover_image_source: "video_cut" },
    activity_list: [{ id: "aigc_bjh_status", is_checked: 0 }],
    bjhtopic_info: [{ id: "topic-1" }],
    content: '[{"title":"title"}]',
    cover_images: '[{"src":"cover"}]',
  });
  assert.equal(
    bodyText,
    "cover_image_source%5Bwide_cover_image_source%5D=video_cut&" +
      "activity_list%5B0%5D%5Bid%5D=aigc_bjh_status&" +
      "activity_list%5B0%5D%5Bis_checked%5D=0&" +
      "bjhtopic_info%5B0%5D%5Bid%5D=topic-1&" +
      "content=%5B%7B%22title%22%3A%22title%22%7D%5D&" +
      "cover_images=%5B%7B%22src%22%3A%22cover%22%7D%5D",
  );
  assert.doesNotMatch(bodyText, /cover_image_source=%7B/u);
  assert.doesNotMatch(bodyText, /activity_list=%5B/u);
  assert.doesNotMatch(bodyText, /bjhtopic_info=%5B/u);
});

test("serializeHttpValue limits binary Base64 logs to 100 characters", async () => {
  const serialized = (await serializeHttpValue(Buffer.alloc(120, 255))) as Record<string, unknown>;
  assert.equal(String(serialized.base64).length, 100);
  assert.equal(serialized.base64Length, 160);
  assert.equal(serialized.base64Truncated, true);
  assert.equal(serialized.omittedCharacters, 60);
  assert.equal(serialized.byteLength, 120);
});

test("serializeHttpValue also limits the cover Base64 form field", async () => {
  const form = new FormData();
  form.append("base64", "a".repeat(160));
  const serialized = (await serializeHttpValue(form)) as {
    entries: Array<{ name: string; value: Record<string, unknown> }>;
  };
  assert.equal(String(serialized.entries[0]?.value.base64).length, 100);
  assert.equal(serialized.entries[0]?.value.omittedCharacters, 60);
});

test("parseCliOptions defaults to repository assets and leaves final publish disabled", () => {
  const options = parseCliOptions([]);
  assert.ok(options);
  assert.equal(options.upload, false);
  assert.equal(options.cookiesPath, join(REPOSITORY_ROOT, "assets/125_baijiahao.json"));
  assert.equal(options.videoPath, join(REPOSITORY_ROOT, "assets/demo.mp4"));
  assert.equal(options.coverPath, join(REPOSITORY_ROOT, "assets/demo.png"));
  assert.equal(options.textPath, join(REPOSITORY_ROOT, "assets/demo.txt"));
});
