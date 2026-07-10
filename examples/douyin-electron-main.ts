import { sign as signEcdsa } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  type Cookie,
  type Session,
} from "electron";

import { signDouyinV4, type DouyinV4SignatureInput } from "./douyin-signature.js";
import type { DouyinCliOptions } from "./douyin-upload.js";

const CREATOR_ORIGIN = "https://creator.douyin.com";
const CREATOR_HOME = `${CREATOR_ORIGIN}/creator-micro/home`;
const CREATOR_REFERER = `${CREATOR_ORIGIN}/creator-micro/content/publish?enter_from=publish_page`;
const BDMS_READY_TIMEOUT = 60_000;
const SIGNING_TIMEOUT = 30_000;

interface SecurityStorage {
  cryptSdk: string | null;
  signData: string | null;
  xmst: string | null;
}

interface SigningResult {
  signedUrl: string;
  ticketHeaders: Record<string, string>;
}

interface RendererResult {
  message?: string;
  success: boolean;
}

/**
 * 从 Electron 进程参数读取 Node CLI 传入的非敏感运行配置。
 *
 * @returns 已解析的 Douyin Demo 配置
 */
function readOptions(): DouyinCliOptions {
  const argument = process.argv.find((value) => value.startsWith("--douyin-options="));
  if (!argument) {
    throw new Error("Electron 缺少 --douyin-options");
  }
  const encoded = argument.slice("--douyin-options=".length);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as DouyinCliOptions;
}

const options = readOptions();
const profileRoot = join(options.repositoryRoot, "assets/douyin");
const accountPath = join(profileRoot, options.sourcePartition);

app.setPath("userData", profileRoot);
app.setPath("sessionData", profileRoot);
app.commandLine.appendSwitch("lang", "zh-CN");

/**
 * 生成与固定 Chrome 138 UA 一致的 Client Hints。
 *
 * @returns Chromium 请求使用的 Client Hint Headers
 */
function createClientHintHeaders(): Record<string, string> {
  return {
    "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": process.platform === "darwin" ? '"macOS"' : '"Windows"',
  };
}

/**
 * 查找不区分大小写的请求 Header 名。
 *
 * @param headers - Electron 请求 Header
 * @param expected - 目标 Header 名
 * @returns 实际 Header 名；不存在时返回 undefined
 */
function findHeaderName(headers: Record<string, string>, expected: string): string | undefined {
  return Object.keys(headers).find((name) => name.toLowerCase() === expected.toLowerCase());
}

/**
 * 安装原包 `_setRequestHeaders` 还原逻辑，只处理 Demo renderer 主动标记的请求。
 *
 * @param accountSession - 两个隐藏窗口共享的账号 Session
 */
function installRequestHeaderBridge(accountSession: Session): void {
  accountSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    const markerName = findHeaderName(headers, "_setRequestHeaders");
    if (!markerName) {
      callback({ cancel: false, requestHeaders: details.requestHeaders });
      return;
    }

    try {
      const desired = JSON.parse(headers[markerName] ?? "{}") as Record<string, string>;
      delete headers[markerName];
      for (const [name, value] of Object.entries(desired)) {
        headers[name] = value;
      }
      Object.assign(headers, createClientHintHeaders());
      callback({ cancel: false, requestHeaders: headers });
    } catch {
      callback({ cancel: true });
    }
  });
}

/**
 * 等待 Creator 页面安全 SDK 完成初始化。
 *
 * @param window - Creator 签名窗口
 */
async function waitForBdms(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + BDMS_READY_TIMEOUT;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      "document.readyState === 'complete' && Boolean(window.bdms) && Boolean(window._SdkGlueInit)",
      true,
    ) as boolean;
    if (ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 Creator BDMS 初始化超时");
}

/**
 * 从 Creator origin 读取本次运行需要的 localStorage 字段。
 *
 * @param signerWindow - 已加载 Creator 页面且完成 BDMS 初始化的窗口
 * @returns 原始 xmst 与 security-sdk 字符串
 */
