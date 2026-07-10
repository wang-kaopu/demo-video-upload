import axios, {
  AxiosHeaders,
  type AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";

const BINARY_LOG_PREVIEW_LENGTH = 100;

export interface SerializedAxiosRequest {
  body: unknown;
  headers: unknown;
  method?: string;
  params: unknown;
  url: string;
}

export interface SerializedAxiosResponse {
  body: unknown;
  headers: unknown;
  request: SerializedAxiosRequest;
  status: number;
  statusText: string;
}

export interface SerializedAxiosError {
  body: unknown;
  code?: string;
  headers: unknown;
  message: string;
  request?: SerializedAxiosRequest;
  status?: number;
  statusText?: string;
}

export type LogEvent =
  | { message: string; type: "info" }
  | { error: SerializedAxiosError | { message: string }; type: "http-error" }
  | { request: SerializedAxiosRequest; type: "http-request" }
  | { response: SerializedAxiosResponse; type: "http-response" };

/** 接收 service 产生的结构化日志事件。 */
export interface Logger {
  /**
   * 记录一个结构化事件。
   *
   * @param event - 进度或 HTTP 日志事件
   */
  log(event: LogEvent): void | Promise<void>;
}

/** 默认把全部结构化事件打印到终端。 */
export class ConsoleLogger implements Logger {
  /**
   * 打印一个结构化事件。
   *
   * @param event - 进度或 HTTP 日志事件
   */
  public log(event: LogEvent): void {
    if (event.type === "info") {
      console.log(event.message);
      return;
    }
    const labels: Record<Exclude<LogEvent["type"], "info">, string> = {
      "http-error": "========== HTTP RESPONSE ERROR ==========",
      "http-request": "========== HTTP REQUEST ==========",
      "http-response": "========== HTTP RESPONSE ==========",
    };
    console.log(labels[event.type]);
    console.log(JSON.stringify(event, null, 2));
  }
}

/**
 * 安全调用 Logger；日志系统失败时不影响上传和发布。
 *
 * @param logger - 可注入 Logger
 * @param event - 待记录事件
 */
export async function emitLog(logger: Logger, event: LogEvent): Promise<void> {
  try {
    await logger.log(event);
  } catch (error) {
    console.error("Logger 执行失败：", error);
  }
}

/**
 * 把二进制日志限制为 100 个 Base64 字符。
 *
 * @param base64 - 完整 Base64 字符串
 * @param metadata - 二进制元数据
 * @returns 截断后的日志结构
 */
function serializeBinaryPreview(base64: string, metadata: Record<string, unknown>): Record<string, unknown> {
  const omittedCharacters = Math.max(0, base64.length - BINARY_LOG_PREVIEW_LENGTH);
  return {
    base64: base64.slice(0, BINARY_LOG_PREVIEW_LENGTH),
    base64Length: base64.length,
    base64Truncated: omittedCharacters > 0,
    ...metadata,
    omittedCharacters,
  };
}

/**
 * 将 HTTP 值转换为可传输日志，二进制只保留前 100 个 Base64 字符。
 *
 * @param value - Axios 请求或响应值
 * @returns 可 JSON 序列化的值
 */
export async function serializeHttpValue(value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    const dataUri = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(value);
    if (dataUri?.[1] && dataUri[2] !== undefined) {
      return serializeBinaryPreview(dataUri[2], {
        mime: dataUri[1],
        type: "Base64DataUri",
      });
    }
  }
  if (Buffer.isBuffer(value)) {
    return serializeBinaryPreview(value.toString("base64"), { byteLength: value.byteLength, type: "Buffer" });
  }
  if (value instanceof ArrayBuffer) {
    const buffer = Buffer.from(value);
    return serializeBinaryPreview(buffer.toString("base64"), {
      byteLength: buffer.byteLength,
      type: "ArrayBuffer",
    });
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return serializeBinaryPreview(buffer.toString("base64"), {
      byteLength: buffer.byteLength,
      type: value.constructor.name,
    });
  }
  if (value instanceof Blob) {
    const buffer = Buffer.from(await value.arrayBuffer());
    const fileName = "name" in value && typeof value.name === "string" ? value.name : undefined;
    return serializeBinaryPreview(buffer.toString("base64"), {
      byteLength: buffer.byteLength,
      ...(fileName ? { fileName } : {}),
      mime: value.type,
      type: value.constructor.name,
    });
  }
  if (value instanceof FormData) {
    const entries: Array<{ name: string; value: unknown }> = [];
    for (const [name, entryValue] of value.entries()) {
      const serialized = name === "base64" && typeof entryValue === "string"
        ? serializeBinaryPreview(entryValue, { type: "Base64FormField" })
        : await serializeHttpValue(entryValue);
      entries.push({ name, value: serialized });
    }
    return { entries, type: "FormData" };
  }
  if (value instanceof URLSearchParams) {
    return value.toString();
  }
  return value;
}

