# 视频上传 Demo

## 命令行参数对照

| 参数 | Bilibili | 抖音 | 百家号 | 搜狐号 |
| --- | --- | --- | --- | --- |
| `--video <path>` | 默认 `assets/demo.mp4` | 默认 `assets/demo.mp4` | 默认 `assets/demo.mp4`，只支持 MP4 | 默认 `assets/demo.mp4` |
| `--cover <path>` | 默认 `assets/demo.png` | 默认 `assets/demo.png` | 默认 `assets/demo.png`，自动生成横竖两版封面 | 默认 `assets/demo.png`，生成 3:2 JPEG |
| `--text <path>` | 默认 `assets/demo.txt` | 默认 `assets/demo.txt` | 默认 `assets/demo.txt` | 默认 `assets/demo.txt` |
| `--cookies <path>` | 默认 `assets/122_bilibili.json` | 不支持，使用 Electron partition | 默认 `assets/125_baijiahao.json` | 默认 `assets/133_sohu.json` |
| 发布开关 | `--publish` | `--publish` | `--publish` | `--publish` |
| 分区或账号 | `--human-type2 <id>` | `--source-partition <id>`，必填 | 无 |
| 可见性 | 无 | `--visibility self\|friends\|public` | 无 |
| 查询模式 | `--list-types` | 无 | 无 |
| 帮助 | `-h`、`--help` | `-h`、`--help` | `-h`、`--help` |

四个 Demo 在不传发布开关时仍会真实上传视频和封面，并在远端保留未发布素材；发布开关只控制是否调用最终投稿或发布接口。

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

抖音示例按照 [`docs/douyin.md`](../docs/douyin.md) 的第 1～17 步实现。它直接使用
`assets/douyin/<partition>` 中的 Electron Session，通过隐藏 Creator 窗口加载官方 BDMS，并以
CDP 截获签名后的 URL。该签名探测请求总是在联网前终止，只有显式传入 `--publish` 才会另行提交作品。

默认素材：

- 视频：`assets/demo.mp4`
- 封面：`assets/demo.png`
- 文案：`assets/demo.txt`

账号目录必须包含：

- `assets/douyin/Local State`
- `assets/douyin/<partition id>/` 的完整内容

不要手工改写其中的 Cookies SQLite、Local Storage 或其他 Chromium 数据。账号目录包含完整登录凭据，
已由 `.gitignore` 排除。

### 上传但不发布

```bash
npm run example:douyin -- --source-partition 1783645517194
```

该命令会真实执行第 1～16 步，上传视频和封面并验证官方 BDMS 可以产生 `a_bogus`，但不会调用
`create_v2`。失败后不会清理已上传的远端素材。

### 正式发布

```bash
npm run example:douyin -- \
  --source-partition 1783645517194 \
  --publish
```

默认可见性是 `self`（仅自己可见）。也可显式使用 `--visibility friends` 或
`--visibility public`。第 17 步不自动重试，避免接口成功但客户端未收到响应时重复发布。

### 覆盖默认素材

```bash
npm run example:douyin -- \
  --source-partition 1783645517194 \
  --video /path/to/video.mp4 \
  --cover /path/to/cover.jpg \
  --text /path/to/description.txt
```

文案的第一个非空行作为标题，最多 20 个字符；后续行作为描述。运行时根据当前系统自动选择
macOS 或 Windows 的一致设备配置；其他系统直接报错。视频按 5 MiB 分片，最多三个分片并发上传；
每片失败后按 1、2、4 秒等待重试。

话题搜索最多处理文案中前五个去重 `#话题`。搜索失败或没有完全匹配时忽略该话题，不影响已经完成的
视频和封面上传。

### Douyin 安全说明

- partition、Cookie、`xmst`、security-sdk 数据和临时上传密钥都是敏感登录凭据，不得提交到仓库。
- Douyin Demo 不打印凭据、签名、完整请求 URL、请求体或二进制素材。
- Demo 直接读写指定 partition；运行期间不要让其他 Electron 进程同时打开同一份复制目录。
- 不支持跨进程断点续传；失败后重新执行会创建新的 VOD/ImageX 上传会话。
- `video/enable` 和 `video/transend` 按原包各请求一次，不实现原包中不存在的转码轮询状态机。

