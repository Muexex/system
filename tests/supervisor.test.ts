import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSupervisor } from "../scripts/run-server.mjs";
import { recordEvent, reportError, readMonitorSnapshot, type MonitorEventInput } from "../src/server/monitoring";

type Event = { kind: string; code?: string; signal?: string; exitCode?: number; attempt?: number };
const active: ReturnType<typeof startSupervisor>[] = [];
let directory: string;
const options = () => ({
  cwd: directory,
  env: { ...process.env, LOG_DIR: join(directory, "logs") },
  restartDelayMs: 20,
  stopTimeoutMs: 200,
  forwardOutput: false,
  print: () => {},
});
function start(overrides: Parameters<typeof startSupervisor>[0]) {
  const controller = startSupervisor({ ...options(), ...overrides });
  active.push(controller);
  return controller;
}
function running(pid: number) {
  try {
    process.kill(pid, 0);
    // Containers may defer reaping an orphan zombie. A zombie has no running
    // code, file descriptors or listener; it is not a surviving server worker.
    if (process.platform === "linux" && existsSync(`/proc/${pid}/stat`)) {
      const status = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (/\) Z /.test(status)) return false;
    }
    return true;
  } catch { return false; }
}

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "yanban-supervisor-")); });
afterEach(async () => {
  await Promise.all(active.splice(0).map((controller) => controller.stop()));
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("server supervisor using real, isolated child processes", () => {
  it("reports a real exit code, retries finitely and never persists child output or credentials", async () => {
    const events: Event[] = [];
    const controller = start({
      args: ["-e", "console.error('SECRET_COOKIE_TOKEN_CHAT'); process.exit(7)"],
      maxRestarts: 2,
      onEvent: (event) => { events.push(event); },
    });
    expect(await controller.done).toMatchObject({ code: 7, signal: null, intentional: false, restarts: 2 });
    expect(events.filter((event) => event.kind === "PROCESS_STARTED")).toHaveLength(3);
    expect(events.filter((event) => event.kind === "PROCESS_EXIT").every((event) => event.exitCode === 7)).toBe(true);
    expect(events.filter((event) => event.kind === "RESTART_LIMIT")).toHaveLength(1);
    const content = readFileSync(join(directory, "logs", "application.jsonl"), "utf8");
    expect(content).not.toContain("SECRET_COOKIE_TOKEN_CHAT");
    expect(content).not.toContain("console.error");
  });

  it("recovers on the next launch and distinguishes an intentional stop without another restart", async () => {
    const events: Event[] = [];
    const attempts = join(directory, "attempts");
    const code = "const fs=require('node:fs'); const file=process.argv[1]; const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0; fs.writeFileSync(file,String(n+1)); if(n===0) process.exit(9); setInterval(()=>{},1000)";
    const controller = start({ args: ["-e", code, attempts], maxRestarts: 3, onEvent: (event) => { events.push(event); } });
    await vi.waitFor(() => expect(events.some((event) => event.kind === "PROCESS_STARTED" && event.attempt === 1)).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(readFileSync(attempts, "utf8")).toBe("2"), { timeout: 5000 });
    expect(await controller.stop("SIGINT")).toMatchObject({ code: 0, intentional: true, restarts: 1 });
    expect(events.filter((event) => event.kind === "STOP_REQUESTED")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "PROCESS_EXIT", code: "OPERATOR_STOP" });
    expect(readFileSync(attempts, "utf8")).toBe("2");
  });

  it.skipIf(process.platform === "win32")("reports a real OS signal rather than pretending a JS catch intercepted it", async () => {
    const events: Event[] = [];
    const controller = start({ args: ["-e", "process.kill(process.pid,'SIGKILL')"], maxRestarts: 0, onEvent: (event) => { events.push(event); } });
    expect(await controller.done).toMatchObject({ code: 1, signal: "SIGKILL", intentional: false, restarts: 0 });
    expect(events.find((event) => event.kind === "PROCESS_EXIT")).toMatchObject({ code: "CHILD_SIGNAL", signal: "SIGKILL" });
  });

  it("handles spawn errors safely without exposing the attempted executable path", async () => {
    const messages: string[] = [];
    const events: Event[] = [];
    const controller = start({ command: join(directory, "PRIVATE_PATH_missing_executable"), maxRestarts: 0, print: (message) => { messages.push(message); }, onEvent: (event) => { events.push(event); } });
    expect(await controller.done).toMatchObject({ code: 1, intentional: false, restarts: 0 });
    expect(events.find((event) => event.kind === "PROCESS_EXIT")).toMatchObject({ code: "SPAWN_FAILED" });
    expect(messages.join(" ")).toContain("无法启动");
    expect(messages.join(" ")).not.toContain("PRIVATE_PATH");
  });

  it("stops the actual descendant worker as well as the launcher", async () => {
    const pidFile = join(directory, "leaf-pid");
    const code = "const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000)";
    const controller = start({ args: ["-e", code, pidFile] });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 });
    const leafPid = Number(readFileSync(pidFile, "utf8"));
    expect(running(leafPid)).toBe(true);
    expect(await controller.stop()).toMatchObject({ code: 0, intentional: true, restarts: 0 });
    await vi.waitFor(() => expect(running(leafPid)).toBe(false), { timeout: 5000 });
  });

  it.skipIf(process.platform === "win32")("reclaims surviving workers when their launcher crashes", async () => {
    const pidFile = join(directory, "crash-leaf-pid");
    const code = "const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));process.exit(2)";
    const controller = start({ args: ["-e", code, pidFile], maxRestarts: 0 });
    expect(await controller.done).toMatchObject({ code: 2, intentional: false });
    const leafPid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(running(leafPid)).toBe(false), { timeout: 5000 });
  });

  it("does not restart a normally completed child", async () => {
    const controller = start({ args: ["-e", "process.exit(0)"], maxRestarts: 3 });
    expect(await controller.done).toMatchObject({ code: 0, signal: null, intentional: false, restarts: 0 });
  });

  it("observes a real uncaught JS exception without swallowing Node's fatal exit", async () => {
    const fixture = join(directory, "uncaught.ts");
    const monitoring = fileURLToPath(new URL("../src/server/monitoring.ts", import.meta.url));
    writeFileSync(fixture, `import { registerMonitoring } from ${JSON.stringify(monitoring)}; registerMonitoring(); throw new TypeError('PRIVATE_UNCAUGHT_TOKEN');`);
    const require = createRequire(import.meta.url);
    const controller = start({ args: ["--import", require.resolve("tsx"), fixture], maxRestarts: 0 });
    expect(await controller.done).toMatchObject({ code: 1, intentional: false, restarts: 0 });
    const log = readFileSync(join(directory, "logs", "application.jsonl"), "utf8");
    expect(log).toContain('"kind":"FATAL_ERROR"');
    expect(log).toContain('"code":"RUNTIME_ERROR"');
    expect(log).not.toContain("PRIVATE_UNCAUGHT_TOKEN");
  });
});

