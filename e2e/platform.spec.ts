import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const origin = 'http://127.0.0.1:3100';
const question = '这道极限题我使用洛必达法则后仍然遇到不确定式，希望帮我分析具体变形过程和适用条件。';
const headers = { Origin: origin };
async function write(api: APIRequestContext, endpoint: string, data: unknown = {}) {
  const response = await api.post(`/api${endpoint}`, { data, headers });
  expect(response.ok(), `${endpoint}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function login(page: Page, name: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: `以${name}登录`, exact: true }).click();
  await expect.poll(async () => (await (await page.request.get('/api/me')).json()).user?.name).toBe(name);
}
async function ask(page: Page, direct: boolean, text = question) {
  await page.goto('/ask');
  await page.getByLabel('答疑科目', { exact: false }).selectOption('math');
  await page.getByLabel('问题描述', { exact: false }).fill(text);
  if (direct) {
    await page.getByRole('radio', { name: /指定答疑者/ }).check();
    await page.getByLabel('选择答疑者').selectOption('answerer-a');
  }
  await page.getByRole('button', { name: /发出答疑请求/ }).click();
  await expect(page).toHaveURL(/\/match\//);
  return page.url().split('/').at(-1)!;
}
async function getRequest(api: APIRequestContext, id: string) {
  return (await (await api.get(`/api/requests/${id}`)).json()).request;
}

test.beforeEach(async ({ playwright }) => {
  // Clear only active workflow in the dedicated ephemeral E2E database; never user's database.
  for (const accountId of ['answerer-a', 'answerer-b', 'answerer-c', 'asker-a', 'asker-b']) {
    const api = await playwright.request.newContext({ baseURL: origin });
    await write(api, '/login', { accountId });
    if (accountId.startsWith('answerer')) {
      await write(api, '/presence', { online: false });
      const board = await (await api.get('/api/answer')).json();
      if (board.currentSession) await write(api, `/sessions/${board.currentSession.id}/end`);
    } else {
      const data = await (await api.get('/api/history')).json();
      for (const item of data.history) {
        if (['WAITING', 'OFFERED'].includes(item.status)) await write(api, `/requests/${item.requestId}/cancel`);
        if (item.sessionId && ['MATCHED', 'IN_PROGRESS'].includes(item.status)) await write(api, `/sessions/${item.sessionId}/end`);
      }
    }
    await api.dispose();
  }
});

test('两个隔离浏览器会话完成邀请、双向聊天、刷新恢复、结束、反馈与真实统计', async ({ browser }) => {
  const askerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const answererContext = await browser.newContext();
  const asker = await askerContext.newPage();
  const answerer = await answererContext.newPage();
  await login(answerer, '答疑者A');
  await answerer.setViewportSize({ width: 390, height: 844 });
  await expect(answerer.getByRole('heading', { name: '我的可答科目', exact: true })).toBeVisible();
  expect(await answerer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await answerer.setViewportSize({ width: 1280, height: 720 });
  await answerer.getByRole('button', { name: '开始接单', exact: true }).click();
  await expect.poll(async () => (await (await answerer.request.get('/api/catalog')).json()).answerers.find((x: { id: string }) => x.id === 'answerer-a')?.status).toBe('AVAILABLE');
  await login(asker, '提问者A');
  const id = await ask(asker, true);
  await expect.poll(async () => (await getRequest(asker.request, id)).status).toBe('OFFERED');
  await answerer.getByRole('button', { name: '接受请求', exact: true }).click();
  await expect(answerer).toHaveURL(/\/room\//);
  await expect(asker).toHaveURL(/\/room\//);
  expect(asker.url().split('/').at(-1)).toBe(answerer.url().split('/').at(-1));
  const sessionId = asker.url().split('/').at(-1)!;
  await expect(asker.getByLabel('消息', { exact: true })).toBeEnabled();
  expect(await asker.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  let failedMessage = false;
  await asker.route(`**/api/sessions/${sessionId}/messages`, async route => {
    if (!failedMessage) { failedMessage = true; await route.abort('failed'); }
    else await route.continue();
  });
  await asker.getByLabel('消息', { exact: true }).fill('我卡在第二次求导，能解释一下吗？');
  await asker.getByRole('button', { name: /^发送消息/ }).click();
  await expect(asker.getByRole('alert').filter({ hasText: '网络' })).toBeVisible();
  await asker.getByRole('button', { name: '重试发送', exact: true }).click();
  await expect(answerer.getByText('我卡在第二次求导，能解释一下吗？', { exact: true })).toBeVisible();
  await answerer.getByLabel('消息', { exact: true }).fill('可以，我们先检查洛必达法则的使用条件。');
  await answerer.getByRole('button', { name: /^发送消息/ }).click();
  await expect(asker.getByText('可以，我们先检查洛必达法则的使用条件。', { exact: true })).toBeVisible();
  const beforeRefresh = (await (await asker.request.get(`/api/sessions/${sessionId}`)).json()).session;
  await asker.reload();
  await expect(asker.getByText('可以，我们先检查洛必达法则的使用条件。', { exact: true })).toBeVisible();
  const afterRefresh = (await (await asker.request.get(`/api/sessions/${sessionId}`)).json()).session;
  expect(afterRefresh.startedAt).toBe(beforeRefresh.startedAt);
  expect(afterRefresh.messages).toHaveLength(2);
  await expect(asker.getByText('设备预览模式，尚未接入双人音视频。', { exact: false })).toBeVisible();
  await answerer.getByRole('button', { name: '结束答疑', exact: true }).click();
  await expect(asker.getByLabel('消息', { exact: true })).toBeDisabled();
  await expect(answerer.getByLabel('消息', { exact: true })).toBeDisabled();
  await asker.goto(`/feedback/${sessionId}`);
  await asker.getByRole('button', { name: '已解决', exact: true }).click();
  await asker.getByRole('button', { name: '满意度5分', exact: true }).click();
  await asker.getByRole('button', { name: '提交反馈', exact: true }).click();
  await expect.poll(async () => (await (await asker.request.get(`/api/sessions/${sessionId}`)).json()).session.feedback?.rating).toBe(5);
  await asker.goto('/history');
  await expect(asker.getByText(question, { exact: true }).first()).toBeVisible();
  const history = (await (await asker.request.get('/api/history')).json()).history;
  expect(history.find((x: { sessionId: string }) => x.sessionId === sessionId)).toMatchObject({ status: 'COMPLETED', feedback: { resolution: 'SOLVED', rating: 5 } });
  const beforeAdmin = await asker.request.get('/api/admin');
  expect(beforeAdmin.status()).toBe(403);
  await login(asker, '管理员');
  const admin = (await (await asker.request.get('/api/admin')).json());
  expect(admin.stats).toMatchObject({ requestCount: 1, matchedCount: 1, completedCount: 1, feedbackCount: 1, solvedRatio: 1 });
  expect(admin.stats.averageMatchMs).toBeGreaterThanOrEqual(0);
  expect(admin.stats.bySubject.find((s: { id: string }) => s.id === 'math').count).toBe(1);
  await expect(asker.getByRole('heading', { name: /管理/ }).first()).toBeVisible();
  const csv = await asker.request.get('/api/admin/export');
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('已完成答疑数');
  expect(await csv.text()).not.toContain('我卡在第二次求导');
  await askerContext.close(); await answererContext.close();
});

test('无人在线正常等待，提问者取消后同步终态', async ({ page }) => {
  await login(page, '提问者A');
  const catalog = await (await page.request.get('/api/catalog')).json();
  expect(catalog.onlineCount).toBe(0);
  const id = await ask(page, false);
  await expect(page.getByText('等待在线答疑者', { exact: true })).toBeVisible();
  expect((await getRequest(page.request, id)).sessionId).toBeNull();
  await page.getByRole('button', { name: /取消/ }).click();
  await expect(page.getByText('请求已取消', { exact: true })).toBeVisible();
  expect((await getRequest(page.request, id)).status).toBe('CANCELLED');
});

test('指定答疑者拒绝不会擅自更换答疑者', async ({ browser }) => {
  const a = await browser.newContext(); const b = await browser.newContext();
  const asker = await a.newPage(); const answerer = await b.newPage();
  await login(answerer, '答疑者A');
  await answerer.getByRole('button', { name: '开始接单', exact: true }).click();
  await login(asker, '提问者A');
  const id = await ask(asker, true);
  await answerer.getByRole('button', { name: '拒绝请求', exact: true }).click();
  await expect(asker.getByText('指定答疑者拒绝了请求', { exact: true })).toBeVisible();
  expect(await getRequest(asker.request, id)).toMatchObject({ status: 'DECLINED', sessionId: null });
  await a.close(); await b.close();
});

test('无人在线等待超时依据后端截止时间，不创建房间', async ({ page }) => {
  await login(page, '提问者A');
  const id = await ask(page, false);
  await expect(page.getByText('等待超时', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await getRequest(page.request, id)).toMatchObject({ status: 'EXPIRED', sessionId: null });
});

test('后端已保存但响应网络丢失，重试不重复创建请求', async ({ page }) => {
  await login(page, '提问者A');
  await page.goto('/ask');
  await page.getByLabel('答疑科目', { exact: false }).selectOption('math');
  await page.getByLabel('问题描述', { exact: false }).fill('网络重试验证：这道高等数学极限题我不知道该如何选择等价无穷小，希望分析。');
  let savedId = '';
  let lost = false;
  await page.route('**/api/requests', async route => {
    if (route.request().method() === 'POST' && !lost) {
      lost = true;
      const upstream = await route.fetch();
      savedId = (await upstream.json()).request.id;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: /发出答疑请求/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: '网络' })).toBeVisible();
  await page.getByRole('button', { name: /发出答疑请求/ }).click();
  await expect(page).toHaveURL(new RegExp(`/match/${savedId}$`));
  const history = (await (await page.request.get('/api/history')).json()).history;
  expect(history.filter((x: { requestId: string }) => x.requestId === savedId)).toHaveLength(1);
  await write(page.request, `/requests/${savedId}/cancel`);
});
