import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import worker, { type Env } from './index.ts';
import { SqliteD1 } from './test-d1.ts';

type Mail = { to: unknown; subject: string; html?: string; text?: string };
type Payload = { ok: boolean; code?: string; data?: { user?: { email: string } | null } };
const ORIGIN = 'https://admin.example.com';
const APPLICANT = 'photographer@example.com';

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

function inputs(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname=["']([^"']*)["']/i.exec(input[0])?.[1];
    const value = /\bvalue=["']([^"']*)["']/i.exec(input[0])?.[1];
    if (name && value !== undefined) fields[name] = value;
  }
  return fields;
}

function fixture(t: TestContext) {
  const database = new SqliteD1();
  const mail: Mail[] = [];
  let failMail = false;
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  t.after(() => database.sqlite.close());
  const env = {
    AUTH_DB: database,
    AUTH_SECRET: 'test-auth-secret-at-least-thirty-two-characters',
    ADMIN_EMAIL: 'owner@example.com',
    EMAIL_FROM: 'access@example.com',
    APP_ORIGIN: ORIGIN,
    EMAIL: { async send(message: Mail) {
      if (failMail) throw new Error('Simulated mail transport failure');
      mail.push(message);
      return { messageId: `test-${mail.length}` };
    } },
    WECHAT_APP_ID: 'wx7f54ff074d26489f',
    WECHAT_APP_SECRET: '0123456789abcdef0123456789abcdef',
    CLOUDBASE_ENV_ID: 'cloud1-d4gbua7848fbcecf0',
  } as unknown as Env;

  async function request(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if ((options.method || 'GET') !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN);
    return worker.fetch(new Request(`${ORIGIN}${path}`, { ...options, headers }), env);
  }

  function post(path: string, data: unknown, headers?: HeadersInit) {
    return request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) }, body: JSON.stringify(data) });
  }

  async function reviewForm(token: string, decision = 'approve') {
    const response = await request(`/api/auth/review?token=${token}&decision=${decision}`);
    assert.equal(response.status, 200);
    const fields = inputs(await response.text());
    assert.ok(fields.csrf, 'Review confirmation must include a CSRF token');
    return { fields, cookie: cookieHeader(response) };
  }

  async function submitReview(form: Awaited<ReturnType<typeof reviewForm>>, changes: Record<string, string> = {}) {
    return request('/api/auth/review', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: form.cookie },
      body: new URLSearchParams({ ...form.fields, ...changes }),
    });
  }

  function approvalToken(index = mail.length - 1) {
    const content = `${mail[index]?.text || ''} ${mail[index]?.html || ''}`;
    const token = /[?&]token=([a-f0-9]{64})/i.exec(content)?.[1];
    assert.ok(token, 'Owner approval email must contain an unguessable review token');
    return token;
  }

  function otp(index = mail.length - 1) {
    const code = /\b\d{6}\b/.exec(`${mail[index]?.text || ''} ${mail[index]?.html || ''}`)?.[0];
    assert.ok(code, 'Login email must contain a six-digit code');
    return code;
  }

  async function approve(email = APPLICANT) {
    const applied = await post('/api/auth/request-access', { email });
    assert.equal(applied.status, 200, await applied.clone().text());
    const token = approvalToken();
    const response = await submitReview(await reviewForm(token));
    assert.equal(response.status, 200, await response.clone().text());
    return token;
  }

  async function login(email = APPLICANT) {
    await approve(email);
    const sent = await post('/api/auth/send-code', { email });
    assert.equal(sent.status, 200, await sent.clone().text());
    const code = otp();
    const response = await post('/api/auth/verify-code', { email, code });
    assert.equal(response.status, 200, await response.clone().text());
    return { response, cookie: cookieHeader(response), code };
  }

  return { database, mail, env, request, post, approvalToken, otp, approve, login, reviewForm, submitReview,
    advance: (milliseconds: number) => { time += milliseconds; },
    failMail: (value: boolean) => { failMail = value; },
  };
}