describe("safe application monitoring", () => {
  beforeEach(() => { vi.stubEnv("LOG_DIR", join(directory, "monitor")); });

  it("classifies Prisma and runtime failures without recording inputs, stacks, tokens or messages", () => {
    const requestId = randomUUID();
    const error = Object.assign(new Error("Cookie: PRIVATE_SECRET_CHAT"), {
      name: "PrismaClientKnownRequestError", code: "P2002", meta: { input: "PRIVATE_SECRET_CHAT" }, stack: "PRIVATE_SECRET_STACK",
    });
    const event = reportError(error, { requestId, operation: "API_POST_REQUESTS" });
    expect(event).toMatchObject({ kind: "API_ERROR", code: "P2002", category: "DATABASE", requestId });
    recordEvent({ kind: "CLIENT_ERROR", code: "NOT_A_SAFE_INTERNAL_CODE", digest: "PRIVATE_SECRET_TOKEN", operation: "/room/PRIVATE_SECRET_ROOM", message: "PRIVATE_SECRET_CHAT", cookie: "PRIVATE_SECRET_COOKIE" } as MonitorEventInput);
    const file = readFileSync(join(directory, "monitor", "application.jsonl"), "utf8");
    expect(file).not.toContain("PRIVATE_SECRET");
    expect(file).not.toContain("meta");
    expect(file).not.toContain("NOT_A_SAFE_INTERNAL_CODE");
    const snapshot = readMonitorSnapshot();
    expect(snapshot.runtime.node).toBe(process.versions.node);
    expect(snapshot.memory.rssBytes).toBeGreaterThan(0);
    expect(snapshot.recentEvents).toContainEqual(expect.objectContaining({ requestId, code: "P2002" }));
  });

  it("limits persisted files and exposes only the recent safe structured records", () => {
    vi.stubEnv("LOG_MAX_BYTES", "65536");
    vi.stubEnv("LOG_ROTATE_FILES", "1");
    for (let attempt = 0; attempt < 800; attempt++) {
      recordEvent({ kind: "CLIENT_ERROR", code: "CLIENT_RENDER_ERROR", operation: "CLIENT_ADMIN", requestId: randomUUID(), digest: "a".repeat(64), attempt });
    }
    const files = readdirSync(join(directory, "monitor"));
    expect(files.sort()).toEqual(["application.jsonl", "application.jsonl.1"]);
    const snapshot = readMonitorSnapshot();
    expect(snapshot.recentEvents).toHaveLength(50);
    expect(snapshot.recentEvents.at(-1)?.attempt).toBe(799);
    expect(snapshot.log).toMatchObject({ available: true, maxBytes: 65536, rotationFiles: 1 });
  });

  it("does not crash while handling an error when the log destination is unavailable", () => {
    const destination = join(directory, "not-a-directory");
    writeFileSync(destination, "occupied");
    vi.stubEnv("LOG_DIR", destination);
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => reportError(new Error("PRIVATE_SECRET"), { operation: "NEXT_ROUTE" })).not.toThrow();
    expect(readMonitorSnapshot().log.available).toBe(false);
    expect(output.mock.calls.flat().join(" ")).not.toContain("PRIVATE_SECRET");
  });

  it("retains Windows native status codes and fixed authentication codes safely", () => {
    const event = recordEvent({ kind: "PROCESS_EXIT", code: "CHILD_EXIT", exitCode: 3_221_225_477 });
    expect(event.exitCode).toBe(3_221_225_477);
    expect(reportError({ name: "HttpError", code: "INVALID_CREDENTIALS", message: "PRIVATE_PASSWORD" }, { operation: "API_POST_LOGIN" })).toMatchObject({ code: "INVALID_CREDENTIALS", category: "KNOWN" });
    expect(readFileSync(join(directory, "monitor", "application.jsonl"), "utf8")).not.toContain("PRIVATE_PASSWORD");
  });
});
