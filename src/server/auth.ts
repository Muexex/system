import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "../generated/prisma/client";
import { db } from "./db";
import { domain } from "./domain";
import { hashPassword, normalizeUsername, validatePassword, verifyPassword } from "./credentials";
import { HttpError, loginRateBucket, optionalString, rateLimit, requestOrigin, requiredString } from "./security";

export type Portal = "student" | "teacher" | "admin";
export type AuthUser = { id: string; name: string; role: "ASKER" | "ANSWERER" | "ADMIN"; portal: Portal };
export const PORTAL_COOKIES = {
  student: "yanban_student_session", teacher: "yanban_teacher_session", admin: "yanban_admin_session",
} as const;
export const TERMS_VERSION = "2026-10-03";
const PORTAL_ROLES = { student: "ASKER", teacher: "ANSWERER", admin: "ADMIN" } as const;
const DEGREES = ["UNDERGRADUATE", "MASTER", "DOCTORATE"];
type Tx = Prisma.TransactionClient;
type Lookup = { username: string } | { userId: string };

export function isPortal(value: unknown): value is Portal {
  return value === "student" || value === "teacher" || value === "admin";
}

/** A portal header/query only selects a cookie; identity/role always come from SQLite. */
export function requestPortal(request: Request, fallback?: Portal): Portal {
  const explicit = request.headers.get("x-yanban-portal") ?? new URL(request.url).searchParams.get("portal");
  if (explicit !== null) {
    if (!isPortal(explicit)) throw new HttpError(400, "账号入口无效。", "INVALID_PORTAL");
    return explicit;
  }
  if (fallback) return fallback;
  return new URL(request.url).pathname.startsWith("/api/admin") ? "admin" : "student";
}

export function publicUser(user: { id: string; name: string; role: string }, portal: Portal): AuthUser {
  return { id: user.id, name: user.name, role: user.role as AuthUser["role"], portal };
}

function sessionToken(request: Request, portal: Portal) {
  const name = PORTAL_COOKIES[portal];
  const value = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }

async function findAccount(client: Tx | typeof db, portal: Portal, where: Lookup) {
  if (portal === "student") return client.studentAccount.findUnique({ where, include: { user: true } });
  if (portal === "teacher") return client.teacherAccount.findUnique({ where, include: { user: true } });
  return client.adminAccount.findUnique({ where, include: { user: true } });
}

async function writeFence(tx: Tx) {
  await tx.writeFence.upsert({ where: { id: 1 }, create: { id: 1, revision: 1 }, update: { revision: { increment: 1 } } });
}

export async function getUser(request: Request, fixedPortal?: Portal): Promise<AuthUser | null> {
  const portal = fixedPortal ?? requestPortal(request);
  const token = sessionToken(request, portal);
  if (!token) return null;
  const session = await db.loginSession.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
  if (!session || session.portal !== portal || session.expiresAt.getTime() <= Date.now()
    || session.user.role !== PORTAL_ROLES[portal]) return null;
  // Legacy demonstration principals have no formal account binding and cannot authenticate.
  const account = await findAccount(db, portal, { userId: session.userId });
  return account ? publicUser(session.user, portal) : null;
}

export async function requireUser(request: Request, role?: AuthUser["role"], fixedPortal?: Portal) {
  const user = await getUser(request, fixedPortal);
  if (!user) throw new HttpError(401, "请先登录当前入口。", "UNAUTHENTICATED");
  if (role && user.role !== role) throw new HttpError(403, "当前账号没有此操作权限。", "FORBIDDEN");
  return user;
}

function cookieOptions(request: Request) {
  const secure = new URL(request.url).protocol === "https:" || new URL(requestOrigin(request)).protocol === "https:";
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
}

function sessionDays(remember: boolean) {
  const configured = Number(remember ? process.env.AUTH_REMEMBER_DAYS : process.env.AUTH_SESSION_DAYS);
  return Number.isInteger(configured) && configured >= 1 && configured <= 90 ? configured : remember ? 30 : 7;
}

function newSession(remember = false) {
  const token = randomBytes(32).toString("hex");
  return { token, remember, expiresAt: new Date(Date.now() + sessionDays(remember) * 86_400_000) };
}

async function saveSession(tx: Tx, request: Request, userId: string, portal: Portal, session: ReturnType<typeof newSession>) {
  const old = sessionToken(request, portal);
  if (old) await tx.loginSession.deleteMany({ where: { tokenHash: tokenHash(old), portal } });
  await tx.loginSession.create({ data: { id: randomUUID(), tokenHash: tokenHash(session.token), portal, userId, expiresAt: session.expiresAt } });
}

