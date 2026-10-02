# 研伴答疑

面向成年在校大学生的实时、按次、临时一对一答疑原型。提问者围绕考研学习中的一个具体问题，选择在线答疑者或快速匹配；对方在独立会话接受后，双方进入同一答疑室交流，任一方可结束，提问者随后评价。

**原型测试 · 免费体验。所有账号与答疑者资料均为虚构。** 答疑者限定成年、非在职的全日制在校大学生或研究生，数据库资格字段也参与匹配校验；测试资料不表示真实学籍认证。没有课程、课时包、录播、招生承诺、固定师生绑定或 AI 自动回复。

## 快速开始

建议 **Node.js 24 LTS**（当前开发验证版本 24.19.0）；也支持 Node.js 22.13+。采用 npm 与提交的 `package-lock.json`。

```bash
cd /workspace/system   # 其他机器改成仓库所在目录
npm ci
npm run setup
npm run dev
```

浏览器本地访问 `http://localhost:3000`，进入 `/login`。首次 `setup` 自动从 `.env.example` 创建无密钥 `.env`、创建数据库及上传目录、生成 Prisma Client、执行已有迁移并 seed。可以反复运行；仅新增缺失测试账号与科目，不清空答疑记录、不覆盖已有 `.env` 或管理员设置。没有自动 `reset`。

`npm run dev` 会先自动执行同样的初始化检查；初始化失败时不会继续启动一个缺少数据库客户端的服务。脚本使用当前 Node.js 直接执行已安装的 Prisma/tsx CLI，兼容 Windows Git Bash，不通过 `npx.cmd` 子进程启动。npm 缓存使用本机默认位置。

Windows 遇到 `spawnSync npx.cmd EINVAL`，或浏览器提示找不到 `../generated/prisma/client` 时，先按 `Ctrl+C` 停止服务，在项目目录逐条执行：

```bash
git pull --ff-only
npm run setup
npm run dev
```

看到“初始化完成”后再打开登录页。如果初始化仍报错，先处理该错误；不要继续启动，也不需要删除数据库或升级 npm。

也可以手动准备配置和初始化：

```bash
cp .env.example .env  # 仅在 .env 尚不存在时执行
npm run setup
# 已初始化数据库的后续迁移、seed：
npm run db:migrate
npm run db:seed
```

生产模式（本地单实例）：

```bash
npm run build
npm start
```

LiveKit 非必需。默认不连接第三方服务，文字答疑独立可用。当前数据库使用 SQLite，适用于**单实例与持久化磁盘**；不能直接部署到没有持久化存储的 Serverless 环境，也不支持多实例共享文件式数据库。

## 演示账号与两个浏览器会话

登录页直接选择虚构账号，无需密码：

| 账号 | 角色 | 初始可答科目 |
| --- | --- | --- |
| 提问者A、提问者B | 提问者 | 发起考研学习问题 |
| 答疑者A | 答疑者 | 考研数学、计算机专业基础 |
| 答疑者B | 答疑者 | 考研英语、考研政治 |
| 答疑者C | 答疑者 | 计算机专业基础、考研数学 |
| 管理员 | 管理员 | 查看统计、设置答疑者状态和科目 |

1. 使用两个浏览器的独立用户配置，或普通窗口与无痕窗口。同一浏览器配置的两个普通标签页共享 Cookie，不能用于扮演两人。
2. 会话一登录答疑者A，进入 `/answer`，点击“开始接单”。答疑者初始离线；关闭页面或心跳失效后停止被匹配。
3. 会话二登录提问者A，进入 `/ask`，选择考研数学，填写 20—2000 字的具体问题，选择指定答疑者A并发出请求。
4. 答疑者A在工作台收到真实邀请并点击“接受请求”。双方进入相同 `/room/[sessionId]`，都进入后开始计时。
5. 在双方页面分别发送不同文字；另一端约 2 秒内收到。刷新仍能恢复消息与开始时间。
6. 任一方点击“结束答疑”。另一端轮询同步结束，停止媒体、禁用聊天。提问者进入反馈页，选择解决情况和 1—5 分满意度。
7. `/history` 读取个人真实记录；管理员 `/admin` 读取数据库汇总，可导出不含私人聊天的 CSV。

快速匹配只邀请科目匹配、启用、资格符合、主动在线、心跳有效且空闲的答疑者。没有在线答疑者时正常等待；不会假匹配或机器人回复。指定邀请被拒绝后终止，不擅自换人。

`APP_DEMO_MODE=true` 是演示登录的必要条件。设为 `false` 并重启后，演示登录返回拒绝，已有演示 Cookie 也不再认证，页面明确说明正式登录尚未实现。不要把演示账号模式当作公网正式认证。

## 页面与保存位置