async function readSecurityStorage(signerWindow: BrowserWindow): Promise<SecurityStorage> {
  return signerWindow.webContents.executeJavaScript(`({
    xmst: localStorage.getItem("xmst"),
    signData: localStorage.getItem("security-sdk/s_sdk_sign_data_key/web_protect"),
    cryptSdk: localStorage.getItem("security-sdk/s_sdk_crypt_sdk"),
  })`, true) as Promise<SecurityStorage>;
}

/**
 * 等待 ticket-guard 的签名数据与私钥完成异步恢复。
 *
 * BDMS 可用只表示请求拦截链已经安装，不能保证 security-sdk 的两个 localStorage 键已同时写入。
 *
 * @param signerWindow - 已加载 Creator 页面的签名窗口
 * @returns 同时包含 sign data 和 crypt SDK 的安全状态
 */
async function waitForTicketSecurityStorage(
  signerWindow: BrowserWindow,
): Promise<SecurityStorage & { cryptSdk: string; signData: string }> {
  const deadline = Date.now() + BDMS_READY_TIMEOUT;
  while (Date.now() < deadline) {
    const storage = await readSecurityStorage(signerWindow);
    if (storage.signData && storage.cryptSdk) {
      return { ...storage, cryptSdk: storage.cryptSdk, signData: storage.signData };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 Creator ticket-guard security-sdk 数据超时");
}

/**
 * 解开 security-sdk 使用的 URI 编码与嵌套 JSON data 包装。
 *
 * @param raw - localStorage 原始字符串
 * @returns 最内层对象
 */
function unwrapSecurityValue(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof value === "string") {
      value = JSON.parse(value) as unknown;
      continue;
    }
    if (value && typeof value === "object" && "data" in value) {
      value = value.data;
      continue;
    }
    break;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("security-sdk localStorage 格式无效");
  }
  return value as Record<string, unknown>;
}

/**
 * 将 Electron Session Cookie 拼成 Creator Axios 使用的 Cookie Header。
 *
 * @param cookies - 当前 Creator URL 可用 Cookie
 * @returns 分号分隔的 Cookie Header
 */
function stringifyCookies(cookies: Cookie[]): string {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

/**
 * 按原包 `_ae/CIt` 逻辑生成 create_v2 ticket-guard Header 集。
 *
 * @param accountSession - 当前账号 Session
 * @param signerWindow - 可读取 Creator localStorage 的窗口
 * @returns 动态签名 Header 和 Cookie 中的四个版本 Header
 */
async function createTicketGuardHeaders(
  accountSession: Session,
  signerWindow: BrowserWindow,
): Promise<Record<string, string>> {
  const storage = await waitForTicketSecurityStorage(signerWindow);
  const signData = unwrapSecurityValue(storage.signData);
  const cryptSdk = unwrapSecurityValue(storage.cryptSdk);
  const ticket = typeof signData.ticket === "string" ? signData.ticket.trim() : "";
  const tsSign = typeof signData.ts_sign === "string" ? signData.ts_sign : "";
  const privateKey = typeof cryptSdk.ec_privateKey === "string" ? cryptSdk.ec_privateKey : "";
  if (!ticket || !tsSign || !privateKey) {
    throw new Error("ticket-guard 数据缺少 ticket、ts_sign 或 ec_privateKey");
  }

  const timestamp = Math.floor(Date.now() / 1_000);
  const content =
    `ticket=${ticket}&path=/web/api/media/aweme/create_v2/&timestamp=${timestamp}`;
  const signature = signEcdsa("sha256", Buffer.from(content, "utf8"), {
    dsaEncoding: "der",
    key: privateKey,
  }).toString("base64");
  const dynamicHeader = Buffer.from(JSON.stringify({
    ts_sign: tsSign,
    req_content: "ticket,path,timestamp",
    req_sign: signature,
    timestamp,
  }), "utf8").toString("base64");

  const ticketCookies = await accountSession.cookies.get({ name: "bd_ticket_guard_client_data" });
  const ticketCookie = ticketCookies[0]?.value;
  if (!ticketCookie) {
    throw new Error("Creator partition 缺少 bd_ticket_guard_client_data Cookie");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(decodeURIComponent(ticketCookie), "base64").toString("utf8"));
  } catch {
    throw new Error("bd_ticket_guard_client_data Cookie 格式无效");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("bd_ticket_guard_client_data Cookie 内容无效");
  }

  const staticHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(decoded as Record<string, unknown>)) {
    staticHeaders[name] = String(value);
  }
  return {
    "bd-ticket-guard-client-data": dynamicHeader,
    ...staticHeaders,
  };
}

