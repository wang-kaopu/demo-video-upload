# 百家号本机发布 endpoint

语义化实现：[../src/platforms/baijiahao-publisher.ts](../src/platforms/baijiahao-publisher.ts)

原包类名：`class fd extends oe`

主要凭证：

- `Cookie`：百家号后台登录态。
- `app_id`：从 `builder/app/appinfo` 返回的用户信息中读取。
- `coverToken`：封面上传响应头中的 `token`，发布时放到 header。

## 调用顺序

```text
GET  /builder/app/appinfo                    -> 获取 app_id
POST /materialui/video/preuploadvideo        -> 视频预上传，得到 upload_key / mediaId
POST /pcui/picture/processproxy              -> 上传竖版封面
POST /pcui/picture/processproxy              -> 上传横版封面
POST https://rsbjh10.baidu.com/...uploadvideo -> 上传视频分片
POST /materialui/video/compuploadvideo       -> 汇总视频上传信息
GET  /pcui/pcpublisher/searchtopic           -> 可选：搜索话题
POST /pcui/article/publish                   -> 发布作品
```

这里以当前本机发布入口 `fd extends oe` 的实际 `oe.run()` 顺序为准：预上传完成后先依次上传
竖版、横版封面，再上传和汇总视频分片。发布 Header 使用第二次横版封面响应中的 `token`。

## Node.js Demo 适配约定

示例实现：[../examples/baijiahao-upload.ts](../examples/baijiahao-upload.ts)

- 凭据读取 Playwright storage-state。domain 为 `baidu.com` 或以 `.baidu.com` 结尾的全部有效、
  非空 Cookie 会按原顺序拼接，同名项不去重；同一个 Header 也会发送给 `rsbjh10.baidu.com`。
- 只支持 MP4。使用 MP4Box 渐进读取时长和视频宽高，`width >= height` 为横版，否则为竖版；
  文件 MD5 使用 Node.js 流式计算。
- 单个源封面由 Sharp 自动旋转并以 attention 策略裁剪。横版输出 1280×720，竖版输出
  1080×1440，均为 quality 90、4:4:4 JPEG，不写临时文件。
- 视频按 2 MiB 分片，并发数为 3。单片失败后等待 1、2、4 秒重试，即最多请求 4 次；
  其他请求和最终发布不重试。
- 文案第一个非空行作为 `content[].title`，后续内容移除 hashtag 后作为描述和顶层 `title`；
  描述为空时回退为标题。所有 hashtag 并发搜索，只提交文案顺序中第一个精确匹配的话题。
- 未传 `--publish` 时仍真实完成账号验证、预上传、两张封面上传、视频分片与汇总和话题搜索，
  但不会调用最终发布接口。
- Demo 完整打印未脱敏的 Cookie、token、上传密钥、普通请求体和响应；二进制 Base64 只保留
  前 100 个字符，并标记原始长度和省略字符数。终端输出仍必须按完整登录凭据保存。

## 1. 获取用户 app_id

- 方法：`GET`
- URL：`https://baijiahao.baidu.com/builder/app/appinfo`
- 原包封装：`ugt`
- 语义化调用：`baijiahaoHttp.getUser`
- 用途：获取后续上传接口必需的 `app_id`。

Headers：

```text
Cookie: <account.cookie>
```

关键返回路径：

```text
data.user.app_id
```

## 2. 视频预上传

- 方法：`POST`
- URL：`https://baijiahao.baidu.com/materialui/video/preuploadvideo`
- 原包封装：`dgt`
- 语义化调用：`baijiahaoHttp.preUpload`
- 用途：用文件 MD5 创建视频上传任务，返回 `upload_key` 和 `mediaId`。

Headers：

```text
Cookie: <account.cookie>
```

Query：

```json
{
  "app_id": "<app_id>"
}
```

Body：

```json
{
  "app_id": "<app_id>",
  "md5": "<fileMd5>",
  "is_pay_column": "0",
  "video_type": "short | tiny",
  "column_videotype": "",
  "size": "<video.size>",
  "org_file_name": "<video.name>"
}
```

关键返回：

```json
{
  "error_code": 20000,
  "upload_key": "...",
  "mediaId": "..."
}
```

后续用途：

- `upload_key`：分片上传和汇总上传时使用。
- `mediaId`：发布参数 `content[].mediaId` 使用。

## 3. 上传封面

- 方法：`POST`
- URL：`https://baijiahao.baidu.com/pcui/picture/processproxy`
- 原包封装：`pgt`
- 语义化调用：`baijiahaoHttp.uploadCover`
- 用途：依次上传竖版和横版封面，返回图片 URL 和发布需要的 token。

