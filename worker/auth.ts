import { AppError } from './wechat.ts';
import { AuthStore } from './auth-store.ts';

export interface AuthEnv {
  AUTH_DB: D1Database;
  EMAIL: SendEmail;
  ADMIN_EMAIL: string;
  EMAIL_FROM: string;
  APP_ORIGIN: string;
  AUTH_SECRET?: string;
}

const SESSION_COOKIE = '__Host-nanbei_session';
const REVIEW_COOKIE = '__Host-nanbei_review_csrf';
const WEEK = 7 * 86400;
const CODE_TTL = 600;
const TOKEN = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const ACCESS_MESSAGE = '申请已提交，请等待管理员审批。已获授权的邮箱可直接获取登录码。';
const CODE_MESSAGE = '登录码已发送到邮箱，10 分钟内有效。';

function accessRequired(): never {
  throw new AppError('ACCESS_REQUIRED', '该邮箱尚未获得授权，请先申请访问权限，待管理员批准后再登录。', 403);
}

function now(): number { return Math.floor(Date.now() / 1000); }

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set('content-type', 'application/json; charset=utf-8');
  result.set('cache-control', 'no-store');
  result.set('x-content-type-options', 'nosniff');
  result.set('referrer-policy', 'no-referrer');
  result.set('x-frame-options', 'DENY');
  result.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(JSON.stringify(data), { status, headers: result });
}

function success(data: unknown, headers?: HeadersInit): Response { return json({ ok: true, data }, 200, headers); }

function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new AppError('INVALID_EMAIL', '请填写有效邮箱', 400);
  const email = raw.trim().toLowerCase();
  // Deliberately accept a conservative ASCII mailbox syntax. Never merge dots or +aliases.
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (email.length > 254 || at < 1 || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new AppError('INVALID_EMAIL', '请填写有效邮箱', 400);
  }
  return email;
}

function configuredOrigin(env: AuthEnv): string {
  if (!env.AUTH_DB || !env.EMAIL || typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length < 32) {
    throw new AppError('AUTH_NOT_CONFIGURED', '登录服务尚未完成配置，请联系管理员', 503);
  }
  try {
    const url = new URL(env.APP_ORIGIN);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    normalizeEmail(env.ADMIN_EMAIL);
    normalizeEmail(env.EMAIL_FROM);
    return url.origin;
  } catch {
    throw new AppError('AUTH_NOT_CONFIGURED', '登录服务尚未完成配置，请联系管理员', 503);
  }
}

function assertOrigin(req: Request, origin: string): void {
  if (new URL(req.url).origin !== origin || req.headers.get('origin') !== origin
    || req.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AppError('BAD_ORIGIN', '不允许跨站请求', 403);
  }
}

async function boundedText(req: Request): Promise<string> {
  const declared = req.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw new AppError('BODY_TOO_LARGE', '请求内容过大', 413);
  if (!req.body) throw new AppError('INVALID_BODY', '请求内容无效', 400);
  const reader = req.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new AppError('BODY_TOO_LARGE', '请求内容过大', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new AppError('INVALID_BODY', '请求内容无效', 400); }
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new AppError('INVALID_BODY', '请使用 JSON 请求', 415);
  }
  const text = await boundedText(req);
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new AppError('INVALID_BODY', '请求内容无效', 400); }
}

function randomToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function hmac(env: AuthEnv, values: string[]): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(values)))));
}

async function verifyHmac(env: AuthEnv, signature: string, values: string[]): Promise<boolean> {
  if (!TOKEN.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (part) => parseInt(part, 16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(JSON.stringify(values)));
}

function secret(env: AuthEnv): string {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new AppError('AUTH_NOT_CONFIGURED', '登录服务尚未完成配置，请联系管理员', 503);
  return env.AUTH_SECRET;
}

function cookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') ?? '';
  if (raw.length > 8192) return null;
  const values = raw.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return TOKEN.test(value) ? value : null;
}

