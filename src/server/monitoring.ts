import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync, fstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { version as nextVersion } from "next/package.json";

export type MonitorEvent = {
  timestamp: string;
  level: "info" | "warn" | "error";
  kind: string;
  code?: string;
  requestId?: string;
  operation?: string;
  digest?: string;
  status?: number;
  signal?: string;
  exitCode?: number;
  attempt?: number;
  category?: string;
};
export type MonitorEventInput = Omit<MonitorEvent, "timestamp" | "level"> & { level?: MonitorEvent["level"] };

const eventKinds = new Set([
  "EVENT", "SERVER_STARTED", "API_ERROR", "REQUEST_ERROR", "CLIENT_ERROR", "FATAL_ERROR",
  "PROCESS_STARTED", "PROCESS_EXIT", "RESTART_SCHEDULED", "RESTART_LIMIT", "STOP_REQUESTED",
]);
const safeCodes = new Set([
  "UNEXPECTED_ERROR", "DATABASE_ERROR", "FILESYSTEM_ERROR", "RUNTIME_ERROR", "TIMEOUT_ERROR",
  "CLIENT_RENDER_ERROR", "CHILD_EXIT", "CHILD_SIGNAL", "SPAWN_FAILED", "RESTART_LIMIT", "OPERATOR_STOP",
  "INVALID_INPUT", "INVALID_REQUEST", "INVALID_JSON", "INVALID_CONTENT_TYPE", "BODY_TOO_LARGE",
  "INVALID_ORIGIN", "ORIGIN_CONFIGURATION", "RATE_LIMITED", "UNAUTHENTICATED", "FORBIDDEN",
  "NOT_FOUND", "STATE_CONFLICT", "IDEMPOTENCY_CONFLICT", "DEMO_DISABLED", "ACCOUNT_NOT_FOUND",
  "ACTIVE_REQUEST", "ANSWERER_UNAVAILABLE", "QUALIFICATION_REQUIRED", "FORMAL_ACCOUNT_REQUIRED",
  "INVALID_ATTACHMENT", "OFFER_EXPIRED", "SESSION_NOT_COMPLETED", "SESSION_NOT_STARTED",
  "INVALID_PASSWORD", "INVALID_USERNAME", "INVALID_PORTAL", "INVALID_SUBJECTS", "INVALID_DEGREE",
  "CONSENT_REQUIRED", "PASSWORD_MISMATCH", "USERNAME_EXISTS", "INVALID_CREDENTIALS", "ACCOUNT_CHANGED", "ADMIN_ALREADY_EXISTS",
]);
const categories = new Set(["DATABASE", "FILESYSTEM", "TIMEOUT", "RUNTIME", "KNOWN", "UNKNOWN"]);
const signals = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGBREAK"]);
type MonitorState = { recentEvents: MonitorEvent[]; available: boolean; warned: boolean; registered: boolean };
const globals = globalThis as typeof globalThis & { __yanbanMonitor?: MonitorState };
function state() {
  return globals.__yanbanMonitor ??= { recentEvents: [], available: true, warned: false, registered: false };
}
function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}
function setting(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const number = value === undefined || value.trim() === "" ? fallback : Number(value);
  return integer(number, minimum, maximum) ?? fallback;
}
function configuration() {
  return {
    // Diagnostic files are runtime data, never build assets. In particular,
    // tracing an unknown LOG_DIR must not glob the checkout's .env/database.
    directory: resolve(/* turbopackIgnore: true */ process.env.LOG_DIR || join(/* turbopackIgnore: true */ process.cwd(), "data", "logs")),
    maxBytes: setting(process.env.LOG_MAX_BYTES, 262_144, 65_536, 5_242_880),
    rotationFiles: setting(process.env.LOG_ROTATE_FILES, 3, 1, 5),
  };
}
function safeToken(value: unknown, expression: RegExp) {
  return typeof value === "string" && expression.test(value) ? value : undefined;
}

// A field allowlist is deliberate: message, stack, HTTP headers, form bodies,
// Prisma meta/input, credentials, environment values and chat text never enter this record.
function sanitize(input: Partial<MonitorEventInput>, timestamp: string): MonitorEvent {
  const result: MonitorEvent = {
    timestamp,
    level: input.level === "warn" || input.level === "error" ? input.level : "info",
    kind: eventKinds.has(input.kind || "") ? input.kind! : "EVENT",
  };
  if (typeof input.code === "string" && (safeCodes.has(input.code) || /^P\d{4}$/.test(input.code) || /^(?:ERR_[A-Z0-9_]{1,48}|EACCES|EPERM|ENOENT|ENOSPC|ETIMEDOUT|ECONNREFUSED|ECONNRESET)$/.test(input.code))) result.code = input.code;
  result.requestId = safeToken(input.requestId, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i);
  result.operation = safeToken(input.operation, /^[A-Z][A-Z0-9_]{0,79}$/);
  result.digest = safeToken(input.digest, /^[a-f\d]{1,64}$/i);
  result.signal = typeof input.signal === "string" && signals.has(input.signal) ? input.signal : undefined;
  result.status = integer(input.status, 100, 599);
  result.exitCode = integer(input.exitCode, -2_147_483_648, 4_294_967_295);
  result.attempt = integer(input.attempt, 0, 1_000_000);
  result.category = typeof input.category === "string" && categories.has(input.category) ? input.category : undefined;
  return result;
}

