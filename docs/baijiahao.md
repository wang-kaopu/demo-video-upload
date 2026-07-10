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
POST https://rsbjh10.baidu.com/...uploadvideo -> 上传视频分片
POST /materialui/video/compuploadvideo       -> 汇总视频上传信息
POST /pcui/picture/processproxy              -> 上传竖版封面
POST /pcui/picture/processproxy              -> 上传横版封面
GET  /pcui/pcpublisher/searchtopic           -> 可选：搜索话题
POST /pcui/article/publish                   -> 发布作品
```

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

## 3. 上传视频分片

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

## 4. 汇总视频上传信息

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

## 5. 上传封面

- 方法：`POST`
- URL：`https://baijiahao.baidu.com/pcui/picture/processproxy`
- 原包封装：`pgt`
- 语义化调用：`baijiahaoHttp.uploadCover`
- 用途：上传竖版和横版封面，返回图片 URL 和发布需要的 token。

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
coverToken -> publish header token
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

横版核心 Body：

```json
{
  "type": "video",
  "title": "<description>",
  "vertical_cover": "<verticalHttps>",
  "desc": "<description>",
  "content": "[{\"title\":\"<title>\",\"mediaId\":\"<mediaId>\",\"videoName\":\"<video.name>\",\"local\":1,\"desc\":\"<description>\"}]",
  "video_duration": "<ceil(duration)>",
  "cover_images": "[{\"src\":\"<horizontalHttps>\",\"isLegal\":0,\"cover_source_tag\":\"video_cut\"}]",
  "cover_source": "upload",
  "tag": "tag1,tag2",
  "bjhtopic_id": "<optional topic id>",
  "bjhtopic_info": "<optional topic info>",
  "timer_time": "<optional unix seconds>"
}
```

竖版核心 Body：

```json
{
  "type": "ugc_video",
  "title": "<description>",
  "content": "[{\"title\":\"<title>\",\"mediaId\":\"<mediaId>\"}]",
  "video_duration": "<ceil(duration)>",
  "vertical_cover_images": "[{\"content_original\":\"<verticalOrg>\",\"src\":\"<verticalHttps>\",\"cropData\":{...},\"isLegal\":0,\"cover_source_tag\":\"video_cut\"}]",
  "size": "<video.size>",
  "width_in_pixel": "<video.width>",
  "height_in_pixel": "<video.height>",
  "cover_images": "[{\"source\":\"local\",\"src\":\"<verticalHttps>\",\"cropData\":{...},\"isLegal\":0,\"cover_source_tag\":\"video_cut\"}]",
  "_cover_images_map": "[{\"src\":\"<verticalHttps>\",\"origin_src\":\"<verticalOrg>\"}]",
  "cover_source": "upload",
  "bjhtopic_id": "<optional topic id>",
  "bjhtopic_info": "<optional topic info>",
  "timer_time": "<optional unix seconds>"
}
```

公共 Body 字段：

```json
{
  "publish_statement": "<publishStatement || 0>",
  "publish_statement_sub": "<publishStatementSub || 0>",
  "activity_list": [
    {
      "id": "aigc_bjh_status",
      "is_checked": "claimOrigin[0] === AI || publishStatement === 2 ? 1 : 0"
    }
  ],
  "bjh_video_finger_printing": "{\"s2l\":null,\"s2game\":null,\"bjh\":{\"duration\":<duration>}}",
  "fe_from": "BJH_CMS_PC",
  "pub_source_from": "pc_faburukou"
}
```

关键返回：

```json
{
  "errno": 0,
  "ret": {
    "nid": "..."
  }
}
```
