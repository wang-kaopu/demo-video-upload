import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDouyinProtocolVersion,
  DOUYIN_SERVICE_PROTOCOL_VERSION,
  DouyinVideo,
} from "./douyin-video.js";
import type { Logger } from "./logger.js";

const SILENT_LOGGER: Logger = { log: () => undefined };

test("assertDouyinProtocolVersion rejects a stale worker build", () => {
  assert.doesNotThrow(() => assertDouyinProtocolVersion(DOUYIN_SERVICE_PROTOCOL_VERSION));
  assert.throws(() => assertDouyinProtocolVersion(DOUYIN_SERVICE_PROTOCOL_VERSION + 1), /协议版本不一致/u);
});

test("DouyinVideo reports missing worker artifacts before network access", async () => {
  const video = new DouyinVideo(
    {
      coverPath: "/missing/cover.png",
      electronMainPath: "/missing/douyin-main.mjs",
      electronRendererPath: "/missing/douyin-renderer.js",
      profileRoot: "/missing/profile",
      sourcePartition: "123",
      textPath: "/missing/text.txt",
      videoPath: "/missing/video.mp4",
    },
    { logger: SILENT_LOGGER },
  );
  await assert.rejects(video.prepare(), /请先执行 npm run build:service/u);
});