function authenticatedResponse(request: Request, portal: Portal, user: AuthUser, session: ReturnType<typeof newSession>, extra: Record<string, unknown> = {}) {
  const response = NextResponse.json({ user, ...extra });
  response.cookies.set(PORTAL_COOKIES[portal], session.token, {
    ...cookieOptions(request), ...(session.remember ? {
      expires: session.expiresAt, maxAge: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)),
    } : {}),
  });
  return response;
}

function boundedText(value: unknown, label: string, min: number, max: number) {
  const text = requiredString(value, label, max);
  if (Array.from(text).length < min) throw new HttpError(400, `${label}须为 ${min}—${max} 字。`);
  return text;
}

function subjectIds(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50
    || value.some((item) => typeof item !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(item))) {
    throw new HttpError(400, "请至少选择一个有效的可答科目。", "INVALID_SUBJECTS");
  }
  return [...new Set(value as string[])];
}

function degree(value: unknown) {
  if (typeof value !== "string" || !DEGREES.includes(value)) throw new HttpError(400, "请选择本科、硕士或博士在读阶段。", "INVALID_DEGREE");
  return value;
}

function assertRegistrationConsent(body: Record<string, unknown>, portal: "student" | "teacher") {
  if (body.adultConfirmed !== true || body.termsAccepted !== true) {
    throw new HttpError(400, "须确认已成年，并阅读同意服务条款。", "CONSENT_REQUIRED");
  }
  if (portal === "teacher" && (body.fullTimeConfirmed !== true || body.notEmployedConfirmed !== true)) {
    throw new HttpError(400, "教师须确认是非在职的全日制在校大学生或研究生。", "QUALIFICATION_REQUIRED");
  }
}

export async function registerAccount(request: Request, portal: "student" | "teacher", body: Record<string, unknown>) {
  await rateLimit(`${loginRateBucket(request)}:${portal}:register`, 20, 60 * 60_000);
  const username = normalizeUsername(body.username);
  const password = validatePassword(body.password);
  if (body.confirmPassword !== password) throw new HttpError(400, "两次输入的密码不一致。", "PASSWORD_MISMATCH");
  assertRegistrationConsent(body, portal);
  const displayName = boundedText(body.displayName, "昵称", 2, 30);
  const university = portal === "teacher" ? boundedText(body.university, "学校", 2, 100) : optionalString(body.university, "学校", 100);
  const major = optionalString(body.major, "专业", 100);
  const teacherDegree = portal === "teacher" ? degree(body.degree) : undefined;
  const bio = portal === "teacher" ? boundedText(body.bio, "擅长方向", 20, 500) : "";
  const chosenSubjects = portal === "teacher" ? subjectIds(body.subjectIds) : [];
  const passwordHash = await hashPassword(password);
  const userId = `${portal}-${randomUUID()}`;
  const session = newSession();
  const now = new Date();
  try {
    const user = await db.$transaction(async (tx) => {
      await writeFence(tx);
      if (await findAccount(tx, portal, { username })) throw new HttpError(409, "此入口中的账号已存在，请换一个账号。", "USERNAME_EXISTS");
      if (chosenSubjects.length && await tx.subject.count({ where: { id: { in: chosenSubjects } } }) !== chosenSubjects.length) {
        throw new HttpError(400, "所选科目不存在，请刷新页面重新选择。", "INVALID_SUBJECTS");
      }
      const principal = await tx.user.create({ data: { id: userId, name: displayName, role: PORTAL_ROLES[portal] } });
      const shared = { userId, username, passwordHash, displayName, university, major, adultConfirmedAt: now, termsAcceptedAt: now, termsVersion: TERMS_VERSION };
      if (portal === "student") await tx.studentAccount.create({ data: shared });
      else {
        await tx.teacherAccount.create({ data: { ...shared, degree: teacherDegree, qualificationConfirmedAt: now } });
        await tx.answererProfile.create({ data: {
          userId, bio, enabled: false, online: false, heartbeatAt: null,
          isAdult: true, isFullTimeStudent: true, isEmployed: false, profileSource: "SELF_DECLARED",
          subjects: { create: chosenSubjects.map((subjectId) => ({ subjectId })) },
        } });
      }
      await saveSession(tx, request, userId, portal, session);
      await tx.businessEvent.create({ data: { kind: "ACCOUNT_REGISTERED", actorId: userId, detail: portal } });
      return publicUser(principal, portal);
    });
    return authenticatedResponse(request, portal, user, session, await profileData(user));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new HttpError(409, "此入口中的账号已存在，请换一个账号。", "USERNAME_EXISTS");
    }
    throw error;
  }
}