/**
 * 通过 BDMS 发起并在网络前终止 create_v2，取得完整签名 URL。
 *
 * @param signerWindow - Creator 签名窗口
 * @param unsignedUrl - 包含稳定 Query、但不含 a_bogus 的 URL
 * @param bodyText - 唯一序列化的发布 Body
 * @param csrfToken - 当前 Electron Session 的 CSRF Token
 * @returns 原样捕获的最终 URL
 */
async function captureSignedUrl(
  signerWindow: BrowserWindow,
  unsignedUrl: string,
  bodyText: string,
  csrfToken: string,
): Promise<string> {
  const debuggerClient = signerWindow.webContents.debugger;
  if (debuggerClient.isAttached()) {
    debuggerClient.detach();
  }
  debuggerClient.attach("1.3");
  await debuggerClient.sendCommand("Fetch.enable", {
    patterns: [{ requestStage: "Request", urlPattern: "*create_v2*" }],
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("等待 BDMS 签名请求超时"));
        }
      }, SIGNING_TIMEOUT);

      const finish = (error: Error | null, signedUrl?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        debuggerClient.off("message", onMessage);
        if (error) {
          reject(error);
        } else if (signedUrl) {
          resolve(signedUrl);
        }
      };

      const onMessage = (
        _event: Electron.Event,
        method: string,
        parameters: Record<string, unknown>,
      ): void => {
        if (method !== "Fetch.requestPaused") {
          return;
        }
        const requestId = parameters.requestId;
        const request = parameters.request as {
          method?: string;
          postData?: string;
          url?: string;
        } | undefined;
        if (typeof requestId !== "string" || !request?.url) {
          finish(new Error("CDP Fetch.requestPaused 缺少 requestId 或 URL"));
          return;
        }

        void debuggerClient.sendCommand("Fetch.failRequest", {
          errorReason: "Aborted",
          requestId,
        }).then(() => {
          if (request.method !== "POST") {
            finish(new Error("BDMS 签名请求方法不是 POST"));
            return;
          }
          if (request.postData !== bodyText) {
            finish(new Error("BDMS 签名请求 Body 与最终 bodyText 不一致"));
            return;
          }
          const url = new URL(request.url as string);
          if (url.searchParams.getAll("msToken").length !== 1) {
            finish(new Error("BDMS 签名 URL 中 msToken 数量不是 1"));
            return;
          }
          if (url.searchParams.getAll("a_bogus").length !== 1 || !url.searchParams.get("a_bogus")) {
            finish(new Error("BDMS 未生成 a_bogus"));
            return;
          }
          finish(null, request.url);
        }).catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
      };

      debuggerClient.on("message", onMessage);
      const request = JSON.stringify({
        bodyText,
        csrfToken,
        unsignedUrl,
      });
      void signerWindow.webContents.executeJavaScript(`(() => {
        const input = ${request};
        void window.fetch(input.unsignedUrl, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Referer": ${JSON.stringify(CREATOR_REFERER)},
            "X-Secsdk-Csrf-Token": input.csrfToken,
          },
          body: input.bodyText,
        }).catch(() => undefined);
      })()`, true).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  } finally {
    try {
      await debuggerClient.sendCommand("Fetch.disable");
    } finally {
      if (debuggerClient.isAttached()) {
        debuggerClient.detach();
      }
    }
  }
}

