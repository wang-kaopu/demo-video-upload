# 抖音本机发布 endpoint

语义化实现：[../src/platforms/douyin-publisher.ts](../src/platforms/douyin-publisher.ts)

原包类名：`class ud extends oe`

主要凭证：

- `Cookie`：创作者后台登录态。
- `xmst/msToken`：从账号 token / cookie 中提取。
- `X-Secsdk-Csrf-Token`：通过 HEAD 请求拿到。
- VOD/ImageX 临时密钥：由 `upload/auth/v5` 返回的 `auth` JSON 提供。
- `Authorization` / `X-Amz-Content-Sha256`：由本机签名 helper 为 VOD/ImageX 请求生成。

### `xmst` / `msToken` 提取契约

原包通用 helper 接受数组或 JSON 数组字符串，元素结构为 `{ name, value }`，提取优先级为：

1. 从 `account.token` 取第一个 `name === "xmst"` 的 `value`。
2. 未取得时，从 `account.cookie` 取最后一个 `name === "msToken"` 的 `value`。
3. 两处都没有时使用空字符串。

当前本机发布类 `ud.start()` 的字面代码少了 `.value`，会把整个 `{ name, value }` 对象赋给
`msToken`；这是原包缺陷，不应作为新实现的参数格式。可运行实现应始终向 Query 写入字符串值。

原包已经恢复出 webview 双向适配链路：注入脚本遍历 `creator.douyin.com` 的 `localStorage`，
筛选 `xmst` 和名称包含 `security-sdk` 的字段，对 value 执行 `encodeURIComponent()` 后组成
`account.token` 数组，并通过 `/api/helper-client/account/updateCookieAndToken` 保存；恢复 webview
时再执行 `decodeURIComponent()` 和 `localStorage.setItem()`。

原包没有直接接收 Playwright `{ cookies, origins }` 外层结构，但可以用下面的确定性转换补齐。

#### Playwright storage-state 转换

转换同时生成三个结果：

- `cookie`：Electron Cookie 结构的 JSON 数组，供 HTTP Cookie 拼接和 partition 恢复。
- `token`：按原包格式编码后的 `xmst/security-sdk` JSON 数组，供账号保存和 webview 恢复。
- `msToken`：未预编码的原始字符串，供本机发布 Query 使用，由请求序列化器只编码一次。

```ts
interface PlaywrightStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: "Strict" | "Lax" | "None" | null;
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

interface AdaptedDouyinState {
  cookie: string;
  token: string;
  msToken: string;
}

/**
 * 将 Playwright storage-state 转换为抖音本机发布和 Electron partition 可消费的账号状态。
 */
function adaptDouyinStorageState(
  state: PlaywrightStorageState,
): AdaptedDouyinState {
  const creatorState = state.origins.find(
    ({ origin }) => origin === "https://creator.douyin.com",
  );

  if (!creatorState) {
    throw new Error("storage-state 缺少 creator.douyin.com localStorage");
  }

  const selectedStorage = creatorState.localStorage.filter(
    ({ name }) => name === "xmst" || name.includes("security-sdk"),
  );
  const xmst = selectedStorage.find(({ name }) => name === "xmst")?.value;
  const cookieMsToken = [...state.cookies]
    .reverse()
    .find(({ name }) => name === "msToken")?.value;
  const msToken = xmst || cookieMsToken;

  if (!msToken) {
    throw new Error("storage-state 缺少 xmst 和 msToken");
  }

  const tokenEntries = selectedStorage.map(({ name, value }) => ({
    name,
    value: encodeURIComponent(value),
    session: false,
    expirationDate: 255033043504,
  }));

  const cookies = state.cookies.map(({ expires, sameSite, ...cookie }) => ({
    ...cookie,
    sameSite:
      sameSite === "None"
        ? "no_restriction"
        : sameSite
          ? sameSite.toLowerCase()
          : "unspecified",
    session: expires < 0,
    ...(expires >= 0 ? { expirationDate: expires } : {}),
  }));

  return {
    cookie: JSON.stringify(cookies),
    token: JSON.stringify(tokenEntries),
    msToken,
  };
}
```

调用方式：

```ts
const storageState = JSON.parse(storageStateText) as PlaywrightStorageState;
const adapted = adaptDouyinStorageState(storageState);

account.cookie = adapted.cookie;
account.token = adapted.token;
publishContext.msToken = adapted.msToken;
```

适配规则：

1. 只读取精确 origin `https://creator.douyin.com`，不能跨 origin 或跨账号合并。
2. `account.token` 保存编码值，恢复 webview 时解码一次；本机 HTTP 请求直接使用原始 `msToken`。
3. Playwright `expires` 转为 Electron `expirationDate/session`；`sameSite=None` 转为
   Electron 的 `no_restriction`，缺失或为 `null` 时转为 `unspecified`。
4. localStorage 没有 `xmst` 时，按原包优先级回退到 Cookie 中最后一个 `msToken`。
5. creator origin、`xmst/msToken` 缺失时直接报错，避免静默使用错误账号的登录态。
6. storage-state 是完整登录凭据，不得写入日志或提交到版本库。

如果发布器只能接收 `account.token`，读取 `xmst` 时必须取 `.value` 并执行一次
`decodeURIComponent()`；更推荐直接传递适配器返回的原始 `msToken`，从结构上避免重复编码。

## 调用顺序