| 路径 | 内容 |
| --- | --- |
| `/` | 科目、真实在线状态、提问及答疑入口 |
| `/login` | 服务端创建登录会话的演示账号入口 |
| `/ask` | 描述、可选单张题目图片、指定或快速匹配 |
| `/match/[requestId]` | 等待、邀请、取消、超时、拒绝状态 |
| `/answer` | 主动上线、待处理邀请、当前答疑与历史 |
| `/room/[sessionId]` | 原始问题、受控图片、真实文字聊天、音视频面板、结束 |
| `/feedback/[sessionId]` | 仅已完成会话的提问者可评价，一条反馈 |
| `/history` | 仅当前账号相关记录与有权限的消息、反馈 |
| `/admin` | 服务端管理员权限、真实汇总、启停、可答科目、CSV |

默认数据库 `data/dev.db`，附件 `data/uploads/`。`DATABASE_URL=file:./data/dev.db` 的相对路径按**项目根目录**解析，Prisma CLI 与应用保持同一文件。附件不会以 public 静态文件暴露；下载 API 校验上传者、当前有效邀请或会话参与者。PNG/JPEG/WebP ≤5MB，真实解码、重编码为 WebP 去除元信息，拒绝 SVG/HTML/损坏图片，使用随机文件名。

`.env`、数据库、上传目录、日志、测试结果、Prisma 生成代码都已加入 `.gitignore`。备份时需要同时保存数据库和上传目录，停止写入或使用 SQLite 一致性备份；不要只备份代码。

## 状态、事务与恢复

业务入口集中在 `src/server/domain.ts`，页面只展示服务器状态：

```text
WAITING → OFFERED → MATCHED → IN_PROGRESS → COMPLETED
              ↘ CANCELLED / EXPIRED / DECLINED
```

- `RequesterLease.askerId` 与 `AnswererLease.answererId` 主键保证一个提问者一个活跃请求、一个答疑者一个邀请或会话；邀请发出即占用。
- SQLite 事务先取得数据库写锁，再读取/迁移状态；条件更新、唯一会话/请求/消息/反馈键保证争抢与重复操作安全。跨两个数据库连接的并发测试覆盖此规则。驱动使用短同步锁等待，服务层对锁冲突异步退避。
- 维护过程先检查截止时间、修复过期占用并调度；业务动作使用事务保存点，非法操作回滚动作但不会撤销已经执行的过期维护。所有业务读取和领取路径都执行维护，不需要某个浏览器一直在线。
- 创建请求的 `idempotencyKey` 和消息 `clientId` 用于网络响应丢失后的重试；同标识不同内容返回冲突，不能产生重复有效请求或消息。
- 开始时间为双方首次进入后的服务端时间，进入记录写入数据库；刷新不重新计时。
- 短暂断网允许恢复；双方长时间都没有访问会话后，按失联回收配置取消并记录 `ABANDONED`，不冒充正常完成或邀请超时。
- 当前通过访问驱动维护，无定时后台任务；如果整个平台完全无请求，下一次访问会修正过期与失联状态。

集中配置：

| 环境变量 | 默认值 | 意义 |
| --- | --- | --- |
| `MATCH_WAIT_MS` | 60000 | 总匹配等待上限 |
| `MATCH_OFFER_MS` | 20000 | 单次接单邀请上限 |
| `HEARTBEAT_TTL_MS` | 30000（示例配置） | 心跳有效期；发送间隔 10 秒 |
| `SESSION_ABANDONED_MS` | 1800000 | 双方无人返回的会话回收期限 |
| `APP_ORIGIN` | 原始 Host + 请求协议（localhost/127 均可） | 反向代理 HTTPS 场景可设置固定外部源以严格校验 Origin 和 Secure Cookie |

登录 Cookie 随机 32 字节，数据库仅存 SHA-256 摘要，HttpOnly、SameSite=Lax，HTTPS 使用 Secure。所有变更请求检查 Origin；身份和角色由服务端会话读取。频率限制使用 SQLite 计数，覆盖登录、创建请求、接单、消息与附件。文本以 React 纯文本呈现，不渲染用户 HTML。未知服务端错误仅返回安全提示及关联编号，不输出堆栈或凭据。

## 音视频两种模式

### 默认 demo：设备预览

```dotenv
RTC_PROVIDER=demo
```

页面显示“设备预览模式，尚未接入双人音视频。”用户主动点击后，才能预览自己的设备。没有伪造远端视频，没有暗示双人已连接；拒绝授权、无设备或非安全浏览器环境会显示提示，文字答疑仍可使用。不会默认录音录像。

### 可选 LiveKit

使用你已有的 LiveKit 服务，在本地 `.env` 或安全环境设置中填写：

```dotenv
RTC_PROVIDER=livekit
LIVEKIT_URL=wss://your-project.example
LIVEKIT_API_KEY=your-server-api-key
LIVEKIT_API_SECRET=your-server-api-secret
```