export async function loginAccount(request: Request, portal: Portal, body: Record<string, unknown>) {
  await rateLimit(`${loginRateBucket(request)}:${portal}`, 60);
  const username = normalizeUsername(body.username);
  const password = validatePassword(body.password);
  if (body.remember !== undefined && typeof body.remember !== "boolean") throw new HttpError(400, "记住登录选项无效。");
  await rateLimit(`login-account:${portal}:${username}`, 20);
  const account = await findAccount(db, portal, { username });
  const verified = await verifyPassword(password, account?.passwordHash);
  if (!verified || !account || account.user.role !== PORTAL_ROLES[portal]) throw new HttpError(401, "账号或密码错误。", "INVALID_CREDENTIALS");
  const session = newSession(body.remember === true);
  const user = await db.$transaction(async (tx) => {
    await writeFence(tx);
    const fresh = await findAccount(tx, portal, { userId: account.userId });
    if (!fresh || fresh.passwordHash !== account.passwordHash || fresh.user.role !== PORTAL_ROLES[portal]) {
      throw new HttpError(401, "账号或密码错误。", "INVALID_CREDENTIALS");
    }
    await saveSession(tx, request, account.userId, portal, session);
    return publicUser(fresh.user, portal);
  });
  return authenticatedResponse(request, portal, user, session);
}

export async function logout(request: Request, fixedPortal?: Portal) {
  const portal = fixedPortal ?? requestPortal(request);
  const user = await getUser(request, portal);
  if (user?.role === "ANSWERER") await domain.setPresence(user.id, false);
  const token = sessionToken(request, portal);
  if (token) await db.loginSession.deleteMany({ where: { tokenHash: tokenHash(token), portal } });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PORTAL_COOKIES[portal], "", { ...cookieOptions(request), maxAge: 0 });
  return response;
}

async function profileData(user: AuthUser) {
  const account = await findAccount(db, user.portal, { userId: user.id });
  if (!account) throw new HttpError(401, "账号资料不存在，请重新登录。", "UNAUTHENTICATED");
  const teacher = user.portal === "teacher" ? await db.answererProfile.findUnique({ where: { userId: user.id }, include: { subjects: true } }) : null;
  const subjects = await db.subject.findMany({ orderBy: { id: "asc" } });
  return { profile: {
    userId: user.id, username: account.username, account: account.username,
    displayName: "displayName" in account ? account.displayName : user.name,
    university: "university" in account ? account.university : null,
    major: "major" in account ? account.major : null, degree: "degree" in account ? account.degree : null,
    bio: teacher?.bio ?? "", subjectIds: teacher?.subjects.map((item) => item.subjectId) ?? [], enabled: teacher?.enabled ?? true,
    approvalStatus: teacher && !teacher.enabled ? "PENDING" : "APPROVED", profileSource: teacher?.profileSource ?? null,
    qualificationConfirmedAt: "qualificationConfirmedAt" in account ? account.qualificationConfirmedAt : null,
    adultConfirmedAt: "adultConfirmedAt" in account ? account.adultConfirmedAt : null,
    termsAcceptedAt: "termsAcceptedAt" in account ? account.termsAcceptedAt : null,
    termsVersion: "termsVersion" in account ? account.termsVersion : null,
  }, subjects };
}

export async function readProfile(request: Request, portal: Portal) {
  const user = await requireUser(request, PORTAL_ROLES[portal], portal);
  return profileData(user);
}