/**
 * 将 Axios headers 转成普通对象。
 *
 * @param headers - Axios headers
 * @returns 可序列化 headers
 */
export function serializeHttpHeaders(headers: unknown): unknown {
  if (headers instanceof AxiosHeaders) {
    return headers.toJSON();
  }
  if (!headers || typeof headers !== "object") {
    return headers;
  }
  const serialized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && typeof value !== "function") {
      serialized[name] = value;
    }
  }
  return serialized;
}

/** 序列化 Axios 请求配置。 */
export async function serializeAxiosRequest(config: InternalAxiosRequestConfig): Promise<SerializedAxiosRequest> {
  return {
    body: await serializeHttpValue(config.data),
    headers: serializeHttpHeaders(config.headers),
    ...(config.method ? { method: config.method.toUpperCase() } : {}),
    params: await serializeHttpValue(config.params),
    url: axios.getUri(config),
  };
}

/** 序列化 Axios 响应及其关联请求。 */
export async function serializeAxiosResponse<T>(response: AxiosResponse<T>): Promise<SerializedAxiosResponse> {
  return {
    body: await serializeHttpValue(response.data),
    headers: serializeHttpHeaders(response.headers),
    request: await serializeAxiosRequest(response.config),
    status: response.status,
    statusText: response.statusText,
  };
}

/** 序列化 Axios 错误。 */
export async function serializeAxiosError(error: AxiosError): Promise<SerializedAxiosError> {
  return {
    body: await serializeHttpValue(error.response?.data),
    ...(error.code ? { code: error.code } : {}),
    headers: serializeHttpHeaders(error.response?.headers),
    message: error.message,
    ...(error.config ? { request: await serializeAxiosRequest(error.config) } : {}),
    ...(error.response?.status === undefined ? {} : { status: error.response.status }),
    ...(error.response?.statusText ? { statusText: error.response.statusText } : {}),
  };
}

/**
 * 为 Axios 实例安装统一日志拦截器。
 *
 * @param client - Axios 实例
 * @param logger - 接收结构化日志的 Logger
 * @param responses - 可选的成功响应收集器
 */
export function installAxiosLogger(
  client: AxiosInstance,
  logger: Logger,
  responses?: SerializedAxiosResponse[],
): void {
  client.interceptors.request.use(async (config) => {
    try {
      await emitLog(logger, { request: await serializeAxiosRequest(config), type: "http-request" });
    } catch (error) {
      console.error("HTTP 请求日志序列化失败：", error);
    }
    return config;
  });
  client.interceptors.response.use(
    async (response) => {
      try {
        const serialized = await serializeAxiosResponse(response);
        responses?.push(serialized);
        await emitLog(logger, { response: serialized, type: "http-response" });
      } catch (error) {
        console.error("HTTP 响应日志序列化失败：", error);
      }
      return response;
    },
    async (error: unknown) => {
      try {
        const serialized = axios.isAxiosError(error)
          ? await serializeAxiosError(error)
          : { message: error instanceof Error ? error.message : String(error) };
        await emitLog(logger, { error: serialized, type: "http-error" });
      } catch (logError) {
        console.error("HTTP 错误日志序列化失败：", logError);
      }
      throw error;
    },
  );
}