function rotate(file: string, count: number) {
  if (existsSync(/* turbopackIgnore: true */ `${file}.${count}`)) unlinkSync(/* turbopackIgnore: true */ `${file}.${count}`);
  for (let index = count - 1; index >= 1; index--) {
    if (existsSync(/* turbopackIgnore: true */ `${file}.${index}`)) renameSync(/* turbopackIgnore: true */ `${file}.${index}`, /* turbopackIgnore: true */ `${file}.${index + 1}`);
  }
  if (existsSync(/* turbopackIgnore: true */ file)) renameSync(/* turbopackIgnore: true */ file, /* turbopackIgnore: true */ `${file}.1`);
}

export function recordEvent(input: MonitorEventInput): MonitorEvent {
  const event = sanitize(input, new Date().toISOString());
  const current = state();
  current.recentEvents.push(event);
  if (current.recentEvents.length > 50) current.recentEvents.splice(0, current.recentEvents.length - 50);
  try {
    const { directory, maxBytes, rotationFiles } = configuration();
    mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true, mode: 0o700 });
    const file = join(/* turbopackIgnore: true */ directory, "application.jsonl");
    const line = `${JSON.stringify(event)}\n`;
    if (existsSync(/* turbopackIgnore: true */ file) && statSync(/* turbopackIgnore: true */ file).size + Buffer.byteLength(line) > maxBytes) rotate(file, rotationFiles);
    appendFileSync(/* turbopackIgnore: true */ file, line, { encoding: "utf8", mode: 0o600 });
    current.available = true;
  } catch {
    current.available = false;
    if (!current.warned) {
      current.warned = true;
      console.error("[研伴答疑] 安全诊断日志暂时无法写入，请检查日志目录权限和磁盘空间。");
    }
  }
  return event;
}

function classify(error: unknown): Pick<MonitorEvent, "code" | "category" | "digest"> {
  try {
    if (!error || typeof error !== "object") return { code: "UNEXPECTED_ERROR", category: "UNKNOWN" };
    const candidate = error as { name?: unknown; code?: unknown; digest?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const digest = safeToken(candidate.digest, /^[a-f\d]{1,64}$/i);
    if (/^Prisma/.test(String(candidate.name)) || /^P\d{4}$/.test(code)) return { code: /^P\d{4}$/.test(code) ? code : "DATABASE_ERROR", category: "DATABASE", digest };
    if (["EACCES", "EPERM", "ENOENT", "ENOSPC"].includes(code)) return { code, category: "FILESYSTEM", digest };
    if (["ETIMEDOUT", "AbortError", "TimeoutError"].includes(code) || candidate.name === "TimeoutError" || candidate.name === "AbortError") return { code: "TIMEOUT_ERROR", category: "TIMEOUT", digest };
    if (candidate.name === "HttpError" || candidate.name === "DomainError") return { code: safeCodes.has(code) ? code : "INVALID_REQUEST", category: "KNOWN", digest };
    if (["TypeError", "ReferenceError", "RangeError", "SyntaxError"].includes(String(candidate.name))) return { code: "RUNTIME_ERROR", category: "RUNTIME", digest };
    return { code: "UNEXPECTED_ERROR", category: "UNKNOWN", digest };
  } catch {
    return { code: "UNEXPECTED_ERROR", category: "UNKNOWN" };
  }
}

export function reportError(error: unknown, context: { requestId?: string; operation?: string; kind?: "API_ERROR" | "REQUEST_ERROR" } = {}) {
  return recordEvent({ level: "error", kind: "API_ERROR", ...classify(error), ...context });
}

function readTail(file: string): MonitorEvent[] {
  if (!existsSync(/* turbopackIgnore: true */ file)) return [];
  const descriptor = openSync(/* turbopackIgnore: true */ file, "r");
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, 65_536);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8").split("\n").flatMap((line) => {
      try {
        const event: Partial<MonitorEvent> = JSON.parse(line);
        if (!event || typeof event !== "object" || typeof event.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.timestamp)) return [];
        return [sanitize(event, event.timestamp)];
      } catch { return []; }
    });
  } finally { closeSync(descriptor); }
}

export function readMonitorSnapshot() {
  const config = configuration();
  const current = state();
  let recentEvents = [...current.recentEvents];
  try {
    const file = join(/* turbopackIgnore: true */ config.directory, "application.jsonl");
    const persisted = [...readTail(`${file}.1`), ...readTail(file)];
    if (persisted.length) recentEvents = persisted.slice(-50);
  } catch { current.available = false; }
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    runtime: { node: process.versions.node, next: nextVersion, pid: process.pid, platform: process.platform, arch: process.arch },
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
    recentEvents,
    log: { enabled: true, available: current.available, rotationFiles: config.rotationFiles, maxBytes: config.maxBytes },
  };
}

export function registerMonitoring() {
  const current = state();
  if (current.registered) return;
  current.registered = true;
  recordEvent({ kind: "SERVER_STARTED", operation: "NEXT_NODE_SERVER" });
  // Monitoring observes the fatal exception; no uncaughtException handler is
  // installed, so Node retains its normal fatal-exit behavior. Native SIGABRT
  // cannot be caught by JS and is reported by scripts/run-server.mjs instead.
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    recordEvent({ level: "error", kind: "FATAL_ERROR", ...classify(error), operation: origin === "unhandledRejection" ? "UNHANDLED_REJECTION" : "UNCAUGHT_EXCEPTION" });
  });
}
