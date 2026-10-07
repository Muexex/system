# 研伴答疑

首次安装可先看[快速安装与运行手册](docs/快速安装与运行手册.md)，按Windows Git Bash命令逐步完成下载、初始化和启动。

从其他电脑下载安装、首次启动、管理员初始化、学生与教师使用、局域网访问以及备份迁移，请阅读[安装与使用手册](docs/使用手册.md)，也可下载[可打印PDF版](docs/研伴答疑安装与使用手册.pdf)。

研伴答疑提供面向成年在校大学生的实时一对一学习答疑。首页介绍服务，学生与教师分别注册、登录并进入各自门户；学生提交具体问题，在线教师接受后进入临时答疑室，双方交流、结束，学生随后反馈。

平台中的教师限定为成年、非在职、全日制在校大学生或研究生。教师提交资格自声明，管理员审核账号及可答范围后才可上线；账号审核不等于第三方学籍核验。当前服务不收费，无课程购买、课时包或录播。

## 安装与启动

使用 **Node.js 22 LTS**，建议 **22.23.3**，支持22.13+的22.x版本。Node.js 24的原生模块清理回归可能导致SQLite崩溃，当前不支持。安装Git后执行：

```bash
git clone https://github.com/Muexex/system.git
cd system
npm ci
npm run setup
npm run dev
```

访问 `http://localhost:3000`，首先显示功能介绍首页。启动终端保持打开。首次setup创建缺失的.env、数据库和附件目录，生成Prisma Client、应用迁移并补充科目；不创建共享用户或管理员口令。重复执行不会清空答疑记录、覆盖.env或重置账号。

开发启动自动先检查数据库，再由监督进程启动。生产模式：

```bash
npm run setup
npm run build
npm start
```

Windows Git Bash支持同样的命令。更新旧版时先停止服务，再执行：

```bash
git pull --ff-only
npm ci
npm run setup
npm run dev
```

旧数据库通过新增迁移升级，旧记录保留。旧共用Cookie、账号选择接口和APP_DEMO_MODE不能登录新门户，需要注册正式账号。旧资料不参与正式教师目录和运营统计。

