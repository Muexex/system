import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function numericSetting(value, fallback, minimum, maximum) {
  const number = value === undefined || value === "" ? fallback : Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

// Keep this bootstrap independent of TypeScript, the database and native addons.
// Only supervisor-generated fields are accepted; child stdout/stderr are never
// copied into the persistent log (they still go to the user's terminal).
function createLogger(env, cwd, onEvent, print) {
  const directory = resolve(cwd, env.LOG_DIR || join("data", "logs"));
  const maxBytes = numericSetting(env.LOG_MAX_BYTES, 262_144, 65_536, 5_242_880);
  const rotations = numericSetting(env.LOG_ROTATE_FILES, 3, 1, 5);
  let warned = false;
  return (kind, fields = {}) => {
    const event = { timestamp: new Date().toISOString(), level: fields.level || "info", kind };
    for (const field of ["code", "signal", "exitCode", "attempt", "operation"]) {
      if (fields[field] !== undefined && fields[field] !== null) event[field] = fields[field];
    }
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, "application.jsonl");
      const line = `${JSON.stringify(event)}\n`;
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        if (existsSync(`${file}.${rotations}`)) unlinkSync(`${file}.${rotations}`);
        for (let index = rotations - 1; index > 0; index--) {
          if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`);
        }
        if (existsSync(file)) renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      if (!warned) { warned = true; print("安全诊断日志暂时无法写入，请检查目录权限和磁盘空间。"); }
    }
    try { onEvent(event); } catch { /* Observers cannot break the supervisor. */ }
  };
}

function taskkillPath(env) {
  return join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "taskkill.exe");
}

function terminateTree(pid, signal, env) {
  if (!pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try { process.kill(-pid, signal); } catch { /* The process group may have already exited. */ }
    return Promise.resolve();
  }
  // Windows does not implement POSIX process groups. /T kills the descendants
  // before the root, including Next's worker, without npm/.cmd/shell wrappers.
  return new Promise((resolveTermination) => {
    const killer = spawn(taskkillPath(env), ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { killer.kill(); resolveTermination(); }, 5000);
    const finish = () => { clearTimeout(timer); resolveTermination(); };
    killer.once("error", finish);
    killer.once("exit", finish);
  });
}

/**
 * The same real-child supervisor is used by dev/start and the failure tests.
 * Returning a controller lets tests stop it without sending signals to Vitest.
 * @param {{command?: string, args?: string[], cwd?: string, env?: NodeJS.ProcessEnv,
 * maxRestarts?: number, restartWindowMs?: number, restartDelayMs?: number,
 * stopTimeoutMs?: number, forwardOutput?: boolean, installSignalHandlers?: boolean,
 * onEvent?: (event: {timestamp: string, level: string, kind: string, code?: string,
 * signal?: string, exitCode?: number, attempt?: number, operation?: string}) => void,
 * print?: (message: string) => void}} options
 */
export function startSupervisor({
  command = process.execPath,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  maxRestarts = 3,
  restartWindowMs = 600_000,
  restartDelayMs = 1000,
  stopTimeoutMs = 5000,
  forwardOutput = true,
  installSignalHandlers = false,
  onEvent = () => {},
  print = (message) => console.error(`[研伴答疑] ${message}`),
} = {}) {
  let child;
  let restartTimer;
  let forceTimer;
  let stopping = false;
  let finished = false;
  let restarts = 0;
  const restartTimes = [];
  const signalHandlers = new Map();
  let resolveDone;
  /** @type {Promise<{code: number, signal: NodeJS.Signals | null, intentional: boolean, restarts: number}>} */
  const done = new Promise((resolveResult) => { resolveDone = resolveResult; });
  const log = createLogger(env, cwd, onEvent, print);

  function emergencyCleanup() {
    const pid = child?.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      try { spawnSync(taskkillPath(env), ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore", timeout: 1500 }); } catch { /* Best effort during final exit. */ }
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }

  function finish(code, signal, intentional) {
    if (finished) return;
    finished = true;
    clearTimeout(restartTimer);
    clearTimeout(forceTimer);
    for (const [name, listener] of signalHandlers) process.off(name, listener);
    if (installSignalHandlers) process.off("exit", emergencyCleanup);
    resolveDone({ code, signal, intentional, restarts });
  }

  async function terminated(current, code, signal, spawnFailed = false) {
    const intentional = stopping;
    clearTimeout(forceTimer);
    // An unexpected Next launcher exit must not leave a worker that still owns
    // the port. The child's distinct POSIX group remains addressable after exit.
    await terminateTree(current.pid, "SIGKILL", env);
    if (child === current) child = undefined;
    const nativeSignal = signal === "SIGABRT" || signal === "SIGSEGV" || signal === "SIGBUS" || signal === "SIGILL";
    log("PROCESS_EXIT", {
      level: intentional || (!spawnFailed && code === 0 && !signal) ? "info" : "error",
      code: intentional ? "OPERATOR_STOP" : spawnFailed ? "SPAWN_FAILED" : signal ? "CHILD_SIGNAL" : "CHILD_EXIT",
      ...(signal ? { signal } : {}), ...(typeof code === "number" ? { exitCode: code } : {}),
      operation: "SERVER_CHILD",
    });
    if (intentional) {
      print(`服务已主动停止（退出码：${code ?? "无"}；信号：${signal || "无"}），不会自动重启。`);
      finish(0, signal, true);
      return;
    }
    if (spawnFailed) print("服务子进程无法启动，请检查 Node.js、依赖和可执行文件权限；详细输入和环境变量不会写入诊断日志。");
    else if (nativeSignal) print(`服务因 ${signal} 终止（退出码：${code ?? "无"}）。这是原生异常或系统信号，JavaScript try/catch 无法拦截。`);
    else print(`服务子进程已退出（退出码：${code ?? "无"}；信号：${signal || "无"}）。`);
    if (!spawnFailed && code === 0 && !signal) {
      print("服务正常退出，监督进程停止。");
      finish(0, null, false);
      return;
    }
    const now = Date.now();
    while (restartTimes.length && restartTimes[0] <= now - restartWindowMs) restartTimes.shift();
    if (restartTimes.length >= maxRestarts) {
      log("RESTART_LIMIT", { level: "error", code: "RESTART_LIMIT", attempt: restarts, operation: "SERVER_SUPERVISOR" });
      print(`最近 ${Math.ceil(restartWindowMs / 1000)} 秒内已重启 ${restartTimes.length} 次，服务仍然失败，现停止自动重启。请查看安全日志及终端输出，修复后重新启动。`);
      finish(typeof code === "number" && code > 0 && code <= 255 ? code : 1, signal, false);
      return;
    }
    restartTimes.push(now);
    restarts++;
    log("RESTART_SCHEDULED", { level: "warn", attempt: restarts, operation: "SERVER_SUPERVISOR" });
    print(`将在 ${restartDelayMs} 毫秒后重新启动服务（本窗口第 ${restartTimes.length}/${maxRestarts} 次）。`);
    restartTimer = setTimeout(launch, restartDelayMs);
  }

  function launch() {
    if (stopping || finished) return;
    const current = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = current;
    if (forwardOutput) {
      current.stdout?.pipe(process.stdout, { end: false });
      current.stderr?.pipe(process.stderr, { end: false });
    } else {
      current.stdout?.resume();
      current.stderr?.resume();
    }
    let handled = false;
    current.once("spawn", () => {
      log("PROCESS_STARTED", { attempt: restarts, operation: "SERVER_CHILD" });
      print(`服务子进程已启动（PID ${current.pid}）。`);
    });
    current.once("error", () => {
      if (handled) return;
      handled = true;
      void terminated(current, null, null, true);
    });
    current.once("exit", (code, signal) => {
      if (handled) return;
      handled = true;
      void terminated(current, code, signal);
    });
  }

  function stop(signal = "SIGTERM") {
    if (stopping || finished) return done;
    stopping = true;
    clearTimeout(restartTimer);
    const safeSignal = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].includes(signal) ? signal : "SIGTERM";
    log("STOP_REQUESTED", { code: "OPERATOR_STOP", signal: safeSignal, operation: "SERVER_SUPERVISOR" });
    print("收到停止请求，正在关闭服务及其子进程…");
    if (!child) { finish(0, safeSignal, true); return done; }
    const pid = child.pid;
    void terminateTree(pid, process.platform === "win32" ? "SIGKILL" : safeSignal, env);
    forceTimer = setTimeout(() => { void terminateTree(pid, "SIGKILL", env); }, stopTimeoutMs);
    return done;
  }

  if (installSignalHandlers) {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]) {
      const listener = () => { void stop(name); };
      signalHandlers.set(name, listener);
      process.on(name, listener);
    }
    process.on("exit", emergencyCleanup);
  }
  launch();
  return { done, stop, get childPid() { return child?.pid; } };
}

async function main() {
  // Direct invocation has the same native-addon compatibility guard as npm's
  // lifecycle hooks; using this wrapper is not a way around the Node 22 check.
  await import("./check-node.mjs");
  const dotenv = await import("dotenv");
  dotenv.config({ quiet: true });
  const [mode, ...extra] = process.argv.slice(2);
  if (!mode || !["dev", "start"].includes(mode)) {
    console.error("用法：node scripts/run-server.mjs dev|start [Next.js 参数]");
    process.exitCode = 2;
    return;
  }
  const require = createRequire(import.meta.url);
  const nextCli = require.resolve("next/dist/bin/next");
  const hostname = extra.some((argument) => argument === "--hostname" || argument === "-H" || argument.startsWith("--hostname=")) ? [] : ["--hostname", "0.0.0.0"];
  const supervisor = startSupervisor({
    command: process.execPath,
    args: [nextCli, mode, ...hostname, ...extra],
    maxRestarts: numericSetting(process.env.SERVER_MAX_RESTARTS, 3, 0, 20),
    restartWindowMs: numericSetting(process.env.SERVER_RESTART_WINDOW_MS, 600_000, 1000, 86_400_000),
    restartDelayMs: numericSetting(process.env.SERVER_RESTART_DELAY_MS, 1000, 10, 60_000),
    stopTimeoutMs: numericSetting(process.env.SERVER_STOP_TIMEOUT_MS, 5000, 100, 30_000),
    installSignalHandlers: true,
  });
  const result = await supervisor.done;
  process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("[研伴答疑] 监督进程无法完成启动，请检查 Node.js 22、依赖安装和文件权限。未输出原始异常或环境变量。");
    process.exitCode = 1;
  });
}
