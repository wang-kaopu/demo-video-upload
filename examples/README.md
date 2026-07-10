# 视频上传 Demo

## Bilibili

本示例按照 [`docs/bilibili.md`](../docs/bilibili.md) 的链路，使用当前账号 Cookie 完成 UPOS 视频分片上传、合并、封面上传，以及可选的最终投稿。

## 环境与安装

项目要求 Node.js 22，并通过 `.nvmrc` 固定版本：

```bash
nvm use
npm install
```

默认素材：

- Cookie：`assets/122_bilibili.json`
- 视频：`assets/demo.mp4`
- 封面：`assets/demo.png`
- 文案：`assets/demo.txt`

封面类型按文件实际内容识别，因此示例中扩展名为 `.png`、实际内容为 JPEG 的文件也能正确上传。

## 查询新分区

正式投稿前先查询当前账号可填写的 `human_type2`：

```bash
npm run example:bilibili -- --list-types
```

输出中的 `human_type2` 是数字 ID。不能填写分区名称，也不能用旧分区 `tid` 的值代替。

## 上传但不投稿

```bash
npm run example:bilibili
```

默认命令会真实上传视频、合并分片并上传封面，但不会调用最终投稿接口。上传会在 B 站留下未投稿的远端素材。

## 正式投稿

```bash
# 1027 是本次查询到的“情感”分区；发布其他内容时请替换为对应 ID
npm run example:bilibili -- --publish --human-type2 1027
```

脚本会在上传前重新查询新分区列表并校验 ID。只有显式提供 `--publish` 才会调用 `/x/vu/web/add/v3`。

## 覆盖默认素材

```bash
npm run example:bilibili -- \
  --cookies /path/to/cookies.json \
  --video /path/to/video.mp4 \
  --cover /path/to/cover.jpg \
  --text /path/to/description.txt
```

文案第一行作为标题和动态，全文作为简介，`#话题` 会提取为普通投稿标签。本示例不调用活动话题搜索接口。

## 安全说明

- Cookie 文件包含登录凭证，不要复制到日志、工单或公开仓库。
- Demo 会完整打印每个请求和响应，不做任何脱敏，包括 Cookie、`bili_jct`、`X-Upos-Auth`、封面 Base64 和视频分片 Base64；终端输出必须按敏感凭证保存。
- 大视频会产生非常大的终端日志，因为每个分片的完整二进制内容都会以 Base64 输出。
- 探测请求和分片 PUT 最多自动重试 3 次；初始化、合并、封面上传和最终投稿不自动重试。
- 不支持跨进程断点续传；失败后重新执行会创建新的上传会话。

## Douyin

抖音示例按照 [`docs/douyin.md`](../docs/douyin.md) 的第 1～15 步，完成创作者中心登录态适配、
VOD 视频上传与提交、视频校验、ImageX 封面上传与提交、封面 URL 获取和话题搜索。

默认素材：

- Cookie：`assets/124_douyin.json`
- 视频：`assets/demo.mp4`
- 封面：`assets/demo.png`
- 文案：`assets/demo.txt`

### 上传但不发布

```bash
npm run example:douyin
```

该命令会真实上传视频和封面，在抖音远端留下未发布素材。当前版本不会计算 `a_bogus`，不会调用
`create_v2`，也不提供 `--upload` 正式发布参数。

### 覆盖默认素材

```bash
npm run example:douyin -- \
  --cookies /path/to/124_douyin.json \
  --video /path/to/video.mp4 \
  --cover /path/to/cover.jpg \
  --text /path/to/description.txt
```

运行时根据当前系统自动选择 macOS 或 Windows 设备配置；其他系统会直接报错。视频按 5 MiB 分片，
最多三个分片并发上传；每片失败后按 1、2、4 秒等待重试。

话题搜索最多处理文案中前五个去重 `#话题`。搜索失败或没有完全匹配时忽略该话题，不影响已经完成的
视频和封面上传。

### Douyin 安全说明

- storage-state、Cookie、`xmst`、security-sdk 数据和临时上传密钥都是敏感登录凭据，不得提交到公开仓库。
- Douyin Demo 不打印凭据、签名、完整请求 URL、请求体或二进制素材。
- 不支持跨进程断点续传；失败后重新执行会创建新的 VOD/ImageX 上传会话。
- `video/enable` 和 `video/transend` 按原包各请求一次，不实现原包中不存在的转码轮询状态机。
