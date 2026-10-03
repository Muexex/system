import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDatabase } from "../prisma/seed";
import { migratedTestDatabase } from "./isolated-db";

type Route = typeof import("@/app/api/[...path]/route");
type Database = ReturnType<typeof import("@/server/db")["createDb"]>;
let template: Awaited<ReturnType<typeof migratedTestDatabase>>;
let directory: string;
let database: Database;
let route: Route;
const base = "http://localhost:3000";
const problem = "请帮我解释这道考研数学极限题的推导过程，并说明适用条件。";
const previousEnvironment = { ...process.env };
const fixturePassword = "YanbanTest!2026";
type Portal = "student" | "teacher" | "admin";
function portalOf(cookie: string): Portal {
  return cookie.includes("yanban_teacher_session=") ? "teacher" : cookie.includes("yanban_admin_session=") ? "admin" : "student";
}

async function api(path: string, cookie = "", body?: unknown, extraHeaders: Record<string, string> = {}) {
  const method = body === undefined ? "GET" : "POST";
  const authPortal = path.match(/^(student|teacher|admin)\/auth\//)?.[1];
  const headers: Record<string, string> = { cookie, "X-Yanban-Portal": authPortal || portalOf(cookie), ...extraHeaders };
  if (method === "POST") {
    headers.origin ??= base;
    headers["content-type"] ??= "application/json";
  }
  const request = new Request(`${base}/api/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return route[method](request, { params: Promise.resolve({ path: path.split("/") }) });
}

async function login(accountId: string, existingCookie = "") {
  const portal: Portal = accountId === "admin" ? "admin" : accountId.startsWith("answerer") ? "teacher" : "student";
  const response = await api(`${portal}/auth/login`, existingCookie, { username: accountId, password: fixturePassword }, { "X-Yanban-Portal": portal });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toMatch(/SameSite=lax/i);
  return cookie.split(";")[0];
}

function registration(portal: "student" | "teacher", changes: Record<string, unknown> = {}) {
  return {
    username: "registered-user", displayName: portal === "teacher" ? "注册教师" : "注册学生",
    password: "Registration!2026", confirmPassword: "Registration!2026", adultConfirmed: true, termsAccepted: true,
    ...(portal === "teacher" ? { university: "示例大学", degree: "MASTER", bio: "擅长考研数学极限、微积分与线性代数，愿意耐心解释问题。",
      subjectIds: ["math"], fullTimeConfirmed: true, notEmployedConfirmed: true } : {}), ...changes,
  };
}
async function register(portal: "student" | "teacher", changes: Record<string, unknown> = {}) {
  return api(`${portal}/auth/register`, "", registration(portal, changes), { "X-Yanban-Portal": portal });
}

async function startedRoom(attachmentId?: string) {
  const asker = await login("asker-a");
  const answerer = await login("answerer-a");
  expect((await api("presence", answerer, { online: true })).ok).toBe(true);
  const response = await api("requests", asker, {
    subjectId: "math", description: problem, mode: "DIRECT", targetAnswererId: "answerer-a",
    idempotencyKey: randomUUID(), attachmentId,
  });
  expect(response.ok).toBe(true);
  const { request } = await response.json();
  const offer = await database.invitation.findFirstOrThrow({ where: { requestId: request.id } });
  const accepted = await api(`offers/${offer.id}/accept`, answerer, {});
  expect(accepted.ok).toBe(true);
  const { sessionId } = await accepted.json();
  return { asker, answerer, sessionId, requestId: request.id };
}

async function upload(cookie: string, bytes: Uint8Array, mime: string, name: string) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type: mime }), name);
  return route.POST(new Request(`${base}/api/attachments`, {
    method: "POST", headers: { origin: base, cookie, "X-Yanban-Portal": "student" }, body: form,
  }), { params: Promise.resolve({ path: ["attachments"] }) });
}

beforeAll(async () => {
  template = await migratedTestDatabase();
  process.env.DATABASE_URL = template.url;
  const { createDb } = await import("@/server/db");
  const initial = createDb(template.url);
  await seedDatabase(initial, { fixtures: true });
  await initial.$disconnect();
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "yanban-vitest-api-"));
  const file = join(directory, "test.db");
  await copyFile(template.file, file);
  process.env.DATABASE_URL = `file:${file}`;
  process.env.APP_DEMO_MODE = "false";
  process.env.APP_ORIGIN = base;
  process.env.UPLOAD_DIR = join(directory, "uploads");
  process.env.LOG_DIR = join(directory, "logs");
  process.env.RTC_PROVIDER = "demo";
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete (globalThis as { yanbanDb?: Database }).yanbanDb;
  vi.resetModules();
  route = await import("@/app/api/[...path]/route");
  database = (await import("@/server/db")).db;
});

afterEach(async () => {
  await database?.$disconnect();
  delete (globalThis as { yanbanDb?: Database }).yanbanDb;
  if (directory) await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await template?.cleanup();
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
});

describe("HTTP boundary security against real persisted sessions", () => {
  it("creates random server sessions from passwords, ignores supplied roles, and logout revokes access", async () => {
    const response = await api("student/auth/login", "", { username: "asker-a", password: fixturePassword, userId: "admin", role: "ADMIN" });
    expect((await response.json()).user.role).toBe("ASKER");
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).toMatch(/^yanban_student_session=[a-f0-9]{64}$/);
    expect(await database.loginSession.count()).toBe(1);
    const me = await api("me", cookie);
    expect(me.headers.get("cache-control")).toContain("no-store");
    expect((await me.json()).user.id).toBe("asker-a");
    await api("student/auth/logout", cookie, {});
    expect((await api("history", cookie)).status).toBe(401);
    expect(await database.loginSession.count()).toBe(0);
  });

  it("the former demo endpoint and cookies stay unusable even when its old flag is true", async () => {
    process.env.APP_DEMO_MODE = "true";
    expect((await api("login", "", { accountId: "admin" })).status).toBe(404);
    expect((await api("logout", "", {})).status).toBe(404);
    const token = randomBytes(32).toString("hex");
    await database.loginSession.create({ data: { userId: "admin", portal: "LEGACY",
      tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) } });
    expect((await api("admin", `yanban_session=${token}`, undefined, { "X-Yanban-Portal": "admin" })).status).toBe(401);
    const me = await (await api("me")).json();
    expect(me.user).toBeNull();
    expect(me).not.toHaveProperty("accounts");
    expect(me).not.toHaveProperty("demoMode");
  });

  it("HTTPS sessions carry Secure and forged cookies do not grant a role", async () => {
    process.env.APP_ORIGIN = "https://prototype.example";
    const response = await route.POST(new Request("https://prototype.example/api/student/auth/login", {
      method: "POST", headers: { origin: "https://prototype.example", "content-type": "application/json" },
      body: JSON.stringify({ username: "asker-a", password: fixturePassword }),
    }), { params: Promise.resolve({ path: ["student", "auth", "login"] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect((await api("admin", `yanban_admin_session=${"a".repeat(64)}; role=ADMIN`)).status).toBe(401);
  });

  it("rejects cross-site and missing-origin writes without changing the database", async () => {
    const response = await api("admin/auth/login", "", { username: "admin", password: fixturePassword }, { origin: "https://outside.example" });
    expect(response.status).toBe(403);
    const absent = await route.POST(new Request(`${base}/api/admin/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: fixturePassword }),
    }), { params: Promise.resolve({ path: ["admin", "auth", "login"] }) });
    expect(absent.status).toBe(403);
    expect(await database.loginSession.count()).toBe(0);
  });

  it("uses the original Host for local aliases and ignores untrusted proxy headers", async () => {
    delete process.env.APP_ORIGIN;
    delete process.env.TRUST_PROXY;
    for (const host of ["localhost:3000", "127.0.0.1:3000"]) {
      const response = await route.POST(new Request("http://0.0.0.0:3000/api/student/auth/login", {
        method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json",
          "x-forwarded-host": "outside.example", "x-forwarded-proto": "https" },
        body: JSON.stringify({ username: "asker-a", password: fixturePassword }),
      }), { params: Promise.resolve({ path: ["student", "auth", "login"] }) });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).not.toContain("Secure");
    }
    const forged = await route.POST(new Request("http://0.0.0.0:3000/api/student/auth/login", {
      method: "POST", headers: { host: "localhost:3000", origin: "https://outside.example", "content-type": "application/json",
        "x-forwarded-host": "outside.example", "x-forwarded-proto": "https" },
      body: JSON.stringify({ username: "asker-a", password: fixturePassword }),
    }), { params: Promise.resolve({ path: ["student", "auth", "login"] }) });
    expect(forged.status).toBe(403);
    expect(await database.loginSession.count()).toBe(2);
  });

  it("explicit APP_ORIGIN takes precedence and enables Secure behind an HTTPS proxy", async () => {
    process.env.APP_ORIGIN = "https://prototype.example";
    const postLogin = (origin: string) => route.POST(new Request("http://0.0.0.0:3000/api/student/auth/login", {
      method: "POST", headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json",
        "x-forwarded-host": "outside.example", "x-forwarded-proto": "http" },
      body: JSON.stringify({ username: "asker-a", password: fixturePassword }),
    }), { params: Promise.resolve({ path: ["student", "auth", "login"] }) });
    expect((await postLogin("http://127.0.0.1:3000")).status).toBe(403);
    const external = await postLogin("https://prototype.example");
    expect(external.status).toBe(200);
    expect(external.headers.get("set-cookie")).toContain("Secure");
    expect(await database.loginSession.count()).toBe(1);
  });

  it("normal seed creates only subjects and never creates default credentials", async () => {
    const clean = await migratedTestDatabase();
    const { createDb } = await import("@/server/db");
    const client = createDb(clean.url);
    try {
      await seedDatabase(client);
      await seedDatabase(client);
      expect(await client.subject.count()).toBe(4);
      expect(await client.user.count()).toBe(0);
      expect(await client.studentAccount.count()).toBe(0);
      expect(await client.teacherAccount.count()).toBe(0);
      expect(await client.adminAccount.count()).toBe(0);
    } finally { await client.$disconnect(); await clean.cleanup(); }
  });

  it("student registration creates its own identity, persists consent and hashes the password", async () => {
    const response = await register("student", { userId: "admin", role: "ADMIN" });
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.user).toMatchObject({ role: "ASKER", portal: "student", name: "注册学生" });
    expect(data.user.id).not.toBe("admin");
    const stored = await database.studentAccount.findUniqueOrThrow({ where: { userId: data.user.id } });
    expect(stored.passwordHash).not.toBe("Registration!2026");
    expect(stored.passwordHash.length).toBeGreaterThan(80);
    expect(stored.adultConfirmedAt).not.toBeNull();
    expect(stored.termsAcceptedAt).not.toBeNull();
    expect(stored.termsVersion).not.toBe("");
    expect(JSON.stringify(data)).not.toMatch(/passwordHash|Registration!2026/);
    expect((await register("student")).status).toBe(409);
    expect(await database.studentAccount.count({ where: { username: "registered-user" } })).toBe(1);
  });

  it("registration validates account syntax, password confirmation and mandatory consent on the server", async () => {
    const invalid = [
      { username: "<script>" }, { password: "short", confirmPassword: "short" },
      { confirmPassword: "Different!2026" }, { displayName: "A" },
      { adultConfirmed: false }, { termsAccepted: false },
      { adultConfirmed: undefined, adultAccepted: true },
    ];
    for (const fields of invalid) expect((await register("student", fields)).status).toBe(400);
    expect(await database.studentAccount.count({ where: { username: "registered-user" } })).toBe(0);
  });

  it("teacher registration requires all eligibility declarations and creates a pending profile", async () => {
    for (const fields of [{ fullTimeConfirmed: false }, { notEmployedConfirmed: false }, { university: "" },
      { degree: "INVALID" }, { subjectIds: [] }, { bio: "太短" }]) {
      expect((await register("teacher", fields)).status).toBe(400);
    }
    const response = await register("teacher");
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.user).toMatchObject({ role: "ANSWERER", portal: "teacher" });
    const profile = await database.answererProfile.findUniqueOrThrow({ where: { userId: data.user.id } });
    expect(profile).toMatchObject({ enabled: false, online: false, profileSource: "SELF_DECLARED", isAdult: true, isFullTimeStudent: true, isEmployed: false });
    const teacher = response.headers.get("set-cookie")!.split(";")[0];
    expect((await api("presence", teacher, { online: true })).status).toBe(403);
    const admin = await login("admin");
    expect((await api(`admin/answerers/${data.user.id}`, admin, { enabled: true, subjectIds: ["math"] })).ok).toBe(true);
    expect((await api("presence", teacher, { online: true })).ok).toBe(true);
    const catalog = await (await api("catalog")).json();
    expect(catalog.answerers.find((p: { id: string }) => p.id === data.user.id)?.status).toBe("AVAILABLE");
  });

  it("student and teacher usernames are independent and credentials do not cross portals", async () => {
    expect((await register("student", { username: "shared-name", password: "StudentOnly!2026", confirmPassword: "StudentOnly!2026" })).ok).toBe(true);
    expect((await register("teacher", { username: "shared-name", password: "TeacherOnly!2026", confirmPassword: "TeacherOnly!2026" })).ok).toBe(true);
    const wrongStudent = await api("student/auth/login", "", { username: "shared-name", password: "TeacherOnly!2026" });
    const wrongTeacher = await api("teacher/auth/login", "", { username: "shared-name", password: "StudentOnly!2026" });
    expect(wrongStudent.status).toBe(401);
    expect(wrongTeacher.status).toBe(401);
    expect((await api("student/auth/login", "", { username: "shared-name", password: "StudentOnly!2026" })).ok).toBe(true);
    expect((await api("teacher/auth/login", "", { username: "shared-name", password: "TeacherOnly!2026" })).ok).toBe(true);
    expect(await database.studentAccount.count({ where: { username: "shared-name" } })).toBe(1);
    expect(await database.teacherAccount.count({ where: { username: "shared-name" } })).toBe(1);
  });

  it("one browser may hold both portal cookies and logging out student keeps teacher signed in", async () => {
    const student = await login("asker-a");
    const teacher = await login("answerer-a", student);
    const together = `${student}; ${teacher}`;
    expect((await (await api("me", together, undefined, { "X-Yanban-Portal": "student" })).json()).user.id).toBe("asker-a");
    expect((await (await api("me", together, undefined, { "X-Yanban-Portal": "teacher" })).json()).user.id).toBe("answerer-a");
    await api("student/auth/logout", together, {}, { "X-Yanban-Portal": "student" });
    expect((await api("history", together, undefined, { "X-Yanban-Portal": "student" })).status).toBe(401);
    expect((await (await api("me", together, undefined, { "X-Yanban-Portal": "teacher" })).json()).user.id).toBe("answerer-a");
    expect(await database.loginSession.count()).toBe(1);
  });

  it("portal hints never turn a student token into teacher or admin authority", async () => {
    const student = await login("asker-a");
    expect((await api("answer", student, undefined, { "X-Yanban-Portal": "teacher" })).status).toBe(401);
    expect((await api("admin", student, undefined, { "X-Yanban-Portal": "admin" })).status).toBe(401);
    expect((await api("presence", student, { online: true })).status).toBe(403);
    const teacher = await login("answerer-a");
    expect((await api("requests", teacher, { subjectId: "math", description: problem, mode: "QUICK", idempotencyKey: randomUUID() })).status).toBe(403);
  });

  it("profile updates cannot choose another principal or expose credential hashes", async () => {
    const student = await login("asker-a");
    const before = await database.studentAccount.findUniqueOrThrow({ where: { userId: "asker-b" } });
    const response = await api("student/profile", student, { userId: "asker-b", role: "ADMIN", displayName: "修改后昵称", university: "示例大学", major: "计算机" });
    expect(response.ok).toBe(true);
    expect(await database.studentAccount.findUniqueOrThrow({ where: { userId: "asker-b" } })).toEqual(before);
    expect((await database.user.findUniqueOrThrow({ where: { id: "asker-a" } })).name).toBe("修改后昵称");
    expect(JSON.stringify(await (await api("student/profile", student)).json())).not.toMatch(/passwordHash|YanbanTest!2026/);
    expect((await api("teacher/profile", student)).status).toBe(401);
  });

  it("password change verifies the old password and revokes only sessions in that portal", async () => {
    const studentA = await login("asker-a");
    const studentB = await login("asker-a");
    const teacher = await login("answerer-a");
    const wrong = await api("student/profile/password", studentA, { currentPassword: "Incorrect!2026", newPassword: "ChangedSecret!2026", confirmPassword: "ChangedSecret!2026" });
    expect([400, 401]).toContain(wrong.status);
    expect((await api("history", studentB)).ok).toBe(true);
    const changed = await api("student/profile/password", studentA, { currentPassword: fixturePassword, newPassword: "ChangedSecret!2026", confirmPassword: "ChangedSecret!2026" });
    expect(changed.ok).toBe(true);
    expect((await api("history", studentA)).status).toBe(401);
    expect((await api("history", studentB)).status).toBe(401);
    expect((await api("answer", teacher)).ok).toBe(true);
    expect((await api("student/auth/login", "", { username: "asker-a", password: fixturePassword })).status).toBe(401);
    expect((await api("student/auth/login", "", { username: "asker-a", password: "ChangedSecret!2026" })).ok).toBe(true);
  });

  it("there is no public administrator registration or role upgrade", async () => {
    expect((await api("admin/auth/register", "", registration("student", { role: "ADMIN" }))).status).toBe(404);
    expect(await database.adminAccount.count()).toBe(1);
  });

  it("remembered login explicitly uses a longer cookie while default login has no persistent max-age", async () => {
    const standard = await api("student/auth/login", "", { username: "asker-a", password: fixturePassword });
    expect(standard.headers.get("set-cookie")).not.toContain("Max-Age=");
    const remembered = await api("student/auth/login", "", { username: "asker-a", password: fixturePassword, remember: true });
    expect(remembered.headers.get("set-cookie")).toMatch(/Max-Age=\d+/);
  });

  it("non-admins cannot access either admin data, mutations or CSV export", async () => {
    const asker = await login("asker-a");
    expect((await api("admin", asker)).status).toBe(403);
    expect((await api("admin/export", asker)).status).toBe(403);
    expect((await api("admin/answerers/answerer-a", asker, { enabled: false, subjectIds: [] })).status).toBe(403);
    expect((await database.answererProfile.findUniqueOrThrow({ where: { userId: "answerer-a" } })).enabled).toBe(true);
  });

  it("non-participants cannot read rooms, messages or issue a token", async () => {
    const { sessionId } = await startedRoom();
    const outsider = await login("asker-b");
    expect((await api(`sessions/${sessionId}`, outsider)).status).toBe(403);
    expect((await api(`sessions/${sessionId}/messages`, outsider, { body: "非法消息", clientId: randomUUID() })).status).toBe(403);
    expect((await api(`sessions/${sessionId}/rtc`, outsider)).status).toBe(403);
    expect(await database.message.count()).toBe(0);
  });

  it("ended sessions reject both message sends and demo RTC tokens", async () => {
    const { asker, answerer, sessionId } = await startedRoom();
    expect((await api(`sessions/${sessionId}/end`, asker, {})).ok).toBe(true);
    expect((await api(`sessions/${sessionId}/messages`, answerer, { body: "结束后消息", clientId: randomUUID() })).status).toBe(409);
    expect((await api(`sessions/${sessionId}/rtc`, answerer)).status).toBe(409);
    expect(await database.message.count()).toBe(0);
  });

  it("incomplete LiveKit configuration returns an explicit error", async () => {
    const { asker, sessionId } = await startedRoom();
    process.env.RTC_PROVIDER = "livekit";
    const response = await api(`sessions/${sessionId}/rtc`, asker);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("RTC_CONFIGURATION");
  });

  it("signs a short-lived LiveKit token restricted to the database room and an opaque identity", async () => {
    const { asker, sessionId } = await startedRoom();
    process.env.RTC_PROVIDER = "livekit";
    process.env.LIVEKIT_URL = "wss://rtc.test.invalid";
    process.env.LIVEKIT_API_KEY = "unit-test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-only-never-a-real-service-credential";
    const response = await api(`sessions/${sessionId}/rtc`, asker);
    expect(response.status).toBe(200);
    const result = await response.json();
    const { TokenVerifier } = await import("livekit-server-sdk");
    const verified = await new TokenVerifier(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET).verify(result.token);
    expect(result.roomName).toBe(`yanban-${sessionId}`);
    expect(verified.video?.room).toBe(result.roomName);
    expect(verified.video?.roomJoin).toBe(true);
    expect(verified.video?.canPublishData).toBe(false);
    expect(verified.sub).toMatch(/^participant-[a-f0-9]{32}$/);
    expect(verified.sub).not.toContain("asker-a");
    expect(verified.exp! - verified.nbf!).toBeLessThanOrEqual(300);
    expect(verified.exp! - verified.nbf!).toBeGreaterThan(0);
    expect(Object.keys(result)).not.toContain("secret");
  });

  it("attachments require uploader/invited-participant authorization, including guessed URLs", async () => {
    const asker = await login("asker-a");
    const outsider = await login("asker-b");
    const answerer = await login("answerer-a");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const uploaded = await upload(asker, png, "image/png", "../../private.png");
    expect(uploaded.ok).toBe(true);
    const { attachmentId } = await uploaded.json();
    expect((await api(`attachments/${attachmentId}`, outsider)).status).toBe(403);
    expect((await api(`attachments/${attachmentId}`, answerer)).status).toBe(403);
    expect((await api(`attachments/${attachmentId}`)).status).toBe(401);
    expect((await api(`attachments/${attachmentId}`, asker)).status).toBe(200);
    await api("presence", answerer, { online: true });
    const created = await api("requests", asker, {
      subjectId: "math", description: problem, mode: "DIRECT", targetAnswererId: "answerer-a",
      idempotencyKey: randomUUID(), attachmentId,
    });
    expect(created.ok).toBe(true);
    expect((await api(`attachments/${attachmentId}`, answerer)).status).toBe(200);
    // Native image/link requests cannot attach the portal header; only the
    // validated query chooses the teacher cookie, then ownership is checked.
    const teacherImage = await route.GET(new Request(`${base}/api/attachments/${attachmentId}?portal=teacher`, {
      headers: { cookie: answerer },
    }), { params: Promise.resolve({ path: ["attachments", attachmentId] }) });
    expect(teacherImage.status).toBe(200);
    expect(teacherImage.headers.get("content-type")).toBe("image/webp");
    expect((await teacherImage.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const substitutedPortal = await route.GET(new Request(`${base}/api/attachments/${attachmentId}?portal=teacher`, {
      headers: { cookie: asker },
    }), { params: Promise.resolve({ path: ["attachments", attachmentId] }) });
    expect(substitutedPortal.status).toBe(401);
    expect((await api(`attachments/${attachmentId}`, outsider)).status).toBe(403);
    const record = await database.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(record.storageKey).not.toContain("private");
    expect(record.storageKey).not.toContain("..");
  });

  it("rejects SVG, executable content disguised as PNG and oversized images", async () => {
    const asker = await login("asker-a");
    const svg = await upload(asker, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), "image/svg+xml", "image.svg");
    expect([400, 415]).toContain(svg.status);
    const executable = await upload(asker, Buffer.from("MZ executable, not an image"), "image/png", "image.png");
    expect([400, 415]).toContain(executable.status);
    const oversized = await upload(asker, new Uint8Array(5 * 1024 * 1024 + 1), "image/png", "large.png");
    expect(oversized.status).toBe(413);
    expect(await database.attachment.count()).toBe(0);
  });

  it("rate limits repeated login and error responses contain no server diagnostics", async () => {
    let response: Response | undefined;
    for (let count = 0; count < 61; count++) response = await api("student/auth/login", "", { username: "asker-a", password: fixturePassword });
    expect(response!.status).toBe(429);
    const failure = await response!.json();
    expect(failure.code).toBe("RATE_LIMITED");
    expect(Object.keys(failure)).not.toContain("stack");
    expect(JSON.stringify(failure)).not.toMatch(/yanban_session|tokenHash|LIVEKIT_API_SECRET/);
  });

  it("unexpected API failures log a fixed operation and exclude client-controlled paths and diagnostics", async () => {
    const student = await login("asker-a");
    const marker = "PRIVATE_CLIENT_PATH_MARKER";
    vi.spyOn(database.loginSession, "findUnique").mockRejectedValueOnce(new Error("PRIVATE_ERROR_BODY_MARKER"));
    const response = await api(marker, student);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    const log = await readFile(join(directory, "logs", "application.jsonl"), "utf8");
    expect(log).toContain("API_GET_UNKNOWN");
    expect(log).toContain(body.requestId);
    expect(log).not.toContain(marker);
    expect(log).not.toContain("PRIVATE_ERROR_BODY_MARKER");
    expect(log).not.toContain(student);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_CLIENT_PATH_MARKER|PRIVATE_ERROR_BODY_MARKER|stack/);
  });

});