## 百家号

百家号示例按照 [`docs/baijiahao.md`](../docs/baijiahao.md) 复刻当前本机发布入口。它使用
Playwright storage-state 中的全部有效百度 Cookie，通过 Node.js Axios 直接请求平台接口，不需要
Electron 或浏览器运行时。

默认素材：

- Cookie：`assets/125_baijiahao.json`
- 视频：`assets/demo.mp4`
- 封面：`assets/demo.png`
- 文案：`assets/demo.txt`

只支持 MP4。运行时从视频轨道读取时长和宽高，`width >= height` 自动使用横版发布参数，否则使用
竖版发布参数。单一源封面会在内存中自动生成 1280×720 横版 JPEG 和 1080×1440 竖版 JPEG。

### 上传但不发布

```bash
npm run example:baijiahao
```

默认命令会真实获取 `app_id`、创建预上传任务、依次上传竖版和横版封面、上传并汇总视频分片、
搜索话题并构造发布参数，但不会调用最终发布接口。远端会保留已经上传的视频和封面素材。

### 正式发布

```bash
npm run example:baijiahao -- --publish
```

`--publish` 只增加最后一次 `/pcui/article/publish` 请求。该请求不自动重试，成功响应会输出 `nid`，
作品仍需经过平台审核。视频发布接口没有原包可证实的可见性字段，因此 Demo 不提供可见性参数。

### 覆盖默认素材

```bash
npm run example:baijiahao -- \
  --cookies /path/to/baijiahao.json \
  --video /path/to/video.mp4 \
  --cover /path/to/cover.jpg \
  --text /path/to/description.txt
```

文案第一个非空行作为标题，后续行作为描述。`#话题` 会从描述删除并并发查询，最终只提交文案顺序中
第一个精确匹配的话题；删除话题后描述为空时回退为标题。

### 百家号安全说明

- `assets/125_baijiahao.json` 是完整登录凭据，已由 `.gitignore` 排除，不得提交到仓库。
- Demo 会完整打印 Cookie、封面 token、上传密钥、普通表单内容和响应；封面及视频分片等二进制
  Base64 只保留前 100 个字符，同时打印原始长度和省略字符数。
- 日志仍包含完整登录凭据，终端输出必须按完整登录凭据保存。
- 视频使用 2 MiB 分片、并发数 3；单片失败后按 1、2、4 秒等待，最多请求 4 次。
- 账号、预上传、封面、汇总、话题和最终发布接口均不自动重试。
- 不支持断点续传或失败后的远端素材清理。

## 搜狐号

搜狐号示例按照 [`docs/sohu.md`](../docs/sohu.md) 复刻当前生产版内容管理前端协议。它直接读取
Playwright storage-state，通过 Axios 构造 HTTP 请求，不点击发布页，也不注入 DOM 元素。

### 上传但不发布

```bash
npm run example:sohu
```

该命令会真实创建视频任务、上传并合并 512 KiB 分片、上传和裁剪封面、查询频道并构造发布参数，
但不会调用最终发布接口。生成的请求体会保存到 `assets/sohu-publish-payload.json`。

### 正式发布

```bash
npm run example:sohu -- --publish
```

如果已经执行过“上传但不发布”，可直接发布保存的请求体，避免重复上传：

```bash
npm run example:sohu -- --publish-payload assets/sohu-publish-payload.json
```

如果账号默认频道没有可用的二级分类，可显式传入：

```bash
npm run example:sohu -- --channel-id 15 --video-channel-id 101
```

### 搜狐号安全说明

- `assets/133_sohu.json` 是完整登录凭据，已由 `.gitignore` 排除。
- HTTP 日志会记录请求参数与响应，但 Cookie 会被隐藏。
- 最终发布请求不重试，避免响应不确定时创建重复作品。