```text
HEAD /web/api/media/anchor/search             -> 获取 X-Secsdk-Csrf-Token
GET  /web/api/media/user/info/                -> 获取 uid / 账号信息
GET  /web/api/media/upload/auth/v5/           -> 获取 VOD/ImageX 临时密钥
GET  https://vod.bytedanceapi.com/            -> ApplyUploadInner，拿视频上传节点
POST {videoUploadUrl}?phase=init              -> 多分片时初始化 uploadid
POST {videoUploadUrl}?phase=transfer          -> 上传视频分片
POST {videoUploadUrl}?phase=finish            -> 多分片时完成分片上传
POST https://vod.bytedanceapi.com/            -> CommitUploadInner，拿 Vid / PosterUri
GET  /web/api/media/video/enable/             -> 校验视频可用
GET  /web/api/media/video/transend/           -> 校验视频转码/上传状态
GET  https://imagex.bytedanceapi.com          -> ApplyImageUpload，拿封面上传节点
POST {imageUploadUrl}                         -> 上传封面二进制
POST https://imagex.bytedanceapi.com          -> CommitImageUpload，拿封面 Uri
GET  /aweme/v1/creator/get/url/               -> 把封面 Uri 换成可访问 URL
GET  /aweme/v1/search/challengesug/           -> 可选：搜索话题
POST /api/helper-client/config/getDySign      -> 原包通过 NewRank helper 生成 a_bogus
本机 bdms + CDP Fetch 拦截                 -> 已验证的本机 a_bogus 替代方案
POST /web/api/media/aweme/create_v2/          -> 发布作品
```

## 1. 获取 csrf token

- 方法：`HEAD`
- URL：`https://creator.douyin.com/web/api/media/anchor/search`
- 原包封装：`QK`
- 语义化调用：`douyinHttp.getCsrfToken`
- 用途：从响应头拿 `x-ware-csrf-token`，拆出 `X-Secsdk-Csrf-Token`。

Headers：

```text
Cookie: <account.cookie>
Referer: https://creator.douyin.com/creator-micro/content/publish
X-Secsdk-Csrf-Request: 1
X-Secsdk-Csrf-Version: 1.2.22
```

关键返回：

```text
x-ware-csrf-token: <prefix>,<csrfToken>
```

## 2. 获取账号信息

- 方法：`GET`
- URL：`https://creator.douyin.com/web/api/media/user/info/`
- 原包封装：`reqGetDYUserInfo`
- 语义化调用：`douyinHttp.getAccountInfo`
- 用途：获取 VOD 上传请求需要的 `uid`。

Headers：

```text
Cookie: <account.cookie>
```

Query：

```json
{
  "msToken": "<msToken>",
  "a_bogus": ""
}
```

关键返回：

```json
{
  "user": {
    "uid": "...",
    "sec_uid": "...",
    "nickname": "..."
  }
}
```

## 3. 获取上传临时密钥

- 方法：`GET`
- URL：`https://creator.douyin.com/web/api/media/upload/auth/v5/`
- 原包封装：`$ae`
- 语义化调用：`douyinHttp.getUploadAuth`
- 用途：返回 VOD/ImageX 请求签名需要的临时密钥。

Headers：

```text
Cookie: <account.cookie>
Referer: https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page
X-Secsdk-Csrf-Token: <csrfToken>
```

Query：

```json
{
  "cookie_enabled": true,
  "screen_width": "<screen width>",
  "screen_height": "<screen height>",
  "browser_language": "zh-CN",
  "browser_platform": "<MacIntel or Win32>",
  "browser_name": "Mozilla",
  "browser_version": "<UA 中第一个 / 后的完整内容>",
  "browser_online": true,
  "timezone_name": "Asia/Shanghai",
  "aid": 1128,
  "support_h265": 1,
  "msToken": "<msToken>"
}
```

原包直接使用 `window.screen.width`、`window.screen.height`、`navigator.platform` 和运行时
`getUA()` 生成这些字段：macOS 必须使用 macOS UA + `MacIntel`，Windows 必须使用 Windows
UA + `Win32`。独立的本机实现可以显式构造固定设备配置，但同一次发布中的 UA、平台和屏幕参数
必须来自同一配置，不能把 macOS 参数与 Windows 示例混用。

关键返回：

```json
{
  "auth": "{\"AccessKeyID\":\"...\",\"SecretAccessKey\":\"...\",\"SessionToken\":\"...\"}"
}
```

### 3.1 原包 VOD/ImageX V4 签名规则

直接证据：

- `main.js:189`：`sign$3`、`queryParamsToString`、`getSignHeaders`、`uriEscape` 和 Body SHA256 的完整实现。
- `main.js:1395`：`ipcMain.handle("getSignature", ..., sign$3)`。
- `resources/render/assets/index-CMt0gaRu.js:1010`：第 4、8、11、13 步传入的完整 `signParams`。
- `resources/render/assets/index-HDonhX6R.js:1550`：`vod/imagex`、`cn-north-1` 和接口版本常量。

原包实现是 AWS4 命名的 V4 变体，不能直接替换为公开文档示例中的算法名和 scope：

```text
Algorithm       = AWS4-HMAC-SHA256
CredentialScope = YYYYMMDD/region/service/aws4_request
kSecret         = "AWS4" + SecretAccessKey
```

签名输入结构：

```ts
interface SignatureInput {
  headers: Record<string, string>;
  query: Record<string, unknown>;
  region: string;
  serviceName: string;
  method: string;
  pathName?: string;
  accessKeyId: string;
  secretAccessKey: string;
  needSignHeaderKeys?: string[];
  data?: unknown;
}
```

四个请求都没有传 `pathName`，签名器使用默认值 `/`。CanonicalRequest 的准确结构为：

```text
UPPERCASE_METHOD
/
CanonicalQueryString
CanonicalHeaders

SignedHeaders
SHA256Payload
```

`CanonicalHeaders` 和 `SignedHeaders` 之间保留一个空行。

Canonical Query 规则：

