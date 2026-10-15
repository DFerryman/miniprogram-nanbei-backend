// 多人编辑的并发与故障场景：真实 Worker 代码 + 模拟微信云数据库（按真实语法执行语句）+ SQLite 版 D1。
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
// @ts-expect-error 纯 JS 的本地模拟服务，没有类型声明
import { startMock } from '../scripts/mock-wechat.mjs';
import worker, { purgeTrash, type Env } from './index.ts';
import { SqliteD1 } from './test-d1.ts';

const ORIGIN = 'https://admin.example.com';
const ENV_ID = 'cloud1-test';
const BUCKET = `cloud://${ENV_ID}.6d6f-mock-bucket`;

interface Mock {
  base: string;
  store: Record<string, Map<string, Record<string, unknown>>>;
  files: Map<string, unknown>;
  pause: (path: string) => { readonly waiting: number; release: () => void };
  close: () => Promise<void>;
}

type Body = { ok: boolean; code?: string; message?: string; data?: any };

let mock: Mock;
let db: SqliteD1;
let env: Env;
let clock = 1_800_000_000;

before(async () => { mock = await startMock({ silent: true }); });
after(async () => { await mock.close(); });

beforeEach(() => {
  for (const col of Object.values(mock.store)) col.clear();
  mock.files.clear();
  db = new SqliteD1();
  clock = 1_800_000_000;
  env = {
    AUTH_DB: db,
    AUTH_SECRET: 'test-auth-secret-at-least-thirty-two-characters',
    ADMIN_EMAIL: 'owner@example.com',
    EMAIL_FROM: 'access@example.com',
    APP_ORIGIN: ORIGIN,
    EMAIL: { async send() { return { messageId: 'x' }; } },
    WECHAT_APP_ID: 'wx7f54ff074d26489f',
    WECHAT_APP_SECRET: '0123456789abcdef0123456789abcdef',
    CLOUDBASE_ENV_ID: ENV_ID,
    WECHAT_API_BASE: mock.base,
    ALLOWED_API_HOSTS: '127.0.0.1',
    ALLOW_INSECURE_LOCALHOST: '1',
  } as unknown as Env;
});

function now() { return clock; }

/** 直接在 D1 中建立已批准邮箱的会话，省去邮件登录流程（登录流程由 auth.test.ts 覆盖）。 */
function session(email: string, token = randomBytes(32).toString('hex')) {
  const hash = createHash('sha256').update(token).digest('hex');
  db.sqlite.prepare(`INSERT INTO auth_users (email, status, created_at, updated_at) VALUES (?, 'approved', 0, 0)
    ON CONFLICT(email) DO NOTHING`).run(email);
  db.sqlite.prepare('INSERT INTO auth_sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, 0, ?)').run(hash, email, now() + 30 * 86400);
  return { email, token, hash };
}

type Who = ReturnType<typeof session> & { tab?: string };

async function call(who: Who, method: string, path: string, data?: unknown): Promise<{ status: number; body: Body }> {
  const headers = new Headers({ cookie: `__Host-nanbei_session=${who.token}` });
  if (who.tab) headers.set('x-tab-id', who.tab);
  if (method !== 'GET') headers.set('origin', ORIGIN);
  if (data !== undefined) headers.set('content-type', 'application/json');
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }), env);
  return { status: res.status, body: await res.json() as Body };
}

function file(path: string) {
  mock.files.set(path, { data: Buffer.from('x'), type: 'image/jpeg' });
  return `${BUCKET}/${path}`;
}

function seedPortfolio(id: string, extra: Record<string, unknown> = {}) {
  mock.store.portfolios.set(id, {
    _id: id, title: '原标题', seriesId: null, location: '', shootDate: '', description: '', tags: [], cover: null,
    media: [], weight: 0, status: 'published', stats: { likes: 7, favorites: 3, shares: 1 },
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...extra,
  });
}

function image(src: string) {
  return { type: 'image', src, width: 100, height: 100 };
}

