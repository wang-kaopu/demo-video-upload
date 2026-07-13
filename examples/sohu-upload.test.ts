import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAuthKey,
  createPublishPayload,
  createVideoChunks,
  parseCliOptions,
  parsePublicationText,
} from "./sohu-upload.js";

test("createAuthKey 按搜狐号前端算法生成校验串", () => {
  const timestamp = 1_783_905_385_012;
  const authKey = createAuthKey("122735987", timestamp);
  assert.match(authKey, new RegExp(`^${timestamp}_[a-f0-9]{32}$`));
});

test("createVideoChunks 使用 512 KiB 且从 1 开始编号", () => {
  assert.deepEqual(createVideoChunks(512 * 1024 + 3), [
    { end: 512 * 1024, partNumber: 1, start: 0 },
    { end: 512 * 1024 + 3, partNumber: 2, start: 512 * 1024 },
  ]);
});

test("parsePublicationText 使用首行标题和完整非空文案", () => {
  assert.deepEqual(parsePublicationText("这是一个测试标题\n第二行简介"), {
    description: "这是一个测试标题\n第二行简介",
    title: "这是一个测试标题",
  });
});

test("createPublishPayload 保留搜狐号发布字段的安全默认值", () => {
  const payload = createPublishPayload({
    accountId: "1",
    channelId: 10,
    cover: "//example.test/cover.jpg",
    description: "测试视频简介",
    title: "测试视频标题",
    videoChannelId: 20,
    videoHtml: '<embed bid="2" />',
    videoId: "2",
  });
  assert.equal(payload.id, 0);
  assert.equal(payload.infoResource, 0);
  assert.equal(payload.userColumnId, 0);
  assert.deepEqual(payload.topicIds, []);
  assert.equal(payload.userLabels, "[]");
});

test("parseCliOptions 默认真实上传但不发布", () => {
  const options = parseCliOptions([]);
  assert.equal(options.publish, false);
  assert.equal(options.publishPayloadPath, undefined);
  assert.match(options.cookiesPath, /assets\/133_sohu\.json$/);
  assert.match(options.payloadOutputPath, /assets\/sohu-publish-payload\.json$/);
  assert.match(options.videoPath, /assets\/demo\.mp4$/);
});

test("parseCliOptions 拒绝两种最终发布模式同时启用", () => {
  assert.throws(
    () => parseCliOptions(["--publish", "--publish-payload", "payload.json"]),
    /不能同时使用/,
  );
});