test('匿名请求和旧访问口令、客户端连接配置都不能访问业务接口', async (t) => {
  const f = fixture(t);
  Object.assign(f.env, { ADMIN_TOKEN: 'legacy-admin-token' });
  const encoded = Buffer.from(JSON.stringify({
    apiBase: 'https://attacker.example.com', envId: 'other-environment',
    appId: 'wx0123456789abcdef', appSecret: '0123456789abcdef0123456789abcdef',
  })).toString('base64');
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Unauthorized requests must never reach an upstream service'); });
  for (const [method, path] of [
    ['GET', '/api/portfolios'], ['GET', '/api/series'], ['GET', '/api/studio'],
    ['POST', '/api/verify'], ['POST', '/api/portfolios'], ['POST', '/api/files/delete'],
  ]) {
    const response = await f.request(path, { method, headers: { 'x-admin-token': 'legacy-admin-token', 'x-cloudbase-config': encoded } });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  const session = await f.request('/api/auth/session');
  assert.deepEqual((await session.json() as Payload).data?.user, null);
});

test('未审批邮箱不能收到登录验证码，申请只向所有者发送审批邮件', async (t) => {
  const f = fixture(t);
  const denied = await f.post('/api/auth/send-code', { email: APPLICANT });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    ok: false,
    code: 'ACCESS_REQUIRED',
    message: '该邮箱尚未获得授权，请先申请访问权限，待管理员批准后再登录。',
  });
  assert.equal(f.mail.length, 0);
  const response = await f.post('/api/auth/request-access', { email: APPLICANT });
  assert.equal(response.status, 200);
  assert.equal(f.mail.length, 1);
  assert.match(JSON.stringify(f.mail[0].to), /owner@example\.com/);
  assert.match(f.mail[0].html || '', /approve/i);
  assert.match(f.mail[0].html || '', /reject/i);
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 403);
  assert.equal(f.mail.length, 1, 'A pending application must not grant login access');
});

test('已授权访问业务时仍只使用服务器连接配置，旧请求头不能替换凭据或主机', async (t) => {
  const f = fixture(t);
  const { cookie } = await f.login();
  const calls: { url: URL; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, 'https://api.weixin.qq.com');
    calls.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
    return Response.json(url.pathname === '/cgi-bin/stable_token'
      ? { access_token: 'test-upstream-token', expires_in: 7200 }
      : { data: [] });
  });
  const attackerConfig = Buffer.from(JSON.stringify({
    apiBase: 'https://attacker.example.com', envId: 'attacker-environment',
    appId: 'wx0123456789abcdef', appSecret: 'attacker-secret-0123456789abcdef',
  })).toString('base64');
  const response = await f.request('/api/portfolios', { headers: { cookie, 'x-cloudbase-config': attackerConfig } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(calls.length > 0);
  const query = calls.find((call) => call.url.pathname === '/tcb/databasequery');
  assert.equal(query?.body.env, 'cloud1-d4gbua7848fbcecf0');
  const token = calls.find((call) => call.url.pathname === '/cgi-bin/stable_token');
  if (token) {
    assert.equal(token.body.appid, 'wx7f54ff074d26489f');
    assert.equal(token.body.secret, '0123456789abcdef0123456789abcdef');
  }
});

test('服务端没有 AppSecret 时拒绝业务请求，客户端请求头无法补齐密钥', async (t) => {
  const f = fixture(t);
  const { cookie } = await f.login();
  delete f.env.WECHAT_APP_SECRET;
  const response = await f.request('/api/portfolios', {
    headers: { cookie, 'x-cloudbase-config': Buffer.from(JSON.stringify({ appSecret: '0123456789abcdef0123456789abcdef' })).toString('base64') },
  });
  assert.equal(response.status, 503);
});

