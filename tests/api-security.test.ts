import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
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

async function api(path: string, cookie = "", body?: unknown, extraHeaders: Record<string, string> = {}) {
  const method = body === undefined ? "GET" : "POST";
  const headers: Record<string, string> = { cookie, ...extraHeaders };
  if (method === "POST") {
    headers.origin ??= base;
    headers["content-type"] ??= "application/json";
  }
  const request = new Request(`${base}/api/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return route[method](request, { params: Promise.resolve({ path: path.split("/") }) });
}

async function login(accountId: string) {
  const response = await api("login", "", { accountId });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toMatch(/SameSite=lax/i);
  return cookie.split(";")[0];
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
    method: "POST", headers: { origin: base, cookie }, body: form,
  }), { params: Promise.resolve({ path: ["attachments"] }) });
}

beforeAll(async () => {
  template = await migratedTestDatabase();
  process.env.DATABASE_URL = template.url;
  const { createDb } = await import("@/server/db");
  const initial = createDb(template.url);
  await seedDatabase(initial);
  await initial.$disconnect();
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "yanban-vitest-api-"));
  const file = join(directory, "test.db");
  await copyFile(template.file, file);
  process.env.DATABASE_URL = `file:${file}`;
  process.env.APP_DEMO_MODE = "true";
  process.env.APP_ORIGIN = base;
  process.env.UPLOAD_DIR = join(directory, "uploads");
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
  it("creates random server sessions, ignores supplied roles, and logout revokes access", async () => {
    const response = await api("login", "", { accountId: "asker-a", userId: "admin", role: "ADMIN" });
    expect((await response.json()).user.role).toBe("ASKER");
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).toMatch(/^yanban_session=[a-f0-9]{64}$/);
    expect(await database.loginSession.count()).toBe(1);
    const me = await api("me", cookie);
    expect(me.headers.get("cache-control")).toContain("no-store");
    expect((await me.json()).user.id).toBe("asker-a");
    await api("logout", cookie, {});
    expect((await api("history", cookie)).status).toBe(401);
    expect(await database.loginSession.count()).toBe(0);
  });

  it("disabling demo mode rejects the login endpoint and conceals demo accounts", async () => {
    const previouslyIssuedCookie = await login("asker-a");
    process.env.APP_DEMO_MODE = "false";
    const response = await api("login", "", { accountId: "admin" });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("DEMO_DISABLED");
    expect(await database.loginSession.count()).toBe(1);
    expect((await api("history", previouslyIssuedCookie)).status).toBe(401);
    const me = await (await api("me")).json();
    expect(me.demoMode).toBe(false);
    expect(me.accounts).toHaveLength(0);
  });

  it("HTTPS sessions carry Secure and forged cookies do not grant a role", async () => {
    process.env.APP_ORIGIN = "https://prototype.example";
    const response = await route.POST(new Request("https://prototype.example/api/login", {
      method: "POST", headers: { origin: "https://prototype.example", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "asker-a" }),
    }), { params: Promise.resolve({ path: ["login"] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect((await api("admin", `yanban_session=${"a".repeat(64)}; role=ADMIN`)).status).toBe(401);
  });

  it("rejects cross-site and missing-origin writes without changing the database", async () => {
    const response = await api("login", "", { accountId: "admin" }, { origin: "https://outside.example" });
    expect(response.status).toBe(403);
    const absent = await route.POST(new Request(`${base}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: "admin" }),
    }), { params: Promise.resolve({ path: ["login"] }) });
    expect(absent.status).toBe(403);
    expect(await database.loginSession.count()).toBe(0);
  });

  it("uses the original Host for local aliases when the production URL uses its listen hostname", async () => {
    delete process.env.APP_ORIGIN;
    delete process.env.TRUST_PROXY;
    for (const host of ["localhost:3000", "127.0.0.1:3000"]) {
      const response = await route.POST(new Request("http://0.0.0.0:3000/api/login", {
        method: "POST", headers: {
          host, origin: `http://${host}`, "content-type": "application/json",
          "x-forwarded-host": "outside.example", "x-forwarded-proto": "https",
        }, body: JSON.stringify({ accountId: "asker-a" }),
      }), { params: Promise.resolve({ path: ["login"] }) });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).not.toContain("Secure");
    }
    const forged = await route.POST(new Request("http://0.0.0.0:3000/api/login", {
      method: "POST", headers: {
        host: "localhost:3000", origin: "https://outside.example", "content-type": "application/json",
        "x-forwarded-host": "outside.example", "x-forwarded-proto": "https",
      }, body: JSON.stringify({ accountId: "admin" }),
    }), { params: Promise.resolve({ path: ["login"] }) });
    expect(forged.status).toBe(403);
    expect(await database.loginSession.count()).toBe(2);
  });

  it("explicit APP_ORIGIN takes precedence over Host and forwarded headers and enables Secure behind HTTPS proxy", async () => {
    process.env.APP_ORIGIN = "https://prototype.example";
    const postLogin = (origin: string) => route.POST(new Request("http://0.0.0.0:3000/api/login", {
      method: "POST", headers: {
        host: "127.0.0.1:3000", origin, "content-type": "application/json",
        "x-forwarded-host": "outside.example", "x-forwarded-proto": "http",
      }, body: JSON.stringify({ accountId: "asker-a" }),
    }), { params: Promise.resolve({ path: ["login"] }) });
    const localAlias = await postLogin("http://127.0.0.1:3000");
    expect(localAlias.status).toBe(403);
    const external = await postLogin("https://prototype.example");
    expect(external.status).toBe(200);
    expect(external.headers.get("set-cookie")).toContain("Secure");
    expect(await database.loginSession.count()).toBe(1);
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
    for (let count = 0; count < 61; count++) response = await api("login", "", { accountId: "asker-a" });
    expect(response!.status).toBe(429);
    const failure = await response!.json();
    expect(failure.code).toBe("RATE_LIMITED");
    expect(Object.keys(failure)).not.toContain("stack");
    expect(JSON.stringify(failure)).not.toMatch(/yanban_session|tokenHash|LIVEKIT_API_SECRET/);
  });
});