function input(p: Record<string, any>, patch: Record<string, unknown> = {}) {
  const { _id, stats, createdAt, updatedAt, ...rest } = p;
  return { ...rest, ...patch };
}

function trashRows() {
  return db.sqlite.prepare('SELECT file_id, state FROM file_trash ORDER BY file_id').all().map((r) => ({ ...r })) as { file_id: string; state: string }[];
}

test('旧数据没有版本号：第一次保存成功，基于旧版本的第二次保存被拒绝，并返回最新内容；互动计数不被覆盖', async (t) => {
  t.mock.method(Date, 'now', () => now() * 1000);
  seedPortfolio('p1');
  const a = session('a@example.com');
  const b = session('b@example.com');
  const loadedA = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  const loadedB = (await call(b, 'GET', '/api/portfolios/p1')).body.data.item;
  assert.equal(loadedA.rev, 0);

  const saved = await call(a, 'PUT', '/api/portfolios/p1', input(loadedA, { title: 'A 的标题' }));
  assert.equal(saved.status, 200, saved.body.message);
  assert.equal(saved.body.data.item.rev, 1);

  const stale = await call(b, 'PUT', '/api/portfolios/p1', input(loadedB, { location: 'B 的地点' }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONFLICT');
  assert.equal(stale.body.data.current.title, 'A 的标题');
  assert.equal(stale.body.data.current.rev, 1);

  const doc = mock.store.portfolios.get('p1')!;
  assert.equal(doc.title, 'A 的标题');
  assert.equal(doc.location, '');
  assert.deepEqual(doc.stats, { likes: 7, favorites: 3, shares: 1 });

  // 合并后基于最新版本再保存
  const merged = await call(b, 'PUT', '/api/portfolios/p1', input(stale.body.data.current, { location: 'B 的地点' }));
  assert.equal(merged.status, 200);
  assert.equal(mock.store.portfolios.get('p1')!.title, 'A 的标题');
  assert.equal(mock.store.portfolios.get('p1')!.location, 'B 的地点');
});

test('同时保存：两个请求都通过了预检查，云数据库的条件更新只让其中一个成功', async () => {
  seedPortfolio('p1', { rev: 4 });
  const a = session('a@example.com');
  const b = session('shared@example.com');
  const base = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  const gate = mock.pause('/tcb/databaseupdate');
  const pending = [
    call(a, 'PUT', '/api/portfolios/p1', input(base, { title: '甲' })),
    call(b, 'PUT', '/api/portfolios/p1', input(base, { title: '乙' })),
  ];
  while (gate.waiting < 2) await new Promise((r) => setTimeout(r, 5));
  gate.release();
  const results = await Promise.all(pending);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = results.find((r) => r.status === 200)!.body.data.item.title;
  const loser = results.find((r) => r.status === 409)!.body;
  assert.equal(loser.code, 'CONFLICT');
  assert.equal(loser.data.current.title, winner);
  assert.equal(mock.store.portfolios.get('p1')!.rev, 5);
});

test('缺少版本号的旧页面请求被拒绝，不会整篇覆盖', async () => {
  seedPortfolio('p1', { rev: 2 });
  const a = session('a@example.com');
  const { rev: _rev, ...noRev } = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  const res = await call(a, 'PUT', '/api/portfolios/p1', input(noRev, { title: 'x' }));
  assert.equal(res.status, 428);
  assert.equal(res.body.code, 'REV_REQUIRED');
  const del = await call(a, 'DELETE', '/api/portfolios/p1');
  assert.equal(del.status, 428);
  assert.equal(mock.store.portfolios.get('p1')!.title, '原标题');
});

test('编辑期间作品被删除：保存返回 410；删除基于旧版本时需要确认；重复删除是幂等的', async () => {
  seedPortfolio('p1', { rev: 1 });
  const a = session('a@example.com');
  const b = session('b@example.com');
  const loaded = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  const edited = await call(b, 'PUT', '/api/portfolios/p1', input(loaded, { title: 'B 改过' }));
  assert.equal(edited.status, 200);

  const staleDelete = await call(a, 'DELETE', '/api/portfolios/p1?rev=1');
  assert.equal(staleDelete.status, 409);
  assert.ok(mock.store.portfolios.has('p1'));

  const del = await call(a, 'DELETE', '/api/portfolios/p1?rev=2');
  assert.equal(del.status, 200);
  const again = await call(a, 'DELETE', '/api/portfolios/p1?rev=2');
  assert.equal(again.status, 200);
  assert.equal(again.body.data.already, true);

  const save = await call(b, 'PUT', '/api/portfolios/p1', input(edited.body.data.item, { title: '还在编辑' }));
  assert.equal(save.status, 410);
  assert.equal(save.body.code, 'GONE');
  assert.ok(!mock.store.portfolios.has('p1'), '保存不能把已删除的作品写回来');
});

test('同时新建同一 ID：只有一个成功，另一个得到 EXISTS 和已存在的内容', async () => {
  const a = session('a@example.com');
  const gate = mock.pause('/tcb/databaseadd');
  const body = { _id: 'p_new', title: '新作品', media: [], status: 'draft' };
  const pending = [call(a, 'POST', '/api/portfolios', body), call(a, 'POST', '/api/portfolios', { ...body, title: '另一个' })];
  while (gate.waiting < 2) await new Promise((r) => setTimeout(r, 5));
  gate.release();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(results.find((r) => r.status === 409)!.body.code, 'EXISTS');
  assert.equal(mock.store.portfolios.get('p_new')!.rev, 1);
});

test('媒体：移除的图片先进入回收列表；旧页面合并后重新引用可取回，清理任务不会删除仍被引用的文件', async (t) => {
  t.mock.method(Date, 'now', () => now() * 1000);
  const x = file('portfolios/p1/x.jpg');
  const y = file('portfolios/p1/y.jpg');
  seedPortfolio('p1', { rev: 1, media: [image(x), image(y)] });
  const a = session('a@example.com');
  const b = session('b@example.com');
  const loadedB = (await call(b, 'GET', '/api/portfolios/p1')).body.data.item;
  const loadedA = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;

  // A 移除 x 并勾选清理
  const removed = await call(a, 'PUT', '/api/portfolios/p1?cleanup=1', input(loadedA, { media: [image(y)] }));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.queued, 1);
  assert.ok(mock.files.has('portfolios/p1/x.jpg'), '文件不会立即删除');
  assert.deepEqual(trashRows(), [{ file_id: x, state: 'pending' }]);

  // B 的旧表单仍包含 x，并且移除了 y：旧版本保存被拒绝，y 不会因此被清理
  const stale = await call(b, 'PUT', '/api/portfolios/p1?cleanup=1', input(loadedB, { media: [image(x)] }));
  assert.equal(stale.status, 409);
  assert.equal(trashRows().length, 1);

  // B 合并后决定保留 x：x 从回收列表中取回
  const merged = await call(b, 'PUT', '/api/portfolios/p1?cleanup=1', input(stale.body.data.current, { media: [image(y), image(x)] }));
  assert.equal(merged.status, 200, merged.body.message);
  assert.deepEqual(trashRows(), []);

  clock += 2 * 86400;
  const purged = await purgeTrash(env, now());
  assert.deepEqual(purged, { deleted: 0, kept: 0, retry: 0 });
  assert.ok(mock.files.has('portfolios/p1/x.jpg'));
});

test('媒体：宽限期后文件被删除；之后保存引用它的旧表单会被拒绝，而不是留下失效图片', async (t) => {
  t.mock.method(Date, 'now', () => now() * 1000);
  const x = file('portfolios/p1/x.jpg');
  seedPortfolio('p1', { rev: 1, media: [image(x)] });
  const a = session('a@example.com');
  const loaded = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  await call(a, 'PUT', '/api/portfolios/p1?cleanup=1', input(loaded, { media: [] }));
  clock += 86400 + 1;
  assert.deepEqual(await purgeTrash(env, now()), { deleted: 1, kept: 0, retry: 0 });
  assert.ok(!mock.files.has('portfolios/p1/x.jpg'));

  const current = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  const res = await call(a, 'PUT', '/api/portfolios/p1', input(current, { media: [image(x)] }));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'MISSING_FILES');
  assert.deepEqual(res.body.data.missing, [x]);
  assert.deepEqual(mock.store.portfolios.get('p1')!.media, []);
});

