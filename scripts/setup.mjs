import { existsSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (!existsSync('.env')) { copyFileSync('.env.example', '.env'); console.log('已创建本地 .env（无真实凭据）。'); }
config({ path: '.env', quiet: true });
const url = process.env.DATABASE_URL ?? 'file:./data/dev.db';
if (!url.startsWith('file:')) throw new Error('此原型只支持 SQLite file: 数据库');
const dbFile = path.resolve(root, url.slice(5));
mkdirSync(path.dirname(dbFile), { recursive: true });
if (!existsSync(dbFile)) writeFileSync(dbFile, '', { flag: 'wx', mode: 0o600 });
mkdirSync(path.resolve(root, process.env.UPLOAD_DIR ?? './data/uploads'), { recursive: true });
for (const args of [['prisma', 'generate'], ['prisma', 'migrate', 'deploy'], ['tsx', 'prisma/seed.ts']]) {
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', ...args], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('初始化完成。运行 npm run dev；仅新增缺失数据，未运行 reset。');