这些密钥仅服务端读取，绝不能改成 `NEXT_PUBLIC_*`，不要提交到 Git、写入日志或发到聊天。配置不完整时明确报错，文字答疑继续可用。需要允许所选 LiveKit 主机及其 WebRTC/STUN/TURN 网络访问；云环境的普通 HTTPS 代理不代表浏览器 WebRTC UDP/TCP 通道已经可用。客户端摄像头/麦克风要求安全上下文（本机 localhost 或 HTTPS）。

`src/lib/rtc-client.ts` 的统一适配接口将设备预览与 LiveKit 分开，`src/server/rtc.ts` 签发 5 分钟令牌：验证登录、成员归属及会话未结束，房间名和匿名参与者标识从数据库 ID 派生，仅允许对应房间的摄像头/麦克风发布与订阅，不授予管理、录制或数据发布权限。客户端显示连接中、已连接、重连中、失败及设备拒绝状态。

结束时，双方停止媒体并退出，服务端拒绝新令牌并调用 `deleteRoom` 主动移除已连接参与者；清理失败持久记录，后续访问按 30 秒间隔重试，短清理超时避免阻塞文字状态同步。LiveKit 已签发的 JWT 无单令牌即时撤销能力，持有旧令牌的恶意延迟重入在其有效期内仍需正式服务的额外供应商准入控制；令牌到期不用于主动断开已连接用户。

真实双人音视频手工验收：

1. 配置自己的 LiveKit 凭据并重启，两个独立浏览器登录、匹配进入同一文字答疑室。
2. 两边分别点击连接并授权设备，观察“已连接”，实际听见对方声音、看到对方摄像头；检查静音、关摄像头按钮确实控制轨道。
3. 一边短暂断网再恢复，核对重连状态及恢复声音；拒绝设备授权时核对提示和文字聊天仍可用。
4. 任一方结束，两边退出音视频、设备指示灯熄灭，旧会话新令牌请求失败，LiveKit 控制台房间已删除。
5. 模拟清理 API 暂时不可达，核对数据库清理状态和恢复后的重试，不把模拟通过当作真实通话通过。

**本次未提供真实 RTC 凭据，真实双人通话尚未完成端到端验证。** SDK mock 和虚构密钥 JWT 权限测试只验证接口与令牌逻辑。

## 检查与隔离测试

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

`npm run check` 顺序执行以上五项。Vitest 使用 `/tmp` 隔离 SQLite 文件，每个用例拷贝迁移后的独立模板；并发用例使用两个独立 Prisma 连接。Playwright 的服务脚本每次新建独立临时数据库及上传目录，测试端口 3100，演示模式和短匹配时限仅注入测试进程。测试不会 reset 或覆盖 `data/dev.db`。请勿在测试端口另开服务。

浏览器测试优先使用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`，其次使用系统 `/usr/bin/chromium`；其他环境安装浏览器：

```bash
npx playwright install chromium
# Linux 缺少系统库时由本机管理员安装依赖：
# npx playwright install --with-deps chromium
```

涵盖科目与心跳、资格限制、双连接并发占用、请求幂等、接受/取消/拒绝/超时竞争、结束释放、失联恢复、资源权限、管理员权限、结束后消息/RTC拒绝、反馈约束、附件真实内容鉴别、演示开关、CSRF 与频率限制。浏览器流程覆盖双方真实收发、结束反馈与数据库记录，以及无人在线、指定拒绝、超时、取消、刷新恢复和后端已写入但响应丢失后的幂等重试。

最新验证记录见 `VALIDATION.md`，以实际执行结果为准。

## 技术与范围

Next.js App Router 16.3.8、React 19.3、TypeScript 5.9、Tailwind CSS 4.3、Prisma 7.10 + `@prisma/adapter-better-sqlite3`，Route Handlers 使用 Node runtime。读取关闭静态缓存，约 2 秒轮询。依赖固定版本并保留 npm 锁文件，不引入 Redis、微服务、复杂消息队列或自建 RTC 服务器。

依赖选择核对了官方 [Next.js 安装要求](https://nextjs.org/docs/app/getting-started/installation)、[异步 cookies API](https://nextjs.org/docs/app/api-reference/functions/cookies)、[Route Handler params](https://nextjs.org/docs/app/api-reference/file-conventions/route)、[Prisma 7 SQLite quickstart](https://www.prisma.io/docs/v7/prisma-orm/quickstart/sqlite) 与 [Prisma 配置](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference)。Prisma 7.10 使用 `prisma7.config.ts`、显式输出的新客户端生成器及 SQLite 驱动适配器。Next.js 自动生成的 AGENTS.md/CLAUDE.md 保留其官方本地指引。

免费本地原型没有正式身份认证、短信、身份证或学籍材料、支付/钱包/充值/提现/分账；没有自动购买服务或部署公网。公网部署、正式认证与资质核验、支付、运营手续、生产级规模和多实例迁移不在此次范围。
