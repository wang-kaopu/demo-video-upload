import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { parseVisibility, type DouyinVisibility } from "./douyin-publish.js";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const electronPath = createRequire(import.meta.url)("electron") as string;

export interface DouyinCliOptions {
  coverPath: string;
  publish: boolean;
  repositoryRoot: string;
  sourcePartition: string;
  textPath: string;
  videoPath: string;
  visibility: DouyinVisibility;
}

/**
 * 把相对素材路径解析到当前工作目录，默认素材仍固定在仓库 assets 中。
 *
 * @param value - 可选命令行路径
 * @param fallback - 仓库内默认路径
 * @returns 绝对路径
 */
function resolveInputPath(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/**
 * 解析 Douyin Demo 命令行参数。
 *
 * @param args - 不含 node 和脚本名的参数
 * @returns 运行选项；显示帮助时返回 undefined
 */
export function parseCliOptions(args: string[]): DouyinCliOptions | undefined {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      cover: { type: "string" },
      help: { short: "h", type: "boolean" },
      publish: { type: "boolean" },
      "source-partition": { type: "string" },
      text: { type: "string" },
      video: { type: "string" },
      visibility: { type: "string" },
    },
    strict: true,
  });
  if (parsed.values.help) {
    printHelp();
    return undefined;
  }

  const sourcePartition = parsed.values["source-partition"];
  if (!sourcePartition || !/^\d+$/u.test(sourcePartition)) {
    throw new Error("必须通过 --source-partition 指定纯数字账号 partition");
  }

  return {
    coverPath: resolveInputPath(parsed.values.cover, join(REPOSITORY_ROOT, "assets/demo.png")),
    publish: parsed.values.publish ?? false,
    repositoryRoot: REPOSITORY_ROOT,
    sourcePartition,
    textPath: resolveInputPath(parsed.values.text, join(REPOSITORY_ROOT, "assets/demo.txt")),
    videoPath: resolveInputPath(parsed.values.video, join(REPOSITORY_ROOT, "assets/demo.mp4")),
    visibility: parseVisibility(parsed.values.visibility),
  };
}

/**
 * 检查 Electron 启动前必须存在的本地素材和账号目录。
 *
 * @param options - 已解析的命令行参数
 */
async function validateInputs(options: DouyinCliOptions): Promise<void> {
  await Promise.all([
    access(options.coverPath),
    access(options.textPath),
    access(options.videoPath),
    access(join(options.repositoryRoot, "assets/douyin/Local State")),
    access(join(options.repositoryRoot, "assets/douyin", options.sourcePartition)),
    access(join(options.repositoryRoot, "dist/douyin-electron-main.cjs")),
  ]);
}

/**
 * 启动独立 Electron 子进程并透传安全日志和退出码。
 *
 * @param options - Electron 运行参数
 */
async function runElectron(options: DouyinCliOptions): Promise<void> {
  await validateInputs(options);
  const encodedOptions = Buffer.from(JSON.stringify(options), "utf8").toString("base64url");
  const mainPath = join(options.repositoryRoot, "dist/douyin-electron-main.cjs");

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(electronPath, [mainPath, `--douyin-options=${encodedOptions}`], {
      cwd: options.repositoryRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(signal ? `Electron 被信号 ${signal} 终止` : `Electron 退出码 ${code ?? "未知"}`));
    });
  });
}

/**
 * 输出 Douyin Demo 的命令行帮助。
 */
function printHelp(): void {
  console.log(`Douyin 视频上传 Demo

用法：npm run example:douyin -- --source-partition <id> [选项]

  --source-partition <id>          assets/douyin 下的账号 partition（必填）
  --video <path>                   视频文件
  --cover <path>                   封面文件
  --text <path>                    首行标题、后续描述和可选 #话题
  --visibility <self|friends|public>
                                  默认 self，仅自己可见
  --publish                        执行 create_v2 正式发布
  -h, --help                       显示帮助

未传 --publish 时仍会真实执行第 1～16 步，上传视频和封面，但不会创建作品。
`);
}

/**
 * 判断当前模块是否由命令行直接执行。
 *
 * @returns 直接执行时返回 true
 */
function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    if (options) {
      await runElectron(options);
    }
  } catch (error) {
    console.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