/**
 * 创建只加载官方 Creator 页面的远程签名窗口。
 *
 * @param accountSession - 账号 Session
 * @returns 完成 BDMS 初始化的隐藏窗口
 */
async function createSignerWindow(accountSession: Session): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: accountSession,
    },
  });
  window.webContents.setUserAgent(createMachineUserAgent());
  await window.loadURL(CREATOR_HOME);
  await waitForBdms(window);
  return window;
}

/**
 * 返回与当前运行系统匹配的固定 Chrome 138 UA。
 *
 * @returns Windows 或 macOS UA
 */
function createMachineUserAgent(): string {
  if (process.platform === "win32") {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/138.0.0.0 Safari/537.36";
  }
  if (process.platform === "darwin") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/138.0.0.0 Safari/537.36";
  }
  throw new Error(`当前系统 ${process.platform} 不支持抖音本机发布 Demo`);
}

/**
 * 注册 renderer 使用的固定 IPC 能力。
 *
 * @param accountSession - 账号 Session
 * @param signerWindow - Creator 签名窗口
 */
function registerIpc(accountSession: Session, signerWindow: BrowserWindow): void {
  ipcMain.handle("douyin:get-options", () => options);
  ipcMain.handle("douyin:get-session-state", async () => {
    const storage = await readSecurityStorage(signerWindow);
    const cookies = await accountSession.cookies.get({ url: CREATOR_ORIGIN });
    const cookieMsToken = [...cookies].reverse().find(({ name }) => name === "msToken")?.value;
    const msToken = storage.xmst || cookieMsToken;
    if (!msToken) {
      throw new Error("Creator partition 缺少 xmst/msToken");
    }
    return {
      cookieHeader: stringifyCookies(cookies),
      msToken,
    };
  });
  ipcMain.handle("douyin:sign-v4", (_event, input: DouyinV4SignatureInput) => signDouyinV4(input));
  ipcMain.handle(
    "douyin:sign-create-v2",
    async (_event, input: { bodyText: string; csrfToken: string; unsignedUrl: string }): Promise<SigningResult> => ({
      signedUrl: await captureSignedUrl(signerWindow, input.unsignedUrl, input.bodyText, input.csrfToken),
      ticketHeaders: await createTicketGuardHeaders(accountSession, signerWindow),
    }),
  );
}

/**
 * 创建运行 Axios XHR 上传链路的本地隐藏窗口。
 *
 * @param accountSession - 与 Creator signer 共享的账号 Session
 * @returns 已创建的本地窗口
 */
async function createNetworkWindow(accountSession: Session): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      session: accountSession,
      webSecurity: false,
    },
  });
  window.webContents.setUserAgent(createMachineUserAgent());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  window.webContents.on("console-message", (details) => {
    console.log(details.message);
  });
  await window.loadFile(join(options.repositoryRoot, "examples/douyin-electron.html"));
  return window;
}

/**
 * 启动独立 Douyin Electron 运行时并等待 renderer 完成。
 */
async function main(): Promise<void> {
  await Promise.all([
    access(join(profileRoot, "Local State")),
    access(accountPath),
  ]);
  await app.whenReady();

  const accountSession = session.fromPath(accountPath, { cache: true });
  await accountSession.setProxy({ mode: "direct" });
  accountSession.setUserAgent(createMachineUserAgent(), "zh-CN");
  installRequestHeaderBridge(accountSession);

  const signerWindow = await createSignerWindow(accountSession);
  registerIpc(accountSession, signerWindow);

  const completion = new Promise<RendererResult>((resolve) => {
    ipcMain.once("douyin:complete", (_event, result: RendererResult) => resolve(result));
  });
  const networkWindow = await createNetworkWindow(accountSession);
  const result = await completion;
  accountSession.flushStorageData();
  networkWindow.destroy();
  signerWindow.destroy();

  if (!result.success) {
    throw new Error(result.message || "Douyin renderer 执行失败");
  }
}

void main().then(() => {
  app.exit(0);
}).catch((error: unknown) => {
  console.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
});
