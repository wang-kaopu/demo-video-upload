# 视频发布 Service

`service` 提供独立于 `examples` 的三平台真实上传与发布实现。三个产品共享两阶段接口：

```ts
interface Video<TPrepared, TPublished> {
  prepare(): Promise<TPrepared>;
  publish(prepared: TPrepared): Promise<TPublished>;
  dispose(): Promise<void>;
}
```

`prepare()` 会真实上传视频和封面并在平台保留远端素材；`publish()` 会真实创建作品。最终发布请求不自动重试。

## 构建

抖音依赖独立 Electron main 和 renderer 产物：

```bash
npm run build:service
```

生成：

```text
dist/service/douyin-electron-main.mjs
dist/service/douyin-electron-renderer.js
```

service 运行时不会自动构建。产物不存在或协议版本不一致时会直接报错。

## 统一运行

`createVideo()` 根据 `videoType` 创建强类型产品，`runVideo()` 固定执行准备、发布和资源释放：

```ts
import { createVideo, runVideo } from "./service/video.js";

const video = createVideo({
  videoType: "bilibili",
  cookiesPath: "/path/to/bilibili.json",
  videoPath: "/path/to/video.mp4",
  coverPath: "/path/to/cover.jpg",
  textPath: "/path/to/text.txt",
  humanTypeId: 1027,
});

const result = await runVideo(video);
console.log(result.published.bvid);
```

只执行素材准备时直接调用产品，并始终释放资源：

```ts
const video = createVideo(options);

try {
  const prepared = await video.prepare();
  console.log(prepared);
} finally {
  await video.dispose();
}
```

## 平台参数

### Bilibili

必填参数：

- `cookiesPath`：Playwright storage-state JSON；
- `videoPath`、`coverPath`、`textPath`；
- `humanTypeId`：当前账号新分区的正整数 ID。

`prepare()` 会校验分区、初始化 UPOS、上传并合并分片、上传封面并构造投稿 Payload。

创建视频服务前可以单独查询当前账号可用的新分区：

```ts
import { getBilibiliHumanTypes } from "./service/bilibili-video.js";

const humanTypes = await getBilibiliHumanTypes(
  "/path/to/bilibili.json",
  { logger: customLogger },
);
```

### 抖音

必填参数：

- `profileRoot`：包含 `Local State` 和 partition 子目录的 Electron profile；
- `sourcePartition`：partition 目录名；
- `videoPath`、`coverPath`、`textPath`。

可选参数：

- `visibility`：`self`、`friends` 或 `public`，默认 `self`；
- `electronMainPath`、`electronRendererPath`：覆盖标准构建产物位置。

`prepare()` 会启动 Electron worker 并执行当前协议第 1～16 步。实例只保留最新 worker，再次准备会先关闭旧 worker。`publish(prepared)` 把上下文交给最新 worker，不校验上下文归属。

### 百家号

必填参数：

- `cookiesPath`：Playwright storage-state JSON；
- `videoPath`：有效 MP4；
- `coverPath`、`textPath`。

`prepare()` 会读取 MP4 元数据、计算 MD5、生成两版封面、完成预上传、分片、汇总和话题搜索。

## Logger

`Logger` 通过统一的 `VideoDependencies` 注入，与平台业务参数分离。`createVideo()` 缺省使用完整日志开启的 `ConsoleLogger`：

```ts
const video = createVideo(options, { logger: customLogger });
```

直接创建具体平台实例时必须显式传入依赖：

```ts
const video = new BilibiliVideo(options, { logger: customLogger });
```

日志行为：

- Cookie、token、授权、普通请求体和响应不脱敏；
- Buffer、ArrayBuffer、TypedArray、Blob 和 FormData 二进制只打印前 100 个 Base64 字符；
- 同时打印原始长度和省略字符数；
- AxiosResponse 打印完整可序列化视图，不打印 socket、XHR 和 adapter 等运行时对象；
- Logger 自身失败不会中断上传或发布。

抖音 renderer 只产生已经序列化的结构化日志事件，由父进程转交注入的 Logger。

## 调用责任

接口不限制调用顺序和重复调用。重复 `prepare()` 会重复上传远端素材，重复 `publish(prepared)` 可能重复创建作品。调用方需要自行控制调用次数，并在所有路径调用 `dispose()`。