遇到 `spawnSync npx.cmd EINVAL` 请拉取更新，当前脚本使用Node直接执行本地CLI。遇到 `RemoveEnvironmentCleanupHook`、`(env) != nullptr` 或 `Statement` 原生崩溃，确认node版本为22.x，再执行npm ci重装原生依赖。参考 [Node上游问题](https://github.com/nodejs/node/issues/65446)。Windows可使用官方 [22.23.3 x64安装包](https://nodejs.org/dist/v22.23.3/node-v22.23.3-x64.msi)，替换24版本后重新打开终端。

## 独立门户与账号

| 路径 | 内容 |
| --- | --- |
| `/` | 功能介绍、学生与教师入口 |
| `/student/login`、`/student/register` | 学生登录、注册 |
| `/student`、`/student/ask` | 学生主页、提交问题 |
| `/student/match/[requestId]` | 匹配与取消 |
| `/student/room/[sessionId]` | 学生答疑室 |
| `/student/history`、`/student/profile` | 学生历史与个人资料 |
| `/student/feedback/[sessionId]` | 已结束会话的学生反馈 |
| `/teacher/login`、`/teacher/register` | 教师独立登录、注册 |
| `/teacher` | 审核状态、上线、接单与当前答疑 |
| `/teacher/room/[sessionId]` | 教师答疑室 |
| `/teacher/history`、`/teacher/profile` | 教师历史与个人资料 |
| `/admin/login`、`/admin` | 独立管理员入口、审核、统计与运行诊断 |
| `/terms`、`/privacy` | 服务条款与个人信息保护说明 |

StudentAccount、TeacherAccount、AdminAccount分别保存账号、口令摘要和资料。相同账号名可以分别注册学生和教师，口令与资料独立；共同User表只用于业务内部标识、昵称和角色关联，不保存口令及学校等独立资料。

三端使用独立HttpOnly Cookie与带门户标识的数据库会话。在同一浏览器登录学生与教师不会相互覆盖，退出一端不影响另一端。客户端门户标识只选择待验证Cookie，真实身份、角色与归属仍由服务器判断。

注册确认成年与条款。教师另需学校、学历、科目、介绍及全日制在校、非在职声明。新教师默认等待管理员审核，不能接单。影响审核的资料或答疑范围变更后需重新审核，以服务端状态为准。

## 创建管理员

在服务所在电脑的项目目录执行：

```bash
npm run admin:create
```

按提示创建专用管理员账号与隐藏口令，再访问 `/admin/login`。无出厂密码，无公开管理员注册。已有管理员不会被此命令重置。

若Git Bash报告终端不支持隐藏口令，执行 `winpty node.exe scripts/admin-create.mjs`。winpty需要启动原生可执行文件，因此这里直接运行Node入口。也可在项目目录打开PowerShell执行 `npm.cmd run admin:create`。不要把口令放进命令行参数、代码或Git。

管理员在教师列表审核资料、启用账号并设置可答科目。CSV只导出汇总，不导出私人聊天、图片或口令摘要。

## 完成一次答疑

1. 注册学生和教师，管理员审核启用教师。
2. 教师进入工作台，点击“开始接单”；必须心跳有效且空闲。
3. 另一浏览器会话登录学生，选科目、填写20—2000字问题，可上传单张图片。
4. 指定或快速匹配；教师接受后双方进入同一会话，双方进入后开始计时。
5. 双向发送文字，约2秒同步；刷新恢复消息和开始时间，发送失败可重试。
6. 任一方结束，另一端同步禁用聊天、停止媒体；学生填写反馈。
7. 两端历史显示本人记录，管理员统计读取实际正式账号的请求、会话与反馈。

普通窗口与无痕窗口便于模拟独立设备。同一浏览器两种门户也有独立Cookie，但多个普通窗口的同一门户仍共享该门户Cookie。

快速匹配按科目、资格、启用、心跳和空闲筛选，优先空闲更久者。指定教师拒绝不擅自换人，无人在线正常等待。默认总等待60秒、单次邀请20秒。

## 运行监督

开发和生产经scripts/run-server.mjs启动。父进程记录子服务退出码、信号和中文原因，并限次重启，默认10分钟内最多3次。主动停止与异常退出分开记录；Ctrl+C停止服务及其子进程。

API try/catch返回安全错误及关联编号，页面错误边界可重试。**JavaScript try/catch不能拦截原生SIGABRT、操作系统终止或掉电**；此类退出由父进程记录，原生堆栈可在终端查看。监督不能替代修复运行时缺陷。

管理员运行诊断显示Node/Next版本、运行时间、内存及最近异常和退出记录。日志data/logs/application.jsonl，默认256KiB轮转、保留3份，不记录口令、Cookie、RTC令牌、密钥或聊天正文。不可写时明确提示。

| 环境配置 | 默认值 |
| --- | --- |
| LOG_DIR、LOG_MAX_BYTES、LOG_ROTATE_FILES | ./data/logs、262144、3 |
| SERVER_MAX_RESTARTS、SERVER_RESTART_WINDOW_MS | 3、600000 |
| SERVER_RESTART_DELAY_MS、SERVER_STOP_TIMEOUT_MS | 1000、5000 |
| MATCH_WAIT_MS、MATCH_OFFER_MS | 60000、20000 |
| HEARTBEAT_TTL_MS | 30000；心跳间隔10秒 |
| SESSION_ABANDONED_MS | 1800000 |
| APP_ORIGIN | 本机按原始Host及协议；HTTPS代理填写固定外部源 |

## 数据与安全

数据库默认data/dev.db、附件data/uploads/。DATABASE_URL相对路径按项目根目录解析，CLI与运行时一致。SQLite适用于**单实例、持久化磁盘**，不适用于无持久化Serverless或多个实例共享文件数据库。

密码为随机盐scrypt摘要。登录Cookie安全随机、HttpOnly、SameSite=Lax，HTTPS启用Secure；所有写接口检查来源，认证与关键业务有频率限制。修改密码需要原口令，撤销本账号其他登录。文本按纯文本显示。

题目图片限PNG/JPEG/WebP、最多1张、最大5MB，检查真实内容并重新编码，随机文件名保存，不暴露为public静态文件。下载验证上传学生、当前有效邀请教师或会话参与者。

请求状态和占用集中于数据库事务，唯一键、条件更新保证并发与幂等。所有读取和领取修复过期占用；短暂断网可恢复，长期无人返回记录失联回收原因。服务重启后从数据库恢复，不把断网当作完成。

.env、数据库、附件、日志、生成客户端和构建输出均被Git忽略。备份同时保存数据库和附件并保证数据库一致性；更新不使用reset。

## 音视频

默认RTC_PROVIDER=demo是本地设备预览，界面明确尚未接入双人通话。文字答疑不依赖第三方密钥。接入已有LiveKit：

```dotenv
RTC_PROVIDER=livekit
LIVEKIT_URL=wss://your-project.example
LIVEKIT_API_KEY=your-server-key
LIVEKIT_API_SECRET=your-server-secret
```

密钥仅服务端，不用NEXT_PUBLIC、不提交仓库或日志。浏览器需要localhost或HTTPS安全上下文，并允许LiveKit/WebRTC网络通道。

服务器检查真实登录、会话参与者及未结束状态后签发5分钟令牌；房间与匿名参与者ID来自数据库，只授予必要权限。结束时停止轨道、退出、拒绝新令牌，并请求删除供应商房间，失败持久重试。旧JWT有效期内的恶意延迟重入需额外供应商准入控制，不能靠令牌过期主动踢人。

真实验收：两个独立浏览器注册、匹配，分别连接授权，确实看到和听到对方；检查静音/关摄像头、断网重连、双方结束退出和房间删除。没有真实凭据时，不把预览或SDK模拟描述为真实通话通过。

## 检查

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

npm run check顺序执行所有检查。测试使用临时隔离数据库、附件及日志；浏览器端口3100、.next-e2e输出，不清用户库。覆盖独立认证/资料/注销、并发匹配、幂等、超时、权限、附件、反馈、进程监督和真实注册双用户流程。

浏览器优先PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH或系统Chromium；其他电脑可运行 `npx playwright install chromium`。实际结果见 [VALIDATION.md](VALIDATION.md)。

## 当前范围

已实现真实账号密码认证、独立门户、教师审核、答疑闭环和运行监督。未接短信/邮件找回、身份证/学籍第三方核验、支付或默认录制，页面没有伪验证或无效社交登录按钮。真实LiveKit需要配置和验收；未自动购买服务或部署公网。实际运营和公网配置由服务运营者安排。