test('媒体：清理任务认领文件之后，保存引用该文件会被拒绝；认领前保存则取回文件', async (t) => {
  t.mock.method(Date, 'now', () => now() * 1000);
  const x = file('portfolios/p1/x.jpg');
  seedPortfolio('p1', { rev: 1, media: [image(x)] });
  seedPortfolio('p2', { rev: 1 });
  const a = session('a@example.com');
  const loaded = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  await call(a, 'PUT', '/api/portfolios/p1?cleanup=1', input(loaded, { media: [] }));
  clock += 86400 + 1;

  // 清理任务认领后、扫描引用期间，有人保存了引用 x 的内容
  const gate = mock.pause('/tcb/databasequery');
  const purge = purgeTrash(env, now());
  while (gate.waiting < 1) await new Promise((r) => setTimeout(r, 5));
  const p2 = mock.store.portfolios.get('p2')!;
  const blocked = call(a, 'PUT', '/api/portfolios/p2', input({ ...p2, rev: 1 }, { media: [image(x)] }));
  // 保存请求自己的查询也会被暂停；先放行全部查询
  gate.release();
  const res = await blocked;
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'MISSING_FILES');
  await purge;
  assert.deepEqual(mock.store.portfolios.get('p2')!.media, []);
});

test('媒体：另一个文档仍引用的文件不会被删除', async (t) => {
  t.mock.method(Date, 'now', () => now() * 1000);
  const x = file('portfolios/p1/x.jpg');
  seedPortfolio('p1', { rev: 1, media: [image(x)] });
  mock.store.series.set('s1', { _id: 's1', title: '系列', cover: { src: x, width: 1, height: 1 }, rev: 1 });
  const a = session('a@example.com');
  const loaded = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  await call(a, 'DELETE', `/api/portfolios/p1?rev=${loaded.rev}&files=1`);
  clock += 86400 + 1;
  assert.deepEqual(await purgeTrash(env, now()), { deleted: 0, kept: 1, retry: 0 });
  assert.ok(mock.files.has('portfolios/p1/x.jpg'));
  assert.deepEqual(trashRows(), []);
});