test('审批链接 GET 无授权副作用，确认页面 POST 才能授权', async (t) => {
  const f = fixture(t);
  await f.post('/api/auth/request-access', { email: APPLICANT });
  const token = f.approvalToken();
  const form = await f.reviewForm(token);
  const pending = await f.post('/api/auth/send-code', { email: APPLICANT });
  assert.equal(pending.status, 403);
  assert.equal(f.mail.length, 1);
  const approved = await f.submitReview(form);
  assert.equal(approved.status, 200);
  const sent = await f.post('/api/auth/send-code', { email: APPLICANT });
  assert.equal(sent.status, 200);
  assert.match(JSON.stringify(f.mail.at(-1)?.to), /photographer@example\.com/);
});

test('审批确认需要匹配的 CSRF cookie 且拒绝跨站 POST', async (t) => {
  const f = fixture(t);
  await f.post('/api/auth/request-access', { email: APPLICANT });
  const form = await f.reviewForm(f.approvalToken());
  const noCookie = await f.request('/api/auth/review', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form.fields),
  });
  assert.equal(noCookie.status, 403);
  const crossSite = await f.request('/api/auth/review', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: form.cookie, origin: 'https://evil.example' },
    body: new URLSearchParams(form.fields),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await f.submitReview(form)).status, 200);
});

test('审批 CSRF 签名绑定当前 token 和 approve/reject 决定，不能修改表单替换', async (t) => {
  const f = fixture(t);
  await f.post('/api/auth/request-access', { email: APPLICANT });
  const form = await f.reviewForm(f.approvalToken());
  await f.post('/api/auth/request-access', { email: 'another@example.com' });
  const anotherToken = f.approvalToken();
  assert.equal((await f.submitReview(form, { decision: 'reject' })).status, 403);
  assert.equal((await f.submitReview(form, { token: anotherToken })).status, 403);
  assert.equal((await f.submitReview(form)).status, 200);
});

test('拒绝申请后无法获取登录码，重新申请产生的新链接会使旧链接失效', async (t) => {
  const f = fixture(t);
  await f.post('/api/auth/request-access', { email: APPLICANT });
  const oldToken = f.approvalToken();
  const oldApproveForm = await f.reviewForm(oldToken);
  const rejectForm = await f.reviewForm(oldToken, 'reject');
  assert.equal((await f.submitReview(rejectForm)).status, 200);
  const before = f.mail.length;
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 403);
  assert.equal(f.mail.length, before);
  f.advance(61 * 1000);
  assert.equal((await f.post('/api/auth/request-access', { email: APPLICANT })).status, 200);
  const newToken = f.approvalToken();
  assert.notEqual(newToken, oldToken);
  assert.equal((await f.request(`/api/auth/review?token=${oldToken}&decision=approve`)).status, 410);
  assert.equal((await f.submitReview(oldApproveForm)).status, 410);
  assert.equal((await f.submitReview(await f.reviewForm(newToken))).status, 200);
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 200);
});

test('重新申请使尚未审批的旧链接失效，旧确认页面也不能授权', async (t) => {
  const f = fixture(t);
  await f.post('/api/auth/request-access', { email: APPLICANT });
  const oldToken = f.approvalToken();
  const oldForm = await f.reviewForm(oldToken);
  f.advance(61 * 1000);
  assert.equal((await f.post('/api/auth/request-access', { email: APPLICANT })).status, 200);
  const newToken = f.approvalToken();
  assert.equal((await f.submitReview(oldForm)).status, 410);
  assert.equal((await f.request(`/api/auth/review?token=${oldToken}&decision=approve`)).status, 410);
  const before = f.mail.length;
  await f.post('/api/auth/send-code', { email: APPLICANT });
  assert.equal(f.mail.length, before);
  assert.equal((await f.submitReview(await f.reviewForm(newToken))).status, 200);
});