1. 使用 JavaScript 默认字典序对原始 key 排序。
2. key/value 分别按 RFC3986 风格编码；空格编码为 `%20`。
3. `undefined` 和 `null` 跳过，空字符串保留为 `key=`。
4. 数组值编码后排序，并使用重复 key 拼接。
5. 最终使用 `&` 连接所有参数。

签名 Header 规则：

- 默认候选集合为 `x-amz-date`、`x-amz-security-token`、`host`，但只签名输入对象中实际存在的 Header。
- `needSignHeaderKeys` 可以增加候选 Header；两个 POST Commit 请求只增加 `x-amz-content-sha256`。
- Header 名转小写后排序；值执行 `trim()` 并将连续空白压缩为一个空格。
- 原包明确忽略 `authorization`、`content-type`、`content-length`、`user-agent`、`presigned-expires` 和 `expect`。
- 原包没有把 `Host` 放入 `signParams.headers`，所以这四个请求的 `host` 不参与签名。
- `Origin` 和 `Referer` 在签名完成后才加入 HTTP 请求，不参与签名。

时间、Body 和临时令牌规则：

```text
X-Amz-Date = UTC YYYYMMDDTHHMMSSZ
ShortDate  = X-Amz-Date.substring(0, 8)
```

- GET 没有 `data`，Canonical payload 使用 `SHA256("")`，不发送 `X-Amz-Content-Sha256`。
- POST 使用 `SHA256(JSON.stringify(data))`，结果同时写入 CanonicalRequest 和 `X-Amz-Content-Sha256`。
- `AccessKeyID` 写入 Authorization Credential。
- `SecretAccessKey` 参与 HMAC 密钥派生。
- `SessionToken` 作为 `X-Amz-Security-Token` 发送，并参与 CanonicalHeaders。

密钥派生和 Authorization：

```text
kDate    = HMAC-SHA256("AWS4" + SecretAccessKey, ShortDate)
kRegion  = HMAC-SHA256(kDate, region)
kService = HMAC-SHA256(kRegion, serviceName)
kSigning = HMAC-SHA256(kService, "aws4_request")
Signature = HEX(HMAC-SHA256(kSigning, StringToSign))

Authorization: AWS4-HMAC-SHA256 Credential=<AccessKeyID>/<scope>, SignedHeaders=<headers>, Signature=<signature>
```

密钥派生顺序中只有一次 `kRegion = HMAC-SHA256(kDate, region)`；重复出现 `kRegion` 属于旧文档
笔误，不代表需要执行两次 region 派生。