Headers：

```text
Content-Type: multipart/form-data
Cookie: <account.cookie>
```

Body：

```json
{
  "action": ["save"],
  "base64": "<base64 without data URL prefix>",
  "videoCover": "frontend"
}
```

关键返回：

```json
{
  "headers": {
    "token": "<coverToken>"
  },
  "data": {
    "errno": 0,
    "ret": {
      "original_url": "http://...",
      "url": "http://..."
    }
  }
}
```

后续用途：

```text
verticalOrg / verticalHttps
horizontalOrg / horizontalHttps
第二次横版响应的 coverToken -> publish header token
```

## 4. 上传视频分片

- 方法：`POST`
- URL：`https://rsbjh10.baidu.com/materialui/video/uploadvideo`
- 原包封装：`hgt`
- 语义化调用：`baijiahaoHttp.uploadChunk`
- 用途：上传每个 2MB 视频分片。

Headers：

```text
Content-Type: multipart/form-data
Cookie: <account.cookie>
```

Query：

```json
{
  "app_id": "<app_id>"
}
```

Form fields：

```json
{
  "app_id": "<app_id>",
  "md5": "<fileMd5>",
  "id": "WU_FILE_0",
  "name": "<video.name>",
  "type": "<video.type || video/mp4>",
  "lastModifiedDate": "<Date>",
  "size": "<video.size>",
  "chunks": "<totalChunks>",
  "chunk": "<zeroBasedChunkIndex>",
  "upload_key": "<upload_key>",
  "file": "<ArrayBuffer(chunk)>"
}
```

成功条件：

```json
{
  "error_code": 20000
}
```

## 5. 汇总视频上传信息

- 方法：`POST`
- URL：`https://baijiahao.baidu.com/materialui/video/compuploadvideo`
- 原包封装：`fgt`
- 语义化调用：`baijiahaoHttp.completeUpload`
- 用途：通知百家号视频分片上传完成。

Headers：

```text
Content-Type: multipart/form-data
Cookie: <account.cookie>
```

Query：

```json
{
  "app_id": "<app_id>"
}
```

Body：

```json
{
  "upload_key": "<upload_key>",
  "chunks": "<chunk count>",
  "name": "<video.name>",
  "size": "<video.size>",
  "is_pay_column": "0",
  "column_videotype": "",
  "type": "video",
  "video_type": "short | tiny",
  "duration": "<ceil(video.duration)>"
}
```

成功条件：

```json
{
  "error_code": 0
}
```

## 6. 搜索话题

- 方法：`GET`
- URL：`https://baijiahao.baidu.com/pcui/pcpublisher/searchtopic`
- 原包封装：`brA`
- 语义化调用：`baijiahaoHttp.searchTopic`
- 用途：把描述中的 `#话题` 转成百家号发布接口的 `bjhtopic_*` 参数。

Headers：

```text
Cookie: <account.cookie>
```

Query：

```json
{
  "content": "<topicName>",
  "resource_type": 3,
  "title": ""
}
```

关键返回：

```text
data.recommend[]
data.hot[]
```

后续用途：

- 横版：`bjhtopic_id`，`bjhtopic_info = [{ id, title, guide, cover }]`
- 竖版：`bjhtopic_id`，`bjhtopic_info = [topic]`

## 7. 提交发布

- 方法：`POST`
- URL：`https://baijiahao.baidu.com/pcui/article/publish`
- 原包封装：`Fae`
- 语义化调用：`baijiahaoHttp.publish`
- 用途：发布横版 `video` 或竖版 `ugc_video`。

Headers：

```text
Content-Type: application/x-www-form-urlencoded
Cookie: <account.cookie>
token: <coverToken>
```

Query：

```json
{
  "callback": "bjhpublish",
  "type": "video | ugc_video"
}
```

### 原包默认模板

`IMAGE_EDIT_POINT` 在模板创建时只序列化一次：

```ts
const IMAGE_EDIT_POINT = [
  {
    img_type: "cover",
    img_num: { template: 0, font: 0, filter: 0, paster: 0, cut: 0, any: 0 },
  },
  {
    img_type: "body",
    img_num: { template: 0, font: 0, filter: 0, paster: 0, cut: 0, any: 0 },
  },
];
```

横版 `hd` 完整默认模板：

