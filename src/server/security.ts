import { createHash } from "node:crypto";
import { db } from "./db";

/** Only safe, deliberately written messages may be returned to callers. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(
    status: number,
    message: string,
    code = "INVALID_REQUEST",
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** Next's internal request URL can use the listen hostname in production. */
export function requestOrigin(request: Request) {
  const configuredOrigin = process.env.APP_ORIGIN;
  if (configuredOrigin) {
    let configured: URL;
    try { configured = new URL(configuredOrigin); }
    catch { throw new HttpError(503, "服务地址配置无效，请联系管理员。", "ORIGIN_CONFIGURATION"); }
    if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password) {
      throw new HttpError(503, "服务地址配置无效，请联系管理员。", "ORIGIN_CONFIGURATION");
    }
    return configured.origin;
  }
  const internal = new URL(request.url);
  const host = request.headers.get("host") || internal.host;
  // Never consume forwarded host/proto here. HTTPS reverse proxies must set
  // APP_ORIGIN to their explicit external origin rather than trust client headers.
  if (!["http:", "https:"].includes(internal.protocol)
    || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?$/.test(host)) {
    throw new HttpError(403, "请求来源无效，请从本站页面重试。", "INVALID_ORIGIN");
  }
  try { return new URL(`${internal.protocol}//${host}`).origin; }
  catch { throw new HttpError(403, "请求来源无效，请从本站页面重试。", "INVALID_ORIGIN"); }
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expectedOrigin = requestOrigin(request);
  // Browser writes must carry Origin, including demonstration login/logout.
  if (!origin || origin !== expectedOrigin) {
    throw new HttpError(403, "请求来源无效，请从本站页面重试。", "INVALID_ORIGIN");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw new HttpError(403, "禁止跨站操作。", "INVALID_ORIGIN");
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "请使用 JSON 格式提交。", "INVALID_CONTENT_TYPE");
  }
  const declaredSize = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > 32_768) {
    throw new HttpError(413, "提交内容过大。", "BODY_TOO_LARGE");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > 32_768) {
    throw new HttpError(413, "提交内容过大。", "BODY_TOO_LARGE");
  }
  try {
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "提交内容不是有效的 JSON 对象。", "INVALID_JSON");
  }
}

export function requiredString(value: unknown, label: string, max = 200) {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > max) {
    throw new HttpError(400, `${label}无效。`);
  }
  return value.trim();
}

export function optionalString(value: unknown, label: string, max = 200) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label, max);
}

export function requiredBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new HttpError(400, `${label}必须为布尔值。`);
  return value;
}

/** Shared SQLite counters remain effective across refreshes and server restarts. */
export async function rateLimit(bucket: string, limit: number, windowMs = 60_000) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const id = createHash("sha256")
    .update(`${bucket}:${windowStart.getTime()}:${windowMs}`)
    .digest("hex");
  const record = await db.rateLimit.upsert({
    where: { id },
    create: { id, bucket, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });
  if (record.count > limit) {
    throw new HttpError(429, "操作过于频繁，请稍后重试。", "RATE_LIMITED");
  }
}

/** Do not trust arbitrary forwarded IP headers without a configured reverse proxy. */
export function loginRateBucket(request: Request) {
  const trustedProxy = process.env.TRUST_PROXY === "true";
  const source = trustedProxy
    ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
    : "single-instance";
  return `login:${createHash("sha256").update(source).digest("hex")}`;
}