export async function updateProfile(request: Request, portal: Portal, body: Record<string, unknown>, passwordOnly = false) {
  const user = await requireUser(request, PORTAL_ROLES[portal], portal);
  await rateLimit(`profile:${portal}:${user.id}`, 20);
  const account = await findAccount(db, portal, { userId: user.id });
  if (!account) throw new HttpError(401, "请重新登录。", "UNAUTHENTICATED");
  const changingPassword = passwordOnly || body.newPassword !== undefined || body.currentPassword !== undefined;
  let passwordHash: string | undefined;
  if (changingPassword) {
    const currentPassword = validatePassword(body.currentPassword);
    const newPassword = validatePassword(body.newPassword);
    if (!await verifyPassword(currentPassword, account.passwordHash)) throw new HttpError(401, "原密码错误。", "INVALID_CREDENTIALS");
    if (body.confirmPassword !== undefined && body.confirmPassword !== newPassword) throw new HttpError(400, "两次输入的新密码不一致。", "PASSWORD_MISMATCH");
    passwordHash = await hashPassword(newPassword);
  }
  if (portal === "admin" && !changingPassword) throw new HttpError(400, "管理员资料仅支持安全修改密码。");
  const displayName = body.displayName !== undefined ? boundedText(body.displayName, "昵称", 2, 30) : undefined;
  const university = body.university !== undefined
    ? portal === "teacher" ? boundedText(body.university, "学校", 2, 100) : optionalString(body.university, "学校", 100) ?? null : undefined;
  const major = body.major !== undefined ? optionalString(body.major, "专业", 100) ?? null : undefined;
  const teacherDegree = portal === "teacher" && body.degree !== undefined ? degree(body.degree) : undefined;
  const bio = portal === "teacher" && body.bio !== undefined ? boundedText(body.bio, "擅长方向", 20, 500) : undefined;
  const chosenSubjects = portal === "teacher" && body.subjectIds !== undefined ? subjectIds(body.subjectIds) : undefined;
  const teacherChanges = portal === "teacher" && [displayName, university, major, teacherDegree, bio, chosenSubjects].some((value) => value !== undefined);
  if (teacherChanges && changingPassword) throw new HttpError(400, "请分别保存个人资料和修改密码。");
  if (teacherChanges) {
    await domain.updateTeacherProfile(user.id, { displayName, university, major, degree: teacherDegree, bio, subjectIds: chosenSubjects });
    const current = { ...user, name: displayName ?? user.name };
    return NextResponse.json({ user: current, ...await profileData(current) });
  }
  const session = changingPassword ? newSession() : null;
  await db.$transaction(async (tx) => {
    await writeFence(tx);
    const fresh = await findAccount(tx, portal, { userId: user.id });
    if (!fresh || (changingPassword && fresh.passwordHash !== account.passwordHash)) throw new HttpError(409, "账号状态已改变，请重新登录后重试。", "ACCOUNT_CHANGED");
    if (displayName !== undefined) await tx.user.update({ where: { id: user.id }, data: { name: displayName } });
    if (portal === "student") await tx.studentAccount.update({ where: { userId: user.id }, data: { displayName, university, major, passwordHash } });
    else if (portal === "teacher" && passwordHash) await tx.teacherAccount.update({ where: { userId: user.id }, data: { passwordHash } });
    else if (portal === "admin" && passwordHash) await tx.adminAccount.update({ where: { userId: user.id }, data: { passwordHash } });
    if (session) {
      await tx.loginSession.deleteMany({ where: { userId: user.id, portal } });
      await saveSession(tx, request, user.id, portal, session);
    }
    await tx.businessEvent.create({ data: { kind: changingPassword ? "PASSWORD_CHANGED" : "PROFILE_UPDATED", actorId: user.id, detail: portal } });
  });
  const current = { ...user, name: displayName ?? user.name };
  const data = await profileData(current);
  return session ? authenticatedResponse(request, portal, current, session, data) : NextResponse.json({ user: current, ...data });
}

/** Local, interactive initialization only; deliberately no public admin registration. */
export async function createAdministrator(usernameInput: unknown, passwordInput: unknown, displayNameInput: unknown = "管理员") {
  const username = normalizeUsername(usernameInput);
  const passwordHash = await hashPassword(validatePassword(passwordInput));
  const displayName = boundedText(displayNameInput, "管理员昵称", 2, 30);
  return db.$transaction(async (tx) => {
    await writeFence(tx);
    if (await tx.adminAccount.count()) throw new HttpError(409, "管理员已初始化，请使用现有管理员账号登录。", "ADMIN_ALREADY_EXISTS");
    const user = await tx.user.create({ data: { id: `admin-${randomUUID()}`, name: displayName, role: "ADMIN" } });
    await tx.adminAccount.create({ data: { userId: user.id, username, passwordHash } });
    await tx.businessEvent.create({ data: { kind: "ADMIN_INITIALIZED", actorId: user.id } });
    return { id: user.id, username, displayName };
  });
}
