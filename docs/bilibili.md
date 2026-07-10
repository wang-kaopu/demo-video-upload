# B 站本机发布 endpoint

语义化实现：[../src/platforms/bilibili-publisher.ts](../src/platforms/bilibili-publisher.ts)

原包类名：`class _d extends oe`

主要凭证：

- `Cookie`：来自本机发布账号。
- `bili_jct`：从 Cookie 中提取，作为 `csrf`。
- `X-Upos-Auth`：由 `preupload` 返回的 `auth`。

## 调用顺序

```text
GET  /preupload                         -> 获取 meta upos_uri
GET  /preupload                         -> 获取视频 auth / endpoint / upos_uri / biz_id
POST {uploadUrl}?uploads=...            -> 初始化 multipart，得到 upload_id / key
PUT  {uploadUrl}?partNumber=...         -> 上传每个视频分片
POST {uploadUrl}?uploadId=...           -> 合并视频分片
POST /x/vu/web/cover/up                 -> 上传封面，得到 cover url
GET  /x/vupre/web/archive/human/type2/list -> 获取 human_type2 新分区 ID
GET  /x/vupre/web/topic/search          -> 可选：把描述中的 #话题 转成平台话题对象
POST /x/vu/web/add/v3                   -> 提交投稿
```

## 1. 获取 meta 上传信息

- 方法：`GET`
- URL：`https://member.bilibili.com/preupload`
- 原包封装：`rdA`
- 语义化调用：`bilibiliHttp.probeUpload`
- 用途：先上传一个固定 `file_meta.txt` 探测请求，返回 `meta_upos_uri`，后续初始化 multipart 时要带上。

Headers：

```text
Cookie: <account.cookie>
Referer: https://member.bilibili.com/platform/upload/video/frame
```

Query：

```json
{
  "probe_version": "20250923",
  "upcdn": "estx",
  "zone": "cs",
  "name": "file_meta.txt",
  "size": 2000,
  "r": "upos",
  "profile": "aicovers/bup",
  "ssl": 0,
  "version": "2.14.0.0",
  "build": "2140000",
  "webVersion": "2.14.0",
  "threads": 2
}
```

关键返回：

```json
{
  "OK": 1,
  "upos_uri": "..."
}
```

## 2. 获取视频上传信息

- 方法：`GET`
- URL：`https://member.bilibili.com/preupload`
- 原包封装：`rdA`
- 语义化调用：`bilibiliHttp.probeUpload`
- 用途：获取真实视频上传需要的 `auth`、`endpoint`、`upos_uri`、`biz_id`。

Query：

```json
{
  "zone": "cs",
  "upcdn": "estx",
  "probe_version": "20250923",
  "name": "<videoFile.name>",
  "r": "upos",
  "profile": "ugcfx/bup",
  "ssl": 0,
  "version": "2.14.0.0",
  "build": "2140000",
  "size": "<videoFile.size>",
  "webVersion": "2.14.0",
  "threads": 2
}
```

关键返回：

```json
{
  "OK": 1,
  "auth": "...",
  "endpoint": "//upos-...",
  "upos_uri": "upos://...",
  "biz_id": 123
}
```

后续处理：

```text
uploadUrl = "https:" + endpoint + "/" + upos_uri.split("//")[1]
publishContext.auth = auth
publishContext.uploadUrl = uploadUrl
bizId = biz_id
```

## 3. 初始化 multipart

- 方法：`POST`
- URL：`{uploadUrl}?{query}`
- 原包封装：`ndA`
- 语义化调用：`bilibiliHttp.initMultipart`
- 用途：创建 UPOS multipart 上传会话。

Headers：

```text
Referer: https://member.bilibili.com/platform/upload/video/frame
X-Upos-Auth: <auth>
```

Query：

```json
{
  "uploads": "",
  "output": "json",
  "profile": "ugcfx/bup",
  "filesize": "<videoFile.size>",
  "partsize": 10485760,
  "meta_upos_uri": "<meta upos_uri>",
  "biz_id": "<biz_id>"
}
```

关键返回：

```json
{
  "OK": 1,
  "upload_id": "...",
  "key": "/<videoKey>.mp4"
}
```

后续用途：

- `upload_id` 用于分片上传和合并。
- `key` 处理成 `videoKey`，发布时写入 `videos[0].filename`。

## 4. 上传视频分片

- 方法：`PUT`
- URL：`{uploadUrl}?{query}`
- 原包封装：`Qct`
- 语义化调用：`bilibiliHttp.uploadChunk`
- 用途：上传每个 10MB 分片。

Headers：

```text
Content-Type: application/octet-stream
Referer: https://member.bilibili.com/platform/upload/video/frame
X-Upos-Auth: <auth>
```

Query：

```json
{
  "uploadId": "<upload_id>",
  "partNumber": 1,
  "chunk": 0,
  "chunks": "<totalChunks>",
  "size": "<currentChunkSize>",
  "start": 0,
  "end": 10485760,
  "total": "<videoFile.size>"
}
```

Body：

```text
ArrayBuffer(chunk)
```

成功条件：

```text
HTTP status === 200
```

## 5. 合并视频分片

- 方法：`POST`
- URL：`{uploadUrl}?{query}`
- 原包封装：`ndA`
- 语义化调用：`bilibiliHttp.completeMultipart`
- 用途：把已上传分片合并成一个视频资源。

Headers：

```text
Referer: https://member.bilibili.com/platform/upload/video/frame
X-Upos-Auth: <auth>
```

Query：

```json
{
  "output": "json",
  "name": "<videoFile.name>",
  "profile": "ugcfx/bup",
  "uploadId": "<upload_id>",
  "biz_id": "<biz_id>"
}
```

