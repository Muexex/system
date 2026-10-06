import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createAdministrator } from '../src/server/auth';
import { db } from '../src/server/db';
import { HttpError } from '../src/server/security';

async function main() {
  if (process.argv.length > 2) throw new HttpError(400, '管理员初始化不接收命令行凭据，请直接运行 npm run admin:create。');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new HttpError(400, '需要交互终端以隐藏密码。Windows Git Bash 请运行 winpty node.exe scripts/admin-create.mjs；也可在 PowerShell 运行 npm.cmd run admin:create。');
  }
  if (await db.adminAccount.count()) throw new HttpError(409, '管理员已初始化，请使用现有管理员账号登录；此命令不会覆盖账号或重置密码。');

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  const cancellation = new AbortController();
  terminal.on('SIGINT', () => cancellation.abort());
  try {
    console.log('本机初始化唯一管理员。密码隐藏输入，至少 10 个字符；不会保存在环境文件中。');
    const username = await terminal.question('管理员账号（3—32 位字母、数字、点、下划线或短横线）：', { signal: cancellation.signal });
    const displayName = await terminal.question('管理员昵称（留空使用“管理员”）：', { signal: cancellation.signal });
    process.stdout.write('密码（隐藏输入）：');
    muted = true;
    let password = await terminal.question('', { signal: cancellation.signal });
    muted = false;
    process.stdout.write('\n再次输入密码（隐藏输入）：');
    muted = true;
    let confirmation = await terminal.question('', { signal: cancellation.signal });
    muted = false;
    process.stdout.write('\n');
    if (password !== confirmation) throw new HttpError(400, '两次密码不一致，管理员未创建。');
    await createAdministrator(username, password, displayName.trim() || '管理员');
    password = '';
    confirmation = '';
    console.log('管理员已创建。请在 /admin/login 使用刚设置的账号与密码登录。');
  } finally {
    muted = false;
    terminal.close();
  }
}

try { await main(); }
catch (error) {
  if (error instanceof HttpError) console.error(error.message);
  else if (error instanceof Error && error.name === 'AbortError') console.error('\n已取消，管理员未创建。');
  else console.error('管理员创建失败，请先运行 npm run setup，并确认数据库目录可写。');
  process.exitCode = 1;
} finally { await db.$disconnect(); }
