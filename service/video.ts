import {
  BaijiahaoVideo,
  type BaijiahaoPreparedContext,
  type BaijiahaoPublishResponse,
  type BaijiahaoVideoOptions,
} from "./baijiahao-video.js";
import {
  BilibiliVideo,
  type BilibiliPreparedContext,
  type BilibiliPublishResponse,
  type BilibiliVideoOptions,
} from "./bilibili-video.js";
import {
  DouyinVideo,
  type DouyinPreparedContext,
  type DouyinPublishResponse,
  type DouyinVideoOptions,
} from "./douyin-video.js";
import { ConsoleLogger, type Logger } from "./logger.js";

/**
 * 将视频准备到可发布状态，并执行最终发布。
 */
export interface Video<TPrepared, TPublished> {
  /**
   * 完成最终发布前的全部请求和素材上传。
   *
   * @returns 最终发布所需的完整上下文
   */
  prepare(): Promise<TPrepared>;

  /**
   * 根据准备上下文执行最终发布请求。
   *
   * @param prepared - prepare 返回的完整上下文
   * @returns 平台完整发布响应
   */
  publish(prepared: TPrepared): Promise<TPublished>;

  /**
   * 释放文件句柄、Electron worker 等运行时资源。
   */
  dispose(): Promise<void>;
}

/** 视频服务运行时依赖。 */
export interface VideoDependencies {
  /** 接收视频服务产生的结构化日志。 */
  logger: Logger;
}

const DEFAULT_VIDEO_DEPENDENCIES: VideoDependencies = {
  logger: new ConsoleLogger(),
};

export type BilibiliCreateVideoOptions = BilibiliVideoOptions & { videoType: "bilibili" };
export type DouyinCreateVideoOptions = DouyinVideoOptions & { videoType: "douyin" };
export type BaijiahaoCreateVideoOptions = BaijiahaoVideoOptions & { videoType: "baijiahao" };

export type CreateVideoOptions =
  | BaijiahaoCreateVideoOptions
  | BilibiliCreateVideoOptions
  | DouyinCreateVideoOptions;

/**
 * 创建 Bilibili 视频服务。
 *
 * @param options - Bilibili 显式运行参数
 * @param dependencies - 可替换的运行时依赖
 * @returns Bilibili 视频实例
 */
export function createVideo(options: BilibiliCreateVideoOptions, dependencies?: VideoDependencies): BilibiliVideo;

/**
 * 创建抖音视频服务。
 *
 * @param options - 抖音显式运行参数
 * @param dependencies - 可替换的运行时依赖
 * @returns 抖音视频实例
 */
export function createVideo(options: DouyinCreateVideoOptions, dependencies?: VideoDependencies): DouyinVideo;

/**
 * 创建百家号视频服务。
 *
 * @param options - 百家号显式运行参数
 * @param dependencies - 可替换的运行时依赖
 * @returns 百家号视频实例
 */
export function createVideo(options: BaijiahaoCreateVideoOptions, dependencies?: VideoDependencies): BaijiahaoVideo;

/**
 * 根据平台类型创建独立视频服务。
 *
 * @param options - 带平台判别字段的显式运行参数
 * @param dependencies - 可替换的运行时依赖，缺省使用 ConsoleLogger
 * @returns 对应平台视频实例
 */
export function createVideo(
  options: CreateVideoOptions,
  dependencies: VideoDependencies = DEFAULT_VIDEO_DEPENDENCIES,
): BaijiahaoVideo | BilibiliVideo | DouyinVideo {
  switch (options.videoType) {
    case "baijiahao":
      return new BaijiahaoVideo(options, dependencies);
    case "bilibili":
      return new BilibiliVideo(options, dependencies);
    case "douyin":
      return new DouyinVideo(options, dependencies);
  }
}

/**
 * 执行一次完整的准备、发布和资源释放流程。
 *
 * @param video - 已创建的平台视频实例
 * @returns 准备上下文和最终发布响应
 */
export async function runVideo<TPrepared, TPublished>(
  video: Video<TPrepared, TPublished>,
): Promise<{ prepared: TPrepared; published: TPublished }> {
  let businessError: Error | undefined;
  let disposeError: Error | undefined;
  let result!: { prepared: TPrepared; published: TPublished };
  try {
    const prepared = await video.prepare();
    const published = await video.publish(prepared);
    result = { prepared, published };
  } catch (error) {
    businessError = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      await video.dispose();
    } catch (error) {
      disposeError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (businessError !== undefined) {
    throw businessError;
  }
  if (disposeError !== undefined) {
    throw disposeError;
  }
  return result;
}

export type AnyPreparedContext =
  | BaijiahaoPreparedContext
  | BilibiliPreparedContext
  | DouyinPreparedContext;

export type AnyPublishResponse =
  | BaijiahaoPublishResponse
  | BilibiliPublishResponse
  | DouyinPublishResponse;
