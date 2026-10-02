const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 22 || minor < 13) {
  console.error(`当前 Node.js ${process.versions.node} 不在本原型支持范围，请安装 Node.js 22 LTS（建议 22.23.3），重新打开终端后执行 npm ci。`);
  console.error('Node.js 24 的原生模块回收兼容问题可能导致 SQLite 驱动终止整个进程，详见 README。');
  process.exit(1);
}