Body：

```json
{
  "parts": [
    {
      "partNumber": 1,
      "eTag": "etag"
    }
  ]
}
```

成功条件：

```json
{ "OK": 1 }
```

## 6. 上传封面

- 方法：`POST`
- URL：`https://member.bilibili.com/x/vu/web/cover/up`
- 原包封装：`gct`
- 语义化调用：`bilibiliHttp.uploadCover`
- 用途：上传表单里的封面图，返回投稿参数需要的封面 URL。

Headers：

```text
Content-Type: multipart/form-data
Cookie: <account.cookie>
Referer: https://member.bilibili.com/platform/upload/video/frame
```

Query：

```json
{
  "t": "<timestamp>",
  "csrf": "<bili_jct>"
}
```

Body：

```json
{
  "cover": "<data:image/...;base64,...>",
  "csrf": "<bili_jct>"
}
```

关键返回：

```json
{
  "code": 0,
  "data": {
    "url": "https://..."
  }
}
```

后续用途：

```text
publishContext.coverUrl -> publish params cover / cover43
```

## 7. 获取 `human_type2` 新分区列表

- 方法：`GET`
- URL：`https://member.bilibili.com/x/vupre/web/archive/human/type2/list`
- 原包封装：`Ict`
- 用途：获取投稿表单“分区”下拉框的数据，并把用户选中的新分区数字 ID 写入最终投稿参数 `human_type2`。

该请求属于本机发布的表单参数准备过程。当前语义化 Publisher 直接消费上游准备好的 `formValues.classify`，因此没有在 `bilibiliHttp` 中重复封装这个请求。

Headers：

```text
Cookie: <account.cookie>
Referer: https://member.bilibili.com/platform/upload/video/frame
```

Query：

```json
{
  "t": "<timestamp milliseconds>"
}
```

关键返回：

```json
{
  "code": 0,
  "data": {
    "type_list": [
      {
        "id": 123,
        "name": "<新分区名称>"
      }
    ]
  }
}
```

表单和发布参数之间的映射：

```text
type_list[].name -> 分区下拉框显示文本
type_list[].id   -> formValues.classify
formValues.classify -> human_type2
```

当前本机表单使用 `name` 作为显示文本、`id` 作为单选值。发布参数生成代码同时兼容历史数组形式：如果 `classify` 是数组，则取最后一个值；否则直接使用该值。

填写约束：

- `human_type2` 的 JSON 类型是数字，应填写当前登录账号返回的 `type_list[].id`。
- 不能填写新分区名称。
- 不能用旧分区字段 `tid` 的值代替；当前发布参数中的 `tid: 221` 与 `human_type2` 是两个独立字段。
- 不要把 `0` 当作真实分区 ID。其他实现可能用 `0` 表示未指定并在序列化时省略该字段，但本机发布表单要求必须选择分区。
- 新分区列表需要有效的 B 站登录 Cookie；匿名请求会返回 `code: -101` 和“账号未登录”。

使用当前账号 Cookie 查看可填写值：

```bash
curl -fsSL \
  'https://member.bilibili.com/x/vupre/web/archive/human/type2/list' \
  -H "Cookie: ${BILI_COOKIE}" \
  -H 'Referer: https://member.bilibili.com/platform/upload/video/frame' |
  jq '(.data.type_list // .type_list)[] | {id, name}'
```

## 8. 搜索话题

- 方法：`GET`
- URL：`https://member.bilibili.com/x/vupre/web/topic/search`
- 原包封装：`Cct`
- 语义化调用：`bilibiliHttp.searchTopic`
- 用途：把描述中的 `#话题` 转成投稿接口接受的话题对象。

Headers：

```text
Cookie: <account.cookie>
Referer: https://member.bilibili.com/platform/upload/video/frame
```

Query：

```json
{
  "keywords": "<topicName>",
  "page_size": 20,
  "offset": 0,
  "t": "<timestamp>"
}
```

关键返回路径：

```text
data.result.topics[]
```

后续用途：

- `topic_name` 追加到 `tag`。
- `mission_id` 写入 `mission_id`。
- `id` 写入 `topic_id` 和 `topic_detail.from_topic_id`。

## 9. 提交投稿

- 方法：`POST`
- URL：`https://member.bilibili.com/x/vu/web/add/v3`
- 原包封装：`Ect`
- 语义化调用：`bilibiliHttp.publish`
- 用途：提交最终 B 站投稿。

Headers：

```text
Cookie: <account.cookie>
Referer: https://member.bilibili.com/platform/upload/video/frame
```

Query：

```json
{
  "web_location": 1,
  "t": "<timestamp>",
  "csrf": "<bili_jct>",
  "w_rid": "",
  "wts": 1781077232,
  "b_wet": ""
}
```

核心 Body：

```json
{
  "cover": "<coverUrl>",
  "cover43": "<coverUrl>",
  "title": "<title>",
  "copyright": 3,
  "creation_statement": {
    "id": "<authorDeclare || -1>"
  },
  "human_type2": 123,
  "tid": 221,
  "tag": "tag1,tag2",
  "desc": "<description>",
  "dynamic": "<dynamic>",
  "videos": [
    {
      "filename": "<videoKey>",
      "title": "<title>",
      "desc": "",
      "cid": "<bizId>"
    }
  ],
  "watermark": {
    "state": 1
  },
  "subtitle": {
    "open": 0,
    "lan": ""
  },
  "dtime": "<optional unix seconds>"
}
```

这里的 `123` 仅用于表示 JSON 数字类型，实际值必须替换为当前账号新分区接口返回的 `data.type_list[].id`。

关键返回：

```json
{
  "code": 0,
  "data": {
    "bvid": "BV..."
  }
}
```
