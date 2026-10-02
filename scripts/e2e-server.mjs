import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(tmpdir(), 'yanban-e2e-'));
writeFileSync(path.join(dir, 'test.db'), '', { flag: 'wx', mode: 0o600 });
const testEnv = {
  ...process.env, DATABASE_URL: `file:${path.join(dir, 'test.db')}`,
  UPLOAD_DIR: path.join(dir, 'uploads'), APP_DEMO_MODE: 'true', RTC_PROVIDER: 'demo',
  APP_ORIGIN: '', MATCH_WAIT_MS: '12000', MATCH_OFFER_MS: '8000',
  HEARTBEAT_TTL_MS: '30000', SESSION_ABANDONED_MS: '1800000',
  NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-e2e'
};
// Avoid conflicting runner color flags in child processes.
delete testEnv.NO_COLOR;
for (const args of [['prisma', 'migrate', 'deploy'], ['tsx', 'prisma/seed.ts']]) {
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', ...args], {
    cwd: root, env: testEnv, stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '0.0.0.0', '--port', '3100'], {
  cwd: root, env: testEnv, stdio: 'inherit'
});
function stop(signal) {
  child.kill(signal);
  const timer = setTimeout(() => { child.kill('SIGKILL'); process.exit(0); }, 3000);
  timer.unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('exit', (code) => { rmSync(dir, { recursive: true, force: true }); process.exit(code ?? 0); });