function setCookie(name: string, value: string, age: number): string {
  return `${name}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Strict`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function html(title: string, content: string, headers?: HeadersInit, status = 200): Response {
  const result = new Headers(headers);
  result.set('content-type', 'text/html; charset=utf-8');
  result.set('cache-control', 'no-store, max-age=0');
  result.set('referrer-policy', 'no-referrer');
  result.set('x-frame-options', 'DENY');
  result.set('x-content-type-options', 'nosniff');
  result.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f4f5f2;color:#20251f;font:16px/1.7 system-ui,sans-serif}main{max-width:480px;margin:12vh auto;padding:32px;background:white;border-radius:20px;overflow-wrap:anywhere}h1{font-size:24px}button,a{font:inherit}button{border:0;border-radius:9px;padding:12px 22px;background:#294b38;color:white;cursor:pointer}p{color:#596357}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`, { status, headers: result });
}

async function limitIp(req: Request, env: AuthEnv, store: AuthStore, scope: 'access' | 'otp' | 'verify' | 'review', time: number): Promise<void> {
  await store.prune(time);
  // CF-Connecting-IP is supplied by the edge. Do not trust client-controlled X-Forwarded-For.
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  const id = await hmac(env, ['ip', ip]);
  const shortPeriod = scope === 'access' ? 3600 : 600;
  const shortLimit = { access: 10, otp: 20, verify: 60, review: 60 }[scope];
  const dailyLimit = { access: 30, otp: 100, verify: 500, review: 500 }[scope];
  for (const [period, maximum] of [[shortPeriod, shortLimit], [86400, dailyLimit]]) {
    const window = Math.floor(time / period);
    if (!await store.takeLimit(`${scope}:${id}:${period}:${window}`, (window + 1) * period, maximum, time)) {
      throw new AppError('RATE_LIMITED', '操作过于频繁，请稍后再试', 429);
    }
  }
}

async function sendEmail(env: AuthEnv, to: string, subject: string, text: string, htmlBody: string): Promise<void> {
  try {
    await env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: '摄影工作室管理后台' }, to, subject, text, html: htmlBody });
  } catch {
    // Provider exceptions can contain addresses, message content, or credentials.
    throw new AppError('EMAIL_UNAVAILABLE', '邮件暂时发送失败，请稍后重试', 503);
  }
}

async function requestAccess(req: Request, env: AuthEnv, origin: string, store: AuthStore): Promise<Response> {
  const email = normalizeEmail((await body(req)).email);
  const time = now();
  await limitIp(req, env, store, 'access', time);
  if (email === normalizeEmail(env.ADMIN_EMAIL) || await store.approved(email)) return success({ message: ACCESS_MESSAGE });
  const token = randomToken();
  const hash = await sha256(token);
  if (!await store.reserveDispatch(email, 'access', hash, 3, time)) throw new AppError('RATE_LIMITED', '请在 60 秒后重试；每个邮箱每天最多申请 3 次', 429);
  const previous = await store.reserveRequest(email, hash, time + WEEK, time);
  if (!previous) {
    await store.finishDispatch(email, 'access', hash, true);
    return success({ message: ACCESS_MESSAGE });
  }
  const approve = `${origin}/api/auth/review?token=${token}&decision=approve`;
  const reject = `${origin}/api/auth/review?token=${token}&decision=reject`;
  try {
    await sendEmail(env, normalizeEmail(env.ADMIN_EMAIL), '摄影工作室：新的访问权限申请',
      `${email} 申请访问管理后台。\nApprove: ${approve}\nReject: ${reject}\n链接 7 天有效，打开后需要再次确认。请勿转发此邮件。`,
      `<h2>新的访问权限申请</h2><p><strong>${escapeHtml(email)}</strong> 申请访问管理后台。</p><p style="margin:28px 0"><a style="display:inline-block;padding:12px 22px;margin:0 12px 12px 0;border-radius:8px;background:#294b38;color:#fff;font-weight:bold;text-decoration:none" href="${escapeHtml(approve)}">Approve / 允许访问</a><a style="display:inline-block;padding:12px 22px;margin:0 0 12px;border-radius:8px;background:#9f3333;color:#fff;font-weight:bold;text-decoration:none" href="${escapeHtml(reject)}">Reject / 拒绝申请</a></p><p>链接 7 天有效，打开后需要再次确认。请勿转发此邮件。</p>`);
  } catch (error) {
    await store.cancelRequest(email, hash, previous, time);
    await store.finishDispatch(email, 'access', hash, true);
    throw error;
  }
  await store.finishRequest(email, hash, time);
  await store.finishDispatch(email, 'access', hash, false);
  return success({ message: ACCESS_MESSAGE });
}