```ts
{
  type: "video",
  title: "",
  vertical_cover: "",
  desc: "",
  bjhtopic_id: "",
  bjhtopic_info: "",
  cover_image_source: {
    wide_cover_image_source: "video_cut",
    vertical_cover_image_source: "video_cut",
  },
  ducut_info: "",
  content: [{ title: "", mediaId: "", videoName: "", local: 1, desc: "" }],
  video_duration: 0,
  nryx_mount_list: "",
  activity_list: [{ id: "aigc_bjh_status", is_checked: 0 }],
  source_reprinted_allow: 0,
  is_auto_optimize_cover: 1,
  bjh_video_finger_printing: { s2l: null, s2game: null, bjh: { duration: 35 } },
  fe_from: "BJH_CMS_PC",
  auto_mount_goods: 0,
  is_consultant_card: 0,
  usingImgFilter: false,
  cover_layout: "one",
  cover_images: [{ src: "", isLegal: 0, cover_source_tag: "smart_recommend" }],
  _cover_images_map: [],
  cover_source: "upload",
  clue: "",
  bjhmt: "",
  order_id: "",
  BJH_FE_NOUNCE: "",
  aigc_rebuild: "",
  pub_source_from: "pc_faburukou",
  image_edit_point: JSON.stringify(IMAGE_EDIT_POINT),
}
```

竖版 `pd` 完整默认模板：

```ts
{
  type: "ugc_video",
  title: "",
  bjhtopic_id: "",
  bjhtopic_info: "",
  cover_image_source: {
    wide_cover_image_source: "video_cut",
    vertical_cover_image_source: "video_cut",
  },
  ducut_info: "",
  content: [{ title: "", mediaId: "" }],
  video_duration: 0,
  nryx_mount_list: "",
  vertical_cover_images: [{
    content_original: "",
    src: "",
    cropData: { x: 0, y: 155, width: 608, height: 810 },
    isLegal: 0,
    cover_source_tag: "video_cut",
  }],
  size: 0,
  width_in_pixel: 1920,
  height_in_pixel: 1080,
  cover_layout: "one",
  cover_images: [{
    source: "local",
    src: "",
    cropData: { x: 0, y: 421, width: 608, height: 342 },
    isLegal: 0,
    cover_source_tag: "video_cut",
  }],
  _cover_images_map: [{ src: "", origin_src: "" }],
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
  image_edit_point: JSON.stringify(IMAGE_EDIT_POINT),
}
```

`usingImgFilter` 和模板阶段的 `bjh_video_finger_printing` 只存在于 `hd`；`loadComplete`
只存在于 `pd`。构造最终 Payload 时先 `structuredClone()` 对应模板，再按原包顺序覆盖文案、
视频和封面字段，最后写入：

```text
title
video_duration
publish_statement
publish_statement_sub
activity_list
bjh_video_finger_printing
```

Demo 固定 `publish_statement=0`、`publish_statement_sub=0`，AIGC 活动项未勾选。无话题时仍发送：

```text
bjhtopic_id=
bjhtopic_info=
```

### URL-encoded 序列化

以下字段在构造阶段已经是单个 JSON 字符串字段：

```text
content
cover_images
vertical_cover_images
_cover_images_map
bjh_video_finger_printing
image_edit_point
```

其中 `image_edit_point` 在默认模板定义时序列化，其余字段在覆盖实际资源时序列化。以下字段必须保持
对象或数组，并交给 Axios `toFormData(payload, new URLSearchParams())` 生成 bracket notation：

```text
cover_image_source
activity_list
bjhtopic_info（有话题时）
```

实际 wire 形态示例：

```text
cover_image_source%5Bwide_cover_image_source%5D=video_cut
activity_list%5B0%5D%5Bid%5D=aigc_bjh_status
bjhtopic_info%5B0%5D%5Bid%5D=<topic id>
content=%5B%7B%22title%22%3A...
```

发布前只生成一次最终 URL-encoded 字符串，同一字符串既用于日志，也原样作为 Axios POST body；
不得再把所有非字符串字段统一 `JSON.stringify()`，也不得让 Axios 二次转换该字符串。

### `errno=10000005` 排查顺序

该错误无法仅靠客户端消息确定唯一原因。当前按以下候选顺序排查，每次只改变一个变量：

1. `hd` / `pd` 默认模板字段缺失。
2. `cover_image_source`、`activity_list` 或 `bjhtopic_info` 被错误编码为单个 JSON 字符串，未使用 bracket notation。
3. storage-state 中的同名 Cookie 冲突；本项尚未通过目标域过滤实验确认。
4. 平台临时繁忙；保持最终发布不重试，避免接口已成功但客户端未收到响应时重复创建作品。

关键返回：

```json
{
  "errno": 0,
  "ret": {
    "nid": "..."
  }
}
```
