import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "./db";
import { HttpError, loginRateBucket, rateLimit, requestOrigin, requiredString } from "./security";

export const SESSION_COOKIE = "yanban_session";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
export type AuthUser = { id: string; name: string; role: "ASKER" | "ANSWERER" | "ADMIN" };

export function isDemoMode() {
  return process.env.APP_DEMO_MODE === "true";
}

export function publicUser(user: AuthUser): AuthUser {
  return { id: user.id, name: user.name, role: user.role };
}

function sessionToken(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function getUser(request: Request): Promise<AuthUser | null> {
  // All current sessions originate from demo login; disabling demo also revokes
  // their access. A future production identity provider must add its own path.
  if (!isDemoMode()) return null;
  const token = sessionToken(request);
  if (!token) return null;
  const session = await db.loginSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return publicUser(session.user as AuthUser);
}

export async function requireUser(request: Request, role?: AuthUser["role"]) {
  const user = await getUser(request);
  if (!user) throw new HttpError(401, "请先登录。", "UNAUTHENTICATED");
  if (role && user.role !== role) {
    throw new HttpError(403, "当前账号没有此操作权限。", "FORBIDDEN");
  }
  return user;
}

function cookieOptions(request: Request) {
  // Local HTTP development must work; HTTPS receives Secure even in development.
  const secure = new URL(request.url).protocol === "https:"
    || new URL(requestOrigin(request)).protocol === "https:";
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
}

export async function demoLogin(request: Request, accountId: unknown) {
  if (!isDemoMode()) {
    throw new HttpError(403, "演示登录已关闭；正式登录尚未接入。", "DEMO_DISABLED");
  }
  await rateLimit(loginRateBucket(request), 60);
  const id = requiredString(accountId, "演示账号", 100);
  // Strict seed allowlist prevents this endpoint becoming a generic role bypass.
  if (!["asker-a", "asker-b", "answerer-a", "answerer-b", "answerer-c", "admin"].includes(id)) {
    throw new HttpError(400, "请选择有效的演示账号。");
  }
  const user = await db.user.findUnique({ where: { id } });
  if (!user) throw new HttpError(404, "演示账号未初始化，请先运行 setup。", "ACCOUNT_NOT_FOUND");
  const oldToken = sessionToken(request);
  const token = randomBytes(32).toString("hex");
  await db.$transaction(async (tx) => {
    if (oldToken) await tx.loginSession.deleteMany({ where: { tokenHash: tokenHash(oldToken) } });
    await tx.loginSession.create({
      data: { id: randomBytes(16).toString("hex"), tokenHash: tokenHash(token), userId: id,
        expiresAt: new Date(Date.now() + SESSION_DURATION_MS) },
    });
  });
  const response = NextResponse.json({ user: publicUser(user as AuthUser) });
  response.cookies.set(SESSION_COOKIE, token, {
    ...cookieOptions(request), maxAge: SESSION_DURATION_MS / 1000,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function logout(request: Request) {
  const token = sessionToken(request);
  if (token) await db.loginSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(request), maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