test('浏览器丢弃的上传只进入回收列表，一小时后无引用才删除', async (t) => {
  t.mock.method(Date, 'now', () => now() * 1000);
  const u = file('portfolios/p9/u.jpg');
  const a = session('a@example.com');
  const res = await call(a, 'POST', '/api/files/delete', { fileIds: [u, 'cloud://other-env.x/portfolios/p9/u.jpg'] });
  assert.deepEqual(res.body.data, { queued: 1 });
  assert.ok(mock.files.has('portfolios/p9/u.jpg'));
  clock += 1800;
  assert.equal((await purgeTrash(env, now())).deleted, 0);
  clock += 1801;
  assert.equal((await purgeTrash(env, now())).deleted, 1);
  assert.ok(!mock.files.has('portfolios/p9/u.jpg'));
});

test('删除系列：解除作品关联并推进作品版本号，正在编辑这些作品的页面保存时得到冲突', async () => {
  mock.store.series.set('s1', { _id: 's1', title: '山野', rev: 2 });
  seedPortfolio('p1', { seriesId: 's1' }); // 旧数据，无版本号
  seedPortfolio('p2', { seriesId: 's1', rev: 3 });
  const a = session('a@example.com');
  const b = session('b@example.com');
  const editing = (await call(b, 'GET', '/api/portfolios/p2')).body.data.item;

  assert.equal((await call(a, 'DELETE', '/api/series/s1?rev=1')).status, 409, '系列刚被修改过时删除需要确认');
  const del = await call(a, 'DELETE', '/api/series/s1?rev=2');
  assert.equal(del.status, 200);
  assert.equal(del.body.data.detached, 2);
  assert.equal(mock.store.portfolios.get('p1')!.seriesId, null);
  assert.equal(mock.store.portfolios.get('p1')!.rev, 1);
  assert.equal(mock.store.portfolios.get('p2')!.rev, 4);

  const stale = await call(b, 'PUT', '/api/portfolios/p2', input(editing, { title: 'B' }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.data.current.seriesId, null);

  const pick = await call(b, 'PUT', '/api/portfolios/p2', input(stale.body.data.current, { seriesId: 's1' }));
  assert.equal(pick.status, 409);
  assert.equal(pick.body.code, 'SERIES_MISSING');
});

test('保存作品与删除系列交错：写入后复查，作品不会指向已删除的系列', async () => {
  mock.store.series.set('s1', { _id: 's1', title: '山野', rev: 1 });
  seedPortfolio('p1', { rev: 1 });
  const a = session('a@example.com');
  const loaded = (await call(a, 'GET', '/api/portfolios/p1')).body.data.item;
  const gate = mock.pause('/tcb/databaseupdate');
  const saving = call(a, 'PUT', '/api/portfolios/p1', input(loaded, { seriesId: 's1' }));
  while (gate.waiting < 1) await new Promise((r) => setTimeout(r, 5));
  // 系列检查已通过、写入尚未执行时，系列被删除（此时没有作品属于它，解除关联无事可做）
  mock.store.series.delete('s1');
  gate.release();
  const res = await saving;
  assert.equal(res.status, 200);
  assert.equal(res.body.data.item.seriesId, null);
  assert.equal(mock.store.portfolios.get('p1')!.seriesId, null);
});

test('系列修改与关于我们同样受版本保护；首次同时创建“关于我们”只有一个成功', async (t) => {
  t.mock.method(Date, 'now', () => now() * 1000);
  mock.store.series.set('s1', { _id: 's1', title: '山野', rev: 1 });
  const a = session('a@example.com');
  const s = { title: '山野', description: '', cover: null, weight: 0, status: 'published' };
  assert.equal((await call(a, 'PUT', '/api/series/s1', { ...s, title: '山', rev: 1 })).status, 200);
  const stale = await call(a, 'PUT', '/api/series/s1', { ...s, title: '野', rev: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.data.current.title, '山');

  const gate = mock.pause('/tcb/databaseadd');
  const pending = [
    call(a, 'PUT', '/api/studio', { name: '甲', rev: 0 }),
    call(a, 'PUT', '/api/studio', { name: '乙', rev: 0 }),
  ];
  while (gate.waiting < 2) await new Promise((r) => setTimeout(r, 5));
  gate.release();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);

  // 更换封面：旧图进入回收列表，不由浏览器直接删除
  const old = file('studio/profile/old.jpg');
  const fresh = file('studio/profile/new.jpg');
  const current = (await call(a, 'GET', '/api/studio')).body.data.studio;
  assert.equal((await call(a, 'PUT', '/api/studio', { ...current, cover: { src: old, width: 1, height: 1 } })).status, 200);
  const next = (await call(a, 'GET', '/api/studio')).body.data.studio;
  const replaced = await call(a, 'PUT', '/api/studio', { ...next, cover: { src: fresh, width: 1, height: 1 } });
  assert.equal(replaced.body.data.queued, 1);
  assert.deepEqual(trashRows(), [{ file_id: old, state: 'pending' }]);
  const stale2 = await call(a, 'PUT', '/api/studio', { ...current, name: '旧页面' });
  assert.equal(stale2.status, 409);
});

test('在线状态：区分本窗口、同账号其他窗口与其他账号；断线、退出与会话过期后消失；修改记录可被其他窗口看到', async (t) => {
  t.mock.method(Date, 'now', () => now() * 1000);
  const a1: Who = { ...session('a@example.com'), tab: 'tab_a1_xxxxxxxx' };
  const a2: Who = { ...session('a@example.com'), tab: 'tab_a2_xxxxxxxx' };
  const b: Who = { ...session('b@example.com'), tab: 'tab_b_xxxxxxxxx' };
  const idle = session('idle@example.com'); // 只是登录了，没有打开页面

  const beat = (who: Who, extra: Record<string, unknown> = {}) =>
    call(who, 'POST', '/api/presence', { tabId: who.tab, view: 'portfolio', viewId: 'p1', state: 'viewing', visible: true, ...extra });

  const first = await beat(a1, { since: null });
  const cursor = first.body.data.cursor;
  await beat(a2, { state: 'unsaved', visible: false });
  await beat(b, { state: 'editing' });
  const view = (await beat(a1)).body.data;
  const self = view.tabs.find((x: any) => x.self);
  assert.equal(self.email, 'a@example.com');
  const sibling = view.tabs.find((x: any) => !x.self && x.email === 'a@example.com');
  assert.equal(sibling.sameSession, false, '同账号的另一个登录会话不能被当成本窗口');
  assert.equal(sibling.state, 'unsaved');
  assert.equal(sibling.visible, false);
  assert.ok(!('tabId' in sibling) && !('session_hash' in sibling));
  assert.equal(view.tabs.find((x: any) => x.email === 'b@example.com').state, 'editing');
  const accounts = Object.fromEntries(view.accounts.map((x: any) => [x.email, x]));
  assert.equal(accounts['a@example.com'].onlineTabs, 2);
  assert.equal(accounts['idle@example.com'].onlineTabs, 0);
  assert.equal(accounts['idle@example.com'].sessions, 1);
  assert.ok(idle);

  // 其他会话不能用相同 tabId 覆盖别人的状态
  await call({ ...b, tab: a1.tab }, 'POST', '/api/presence', { tabId: a1.tab, view: 'studio', state: 'viewing' });
  assert.equal(db.sqlite.prepare('SELECT view_kind FROM collab_presence WHERE tab_id = ?').get(a1.tab!)!.view_kind, 'portfolio');

  // 修改记录：b 保存后，a1 在下一次心跳中看到
  seedPortfolio('p1', { rev: 1 });
  const loaded = (await call(b, 'GET', '/api/portfolios/p1')).body.data.item;
  await call(b, 'PUT', '/api/portfolios/p1', input(loaded, { title: 'b 改' }));
  const changes = (await beat(a1, { since: cursor })).body.data.changes;
  assert.deepEqual(changes.map((c: any) => [c.kind, c.id, c.action, c.rev, c.email, c.self]), [['portfolio', 'p1', 'update', 2, 'b@example.com', false]]);

  // 断线：超过在线时限后标为离线，再过一段时间从列表中消失
  clock += 90;
  await beat(a1);
  let tabs = (await beat(a1)).body.data.tabs;
  assert.equal(tabs.find((x: any) => x.email === 'b@example.com').online, false);
  clock += 120;
  tabs = (await beat(a1)).body.data.tabs;
  assert.deepEqual(tabs.map((x: any) => x.email), ['a@example.com']);

  // 主动离开与会话失效
  await beat(a2);
  await call(a2, 'POST', '/api/presence/leave', { tabId: a2.tab });
  db.sqlite.prepare('UPDATE auth_sessions SET expires_at = 0 WHERE token_hash = ?').run(b.hash);
  tabs = (await beat(a1)).body.data.tabs;
  assert.equal(tabs.length, 1);
  assert.equal((await beat(b)).status, 401);
});
