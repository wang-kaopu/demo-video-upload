import CRC32 from "crc-32";

export const DOUYIN_CHUNK_SIZE = 5 * 1024 * 1024;

export interface MachineProfile {
  language: "zh-CN";
  platform: "MacIntel" | "Win32";
  screenHeight: number;
  screenWidth: number;
  timezone: "Asia/Shanghai";
  userAgent: string;
}

export interface CommonParams {
  aid: 1128;
  browser_language: string;
  browser_name: string;
  browser_online: true;
  browser_platform: string;
  browser_version: string;
  cookie_enabled: true;
  screen_height: number;
  screen_width: number;
  support_h265: 1;
  timezone_name: string;
}

export interface ChunkDescriptor {
  end: number;
  partNumber: number;
  size: number;
  start: number;
}

/**
 * 根据当前操作系统选择 UA、平台、语言和屏幕尺寸相互一致的设备配置。
 *
 * @param platform - Node.js 平台标识
 * @returns macOS 或 Windows 的固定 Chrome 138 配置
 */
export function createMachineProfile(platform: NodeJS.Platform = process.platform): MachineProfile {
  const shared = {
    language: "zh-CN" as const,
    screenHeight: 1080,
    screenWidth: 1920,
    timezone: "Asia/Shanghai" as const,
  };

  if (platform === "darwin") {
    return {
      ...shared,
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/138.0.0.0 Safari/537.36",
    };
  }
  if (platform === "win32") {
    return {
      ...shared,
      platform: "Win32",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/138.0.0.0 Safari/537.36",
    };
  }
  throw new Error(`当前系统 ${platform} 不支持抖音本机发布 Demo`);
}

/**
 * 从设备配置构造创作者中心公共 Query 参数。
 *
 * @param profile - 与请求 User-Agent 一致的设备配置
 * @returns Creator API 公共参数
 */
export function buildCommonParams(profile: MachineProfile): CommonParams {
  const slashIndex = profile.userAgent.indexOf("/");
  if (slashIndex <= 0) {
    throw new Error("设备 User-Agent 缺少浏览器名称分隔符");
  }

  return {
    cookie_enabled: true,
    screen_width: profile.screenWidth,
    screen_height: profile.screenHeight,
    browser_language: profile.language,
    browser_platform: profile.platform,
    browser_name: profile.userAgent.slice(0, slashIndex),
    browser_version: profile.userAgent.slice(slashIndex + 1),
    browser_online: true,
    timezone_name: profile.timezone,
    aid: 1128,
    support_h265: 1,
  };
}

/**
 * 计算视频和封面上传协议要求的 CRC-32/IEEE 字符串。
 *
 * @param bytes - 上传的原始字节
 * @returns 无符号、不补零的小写十六进制 CRC32
 */
export function calculateCrc32(bytes: Uint8Array): string {
  return (CRC32.buf(bytes) >>> 0).toString(16);
}

/**
 * 按 5 MiB 生成从 1 开始编号的视频分片描述。
 *
 * @param fileSize - 视频字节数
 * @param chunkSize - 单片字节上限
 * @returns 保持文件顺序的分片列表
 */
export function createChunkDescriptors(
  fileSize: number,
  chunkSize = DOUYIN_CHUNK_SIZE,
): ChunkDescriptor[] {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("视频文件必须是非空且大小可安全表示的文件");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("分片大小必须是正整数");
  }

  const descriptors: ChunkDescriptor[] = [];
  for (let start = 0, partNumber = 1; start < fileSize; start += chunkSize, partNumber += 1) {
    const end = Math.min(fileSize, start + chunkSize);
    descriptors.push({ end, partNumber, size: end - start, start });
  }
  return descriptors;
}

/**
 * 从文案中提取最多五个去重井号话题。
 *
 * @param text - UTF-8 发布文案
 * @returns 不含井号的话题名称
 */
export function extractTopicNames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/#([^#\s]+)(?=\s|#|$)/gu)) {
    const name = match[1]?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    if (names.length === 5) {
      break;
    }
  }
  return names;
}
