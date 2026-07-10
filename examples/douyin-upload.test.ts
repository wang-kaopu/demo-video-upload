import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  adaptDouyinStorageState,
  buildCommonParams,
  buildCookieHeader,
  calculateCrc32,
  createChunkDescriptors,
  createMachineProfile,
  extractTopicNames,
  serializeQuery,
  type PlaywrightStorageState,
} from "./douyin-upload.js";

const REPOSITORY_ROOT = join(import.meta.dirname, "..");

/**
 * 验证 storage-state 会生成账号 Cookie、编码 token 和未经预编码的 msToken。
 */
test("adaptDouyinStorageState preserves the three credential representations", () => {
  const state: PlaywrightStorageState = {
    cookies: [
      {
        domain: ".douyin.com",
        expires: 2_000,
        httpOnly: true,
        name: "sessionid",
        path: "/",
        sameSite: "None",
        secure: true,
        value: "session",
      },
    ],
    origins: [
      {
        localStorage: [
          { name: "xmst", value: "raw token/+=" },
          { name: "security-sdk/example", value: '{"secret":true}' },
          { name: "ignored", value: "value" },
        ],
        origin: "https://creator.douyin.com",
      },
    ],
  };

  const adapted = adaptDouyinStorageState(state);
  const cookies = JSON.parse(adapted.cookie) as Array<Record<string, unknown>>;
  const tokens = JSON.parse(adapted.token) as Array<Record<string, unknown>>;

  assert.equal(adapted.msToken, "raw token/+=");
  assert.equal(cookies[0]?.sameSite, "no_restriction");
  assert.equal(cookies[0]?.expirationDate, 2_000);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0]?.value, "raw%20token%2F%2B%3D");
  assert.equal(tokens.some(({ name }) => name === "ignored"), false);
});

/**
 * 验证 localStorage 没有 xmst 时使用最后一个 Cookie msToken。
 */
test("adaptDouyinStorageState falls back to the last msToken cookie", () => {
  const state: PlaywrightStorageState = {
    cookies: [
      {
        domain: ".douyin.com",
        expires: -1,
        httpOnly: false,
        name: "msToken",
        path: "/",
        sameSite: "Lax",
        secure: true,
        value: "first",
      },
      {
        domain: "creator.douyin.com",
        expires: -1,
        httpOnly: false,
        name: "msToken",
        path: "/",
        sameSite: "Lax",
        secure: true,
        value: "last",
      },
    ],
    origins: [{ localStorage: [], origin: "https://creator.douyin.com" }],
  };

  assert.equal(adaptDouyinStorageState(state).msToken, "last");
});

/**
 * 验证真实 Demo storage-state 能提取 xmst，但不输出任何凭据值。
 */
test("adaptDouyinStorageState accepts the bundled Douyin storage-state", async () => {
  const state = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, "assets/124_douyin.json"), "utf8"),
  ) as PlaywrightStorageState;
  const adapted = adaptDouyinStorageState(state);

  assert.ok(adapted.cookie.length > 0);
  assert.ok(adapted.token.length > 0);
  assert.ok(adapted.msToken.length > 0);
});

/**
 * 验证 Cookie Header 会过滤域名和过期项，并优先排列更具体的 domain。
 */
test("buildCookieHeader filters cookies for creator.douyin.com", () => {
  const cookieJson = JSON.stringify([
    {
      domain: ".douyin.com",
      httpOnly: false,
      name: "shared",
      path: "/",
      sameSite: "lax",
      secure: true,
      session: true,
      value: "parent",
    },
    {
      domain: "creator.douyin.com",
      expirationDate: 2_000,
      httpOnly: false,
      name: "shared",
      path: "/",
      sameSite: "lax",
      secure: true,
      session: false,
      value: "creator",
    },
    {
      domain: ".example.com",
      httpOnly: false,
      name: "foreign",
      path: "/",
      sameSite: "lax",
      secure: true,
      session: true,
      value: "ignored",
    },
  ]);

  assert.equal(
    buildCookieHeader(cookieJson, "https://creator.douyin.com/path", 1_000),
    "shared=creator; shared=parent",
  );
});

/**
 * 验证操作系统检测只生成 macOS/Windows 内部一致配置。
 */
test("createMachineProfile selects a matching platform and UA", () => {
  const mac = createMachineProfile("darwin");
  const windows = createMachineProfile("win32");

  assert.equal(mac.platform, "MacIntel");
  assert.match(mac.userAgent, /Macintosh/u);
  assert.equal(windows.platform, "Win32");
  assert.match(windows.userAgent, /Windows NT/u);
  assert.throws(() => createMachineProfile("linux"), /不支持/u);
});

/**
 * 验证 commonParams 从同一设备配置派生 Mozilla 名称和完整版本文本。
 */
test("buildCommonParams derives browser fields from the selected profile", () => {
  const params = buildCommonParams(createMachineProfile("darwin"));

  assert.equal(params.browser_name, "Mozilla");
  assert.match(params.browser_version, /^5\.0 \(Macintosh/u);
  assert.equal(params.browser_platform, "MacIntel");
  assert.equal(params.screen_width, 1920);
});

/**
 * 验证普通 Query 保持插入顺序并只编码一次原始 msToken。
 */
test("serializeQuery encodes a raw msToken exactly once", () => {
  assert.equal(
    serializeQuery({ first: 1, msToken: "raw token/%", empty: "", skip: undefined }),
    "first=1&msToken=raw%20token%2F%25&empty=",
  );
});

/**
 * 验证恰好 5 MiB 是单分片，多一个字节才进入 multipart。
 */
test("createChunkDescriptors uses the recovered 5 MiB boundary", () => {
  const fiveMiB = 5 * 1024 * 1024;
  assert.equal(createChunkDescriptors(fiveMiB).length, 1);
  assert.deepEqual(createChunkDescriptors(fiveMiB + 1), [
    { end: fiveMiB, partNumber: 1, size: fiveMiB, start: 0 },
    { end: fiveMiB + 1, partNumber: 2, size: 1, start: fiveMiB },
  ]);
});

/**
 * 验证 crc-32@1.2.2 使用标准 CRC-32/IEEE 小写十六进制结果。
 */
test("calculateCrc32 matches the standard CRC-32/IEEE vector", () => {
  assert.equal(calculateCrc32(Buffer.from("123456789", "ascii")), "cbf43926");
});

/**
 * 验证话题提取去重并限制为前五个。
 */
test("extractTopicNames returns at most five unique hashtags", () => {
  assert.deepEqual(
    extractTopicNames("正文 #一 #二 #一 #三 #四 #五 #六"),
    ["一", "二", "三", "四", "五"],
  );
});