公开的火山引擎 [V4 签名规范](https://www.volcengine.com/docs/6392/1272450?lang=zh)
和 [ApplyImageUpload 文档](https://api.volcengine.com/api-docs/view?action=ApplyImageUpload&serviceCode=ImageX&version=2018-08-01)
用于理解协议背景；本机发布必须以原包上述规则为准。

## 4. 申请视频上传节点

- 方法：`GET`
- URL：`https://vod.bytedanceapi.com/`
- 原包封装：`hIt`
- 语义化调用：`douyinHttp.signVodRequest`
- 用途：执行 `ApplyUploadInner`，获取视频上传 host、store uri、auth、session key。

Headers：

```text
Origin: https://creator.douyin.com
Referer: https://creator.douyin.com/
Authorization: <signed authorization>
X-Amz-Date: <amz date>
X-Amz-Security-Token: <SessionToken>
```

Query：

```json
{
  "Action": "ApplyUploadInner",
  "Version": "2020-11-19",
  "SpaceName": "aweme",
  "FileType": "video",
  "IsInner": 1,
  "FileSize": "<videoFile.size>",
  "app_id": 2906,
  "user_id": "<uid>",
  "s": "<random>"
}
```

V4 签名输入：

```text
serviceName  = vod
region       = cn-north-1
method       = GET
pathName     = /
SignedHeaders = x-amz-date;x-amz-security-token
SHA256Payload = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Canonical Query 顺序：

```text
Action=ApplyUploadInner&FileSize=<bytes>&FileType=video&IsInner=1&SpaceName=aweme&Version=2020-11-19&app_id=2906&s=<random>&user_id=<uid>
```

关键返回路径：

```text
Result.InnerUploadAddress.UploadNodes[0]
  .UploadHost
  .StoreInfos[0].StoreUri
  .StoreInfos[0].Auth
  .SessionKey
```

后续处理：

```text
videoUploadUrl = "https://" + UploadHost + "/upload/v1/" + StoreUri
uploadHeaders = Host + Authorization + X-Storage-U
```

当前本机发布只消费上述四个节点字段；实现这条链路不需要猜测 `UploadNodes[0]` 的其他字段。

## 5. 初始化视频分片上传

- 方法：`POST`
- URL：`{videoUploadUrl}`
- 原包封装：`VuA`
- 语义化调用：`douyinHttp.initVideoPartUpload`
- 用途：多分片上传时初始化 `uploadid`。

原包当前“本机发布”入口的分片运行契约：

- 固定分片大小为 `5 * 1024 * 1024`，即 5 MiB。
- `chunkNum = ceil(file.size / 5 MiB)`；只有 `chunkNum > 1` 才执行本步骤。
- 因此文件大小严格大于 5 MiB 才初始化 multipart；恰好 5 MiB 仍走单分片。
- 视频分片并发上限为 3，不是顺序上传；结果数组仍按 part 顺序保存。
- 每片首次失败后最多重试 3 次，等待时间依次为 1 秒、2 秒、4 秒，即单片最多请求 4 次。
- 旧发布工厂 `oI` 的默认并发 2 不是当前 UI“本机发布”入口的契约。

注意：语义化文件中如果仍定义 `20 MiB` 分片常量，则与原包 `ud` 的 5 MiB 直接证据不符。

Query：

```json
{
  "uploadmode": "part",
  "phase": "init"
}
```

Body：

```text
FormData()
```

关键返回：

```json
{
  "code": 2000,
  "data": {
    "uploadid": "..."
  }
}
```

## 6. 上传视频分片

- 方法：`POST`
- URL：`{videoUploadUrl}`
- 原包封装：`VuA`
- 语义化调用：`douyinHttp.uploadVideoChunk`
- 用途：上传视频单分片或多分片中的一个 part。

Headers：

```text
Content-Disposition: attachment; filename="undefined"
Content-Type: application/octet-stream
Content-Crc32: <crc32>
Host: <UploadHost>
Authorization: <StoreInfos[0].Auth>
X-Storage-U: <uid>
```

多分片 Query：

```json
{
  "uploadid": "<uploadid>",
  "part_number": 1,
  "phase": "transfer",
  "part_offset": 0
}
```

单分片场景不带 Query。

Body：

```text
ArrayBuffer(chunk)
```

`Content-Crc32` 的准确算法和格式为：

```ts
(CRC32.buf(new Uint8Array(chunk)) >>> 0).toString(16)
```

- 原包内置依赖为 `crc-32@1.2.2`，使用标准 CRC-32/IEEE 计算。
- `>>> 0` 把有符号结果转换为无符号 32 位整数。
- 输出为小写十六进制，不带 `0x`，并且不补齐到 8 位。
- VOD 视频分片和 ImageX 封面二进制使用完全相同的算法和输出格式。
- 多分片的 `part_offset = min(file.size, (part_number - 1) * 5 MiB)`。

成功条件：

```json
{
  "code": 2000,
  "data": {}
}
```

多分片场景下，服务端响应 `data` 需要提供 `part_number` 和 `crc32`。第 7 步 finish Body 使用服务端
返回的 `${part_number}:${crc32}`，不是重新使用本地计算的 `Content-Crc32` Header 值。

## 7. 完成视频分片上传

- 方法：`POST`
- URL：`{videoUploadUrl}`
- 原包封装：`fIt`
- 语义化调用：`douyinHttp.finishVideoPartUpload`
- 用途：多分片上传时通知 VOD 合并所有 part。

Headers：

```text
Content-Type: text/plain;charset=UTF-8
Host: <UploadHost>
Authorization: <StoreInfos[0].Auth>
X-Storage-U: <uid>
```

Query：

```json
{
  "uploadmode": "partial",
  "phase": "finish",
  "uploadid": "<uploadid>"
}
```

Body：

```text
part_number:crc32,part_number:crc32
```

## 8. 提交视频上传

- 方法：`POST`
- URL：`https://vod.bytedanceapi.com/`
- 原包封装：`pIt`
- 语义化调用：`douyinHttp.signVodRequest`
- 用途：执行 `CommitUploadInner`，生成发布接口需要的 `Vid` 和 `PosterUri`。

Headers：

```text
Origin: https://creator.douyin.com
Referer: https://creator.douyin.com/
Authorization: <signed authorization>
X-Amz-Content-Sha256: <signed sha256>
X-Amz-Date: <amz date>
X-Amz-Security-Token: <SessionToken>
```

Query：

```json
{
  "Action": "CommitUploadInner",
  "Version": "2020-11-19",
  "SpaceName": "aweme",
  "app_id": 2906,
  "user_id": "<uid>"
}
```

Body：

```json
{
  "SessionKey": "<video upload SessionKey>",
  "Functions": [
    { "name": "GetMeta" },
    {
      "name": "Snapshot",
      "input": { "SnapshotTime": 0 }
    }
  ]
}
```

V4 签名输入：

```text
serviceName   = vod
region        = cn-north-1
method        = POST
pathName      = /
SignedHeaders = x-amz-content-sha256;x-amz-date;x-amz-security-token
```

Canonical Query：

```text
Action=CommitUploadInner&SpaceName=aweme&Version=2020-11-19&app_id=2906&user_id=<uid>
```

参与哈希并必须原样发送的 Body：

```text
{"SessionKey":"<video upload SessionKey>","Functions":[{"name":"GetMeta"},{"name":"Snapshot","input":{"SnapshotTime":0}}]}
```

```text
X-Amz-Content-Sha256 = SHA256(<上面的 UTF-8 Body 字节>)
```

关键返回路径：

```text
Result.Results[0].Vid
Result.Results[0].PosterUri
```

原包只校验 `Result.Results` 非空并要求后续使用 `Vid`；`PosterUri` 缺失时仍继续调用
`video/enable`、`video/transend` 和自定义封面上传。当前接口可能只返回 `Vid` 与 `VideoMeta`，因此
复刻实现不能把 `PosterUri` 作为第 8 步的强制成功条件。

## 9. 校验视频可用性

- 方法：`GET`
- URL：`https://creator.douyin.com/web/api/media/video/enable/`
- 原包封装：`cIt`
- 语义化调用：`douyinHttp.verifyVideo`
- 用途：提交发布前检查视频是否可用。

Headers：

```text
Cookie: <account.cookie>
Referer: https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page
X-Secsdk-Csrf-Token: <csrfToken>
```

Query：

```json
{
  "...commonParams": "...",
  "msToken": "<msToken>",
  "video_id": "<Vid>"
}
```

## 10. 校验视频转码状态

- 方法：`GET`
- URL：`https://creator.douyin.com/web/api/media/video/transend/`
- 原包封装：`uIt`
- 语义化调用：`douyinHttp.verifyVideo`
- 用途：检查上传/转码状态。

Headers 和 Query 与 `video/enable` 同类。

### 第 9、10 步的原包响应契约

原包在 `CommitUploadInner` 成功后按顺序各调用一次 `video/enable` 和 `video/transend`：

```text
await video/enable
await video/transend
继续封面上传和发布
```

代码不读取两个请求的响应 Body，也没有成功码、处理中状态、失败状态、轮询间隔或最大轮询次数。
HTTP/网络错误由请求封装抛出并中断流程；请求正常返回即继续。因此复刻原包只需要各等待一次。
如果要实现可靠的转码状态轮询，需要基于真实响应抓包另行设计，不能声称来自原包。

两个请求的 ID 参数名都是 `video_id`，不是 `vid`，并且 Query 必须包含完整 `commonParams`、
`msToken` 和 `video_id`。

## 11. 申请封面上传节点

- 方法：`GET`
- URL：`https://imagex.bytedanceapi.com`
- 原包封装：`ABe`
- 语义化调用：`douyinHttp.applyImageUpload`
- 用途：执行 `ApplyImageUpload`，获取 ImageX 上传节点。

Headers：

```text
Origin: https://creator.douyin.com
Referer: https://creator.douyin.com/
Authorization: <signed authorization>
X-Amz-Date: <amz date>
X-Amz-Security-Token: <SessionToken>
```

Query：

```json
{
  "Action": "ApplyImageUpload",
  "Version": "2018-08-01",
  "ServiceId": "jm8ajry58r",
  "app_id": 2906,
  "user_id": "",
  "s": "<random>"
}
```

V4 签名输入：

```text
serviceName   = imagex
region        = cn-north-1
method        = GET
pathName      = /
SignedHeaders = x-amz-date;x-amz-security-token
SHA256Payload = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Canonical Query：

```text
Action=ApplyImageUpload&ServiceId=jm8ajry58r&Version=2018-08-01&app_id=2906&s=<random>&user_id=
```

关键返回路径：

```text
Result.InnerUploadAddress.UploadNodes[0]
  .UploadHost
  .StoreInfos[0].StoreUri
  .StoreInfos[0].Auth
  .SessionKey
```

原包构造 ImageX 上传地址的准确规则：

```text
imageUploadUrl = "https://" + UploadHost + "/upload/v1/" + StoreInfos[0].StoreUri
```

上传二进制时使用 `StoreInfos[0].Auth` 作为 `Authorization`，第 13 步使用同一个节点的
`SessionKey` 构造 Commit Body。当前链路不依赖 `UploadNodes[0]` 的其他字段。

## 12. 上传封面二进制

- 方法：`POST`
- URL：`{imageUploadUrl}`
- 原包封装：`eBe`
- 语义化调用：`douyinHttp.uploadImage`
- 用途：上传横版或竖版封面。

Headers：

```text
Content-Type: application/octet-stream
Authorization: <StoreInfos[0].Auth>
Content-Crc32: <crc32>
Origin: https://creator.douyin.com
Referer: https://creator.douyin.com/
```

这里的 `Content-Crc32` 与第 6 步完全相同：`crc-32@1.2.2` 计算结果先执行 `>>> 0`，再调用
`.toString(16)`；输出为不带 `0x`、不补零的小写十六进制字符串。

Body：

```text
ArrayBuffer(coverBlob)
```

成功条件：

```json
{
  "code": 2000,
  "data": {}
}
```

## 13. 提交封面上传

- 方法：`POST`
- URL：`https://imagex.bytedanceapi.com`
- 原包封装：`tBe`
- 语义化调用：`douyinHttp.commitImageUpload`
- 用途：执行 `CommitImageUpload`，拿封面 `Uri`。

Headers：

```text
Origin: https://creator.douyin.com
Referer: https://creator.douyin.com/
Authorization: <signed authorization>
X-Amz-Content-Sha256: <signed sha256>
X-Amz-Date: <amz date>
X-Amz-Security-Token: <SessionToken>
```

Query：

```json
{
  "Action": "CommitImageUpload",
  "Version": "2018-08-01",
  "ServiceId": "jm8ajry58r",
  "app_id": 2906,
  "user_id": ""
}
```

Body：

```json
{
  "SessionKey": "<image upload SessionKey>"
}
```

V4 签名输入：

```text
serviceName   = imagex
region        = cn-north-1
method        = POST
pathName      = /
SignedHeaders = x-amz-content-sha256;x-amz-date;x-amz-security-token
```

Canonical Query：

```text
Action=CommitImageUpload&ServiceId=jm8ajry58r&Version=2018-08-01&app_id=2906&user_id=
```

参与哈希并必须原样发送的 Body：

```text
{"SessionKey":"<image upload SessionKey>"}
```

```text
X-Amz-Content-Sha256 = SHA256(<上面的 UTF-8 Body 字节>)
```

关键返回：

```text
Result.Results[0].Uri
Result.Results[0].UriStatus === 2000
```

## 14. 获取封面访问 URL

- 方法：原包通过 `qA.get(...)` 调用；其 config 内又残留 `method: "post"`，存在封装层冲突
- URL：`https://creator.douyin.com/aweme/v1/creator/get/url/`
- 原包封装：`wIt`
- 语义化调用：`douyinHttp.getImageUrl`
- 用途：把 ImageX `Uri` 换成可访问 URL；发布接口仍主要使用 `Uri`。

Headers：

```text
Cookie: <account.cookie>
Origin: https://creator.douyin.com
Referer: https://creator.douyin.com/
```

Query：

```json
{
  "...commonParams": "...",
  "uri": "<image Uri>"
}
```

调用 API 的直接证据偏向 `GET`，但 `wIt` 内部同时出现 `method: "post"`。在没有恢复 `qA.get`
最终 method 覆盖顺序或抓取真实请求前，不能把 wire method 写成完全确定；当前复刻可按 GET 实现，
需要与线上绝对一致时应通过抓包确认。

成功响应路径：

```json
{
  "status_code": 0,
  "url": "https://..."
}
```

原包只在 `response.data.status_code === 0` 且 `response.data.url` 非空时采用该 URL。失败或缺少
`url` 时不抛错，而是把 `coverUrl` 置为空字符串；后续发布参数仍主要使用 ImageX `Uri`。

## 15. 搜索话题

- 方法：`GET`
- URL：`https://creator.douyin.com/aweme/v1/search/challengesug/`
- 原包封装：`LrA`
- 语义化调用：`douyinHttp.searchTopic`
- 用途：把描述中的 `#话题` 转成 `challenge` 对象。

Headers：

```text
Cookie: <account.cookie>
Referer: https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page
```

Query：

```json
{
  "...commonParams": "...",
  "source": "challenge_create",
  "aid": 2906,
  "keyword": "<topicName>"
}
```

关键返回：

```text
sug_list[].cha_name
sug_list[].cid / challenge_id
```

## 16. 获取 `a_bogus` 签名

- 方法：`POST`
- URL：`/api/helper-client/config/getDySign`
- 服务：NewRank helper 服务，不是抖音平台 endpoint。
- 原包封装：`DaA`
- 语义化调用：`douyinHttp.getABogus`
- 用途：根据即将提交的完整 URL、User-Agent 和发布 Body 生成 `create_v2` 所需的 `a_bogus`。

原包只提供相对路径，实际 host 由 NewRank HTTP client 的 `baseURL` 决定。该请求还会继承
HTTP client 的登录态或认证拦截器，不能把相对路径当成一个无需认证的公开接口。

调用本步骤前必须先构造第 17 步使用的 `queryString` 和 `bodyText`。签名成功后，将返回的
`result.a_bogus` 加入第 17 步最终 Query。

Headers：

```text
Content-Type: application/json
```

认证信息由 NewRank HTTP client 的登录态或请求拦截器注入；当前原包证据未确认具体 Header 名称，
不要自行硬编码为 `Authorization` 或 `Cookie`。

Body：

```json
{
  "uri": "https://creator.douyin.com/web/api/media/aweme/create_v2/?<完整待签名 query>",
  "ua": "<与最终发布请求一致的完整 User-Agent>",
  "data": "<与最终发布请求一致的 JSON.stringify(publishParams)>"
}
```

成功返回：

```json
{
  "success": true,
  "result": {
    "a_bogus": "<签名结果>"
  }
}
```

原包仅在 `success === true` 且 `result.a_bogus` 非空时继续发布，否则抛出
`获取加密参数 a_bogus失败`。

### 16.1 已验证的本机替代请求

Windows 远程机器 `dev` 的真实抖音 partition 已完成只读取证。对应账号使用：

```text
%AppData%\小豆芽\Partitions\1783645517194
Electron partition: persist:1783645517194
```

创作者中心实际加载以下安全 SDK：

```text
https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/stable/1.0.1.16/bdms.js
https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/1.0.0.62/sdk-glue.js
https://lf-security.bytegoofy.com/obj/security-secsdk/runtime_bundler_40.js
https://lf1-cdn-tos.bytegoofy.com/obj/goofy/secsdk/secsdk-lastest.umd.js
```

其中 `bdms.js` 与 Chromium 缓存中的文件 SHA-256 完全一致。页面没有
`window.byted_acrawler`，当前签名入口是 `window.bdms.init` 以及 SDK glue 安装的
Fetch/XMLHttpRequest 请求拦截链。`bdms v1.0.1.16` 的真实运行时配置为：

```json
{
  "aid": 2906,
  "pageId": 33638,
  "boe": false,
  "ddrt": 3,
  "dump": true,
  "paths": {
    "include": [
      "/\\/aweme/",
      "/\\/web\\/api/",
      "/\\/passport/",
      "/\\/bind_mobile/",
      "/\\/live\\/api\\/room\\/create_media_room/"
    ],
    "exclude": []
  }
}
```

这里的内部 `aid: 2906` 和 `pageId: 33638` 是 BDMS 初始化配置，不能替换外层 Query
里的 `aid: 1128` 或 `read_aid: 2906`。三者属于不同协议层。

本机签名按以下步骤作为第 16 步单独执行：

1. 使用账号真实 `persist:<accountId>` 创建隐藏 Electron Webview，并传入该账号的
   `envConf`、User-Agent 和 partition。
2. 加载 `https://creator.douyin.com/creator-micro/home`，等待 `document.readyState === "complete"`
   且 `window.bdms`、`window._SdkGlueInit` 已初始化。
3. 构造第 17 步最终 URL 和唯一的 `bodyText`，此时不要添加 `a_bogus`，也不要改动
   Query 的插入顺序。
4. 对该 Webview 的 CDP target 调用 `Fetch.enable`，在
   `requestStage: "Request"` 拦截目标 `create_v2` URL。
5. 在 Webview 内使用 Fetch 或 XMLHttpRequest 发起相同方法、URL、Headers 和原始 Body。
   BDMS 会在请求进入 CDP 拦截点前追加或确认 `msToken`，并生成 `a_bogus`。
6. 从 `Fetch.requestPaused.request.url` 读取最终 `msToken`、`a_bogus` 和参数顺序，随后立即调用
   `Fetch.failRequest({ errorReason: "Aborted" })`。该行为已验证会在请求发往网络前终止请求。
7. 销毁临时 Webview；将捕获的最终 URL 与同一份 `bodyText` 交给第 17 步本机 HTTP client。

最小 CDP 拦截逻辑：

```ts
await cdp.send("Fetch.enable", {
  patterns: [{ urlPattern: "*create_v2*", requestStage: "Request" }],
});

cdp.on("Fetch.requestPaused", async (event) => {
  const signedUrl = event.request.url;
  const url = new URL(signedUrl);
  const aBogus = url.searchParams.get("a_bogus");
  const msToken = url.searchParams.get("msToken");

  await cdp.send("Fetch.failRequest", {
    requestId: event.requestId,
    errorReason: "Aborted",
  });

  resolve({ signedUrl, aBogus, msToken });
});
```

真实运行时已验证 GET 和 POST 都会签名，POST 的原始 Body 参与签名；原 Query 保持原顺序，
SDK 在其后追加 `msToken`、`a_bogus`。实测输出出现 184 和 188 字符，NewRank helper 样本出现
188 和 192 字符，因此不得按固定长度判断版本或合法性。

## 17. 提交发布

- 方法：`POST`
- URL：`https://creator.douyin.com/web/api/media/aweme/create_v2/`
- 原包封装：`DIt`
- 语义化调用：`douyinHttp.publish`
- 用途：提交最终作品。

### 17.1 请求头

```text
Cookie: <account.cookie>
Referer: https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page
X-Secsdk-Csrf-Token: <csrfToken>
bd-ticket-guard-client-data: <from token/local security data>
```

### 17.2 最终 Query 结构

```json
{
  "read_aid": 2906,
  "...commonParams": "...",
  "msToken": "<msToken>",
  "a_bogus": "<computed a_bogus>"
}
```

### 17.3 构造发布 Body

```json
{
  "common": {
    "text": "<title + description + topics>",
    "caption": "<caption>",
    "item_title": "<title>",
    "text_extra": "[...]",
    "challenges": "[...]",
    "visibility_type": 1,
    "download": 1,
    "timing": 0,
    "media_type": 4,
    "video_id": "<Vid>"
  },
  "cover": {
    "poster": "<vertical cover Uri or PosterUri>",
    "custom_cover_image_height": "<vertical height>",
    "custom_cover_image_width": "<vertical width>",
    "horizontal_custom_cover_image_uri": "<horizontal cover Uri>",
    "horizontal_custom_cover_image_height": "<horizontal height>",
    "horizontal_custom_cover_image_width": "<horizontal width>"
  },
  "sync": {
    "dx_upgraded": 1,
    "should_sync": false,
    "sync_to_toutiao": 0
  }
}
```

### 17.4 构造签名输入与本机运行时方案

#### 与第 16 步的关系

原包发布链路通过第 16 步的 NewRank helper 请求获取 `a_bogus`，没有暴露可供 Node.js
直接调用的纯函数。真实抖音 partition 中存在官方 `bdms` SDK，可按第 16.1 节使用本机
Webview + CDP 请求拦截替代远程 helper。两条路径的签名输入都必须包含最终查询参数、完整 UA
和最终发送的 JSON 字符串；不能只传基础 URL，也不能使用 `desktop` 之类的 UA 占位符。

#### 本机设备配置

原包渲染进程直接依赖 `window.screen`、`navigator.platform` 和运行时 UA。抽取后的独立本机实现
不应隐式依赖浏览器全局，而应明确构造一套与原包字段一致的设备配置，并保证 UA、平台和
`commonParams` 一直使用同一套值。例如 Windows 配置：

```ts
const machineProfile = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/138.0.0.0 Safari/537.36",
  screenWidth: 1920,
  screenHeight: 1080,
  platform: "Win32",
  language: "zh-CN",
  timezone: "Asia/Shanghai",
};
```

macOS 配置应同时使用 macOS UA 和 `platform: "MacIntel"`，不能混用 Windows UA。

#### 完整参数构造

原包通过 UA 中第一个 `/` 拆分浏览器名称和版本，所以 `browser_name` 的实际值是
`Mozilla`，不是 `Chrome`：

```ts
const slashIndex = machineProfile.userAgent.indexOf("/");

const commonParams = {
  cookie_enabled: true,
  screen_width: machineProfile.screenWidth,
  screen_height: machineProfile.screenHeight,
  browser_language: machineProfile.language,
  browser_platform: machineProfile.platform,
  browser_name: machineProfile.userAgent.slice(0, slashIndex),
  browser_version: machineProfile.userAgent.slice(slashIndex + 1),
  browser_online: true,
  timezone_name: machineProfile.timezone,
  aid: 1128,
  support_h265: 1,
};

const signingParams = {
  ...commonParams,
  read_aid: 2906,
  msToken,
};
```

`msToken` 来自当前抖音账号登录态。`commonParams` 本身不包含 `read_aid`、`msToken`
和 `a_bogus`；后三者属于具体接口的附加参数。

签名 query 的字段顺序为：

```text
cookie_enabled
screen_width
screen_height
browser_language
browser_platform
browser_name
browser_version
browser_online
timezone_name
aid
support_h265
read_aid
msToken
```

#### 查询参数序列化

签名和最终请求必须共用同一个序列化结果。不要排序字段，也不要让 HTTP 库在签名后重新编码：

```ts
/**
 * 按原包规则序列化用于抖音签名和请求的查询参数。
 *
 * @param params - 保持插入顺序的查询参数
 * @returns 已执行 URI 编码的查询字符串
 */
function serializeQuery(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  return Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
}
```

#### 请求体序列化

请求体只能执行一次 `JSON.stringify`。参与签名的字符串必须原样作为最终 HTTP Body 发送：

```ts
const queryString = serializeQuery(signingParams);
const bodyText = JSON.stringify(publishPayload);
const signingUri =
  `https://creator.douyin.com/web/api/media/aweme/create_v2/?${queryString}`;
```

不能在生成 `a_bogus` 后重新构造对象或再次序列化另一份 Body，否则字段顺序或内容可能发生变化，
导致签名与请求不一致。

#### 纯算法自实现状态

不能直接移植 `f2 0.0.3` 的 `ABogus` 实现作为当前创作者中心签名器。对 NewRank 当前
188/192 字符样本执行逆向解码时，指纹长度、XOR 校验和、时间戳以及 `aid/pageId/options`
三个关键不变量均不成立；`f2` 现有测试也只覆盖 164/168/172 字符格式。

真实 `bdms v1.0.1.16` 已完整取得，但核心通过自定义字节码解释器执行，并依赖浏览器指纹、
时间、随机状态和页面安全运行时。当前可以确认：

- 外层 Query 的 `aid` 是 1128，`read_aid` 是 2906。
- BDMS 内部初始化参数是 `aid: 2906`、`pageId: 33638`、`ddrt: 3`。
- 最终 Query、完整 UA、原始 POST Body 和 Query 中的 `msToken` 均参与签名。
- 相同输入仍会因时间、随机数和运行时状态产生不同结果。
- 输出长度不是固定协议字段，当前至少观察到 184/188/192。

因此，现阶段的“本地签名”应指第 16.1 节的本机浏览器安全运行时，而不是未经接口验收的
TypeScript/Python 纯算法。只有完成 BDMS 字节码反编译、浏览器状态抽象和真实 `create_v2`
验收后，才能把该运行时替换为纯 Node.js 实现。

### 17.5 发送最终请求

```ts
const finalQuery =
  `${queryString}&a_bogus=${encodeURIComponent(aBogus)}`;
const url =
  `https://creator.douyin.com/web/api/media/aweme/create_v2/?${finalQuery}`;

await http.post(url, bodyText, {
  headers: {
    "Content-Type": "application/json",
    "User-Agent": machineProfile.userAgent,
    Cookie: cookieHeader,
    Referer:
      "https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page",
    "X-Secsdk-Csrf-Token": csrfToken,
    "bd-ticket-guard-client-data": ticketGuardClientData,
  },
  transformRequest: [(data) => data],
});
```

`queryString` 中的 `msToken` 已经编码一次；不要在拼接最终 URL 前再次编码整段 query。

### 17.6 发布结果

```json
{
  "status_code": 0,
  "item_id": "..."
}
```

### 17.6.1 当前 Demo 实现

`examples/douyin-upload.ts` 是 Node CLI，负责参数校验和启动固定版本 Electron。Electron 主进程：

- 把 `assets/douyin` 作为独立 `userData/sessionData` 根目录；
- 通过 `session.fromPath(assets/douyin/<partition id>)` 直接打开复制的账号 Session；
- 创建两个 `show: false` 的 BrowserWindow，共用上述 Session；
- 在本地 renderer 中使用 Axios XHR 执行第 1～15、17 步；
- 在官方 Creator 页面中加载在线 BDMS，第 16 步用 CDP 截获签名 URL并立即
  `Fetch.failRequest`；
- 在主进程中按 `_ae/CIt` 生成 ticket-guard Header，并计算 VOD/ImageX V4 签名。

CLI 必须显式指定 `--source-partition <纯数字 id>`。默认仍会真实上传视频和封面并执行第 16 步，
但不会提交作品；只有 `--publish` 才执行第 17 步。可见性默认为 `--visibility self`，还支持
`friends` 和 `public`。第 17 步不重试。

当前 Demo 不读取 Playwright storage-state，也不依赖小豆芽进程、NewRank `getDySign` 或
`electron.net.request()`。partition 由 Electron 自行读写，不能手工修改其 Cookies SQLite、
LevelDB 或 IndexedDB；`assets/douyin` 必须保持在 Git 忽略列表中。

### 17.7 验证要求

本地实现需要完成两类验证：

1. 使用固定 URL、UA 和原始 Body，确认 CDP 捕获的请求保持原 Query 顺序，并包含非空
   `msToken`、`a_bogus`；随后以 `Fetch.failRequest` 证明签名探测请求没有发往网络。
2. 使用同一份捕获 URL、Body、Cookie、CSRF Token 和 ticket guard 数据请求真实
   `create_v2`，检查服务端是否接受签名。

算法有输出不代表创作者中心接受该签名。请求失败时依次检查：

- Webview 没有使用账号真实 partition、`envConf` 或 UA。
- `window.bdms` 尚未完成初始化，或加载了不同版本的 SDK。
- 签名后的 query 顺序或编码被改变。
- 请求 Body 被 HTTP 库重新序列化。
- 签名 UA 与请求头 UA 不一致。
- `msToken` 被二次编码，或与当前 Cookie 会话不匹配。
- `bd-ticket-guard-client-data`、CSRF Token 或其他登录态数据缺失。

## 当前实现文件

Demo 本机发布实现拆分为：

- `examples/douyin-upload.ts`：Node CLI 和 Electron 子进程入口。
- `examples/douyin-electron-main.ts`：真实 partition Session、隐藏窗口、ticket guard、V4 和 CDP。
- `examples/douyin-electron-renderer.ts`：Axios XHR 第 1～15/17 步及唯一 Body 序列化链路。
- `examples/douyin-runtime-core.ts`：设备配置、公共参数、CRC、分片和话题提取。
- `examples/douyin-publish.ts`：稳定 Query、文案、可见性和 `create_v2` Payload。
- `examples/douyin-upload.test.ts`：纯逻辑和 CLI 安全默认值测试。

当前结论是：完整 `commonParams` 可以按原包证据直接实现；真实 partition 中的
`bdms + CDP Fetch` 本机签名链路已经跑通，并能在请求发往网络前取得签名。纯 Node.js
算法仍未完成，不能使用现有 `f2` 实现替代当前创作者中心签名格式。