async function sendCode(req: Request, env: AuthEnv, store: AuthStore): Promise<Response> {
  const email = normalizeEmail((await body(req)).email);
  const time = now();
  await limitIp(req, env, store, 'otp', time);
  if (email === normalizeEmail(env.ADMIN_EMAIL)) await store.ensureAdmin(email, time);
  if (!await store.approved(email)) accessRequired();
  const nonce = randomToken();
  if (!await store.reserveDispatch(email, 'otp', nonce, 10, time)) throw new AppError('RATE_LIMITED', '请在 60 秒后重试；每个邮箱每天最多发送 10 次登录码', 429);
  // Rejection sampling avoids modulo bias in a uniformly random six digit code.
  let random: number;
  do { random = crypto.getRandomValues(new Uint32Array(1))[0]; } while (random >= 4294000000);
  const code = String(random % 1000000).padStart(6, '0');
  const hash = await hmac(env, ['otp', email, nonce, code]);
  if (!await store.reserveCode(email, nonce, hash, time + CODE_TTL, time)) {
    await store.finishDispatch(email, 'otp', nonce, true);
    accessRequired();
  }
  try {
    await sendEmail(env, email, '摄影工作室：登录验证码',
      `你的登录码是 ${code}，10 分钟内有效，仅可使用一次。如非本人操作，请忽略。`,
      `<h2>登录验证码</h2><p style="font-size:32px;letter-spacing:8px"><strong>${code}</strong></p><p>10 分钟内有效，仅可使用一次。如非本人操作，请忽略。</p>`);
  } catch (error) {
    await store.finishCode(email, nonce, true);
    await store.finishDispatch(email, 'otp', nonce, true);
    throw error;
  }
  await store.finishCode(email, nonce, false);
  await store.finishDispatch(email, 'otp', nonce, false);
  return success({ message: CODE_MESSAGE });
}

async function verifyCode(req: Request, env: AuthEnv, store: AuthStore): Promise<Response> {
  const raw = await body(req);
  const email = normalizeEmail(raw.email);
  const time = now();
  await limitIp(req, env, store, 'verify', time);
  if (typeof raw.code !== 'string' || !/^\d{6}$/.test(raw.code)) throw new AppError('INVALID_CODE', '请输入 6 位登录码', 400);
  const challenge = await store.code(email, time);
  if (!challenge) throw new AppError('INVALID_CODE', '登录码无效或已过期，请重新获取', 401);
  const token = randomToken();
  const session = await sha256(token);
  const hash = await hmac(env, ['otp', email, challenge.nonce, raw.code]);
  if (!await store.consumeCode(email, challenge.nonce, hash, session, time + WEEK, time)) {
    throw new AppError('INVALID_CODE', '登录码无效或已过期，请重新获取', 401);
  }
  // Rotating a browser session also invalidates its previous token.
  const old = cookie(req, SESSION_COOKIE);
  if (old) await store.logout(await sha256(old));
  return success({ user: { email } }, { 'set-cookie': setCookie(SESSION_COOKIE, token, WEEK) });
}

