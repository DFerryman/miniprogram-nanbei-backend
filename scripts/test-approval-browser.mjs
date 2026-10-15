// Real Chromium regression: a native approval form must retain its same-origin
// Origin header while never disclosing its bearer token through Referer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.ts';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8'));
function prepare(sql, values = []) {
  return {
    bind(...args) { return prepare(sql, args); },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async run() {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  };
}
const database = {
  prepare,
  withSession() { return this; },
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      sqlite.exec('COMMIT');
      return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
const mail = [];
let origin;
let onSubmission;
const env = {
  AUTH_DB: database,
  EMAIL: { async send(message) { mail.push(message); return { messageId: 'browser-test' }; } },
  AUTH_SECRET: 'browser-regression-only-not-a-production-secret',
  ADMIN_EMAIL: 'owner@example.com',
  EMAIL_FROM: 'access@example.com',
};
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await worker.fetch(new Request(`${origin}${req.url}`, {
      method: req.method, headers: req.headers,
      ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
    }), { ...env, APP_ORIGIN: origin });
    res.statusCode = response.status;
    response.headers.forEach((value, name) => { if (name !== 'set-cookie') res.setHeader(name, value); });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
    if (req.method === 'POST' && req.url === '/api/auth/review') {
      onSubmission?.({ status: response.status, origin: req.headers.origin, referer: req.headers.referer });
    }
  } catch (error) { res.statusCode = 500; res.end('Browser test server error'); console.error(error); }
});
const profile = mkdtempSync(join(tmpdir(), 'nanbei-approval-browser-'));
let browser;
let socket;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${server.address().port}`;
  const applied = await fetch(`${origin}/api/auth/request-access`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'browser-test@example.com' }),
  });
  assert.equal(applied.status, 200);
  const token = /token=([a-f0-9]{64})/.exec(mail[0].text)[1];
  browser = spawn(process.env.CHROMIUM_PATH || '/usr/bin/chromium', [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chromium startup timed out')), 15000);
    browser.once('error', (error) => { clearTimeout(timeout); reject(error); });
    browser.stderr.on('data', (chunk) => {
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk));
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    }
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  await command('Page.enable', {}, sessionId);
  await command('Page.navigate', { url: `${origin}/api/auth/review?token=${token}&decision=approve` }, sessionId);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await command('Runtime.evaluate', { expression: 'Boolean(document.querySelector("form button"))', returnByValue: true }, sessionId);
    if (result.result.value) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'Approval form must load');
  const submitted = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Form submission timed out')), 10000);
    onSubmission = (value) => { clearTimeout(timeout); resolve(value); };
  });
  await command('Runtime.evaluate', { expression: 'document.querySelector("form button").click()' }, sessionId);
  const result = await submitted;
  console.log('Native approval form:', JSON.stringify(result));
  assert.equal(result.status, 200, 'A real browser must be able to confirm approval');
  assert.equal(result.origin, origin);
  assert.ok(!result.referer?.includes(token), 'Approval token must never appear in Referer');
  assert.equal(sqlite.prepare('SELECT status FROM auth_users WHERE email = ?').get('browser-test@example.com').status, 'approved');
  console.log('Browser approval regression passed');
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill('SIGKILL');
    await exited;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  sqlite.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