test('审批 token 过期后不能授权；已完成审批不能重放更改决定', async (t) => {
  const f = fixture(t);
  await f.post('/api/auth/request-access', { email: APPLICANT });
  const token = f.approvalToken();
  const form = await f.reviewForm(token);
  const rejectForm = await f.reviewForm(token, 'reject');
  assert.equal((await f.submitReview(form)).status, 200);
  const replay = await f.submitReview(form);
  assert.ok(replay.status >= 400);
  assert.ok((await f.submitReview(rejectForm)).status >= 400);
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 200);

  await f.post('/api/auth/request-access', { email: 'expired@example.com' });
  const expiredToken = f.approvalToken();
  const expiredForm = await f.reviewForm(expiredToken);
  f.database.sqlite.prepare('UPDATE auth_requests SET expires_at = ? WHERE email = ?')
    .run(Math.floor(Date.now() / 1000) - 1, 'expired@example.com');
  const expired = await f.submitReview(expiredForm);
  assert.ok(expired.status >= 400);
  const before = f.mail.length;
  const denied = await f.post('/api/auth/send-code', { email: 'expired@example.com' });
  assert.equal(denied.status, 403);
  assert.equal(f.mail.length, before);
});

test('并发审批只能作出一个决定，不能在同一 token 上反转结果', async (t) => {
  const f = fixture(t);
  await f.post('/api/auth/request-access', { email: APPLICANT });
  const token = f.approvalToken();
  const [approveForm, rejectForm] = await Promise.all([f.reviewForm(token), f.reviewForm(token, 'reject')]);
  const responses = await Promise.all([f.submitReview(approveForm), f.submitReview(rejectForm)]);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status >= 400).length, 1);
});

test('邮箱在申请和登录时统一规范化，验证码一次使用且 session cookie 安全', async (t) => {
  const f = fixture(t);
  await f.approve('  Photographer@EXAMPLE.com  ');
  assert.equal((await f.post('/api/auth/send-code', { email: 'PHOTOGRAPHER@example.COM' })).status, 200);
  const code = f.otp();
  const response = await f.post('/api/auth/verify-code', { email: APPLICANT, code });
  assert.equal(response.status, 200, await response.clone().text());
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /__Host-nanbei_session=/);
  assert.match(setCookie, /;\s*HttpOnly/i);
  assert.match(setCookie, /;\s*Secure/i);
  assert.match(setCookie, /;\s*SameSite=(?:Strict|Lax)/i);
  assert.match(setCookie, /;\s*Path=\//i);
  assert.doesNotMatch(setCookie, /;\s*Domain=/i);
  const session = await f.request('/api/auth/session', { headers: { cookie: cookieHeader(response) } });
  assert.equal((await session.json() as Payload).data?.user?.email, APPLICANT);
  assert.ok((await f.post('/api/auth/verify-code', { email: APPLICANT, code })).status >= 400);
});

test('并发提交同一验证码只有一个请求获得 session', async (t) => {
  const f = fixture(t);
  await f.approve();
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 200);
  const code = f.otp();
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.post('/api/auth/verify-code', { email: APPLICANT, code })));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.headers.get('set-cookie')?.includes('__Host-nanbei_session=')).length, 1);
});

test('并发索取验证码只投递一封，邮箱级限制阻止重复发送', async (t) => {
  const f = fixture(t);
  await f.approve();
  const previous = f.mail.length;
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.post('/api/auth/send-code', { email: APPLICANT })));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(f.mail.length, previous + 1);
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 429);
  assert.equal(f.mail.length, previous + 1);
});

test('错误验证码尝试次数受限，达到上限后正确验证码也不能使用', async (t) => {
  const f = fixture(t);
  await f.approve();
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 200);
  const code = f.otp();
  const wrong = code === '000000' ? '999999' : '000000';
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.ok((await f.post('/api/auth/verify-code', { email: APPLICANT, code: wrong })).status >= 400);
  }
  assert.ok((await f.post('/api/auth/verify-code', { email: APPLICANT, code })).status >= 400);
});