async function review(req: Request, env: AuthEnv, origin: string, store: AuthStore): Promise<Response> {
  const time = now();
  await limitIp(req, env, store, 'review', time);
  let token: string | null;
  let decision: string | null;
  let csrf: string | null = null;
  if (req.method === 'GET') {
    const url = new URL(req.url);
    token = url.searchParams.get('token');
    decision = url.searchParams.get('decision');
  } else {
    if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
      throw new AppError('INVALID_BODY', '请求内容无效', 415);
    }
    const form = new URLSearchParams(await boundedText(req));
    token = form.get('token'); decision = form.get('decision'); csrf = form.get('csrf');
  }
  if (!token || !TOKEN.test(token) || (decision !== 'approve' && decision !== 'reject')) {
    throw new AppError('INVALID_REVIEW', '审批链接无效或已过期', 400);
  }
  const hash = await sha256(token);
  if (req.method === 'GET') {
    const request = await store.review(hash, time);
    if (!request) return html('审批链接不可用', '<p>该链接已过期、已处理，或已被新的申请替代。</p>', undefined, 410);
    const nonce = randomToken();
    const signature = await hmac(env, ['review', hash, decision, nonce]);
    const action = decision === 'approve' ? '允许访问' : '拒绝申请';
    return html(`确认${action}`, `<p>申请邮箱：<strong>${escapeHtml(request.email)}</strong></p><p>确认后将${action}，同一申请只能处理一次。</p><form method="post" action="${escapeHtml(origin)}/api/auth/review"><input type="hidden" name="token" value="${token}"><input type="hidden" name="decision" value="${decision}"><input type="hidden" name="csrf" value="${signature}"><button type="submit">确认${action}</button></form>`,
      { 'set-cookie': setCookie(REVIEW_COOKIE, nonce, 900) });
  }
  const nonce = cookie(req, REVIEW_COOKIE);
  if (!nonce || !csrf || !await verifyHmac(env, csrf, ['review', hash, decision, nonce])) {
    throw new AppError('INVALID_CSRF', '页面已失效，请重新打开邮件中的审批链接', 403);
  }
  const accepted = await store.decide(hash, decision === 'approve' ? 'approved' : 'rejected', randomToken(), time);
  if (!accepted) return html('审批链接不可用', '<p>该链接已过期、已处理，或已被新的申请替代。</p>', { 'set-cookie': setCookie(REVIEW_COOKIE, '', 0) }, 410);
  const title = decision === 'approve' ? '已允许访问' : '已拒绝申请';
  return html(title, `<p>${decision === 'approve' ? '申请人现在可以使用该邮箱获取登录码。' : '该邮箱未获得访问权限。'}</p><a href="${escapeHtml(origin)}/">返回管理后台</a>`,
    { 'set-cookie': setCookie(REVIEW_COOKIE, '', 0) });
}

export async function requireUser(req: Request, env: AuthEnv): Promise<{ email: string }> {
  const origin = configuredOrigin(env);
  if (new URL(req.url).origin !== origin) throw new AppError('BAD_ORIGIN', '请使用应用的正式访问地址', 403);
  if (!['GET', 'HEAD'].includes(req.method)) assertOrigin(req, origin);
  const token = cookie(req, SESSION_COOKIE);
  if (!token) throw new AppError('UNAUTHORIZED', '请先登录', 401);
  const user = await new AuthStore(env.AUTH_DB).session(await sha256(token), now());
  if (!user) throw new AppError('UNAUTHORIZED', '登录已过期或邮箱未获授权，请重新登录', 401);
  return user;
}

/** Returns null only for paths outside the auth namespace. */
export async function handleAuth(req: Request, env: AuthEnv): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/auth/')) return null;
  try {
    const origin = configuredOrigin(env);
    if (new URL(req.url).origin !== origin) throw new AppError('BAD_ORIGIN', '请使用应用的正式访问地址', 403);
    if (req.method !== 'GET') assertOrigin(req, origin);
    const store = new AuthStore(env.AUTH_DB);
    if (path === '/api/auth/session' && req.method === 'GET') {
      const token = cookie(req, SESSION_COOKIE);
      const user = token ? await store.session(await sha256(token), now()) : null;
      return success({ user });
    }
    if (path === '/api/auth/request-access' && req.method === 'POST') return await requestAccess(req, env, origin, store);
    if (path === '/api/auth/send-code' && req.method === 'POST') return await sendCode(req, env, store);
    if (path === '/api/auth/verify-code' && req.method === 'POST') return await verifyCode(req, env, store);
    if (path === '/api/auth/review' && (req.method === 'GET' || req.method === 'POST')) return await review(req, env, origin, store);
    if (path === '/api/auth/logout' && req.method === 'POST') {
      const token = cookie(req, SESSION_COOKIE);
      if (token) await store.logout(await sha256(token));
      return success({ message: '已退出登录' }, { 'set-cookie': setCookie(SESSION_COOKIE, '', 0) });
    }
    throw new AppError('NOT_FOUND', '接口不存在', 404);
  } catch (error) {
    if (error instanceof AppError) return json({ ok: false, code: error.code, message: error.message }, error.status);
    console.error('auth_unhandled');
    return json({ ok: false, code: 'AUTH_UNAVAILABLE', message: '登录服务暂不可用，请稍后重试' }, 503);
  }
}
