import assert from "node:assert/strict";
import test from "node:test";

import { BaijiahaoVideo } from "./baijiahao-video.js";
import { BilibiliVideo, getBilibiliHumanTypes } from "./bilibili-video.js";
import { DouyinVideo } from "./douyin-video.js";
import type { Logger } from "./logger.js";
import { createVideo, runVideo, type Video } from "./video.js";

const SILENT_LOGGER: Logger = { log: () => undefined };

/** 测试用视频实例，记录统一编排的调用顺序。 */
class RecordingVideo implements Video<string, string> {
  public readonly calls: string[] = [];

  /** 返回准备结果。 */
  public prepare(): Promise<string> {
    this.calls.push("prepare");
    return Promise.resolve("prepared");
  }

  /** 返回发布结果。 */
  public publish(prepared: string): Promise<string> {
    this.calls.push(`publish:${prepared}`);
    return Promise.resolve("published");
  }

  /** 记录资源释放。 */
  public dispose(): Promise<void> {
    this.calls.push("dispose");
    return Promise.resolve();
  }
}

test("createVideo selects the concrete product from videoType", () => {
  const common = {
    coverPath: "cover.png",
    textPath: "text.txt",
    videoPath: "video.mp4",
  };
  const dependencies = { logger: SILENT_LOGGER };
  assert.ok(createVideo({ ...common, cookiesPath: "bili.json", humanTypeId: 1, videoType: "bilibili" }, dependencies) instanceof BilibiliVideo);
  assert.ok(createVideo({
    ...common,
    profileRoot: "douyin-profile",
    sourcePartition: "123",
    videoType: "douyin",
  }, dependencies) instanceof DouyinVideo);
  assert.ok(createVideo({ ...common, cookiesPath: "baijiahao.json", videoType: "baijiahao" }, dependencies) instanceof BaijiahaoVideo);
});

test("getBilibiliHumanTypes validates the cookie file before requesting human types", async () => {
  await assert.rejects(
    getBilibiliHumanTypes("/missing/bilibili-cookies.json", { logger: SILENT_LOGGER }),
    /ENOENT/u,
  );
});

test("runVideo calls prepare, publish and dispose in order", async () => {
  const video = new RecordingVideo();
  const result = await runVideo(video);
  assert.deepEqual(result, { prepared: "prepared", published: "published" });
  assert.deepEqual(video.calls, ["prepare", "publish:prepared", "dispose"]);
});

test("runVideo preserves the business error when dispose also fails", async () => {
  const businessError = new Error("publish failed");
  const video: Video<string, string> = {
    dispose: () => Promise.reject(new Error("dispose failed")),
    prepare: () => Promise.resolve("prepared"),
    publish: () => Promise.reject(businessError),
  };
  await assert.rejects(runVideo(video), (error: unknown) => error === businessError);
});