test('过期验证码和伪造 session 均无法登录', async (t) => {
  const f = fixture(t);
  await f.approve();
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 200);
  const code = f.otp();
  f.advance(60 * 60 * 1000);
  assert.ok((await f.post('/api/auth/verify-code', { email: APPLICANT, code })).status >= 400);
  const session = await f.request('/api/auth/session', { headers: { cookie: `__Host-nanbei_session=${'a'.repeat(64)}` } });
  assert.equal((await session.json() as Payload).data?.user, null);
});

test('退出会使服务器 session 失效，旧 cookie 无法重放', async (t) => {
  const f = fixture(t);
  const { cookie } = await f.login();
  assert.equal((await f.post('/api/auth/logout', {}, { cookie })).status, 200);
  const session = await f.request('/api/auth/session', { headers: { cookie } });
  assert.equal((await session.json() as Payload).data?.user, null);
  assert.equal((await f.request('/api/portfolios', { headers: { cookie } })).status, 401);
});

test('撤销邮箱权限会立即禁止现有 session 和新验证码登录', async (t) => {
  const f = fixture(t);
  const { cookie } = await f.login();
  f.database.sqlite.prepare("UPDATE auth_users SET status = 'rejected' WHERE email = ?").run(APPLICANT);
  const session = await f.request('/api/auth/session', { headers: { cookie } });
  assert.equal((await session.json() as Payload).data?.user, null);
  assert.equal((await f.request('/api/portfolios', { headers: { cookie } })).status, 401);
  f.advance(2 * 60 * 1000);
  const before = f.mail.length;
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 403);
  assert.equal(f.mail.length, before);
});

test('服务器校验 session 有效期，不能依靠重放 cookie 延长登录', async (t) => {
  const f = fixture(t);
  const { cookie } = await f.login();
  f.advance(31 * 24 * 60 * 60 * 1000);
  const session = await f.request('/api/auth/session', { headers: { cookie } });
  assert.equal((await session.json() as Payload).data?.user, null);
  assert.equal((await f.request('/api/portfolios', { headers: { cookie } })).status, 401);
});

test('所有认证写操作拒绝来自其他网站的请求', async (t) => {
  const f = fixture(t);
  for (const path of ['/api/auth/request-access', '/api/auth/send-code', '/api/auth/verify-code', '/api/auth/logout']) {
    const response = await f.post(path, { email: APPLICANT, code: '123456' }, { origin: 'https://evil.example' });
    assert.equal(response.status, 403, path);
  }
  assert.equal(f.mail.length, 0);
});

test('审批邮件投递失败后可以重试申请，不会留下永久待处理状态', async (t) => {
  const f = fixture(t);
  f.failMail(true);
  const failed = await f.post('/api/auth/request-access', { email: APPLICANT });
  assert.ok(failed.status >= 500);
  assert.equal(f.mail.length, 0);
  f.failMail(false);
  f.advance(2 * 60 * 1000);
  assert.equal((await f.post('/api/auth/request-access', { email: APPLICANT })).status, 200);
  assert.equal(f.mail.length, 1);
  assert.equal((await f.submitReview(await f.reviewForm(f.approvalToken()))).status, 200);
});

test('验证码邮件投递失败后可重试，失败邮件不会产生可用验证码', async (t) => {
  const f = fixture(t);
  await f.approve();
  const previousMailCount = f.mail.length;
  f.failMail(true);
  const failed = await f.post('/api/auth/send-code', { email: APPLICANT });
  assert.ok(failed.status >= 500);
  assert.equal(f.mail.length, previousMailCount);
  f.failMail(false);
  f.advance(2 * 60 * 1000);
  assert.equal((await f.post('/api/auth/send-code', { email: APPLICANT })).status, 200);
  const response = await f.post('/api/auth/verify-code', { email: APPLICANT, code: f.otp() });
  assert.equal(response.status, 200);
});
