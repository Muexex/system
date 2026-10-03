import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Node executes the installed CLI directly on every platform, including Git Bash.
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  path.join(root, 'scripts', 'admin-create.ts'),
], { cwd: root, env: process.env, stdio: 'inherit' });
if (result.error) {
  console.error('无法启动管理员初始化，请先运行 npm ci 和 npm run setup。');
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
