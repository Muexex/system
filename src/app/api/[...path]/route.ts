import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { domain } from "@/server/domain";
import { DomainError } from "@/server/errors";
import { getUser, isPortal, loginAccount, logout, readProfile, registerAccount, requestPortal, requireUser, updateProfile } from "@/server/auth";
import { readMonitorSnapshot, recordEvent, reportError } from "@/server/monitoring";
import { downloadAttachment, uploadAttachment } from "@/server/attachments";
import { cleanupRtcRoom, issueRtcAccess, retryRtcCleanup } from "@/server/rtc";
import { HttpError, assertSameOrigin, loginRateBucket, optionalString, rateLimit, readJson, requiredBoolean, requiredString } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ path: string[] }> };
const MONITOR_RESOURCES = new Set([
  "student", "teacher", "admin", "me", "catalog", "requests", "answer", "sessions",
  "attachments", "history", "presence", "heartbeat", "offers", "client-errors",
]);

function json(data: unknown) { return NextResponse.json(data); }
function identifier(value: unknown) { return requiredString(value, "资源编号", 200); }

function csvCell(value: string | number | null) {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

async function get(request: Request, parts: string[]): Promise<Response> {
  const [resource, id, action] = parts;
  if (parts.length === 1 && resource === "me") {
    const portal = requestPortal(request);
    const user = await getUser(request);
    return json({ user, portal });
  }
  if (isPortal(resource) && id === "profile" && parts.length === 2) return json(await readProfile(request, resource));
  if (isPortal(resource) && id === "auth") throw new HttpError(404, "接口不存在。", "NOT_FOUND");
  if (parts.length === 1 && resource === "catalog") {
    const result = await domain.catalog();
    await retryRtcCleanup();
    return json(result);
  }
  const user = await requireUser(request);
  if (resource === "admin" && parts.length === 2 && id === "monitoring") {
    if (user.role !== "ADMIN") throw new HttpError(403, "仅管理员可以访问运行监控。", "FORBIDDEN");
    return json(readMonitorSnapshot());
  }
  if (resource === "requests" && parts.length === 2) {
    return json({ request: await domain.getRequest(user.id, identifier(id)) });
  }
  if (resource === "answer" && parts.length === 1) {
    if (user.role !== "ANSWERER") throw new HttpError(403, "仅答疑者可以访问工作台。", "FORBIDDEN");
    const result = await domain.answerDashboard(user.id);
    await retryRtcCleanup();
    return json(result);
  }
  if (resource === "sessions" && parts.length === 2) {
    const session = await domain.getSession(user.id, identifier(id));
    if (session.endedAt) await cleanupRtcRoom(session.id);
    return json({ session });
  }
  if (resource === "sessions" && parts.length === 3 && action === "rtc") {
    return json(await issueRtcAccess(user.id, identifier(id)));
  }
  if (resource === "attachments" && parts.length === 2) {
    return downloadAttachment(user, identifier(id));
  }
  if (resource === "history" && parts.length === 1) {
    return json({ history: await domain.history(user.id) });
  }
  if (resource === "admin" && (parts.length === 1 || (parts.length === 2 && id === "export"))) {
    if (user.role !== "ADMIN") throw new HttpError(403, "仅管理员可以访问。", "FORBIDDEN");
    const data = await domain.adminData(user.id);
    if (parts.length === 1) return json(data);
    const stats = data.stats;
    const rows: (string | number | null)[][] = [
      ["统计项", "值"],
      ["请求数", stats.requestCount], ["成功匹配数", stats.matchedCount],
      ["已完成答疑数", stats.completedCount], ["等待超时数", stats.expiredCount],
      ["取消数", stats.cancelledCount], ["平均匹配耗时（毫秒）", stats.averageMatchMs],
      ["问题已解决比例", stats.solvedRatio], ["反馈数", stats.feedbackCount],
      ...stats.bySubject.map((subject) => [`科目请求量：${subject.name}`, subject.count]),
    ];
    return new Response(`\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=yanban-statistics.csv" },
    });
  }
  throw new HttpError(404, "接口不存在。", "NOT_FOUND");
}

async function post(request: Request, parts: string[]): Promise<Response> {
  assertSameOrigin(request);
  const [resource, id, action] = parts;
  if (["login", "logout"].includes(resource) && parts.length === 1) throw new HttpError(404, "请使用对应账号入口登录。", "NOT_FOUND");
  if (isPortal(resource) && id === "auth" && parts.length === 3) {
    if (action === "logout") return logout(request, resource);
    const body = await readJson(request);
    if (action === "login") return loginAccount(request, resource, body);
    if (action === "register" && resource !== "admin") return registerAccount(request, resource, body);
    throw new HttpError(404, "此入口没有公开注册接口。", "NOT_FOUND");
  }
  if (isPortal(resource) && id === "profile" && (parts.length === 2 || (parts.length === 3 && action === "password"))) {
    return updateProfile(request, resource, await readJson(request), action === "password");
  }
  if (resource === "client-errors" && parts.length === 1) {
    const user = await getUser(request);
    await rateLimit(`client-error:${user?.id ?? loginRateBucket(request)}`, 20);
    const body = await readJson(request);
    const digest = typeof body.digest === "string" && /^[a-fA-F0-9]{1,64}$/.test(body.digest) ? body.digest : undefined;
    const page = typeof body.path === "string" && body.path.length <= 200 ? body.path.split("?")[0] : "";
    const operation = page.startsWith("/student") ? "CLIENT_STUDENT"
      : page.startsWith("/teacher") ? "CLIENT_TEACHER" : page.startsWith("/admin") ? "CLIENT_ADMIN" : "CLIENT_PUBLIC";
    recordEvent({ kind: "CLIENT_ERROR", code: "CLIENT_RENDER_ERROR", digest, operation });
    return json({ ok: true });
  }
  const user = await requireUser(request);
  if (resource === "attachments" && parts.length === 1) {
    return json(await uploadAttachment(request, user));
  }
  const body = await readJson(request);
  if (resource === "requests" && parts.length === 1) {
    if (user.role !== "ASKER") throw new HttpError(403, "仅提问者可以发起请求。", "FORBIDDEN");
    await rateLimit(`requests:${user.id}`, 20);
    if (body.mode !== "DIRECT" && body.mode !== "QUICK") throw new HttpError(400, "请选择有效的匹配方式。");
    return json({ request: await domain.createRequest(user.id, {
      subjectId: requiredString(body.subjectId, "科目", 100),
      description: requiredString(body.description, "问题描述", 2000),
      mode: body.mode,
      targetAnswererId: optionalString(body.targetAnswererId, "答疑者", 100),
      attachmentId: optionalString(body.attachmentId, "图片编号", 100),
      idempotencyKey: requiredString(body.idempotencyKey, "提交编号", 100),
    }) });
  }
  if (resource === "requests" && parts.length === 3 && action === "cancel") {
    return json({ request: await domain.cancelRequest(user.id, identifier(id)) });
  }
  if (resource === "presence" && parts.length === 1) {
    if (user.role !== "ANSWERER") throw new HttpError(403, "仅答疑者可以设置在线状态。", "FORBIDDEN");
    await rateLimit(`presence:${user.id}`, 60);
    return json({ profile: await domain.setPresence(user.id, requiredBoolean(body.online, "在线状态")) });
  }
  if (resource === "heartbeat" && parts.length === 1) {
    if (user.role !== "ANSWERER") throw new HttpError(403, "仅答疑者可以发送在线心跳。", "FORBIDDEN");
    await rateLimit(`heartbeat:${user.id}`, 60);
    return json({ profile: await domain.heartbeat(user.id) });
  }
  if (resource === "offers" && parts.length === 3 && ["accept", "reject"].includes(action)) {
    if (user.role !== "ANSWERER") throw new HttpError(403, "仅答疑者可以处理邀请。", "FORBIDDEN");
    await rateLimit(`offers:${user.id}`, 60);
    if (action === "accept") return json(await domain.acceptOffer(user.id, identifier(id)));
    await domain.rejectOffer(user.id, identifier(id));
    return json({ ok: true });
  }
  if (resource === "sessions" && parts.length === 3) {
    const sessionId = identifier(id);
    if (action === "enter") return json({ session: await domain.enterSession(user.id, sessionId) });
    if (action === "end") {
      const session = await domain.endSession(user.id, sessionId);
      await cleanupRtcRoom(sessionId);
      return json({ session });
    }
    if (action === "messages") {
      await rateLimit(`messages:${user.id}`, 60);
      return json({ message: await domain.sendMessage(user.id, sessionId, {
        body: requiredString(body.body, "消息", 2000),
        clientId: requiredString(body.clientId, "消息编号", 100),
      }) });
    }
    if (action === "feedback") {
      if (!["SOLVED", "PARTIAL", "UNSOLVED"].includes(String(body.resolution))) throw new HttpError(400, "请选择问题解决情况。");
      if (typeof body.rating !== "number" || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
        throw new HttpError(400, "满意度应为 1—5 分。");
      }
      return json({ feedback: await domain.feedback(user.id, sessionId, {
        resolution: body.resolution as "SOLVED" | "PARTIAL" | "UNSOLVED", rating: body.rating,
        comment: optionalString(body.comment, "反馈意见", 500) ?? "",
      }) });
    }
  }
  if (resource === "admin" && parts.length === 3 && id === "answerers") {
    if (user.role !== "ADMIN") throw new HttpError(403, "仅管理员可以修改答疑者。", "FORBIDDEN");
    if (!Array.isArray(body.subjectIds) || body.subjectIds.length > 50 || body.subjectIds.some((subject) => typeof subject !== "string" || !subject || subject.length > 100)) {
      throw new HttpError(400, "请选择有效的可答科目。");
    }
    await domain.updateAnswerer(user.id, identifier(action), {
      enabled: requiredBoolean(body.enabled, "启用状态"), subjectIds: [...new Set(body.subjectIds as string[])],
    });
    return json({ ok: true });
  }
  throw new HttpError(404, "接口不存在。", "NOT_FOUND");
}

async function handle(request: Request, context: Context, method: "GET" | "POST") {
  try {
    const { path } = await context.params;
    if (!Array.isArray(path) || path.length < 1 || path.length > 3) throw new HttpError(404, "接口不存在。", "NOT_FOUND");
    const response = await (method === "GET" ? get(request, path) : post(request, path));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("Vary", "Cookie, X-Yanban-Portal");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch (error) {
    const known = error instanceof HttpError || error instanceof DomainError;
    const requestId = randomUUID();
    if (!known) {
      const resource = new URL(request.url).pathname.split("/")[2];
      const first = MONITOR_RESOURCES.has(resource) ? resource.toUpperCase().replaceAll("-", "_") : "UNKNOWN";
      reportError(error, { requestId, operation: `API_${method}_${first}` });
    }
    return NextResponse.json({
      error: known ? error.message : "服务暂时不可用，请稍后重试。",
      code: known ? error.code : "INTERNAL_ERROR",
      ...(known ? {} : { requestId }),
    }, { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: Request, context: Context) { return handle(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return handle(request, context, "POST"); }
