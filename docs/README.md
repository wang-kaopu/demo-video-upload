# 三平台本机发布 endpoint 总览

本目录整理 B 站、抖音、百家号本机发布链路中实际触达的平台 endpoint。

整理边界：

- 只包含 `Zd(accounts) -> Qd(account) -> publisher.run()` 之后的本机发布链路。
- 不包含浏览器发布 / RPA 填表链路。
- 以打包产物中的真实 URL、HTTP 方法、headers、query/body、返回字段为准。
- 打包产物是单行压缩文件，证据定位优先使用 URL 字符串、封装函数名和语义化实现文件。

## 文件

- [bilibili.md](./bilibili.md)：B 站 UPOS 视频上传、封面上传、话题搜索、投稿发布 endpoint。
- [douyin.md](./douyin.md)：抖音 VOD/ImageX 上传、视频校验、话题搜索、create_v2 发布 endpoint。
- [baijiahao.md](./baijiahao.md)：百家号 appinfo、视频预上传、分片上传、封面上传、话题搜索、发布 endpoint。

## 示例

- [Bilibili 视频上传 Demo](../examples/README.md)：使用 `assets` 中的 Cookie、视频、封面和文案验证本机上传链路；最终投稿必须显式传入 `--publish`。
- [Douyin 视频上传 Demo](../examples/README.md#douyin)：使用 Playwright storage-state 和 Demo 素材验证第 1～15 步；不调用 `create_v2`。
- [百家号视频上传 Demo](../examples/README.md#百家号)：使用 storage-state 和单一封面完成原包上传链路；最终发布必须显式传入 `--upload`。

## 关键结论

这三组 endpoint 都是平台创作者后台 Web 端使用的接口，不是公开开放平台 SDK。
其中抖音视频和封面二进制上传复用了火山引擎 VOD/ImageX 风格的签名接口，但入口凭证、csrf、
发布参数仍来自 `creator.douyin.com` 创作者后台。
