import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

type Portal = 'student' | 'teacher' | 'admin';
const origin = 'http://127.0.0.1:3100';
const password = 'YanbanTest!2026';
const question = '这道极限题我使用洛必达法则后仍然遇到不确定式，希望帮我分析具体变形过程和适用条件。';
const username = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
const headers = (portal: Portal) => ({ Origin: origin, 'X-Yanban-Portal': portal });
async function write(api: APIRequestContext, endpoint: string, data: unknown = {}, portal: Portal = 'student') {
  const response = await api.post(`/api${endpoint}`, { data, headers: headers(portal) });
  expect(response.ok(), `${endpoint}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function read(api: APIRequestContext, endpoint: string, portal: Portal = 'student') {
  const response = await api.get(`/api${endpoint}`, { headers: headers(portal) });
  expect(response.ok(), `${endpoint}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function login(page: Page, portal: Portal, account: string, secret = password) {
  await page.goto(`/${portal}/login`);
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(secret);
  await page.getByRole('button', { name: portal === 'student' ? '登录学生端' : portal === 'teacher' ? '登录教师端' : '登录管理后台', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${portal}$`));
  expect((await read(page.request, '/me', portal)).user.portal).toBe(portal);
}
async function register(page: Page, portal: 'student' | 'teacher', displayName: string, account = username(portal)) {
  await page.goto(`/${portal}/register`);
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('昵称', { exact: true }).fill(displayName);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  if (portal === 'teacher') {
    await page.getByLabel('学校', { exact: true }).fill('示例大学');
    await page.getByLabel('在读层次', { exact: true }).selectOption('MASTER');
    await page.getByLabel('擅长方向', { exact: true }).fill('擅长考研数学极限、微积分与线性代数，愿意耐心解释问题。');
    await page.getByRole('checkbox', { name: '考研数学', exact: true }).check();
    await page.getByRole('checkbox', { name: /全日制/ }).check();
    await page.getByRole('checkbox', { name: /非在职/ }).check();
  }
  await page.getByRole('checkbox', { name: /18|成年/ }).check();
  await page.getByRole('checkbox', { name: /条款|协议|规则/ }).check();
  await page.getByRole('button', { name: `注册并进入${portal === 'student' ? '学生' : '教师'}端`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${portal}$`));
  const user = (await read(page.request, '/me', portal)).user;
  expect(user.name).toBe(displayName);
  return { account, user };
}
async function approve(admin: Page, id: string, name: string) {
  await admin.goto('/admin');
  await admin.getByRole('checkbox', { name: `启用${name}`, exact: true }).check();
  await admin.getByRole('button', { name: `保存${name}设置`, exact: true }).click();
  await expect.poll(async () => (await read(admin.request, '/admin', 'admin')).users.find((u: { id: string }) => u.id === id)?.enabled).toBe(true);
}
async function ask(page: Page, target?: string, text = question) {
  await page.goto('/student/ask');
  await page.getByLabel('答疑科目', { exact: false }).selectOption('math');
  await page.getByLabel('问题描述', { exact: false }).fill(text);
  if (target) {
    await page.getByRole('radio', { name: /指定教师/ }).check();
    await page.getByLabel('选择教师', { exact: true }).selectOption(target);
  }
  await page.getByRole('button', { name: /发出答疑请求/ }).click();
  await expect(page).toHaveURL(/\/student\/match\//);
  return page.url().split('/').at(-1)!;
}
async function getRequest(api: APIRequestContext, id: string) {
  return (await read(api, `/requests/${id}`)).request;
}
async function readyTeacher(page: Page, adminApi: APIRequestContext, name: string) {
  const teacher = await register(page, 'teacher', name);
  await write(adminApi, `/admin/answerers/${teacher.user.id}`, { enabled: true, subjectIds: ['math'] }, 'admin');
  await page.reload();
  await page.getByRole('button', { name: '开始接单', exact: true }).click();
  await expect.poll(async () => (await read(page.request, '/catalog', 'teacher')).answerers.find((u: { id: string }) => u.id === teacher.user.id)?.status).toBe('AVAILABLE');
  return teacher;
}

test.beforeEach(async ({ playwright }) => {
  // Only the dedicated temporary E2E database is reachable from this server.
  const api = await playwright.request.newContext({ baseURL: origin });
  await write(api, '/admin/auth/login', { username: 'admin', password }, 'admin');
  const data = await read(api, '/admin', 'admin');
  for (const user of data.users) {
    if (user.role === 'ANSWERER') await write(api, `/admin/answerers/${user.id}`, {
      enabled: false, subjectIds: user.subjects.map((s: { id: string }) => s.id),
    }, 'admin');
  }
  await api.dispose();
});

test('真实页面注册、管理员审核、双浏览器匹配聊天刷新结束反馈与统计', async ({ browser }) => {
  const studentContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const teacherContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const student = await studentContext.newPage();
  const teacher = await teacherContext.newPage();
  const admin = await adminContext.newPage();
  await register(teacher, 'teacher', '交流教师');
  const teacherUser = (await read(teacher.request, '/me', 'teacher')).user;
  await expect(teacher.getByRole('button', { name: '开始接单', exact: true })).toBeDisabled();
  await login(admin, 'admin', 'admin');
  await approve(admin, teacherUser.id, teacherUser.name);
  await teacher.reload();
  await teacher.setViewportSize({ width: 390, height: 844 });
  await expect(teacher.getByRole('heading', { name: '我的可答科目', exact: true })).toBeVisible();
  expect(await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await teacher.setViewportSize({ width: 1280, height: 720 });
  await teacher.getByRole('button', { name: '开始接单', exact: true }).click();
  await expect.poll(async () => (await read(teacher.request, '/catalog', 'teacher')).answerers.find((u: { id: string }) => u.id === teacherUser.id)?.status).toBe('AVAILABLE');
  await register(student, 'student', '学习学生');
  await expect(student.getByRole('link', { name: /管理/ })).toHaveCount(0);
  await expect(student.locator('body')).not.toContainText(/原型测试|演示账号|虚构测试/);
  const id = await ask(student, teacherUser.id);
  await expect.poll(async () => (await getRequest(student.request, id)).status).toBe('OFFERED');
  await teacher.getByRole('button', { name: '接受请求', exact: true }).click();
  await expect(teacher).toHaveURL(/\/teacher\/room\//);
  await expect(student).toHaveURL(/\/student\/room\//);
  expect(student.url().split('/').at(-1)).toBe(teacher.url().split('/').at(-1));
  const sessionId = student.url().split('/').at(-1)!;
  await expect(student.getByLabel('消息', { exact: true })).toBeEnabled();
  expect(await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  let failedMessage = false;
  await student.route(`**/api/sessions/${sessionId}/messages`, async route => {
    if (!failedMessage) { failedMessage = true; await route.abort('failed'); } else await route.continue();
  });
  await student.getByLabel('消息', { exact: true }).fill('我卡在第二次求导，能解释一下吗？');
  await student.getByRole('button', { name: /^发送消息/ }).click();
  await expect(student.getByRole('alert').filter({ hasText: '网络' })).toBeVisible();
  await student.getByRole('button', { name: '重试发送', exact: true }).click();
  await expect(teacher.getByText('我卡在第二次求导，能解释一下吗？', { exact: true })).toBeVisible();
  await teacher.getByLabel('消息', { exact: true }).fill('可以，我们先检查洛必达法则的使用条件。');
  await teacher.getByRole('button', { name: /^发送消息/ }).click();
  await expect(student.getByText('可以，我们先检查洛必达法则的使用条件。', { exact: true })).toBeVisible();
  const beforeRefresh = (await read(student.request, `/sessions/${sessionId}`)).session;
  await student.reload();
  await expect(student.getByText('可以，我们先检查洛必达法则的使用条件。', { exact: true })).toBeVisible();
  const afterRefresh = (await read(student.request, `/sessions/${sessionId}`)).session;
  expect(afterRefresh.startedAt).toBe(beforeRefresh.startedAt);
  expect(afterRefresh.messages).toHaveLength(2);
  await expect(student.getByText('设备预览模式，尚未接入双人音视频。', { exact: false })).toBeVisible();
  await teacher.getByRole('button', { name: '结束答疑', exact: true }).click();
  await expect(student.getByLabel('消息', { exact: true })).toBeDisabled();
  await expect(teacher.getByLabel('消息', { exact: true })).toBeDisabled();
  await student.goto(`/student/feedback/${sessionId}`);
  await student.getByRole('button', { name: '已解决', exact: true }).click();
  await student.getByRole('button', { name: '满意度5分', exact: true }).click();
  await student.getByRole('button', { name: '提交反馈', exact: true }).click();
  await expect.poll(async () => (await read(student.request, `/sessions/${sessionId}`)).session.feedback?.rating).toBe(5);
  await student.goto('/student/history');
  await expect(student.getByText(question, { exact: true }).first()).toBeVisible();
  const history = (await read(student.request, '/history')).history;
  expect(history.find((u: { sessionId: string }) => u.sessionId === sessionId)).toMatchObject({ status: 'COMPLETED', feedback: { resolution: 'SOLVED', rating: 5 } });
  expect((await student.request.get('/api/admin', { headers: headers('student') })).status()).toBe(403);
  const stats = (await read(admin.request, '/admin', 'admin')).stats;
  expect(stats).toMatchObject({ requestCount: 1, matchedCount: 1, completedCount: 1, feedbackCount: 1, solvedRatio: 1 });
  expect(stats.averageMatchMs).toBeGreaterThanOrEqual(0);
  expect(stats.bySubject.find((s: { id: string }) => s.id === 'math').count).toBe(1);
  const csv = await admin.request.get('/api/admin/export', { headers: headers('admin') });
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('已完成答疑数');
  expect(await csv.text()).not.toContain('我卡在第二次求导');
  await studentContext.close(); await teacherContext.close(); await adminContext.close();
});

test('无人在线正常等待，学生取消后同步终态', async ({ page }) => {
  await register(page, 'student', '等待学生');
  expect((await read(page.request, '/catalog')).onlineCount).toBe(0);
  const id = await ask(page);
  await expect(page.getByText('等待在线教师', { exact: true })).toBeVisible();
  expect((await getRequest(page.request, id)).sessionId).toBeNull();
  await page.getByRole('button', { name: /取消/ }).click();
  await expect(page.getByText('请求已取消', { exact: true })).toBeVisible();
  expect((await getRequest(page.request, id)).status).toBe('CANCELLED');
});

test('指定教师拒绝不会擅自更换教师', async ({ browser, request }) => {
  await write(request, '/admin/auth/login', { username: 'admin', password }, 'admin');
  const a = await browser.newContext(); const b = await browser.newContext();
  const student = await a.newPage(); const teacher = await b.newPage();
  const teacherUser = await readyTeacher(teacher, request, '拒绝教师');
  await register(student, 'student', '重选学生');
  const id = await ask(student, teacherUser.user.id);
  await teacher.getByRole('button', { name: '拒绝请求', exact: true }).click();
  await expect(student.getByText(/指定(?:教师|答疑者)拒绝了请求/)).toBeVisible();
  expect(await getRequest(student.request, id)).toMatchObject({ status: 'DECLINED', sessionId: null });
  await a.close(); await b.close();
});

test('无人在线等待超时依据后端截止时间，不创建房间', async ({ page }) => {
  await register(page, 'student', '超时学生');
  const id = await ask(page);
  await expect(page.getByText('等待超时', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await getRequest(page.request, id)).toMatchObject({ status: 'EXPIRED', sessionId: null });
});

test('后端已保存但响应网络丢失，重试不重复创建请求', async ({ page }) => {
  await register(page, 'student', '重试学生');
  await page.goto('/student/ask');
  await page.getByLabel('答疑科目', { exact: false }).selectOption('math');
  await page.getByLabel('问题描述', { exact: false }).fill('网络重试验证：这道高等数学极限题我不知道该如何选择等价无穷小，希望分析。');
  let savedId = ''; let lost = false;
  await page.route('**/api/requests', async route => {
    if (route.request().method() === 'POST' && !lost) {
      lost = true; const upstream = await route.fetch(); savedId = (await upstream.json()).request.id;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: /发出答疑请求/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: '网络' })).toBeVisible();
  await page.getByRole('button', { name: /发出答疑请求/ }).click();
  await expect(page).toHaveURL(new RegExp(`/student/match/${savedId}$`));
  const history = (await read(page.request, '/history')).history;
  expect(history.filter((u: { requestId: string }) => u.requestId === savedId)).toHaveLength(1);
  await write(page.request, `/requests/${savedId}/cancel`);
});

test('手机首页和独立登录入口无演示入口，同一浏览器学生教师会话相互独立', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: /管理/ })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/原型测试|演示账号|虚构测试/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/student/login');
  await expect(page.getByRole('navigation', { name: '登录身份' }).getByRole('link', { name: '教师登录', exact: true })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill('Password!2026');
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByRole('checkbox', { name: '记住登录状态', exact: true })).toBeVisible();
  const student = await register(page, 'student', '双端学生');
  const teacher = await register(page, 'teacher', '双端教师');
  expect((await read(page.request, '/me', 'student')).user.id).toBe(student.user.id);
  expect((await read(page.request, '/me', 'teacher')).user.id).toBe(teacher.user.id);
  await page.goto('/student');
  await expect(page.getByRole('link', { name: /教师工作台/ })).toHaveCount(0);
  await write(page.request, '/student/auth/logout', {}, 'student');
  expect((await read(page.request, '/me', 'student')).user).toBeNull();
  expect((await read(page.request, '/me', 'teacher')).user.id).toBe(teacher.user.id);
  await login(page, 'student', student.account);
  expect((await read(page.request, '/me', 'teacher')).user.id).toBe(teacher.user.id);
  await page.goto('/teacher');
  await expect(page.getByRole('link', { name: '发起提问', exact: true })).toHaveCount(0);
});
