# 搜狐号本机发布 endpoint

搜狐号 Demo 直接复刻 2026-07-09 生产版内容管理前端协议，使用 Playwright storage-state
中的登录 Cookie，通过 Node.js Axios 完成上传和发布，不点击发布页，也不注入 DOM 元素。

## 请求链路

```text
GET  /mpbp/bp/account/check/user                   -> 验证登录态
POST /commons/mp/createVideo                       -> 创建视频上传任务
POST {vto}&id=...&partNo=...                       -> 上传 512 KiB 视频分片
POST /commons/mp/chunkUploadDone                   -> 合并视频并得到 videoHtml
POST /commons/front/outerUpload/image/file          -> 上传封面
POST /commons/front/outerUpload/image/thumbnail/url -> 生成 3:2 裁剪封面
GET  /mpbp/bp/account/common/channels-data-api     -> 查询一级频道
GET  /mpbp/bp/news/v4/videoChannels                -> 查询视频二级频道
GET  /mpbp/bp/news/v4/news/publishLimit            -> 发布前查询额度
POST /mpbp/bp/news/v4/news/publishVideo/v2         -> 发布视频
```

## 视频上传

`createVideo` 使用 `application/x-www-form-urlencoded`，关键参数包括：

- `accountId`：从 storage-state 的 `https://mp.sohu.com` localStorage `vuex.app.userInfo.id` 获取。
- `nameMd5`：`md5("<videoName>_<videoSize>")`。
- `authKey`：`<timestamp>_<md5("sohu-mp-<accountId>-<timestamp>")>`。
- `uploadFrom=277`、`cateCode=329`、`uploadType=2`、`uploadSource=mp`、`delayAudit=true`。

搜狐号对写请求还会校验网页端生成的客户端标识。Demo 从同一份 storage-state 的 localStorage
读取 `sp-cm`（优先使用 `<userCode>-sp-cm`）和 `preview-dv-id`，分别作为 `sp-cm`、`dv-id`
请求头发送；存在 `mp-cv` Cookie 时也同步发送同名请求头。缺少这些字段时直接报错，不伪造设备指纹。

响应返回 `id`、`vto` 和 `token`。视频按 512 KiB 分片，最多三个并发请求；每个分片以
multipart 字段 `file` 上传到：

```text
{vto}&id={id}&type=6&partNo={1-based}&outType=3&partsize=524288
```

分片响应 `code=100` 表示成功。全部分片完成后调用 `chunkUploadDone`，响应中的
`data.videoHtml` 和任务 `id` 用于最终发布。

## 封面上传

封面上传 multipart 包含 `accountId` 和 `file`。Demo 将输入统一转成 JPEG，然后按搜狐号前端
相同的居中 3:2 规则构造 `a_auto,c_cut,q_70,x_*,y_*,w_*,h_*` URL，并调用 thumbnail 接口
生成最终封面 URL。

## 最终发布

发布接口使用 JSON，并在 URL 和 body 中同时携带 `accountId`。主要字段：

- `videoId`、`content`、`cover`：来自上传链路。
- `channelId`、`videoChannelId`：来自频道接口；可由 CLI 显式覆盖。
- `title`、`brief`：来自文案。
- `infoResource=0`、`userColumnId=0`、`topicIds=[]`、`userLabels="[]"`。

Demo 不重试创建、合并、封面和最终发布请求，避免不确定响应导致重复资源或重复作品。分片失败也
直接暴露，暂不实现前端的跨进程续传与 reupload 协议。

## 安全说明

- `assets/133_sohu.json` 包含完整登录凭据，已由 `.gitignore` 排除。
- HTTP 日志会输出请求参数和响应，但 Cookie、`sp-cm`、`dv-id`、`mp-cv` 始终显示为
  `<redacted>`。
- 默认命令会真实上传视频和封面，但不会调用最终发布接口。
- 默认命令将最终请求体保存为 `assets/sohu-publish-payload.json`；可用 `--publish-payload`
  单独提交它，避免确认发布时重复上传。
- 只有显式传入 `--publish` 或 `--publish-payload` 才会提交作品；发布成功后仍可能进入平台审核。
