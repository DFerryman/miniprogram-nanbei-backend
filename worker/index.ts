// Cloudflare Worker：静态页面由 assets 提供，/api/* 由这里处理。
// 云开发凭据仅从服务端绑定读取，所有业务接口均要求已授权的邮箱会话。
import * as N from '../shared/normalize.ts';
import type { CloudConfig } from '../shared/types.ts';
import * as Q from './query.ts';
import { AppError, WxCloud } from './wechat.ts';

import { handleAuth, requireUser } from './auth.ts';
import { CollabStore, LINGER_TTL, ONLINE_TTL, TRASH_GRACE, UPLOAD_GRACE, type EditState, type ViewKind } from './collab-store.ts';
import { parseConfig } from './config.ts';
export { parseConfig } from './config.ts';

export interface Env extends Omit<CloudflareBindings, 'ALLOW_INSECURE_LOCALHOST'> {
  WECHAT_APP_SECRET?: string;
  AUTH_SECRET?: string;
  /** 仅供本地 mock 联调，线上不要启用。 */
  ALLOW_INSECURE_LOCALHOST?: string;
}

const PORTFOLIOS = 'portfolios';
const SERIES = 'series';
const STUDIO = 'studio';
const STUDIO_ID = 'profile';
const COLLECTIONS = [PORTFOLIOS, SERIES, STUDIO, 'users', 'likes'];
const PAGE = 100;
const MAX_DOCS = 5000;

// 上传路径与小程序数据模型文档的建议目录一致
const UPLOAD_PATH = /^(portfolios|series|studio)\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_.-]{1,128}$/;

type Ctx = {
  cloud: WxCloud;
  req: Request;
  url: URL;
  params: string[];
  collab: CollabStore;
  user: { email: string; sessionHash: string };
  /** 发起请求的浏览器窗口，用于在修改记录中区分“本窗口”和同账号的其他窗口。 */
  tabId: string | null;
};
type Handler = (ctx: Ctx) => Promise<unknown>;

const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/;

function nowSec(): number { return Math.floor(Date.now() / 1000); }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    throw new AppError('BAD_JSON', '请求内容不是有效的 JSON', 400);
  }
}

function checkId(id: string | undefined, what = 'ID'): string {
  const v = decodeURIComponent(id || '');
  if (!N.ID_PATTERN.test(v)) throw new AppError('BAD_ID', `${what} 只能包含字母、数字、下划线和短横线，最长 64 位`, 400);
  return v;
}

/** 只允许操作当前环境内、指定目录下的文件，避免误删其他文件。 */
function ownFile(cfg: CloudConfig, fileId: string, dir?: string): boolean {
  if (!fileId.startsWith(`cloud://${cfg.envId}.`)) return false;
  const path = fileId.slice(fileId.indexOf('/', 'cloud://'.length) + 1);
  return dir ? path.startsWith(dir) : UPLOAD_PATH.test(path);
}

async function findAll(cloud: WxCloud, name: string, orderBy: Q.Order[], where?: Q.QueryValue, strict = false): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let skip = 0; skip < MAX_DOCS; skip += PAGE) {
    const { data } = await cloud.query(Q.find(name, { where, orderBy, skip, limit: PAGE }));
    out.push(...data);
    if (data.length < PAGE) return out;
  }
  // 文件引用扫描必须完整，否则可能误删仍在使用的文件
  if (strict) throw new AppError('TOO_MANY_DOCS', `${name} 集合超过 ${MAX_DOCS} 条，无法完整扫描`, 500);
  return out;
}

async function findOne(cloud: WxCloud, name: string, id: string): Promise<unknown | null> {
  const { data } = await cloud.query(Q.byId(name, id));
  return data[0] ?? null;
}

const SORT: Q.Order[] = [
  { field: 'weight', dir: 'desc' },
  { field: 'createdAt', dir: 'desc' },
];

// ---------- 并发保护 ----------
// 云数据库中的每个文档带 rev 版本号。写入以 where({_id, rev}) 为条件，并在同一条更新语句中把 rev 加 1，
// 单文档的条件更新是原子的：两个基于同一版本的保存只有一个能匹配到文档，另一个得到冲突。
// D1 中的在线状态、修改记录、文件回收列表与内容写入不在同一事务中，只作为提示与兜底。

const NOUN: Record<string, string> = { [PORTFOLIOS]: '作品', [SERIES]: '系列', [STUDIO]: '工作室信息' };

function expectedRev(raw: Record<string, unknown> | URLSearchParams): number {
  const value = raw instanceof URLSearchParams ? raw.get('rev') : raw.rev;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new AppError('REV_REQUIRED', '请求缺少版本号，页面可能是旧版本。请先复制未保存的内容，再刷新页面。', 428);
  }
  return n;
}

function conflict(name: string, current: unknown): AppError {
  return new AppError('CONFLICT', `${NOUN[name]}已被其他人或其他窗口修改，你的修改尚未保存。请查看最新内容并合并后再保存。`, 409, { current });
}

function gone(name: string): AppError {
  return new AppError('GONE', `${NOUN[name]}已被删除，你的修改尚未保存。`, 410);
}

/** 条件更新：只有版本号仍等于 rev 时才写入，并把版本号推进到 rev + 1。 */
async function casUpdate(cloud: WxCloud, name: string, id: string, rev: number, data: Record<string, Q.QueryValue>): Promise<boolean> {
  const { matched } = await cloud.update(Q.updateWhere(name, { _id: id, rev: Q.revIs(rev) }, { ...Q.replaceFields(data), rev: rev + 1 }));
  return matched === 1;
}

/** 条件写入失败后读取最新状态，给出“已删除”或“冲突（附最新文档）”。 */
async function staleError(cloud: WxCloud, name: string, id: string, normalize: (raw: unknown) => unknown): Promise<AppError> {
  const doc = await findOne(cloud, name, id);
  return doc ? conflict(name, normalize(doc)) : gone(name);
}

/** D1 中的辅助记录失败不应让已成功的内容写入报错。 */
async function safely(what: string, task: Promise<unknown>): Promise<void> {
  try {
    await task;
  } catch (err) {
    console.error(`collab_${what}_failed`, (err as Error).message);
  }
}

function record(ctx: Ctx, kind: string, id: string, action: 'create' | 'update' | 'delete', rev: number | null) {
  return safely('record', ctx.collab.recordChange({ kind, item_id: id, action, rev, email: ctx.user.email, tab_id: ctx.tabId, at: nowSec() }));
}

/**
 * 新引用的文件在写入前检查：先从回收列表取回（之后清理任务不会再删除它），再确认文件仍在云存储中。
 * 返回取回的文件，写入失败时需要放回回收列表。
 */
async function claimRefs(ctx: Ctx, next: Set<string>, before: Set<string>): Promise<string[]> {
  const own = [...next].filter((f) => !before.has(f) && f.startsWith(`cloud://${ctx.cloud.cfg.envId}.`));
  if (!own.length) return [];
  const { restored, blocked } = await ctx.collab.restore(own);
  try {
    const check = own.filter((f) => !blocked.includes(f));
    const urls = check.length ? await ctx.cloud.tempUrls(check) : {};
    const missing = [...blocked, ...check.filter((f) => !urls[f])];
    if (missing.length) {
      throw new AppError('MISSING_FILES', `有 ${missing.length} 个文件已从云存储删除（可能被其他人移除），不能保存对它们的引用。请移除这些媒体或重新上传后再保存。`, 409, { missing });
    }
  } catch (err) {
    await release(ctx, restored);
    throw err;
  }
  return restored;
}

/** 放回回收列表。即使文件其实已被成功写入的文档引用，清理任务在删除前也会扫描引用，不会误删。 */
function release(ctx: Ctx, files: string[]) {
  return safely('release', ctx.collab.trash(files, 'restore-failed', ctx.user.email, nowSec(), TRASH_GRACE));
}

async function requireSeries(cloud: WxCloud, seriesId: string | null) {
  if (seriesId && !(await findOne(cloud, SERIES, seriesId))) {
    throw new AppError('SERIES_MISSING', '所选系列已不存在（可能刚被删除），请重新选择系列后保存。', 409);
  }
}

/**
 * 写入后复查系列是否仍存在。删除系列时先删系列、再解除作品关联；保存作品时先写入、再复查。
 * 两边各自“先写后读”，因此不论先后，作品都不会指向已删除的系列。
 */
async function settleSeries(cloud: WxCloud, id: string, seriesId: string | null, rev: number) {
  if (!seriesId || (await findOne(cloud, SERIES, seriesId))) return;
  await cloud.update(Q.updateWhere(PORTFOLIOS, { _id: id, seriesId, rev }, { seriesId: null, rev: rev + 1, updatedAt: Q.date() }));
}

// ---------- 处理函数 ----------

async function verify({ cloud }: Ctx) {
  await cloud.token();
  const counts: Record<string, number | null> = {};
  const missing: string[] = [];
  for (const name of COLLECTIONS) {
    try {
      counts[name] = await cloud.count(Q.count(name));
    } catch (err) {
      if (err instanceof AppError && err.code === 'WX_-502005') {
        counts[name] = null;
        missing.push(name);
      } else {
        throw err;
      }
    }
  }
  return { envId: cloud.cfg.envId, counts, missing };
}

async function listPortfolios({ cloud }: Ctx) {
  const docs = await findAll(cloud, PORTFOLIOS, SORT);
  return { items: docs.map(N.portfolio) };
}

async function getPortfolio({ cloud, params }: Ctx) {
  const id = checkId(params[0]);
  const doc = await findOne(cloud, PORTFOLIOS, id);
  if (!doc) throw new AppError('NOT_FOUND', '作品不存在', 404);
  return { item: N.portfolio(doc) };
}

function portfolioData(input: ReturnType<typeof N.portfolioInput>): Record<string, Q.QueryValue> {
  return { ...input } as unknown as Record<string, Q.QueryValue>;
}

async function createPortfolio(ctx: Ctx) {
  const { cloud, req } = ctx;
  const raw = await body(req);
  const id = checkId(N.text(raw._id, 64), '作品 ID');
  const input = N.portfolioInput(raw);
  if (!input.title) throw new AppError('INVALID', '请填写作品标题', 400);
  const existing = await findOne(cloud, PORTFOLIOS, id);
  if (existing) throw new AppError('EXISTS', `作品 ID ${id} 已存在`, 409, { current: N.portfolio(existing) });
  await requireSeries(cloud, input.seriesId);
  const restored = await claimRefs(ctx, N.collectFileIds(input), new Set());
  const now = Q.date();
  try {
    await cloud.add(Q.add(PORTFOLIOS, {
      _id: id,
      ...portfolioData(input),
      rev: 1,
      stats: { likes: 0, favorites: 0, shares: 0 },
      createdAt: now,
      updatedAt: now,
    }));
  } catch (err) {
    await release(ctx, restored);
    // 两个窗口同时用同一 ID 新建：后到的一方因主键重复失败
    const raced = await findOne(cloud, PORTFOLIOS, id).catch(() => null);
    if (raced) throw new AppError('EXISTS', `作品 ID ${id} 已被其他人或其他窗口创建`, 409, { current: N.portfolio(raced) });
    throw err;
  }
  await settleSeries(cloud, id, input.seriesId, 1);
  await record(ctx, 'portfolio', id, 'create', 1);
  return { item: N.portfolio(await findOne(cloud, PORTFOLIOS, id)) };
}

async function updatePortfolio(ctx: Ctx) {
  const { cloud, req, url, params } = ctx;
  const id = checkId(params[0]);
  const raw = await body(req);
  const rev = expectedRev(raw);
  const input = N.portfolioInput(raw);
  if (!input.title) throw new AppError('INVALID', '请填写作品标题', 400);
  const before = await findOne(cloud, PORTFOLIOS, id);
  if (!before) throw gone(PORTFOLIOS);
  const current = N.portfolio(before);
  if (current.rev !== rev) throw conflict(PORTFOLIOS, current);
  if (input.seriesId !== current.seriesId) await requireSeries(cloud, input.seriesId);

  const beforeRefs = N.collectFileIds(before);
  const nextRefs = N.collectFileIds(input);
  const restored = await claimRefs(ctx, nextRefs, beforeRefs);
  let written = false;
  try {
    // stats 由小程序 user 云函数维护，这里不写入，避免覆盖并发产生的计数；rev 也不受计数更新影响
    written = await casUpdate(cloud, PORTFOLIOS, id, rev, { ...portfolioData(input), updatedAt: Q.date() });
  } finally {
    if (!written) await release(ctx, restored);
  }
  if (!written) throw await staleError(cloud, PORTFOLIOS, id, N.portfolio);
  await settleSeries(cloud, id, input.seriesId, rev + 1);

  // 版本号保证 before 就是这次写入覆盖的内容，因此“移除的文件”只包含本次保存有意移除的文件。
  // 文件先进入回收列表，宽限期后确认没有任何文档引用才会真正删除。
  let queued: string[] = [];
  if (url.searchParams.get('cleanup') === '1') {
    queued = [...beforeRefs].filter((f) => !nextRefs.has(f) && ownFile(cloud.cfg, f, `portfolios/${id}/`));
    await safely('trash', ctx.collab.trash(queued, `portfolio:${id}`, ctx.user.email, nowSec(), TRASH_GRACE));
  }
  await record(ctx, 'portfolio', id, 'update', rev + 1);
  return { item: N.portfolio(await findOne(cloud, PORTFOLIOS, id)), queued: queued.length };
}

async function deletePortfolio(ctx: Ctx) {
  const { cloud, url, params } = ctx;
  const id = checkId(params[0]);
  const rev = expectedRev(url.searchParams);
  const before = await findOne(cloud, PORTFOLIOS, id);
  if (!before) return { deleted: id, already: true, queued: 0 };
  const current = N.portfolio(before);
  // 删除也要基于最新版本：别人刚保存过的作品，需要确认后再删
  if (current.rev !== rev) throw conflict(PORTFOLIOS, current);
  const removed = await cloud.remove(Q.removeWhere(PORTFOLIOS, { _id: id, rev: Q.revIs(rev) }));
  if (removed !== 1) {
    const err = await staleError(cloud, PORTFOLIOS, id, N.portfolio);
    if (err.code === 'GONE') return { deleted: id, already: true, queued: 0 };
    throw err;
  }
  let queued: string[] = [];
  if (url.searchParams.get('files') === '1') {
    queued = [...N.collectFileIds(before)].filter((f) => ownFile(cloud.cfg, f, `portfolios/${id}/`));
    await safely('trash', ctx.collab.trash(queued, `portfolio-deleted:${id}`, ctx.user.email, nowSec(), TRASH_GRACE));
  }
  await record(ctx, 'portfolio', id, 'delete', null);
  return { deleted: id, queued: queued.length };
}

async function listSeries({ cloud }: Ctx) {
  const docs = await findAll(cloud, SERIES, SORT);
  return { items: docs.map(N.series) };
}

function seriesData(input: ReturnType<typeof N.seriesInput>): Record<string, Q.QueryValue> {
  return { ...input } as unknown as Record<string, Q.QueryValue>;
}

async function createSeries(ctx: Ctx) {
  const { cloud, req } = ctx;
  const raw = await body(req);
  const id = checkId(N.text(raw._id, 64), '系列 ID');
  const input = N.seriesInput(raw);
  if (!input.title) throw new AppError('INVALID', '请填写系列名称', 400);
  const existing = await findOne(cloud, SERIES, id);
  if (existing) throw new AppError('EXISTS', `系列 ID ${id} 已存在`, 409, { current: N.series(existing) });
  const restored = await claimRefs(ctx, N.collectFileIds(input), new Set());
  const now = Q.date();
  try {
    await cloud.add(Q.add(SERIES, { _id: id, ...seriesData(input), rev: 1, createdAt: now, updatedAt: now }));
  } catch (err) {
    await release(ctx, restored);
    const raced = await findOne(cloud, SERIES, id).catch(() => null);
    if (raced) throw new AppError('EXISTS', `系列 ID ${id} 已被其他人或其他窗口创建`, 409, { current: N.series(raced) });
    throw err;
  }
  await record(ctx, 'series', id, 'create', 1);
  return { item: N.series(await findOne(cloud, SERIES, id)) };
}

async function updateSeries(ctx: Ctx) {
  const { cloud, req, params } = ctx;
  const id = checkId(params[0]);
  const raw = await body(req);
  const rev = expectedRev(raw);
  const input = N.seriesInput(raw);
  if (!input.title) throw new AppError('INVALID', '请填写系列名称', 400);
  const before = await findOne(cloud, SERIES, id);
  if (!before) throw gone(SERIES);
  const current = N.series(before);
  if (current.rev !== rev) throw conflict(SERIES, current);
  const restored = await claimRefs(ctx, N.collectFileIds(input), N.collectFileIds(before));
  let written = false;
  try {
    written = await casUpdate(cloud, SERIES, id, rev, { ...seriesData(input), updatedAt: Q.date() });
  } finally {
    if (!written) await release(ctx, restored);
  }
  if (!written) throw await staleError(cloud, SERIES, id, N.series);
  await record(ctx, 'series', id, 'update', rev + 1);
  return { item: N.series(await findOne(cloud, SERIES, id)) };
}

async function deleteSeries(ctx: Ctx) {
  const { cloud, url, params } = ctx;
  const id = checkId(params[0]);
  const rev = expectedRev(url.searchParams);
  const before = await findOne(cloud, SERIES, id);
  let already = !before;
  if (before) {
    const current = N.series(before);
    if (current.rev !== rev) throw conflict(SERIES, current);
    const removed = await cloud.remove(Q.removeWhere(SERIES, { _id: id, rev: Q.revIs(rev) }));
    if (removed !== 1) {
      const err = await staleError(cloud, SERIES, id, N.series);
      if (err.code !== 'GONE') throw err;
      already = true;
    }
  }
  // 系列已不存在时也执行：上次删除后解除关联失败，重试即可补上。
  // 解除关联同时推进作品版本号，正在编辑这些作品的页面保存时会得到冲突，而不是悄悄写回旧系列。
  const { modified } = await cloud.update(Q.updateWhere(PORTFOLIOS, { seriesId: id }, { seriesId: null, rev: Q.inc(1), updatedAt: Q.date() }));
  if (!already) await record(ctx, 'series', id, 'delete', null);
  if (modified) await record(ctx, 'portfolio', '*', 'update', null);
  return { deleted: id, already, detached: modified };
}

async function getStudio({ cloud }: Ctx) {
  const doc = await findOne(cloud, STUDIO, STUDIO_ID);
  return { studio: doc ? N.studio(doc) : null };
}

async function saveStudio(ctx: Ctx) {
  const { cloud, req } = ctx;
  const raw = await body(req);
  const rev = expectedRev(raw);
  const input = N.studio(raw);
  if (!input.name) throw new AppError('INVALID', '请填写工作室名称', 400);
  const { updatedAt: _ignored, rev: _rev, ...rest } = input;
  // 小程序以字符串数组读取 intro，sections.body 支持换行分段的字符串
  const data = { ...(rest as unknown as Record<string, Q.QueryValue>), updatedAt: Q.date() };
  const before = await findOne(cloud, STUDIO, STUDIO_ID);
  const current = before ? N.studio(before) : null;
  if ((current?.rev ?? 0) !== rev || (!current && rev > 0)) {
    if (!current) throw gone(STUDIO);
    throw conflict(STUDIO, current);
  }
  const beforeRefs = N.collectFileIds(before);
  const nextRefs = N.collectFileIds(input);
  const restored = await claimRefs(ctx, nextRefs, beforeRefs);
  let written = false;
  try {
    if (before) {
      written = await casUpdate(cloud, STUDIO, STUDIO_ID, rev, data);
    } else {
      try {
        await cloud.add(Q.add(STUDIO, { _id: STUDIO_ID, ...data, rev: 1 }));
        written = true;
      } catch (err) {
        // 两个窗口同时首次保存：后到的一方主键重复
        if (!(await findOne(cloud, STUDIO, STUDIO_ID).catch(() => null))) throw err;
      }
    }
  } finally {
    if (!written) await release(ctx, restored);
  }
  if (!written) throw await staleError(cloud, STUDIO, STUDIO_ID, N.studio);
  // 以前由浏览器根据自己加载时的旧数据计算要删除的图片；现在由服务端基于被覆盖的版本计算，并延迟删除
  const queued = [...beforeRefs].filter((f) => !nextRefs.has(f) && ownFile(cloud.cfg, f, `${STUDIO}/`));
  await safely('trash', ctx.collab.trash(queued, 'studio', ctx.user.email, nowSec(), TRASH_GRACE));
  await record(ctx, 'studio', STUDIO_ID, before ? 'update' : 'create', rev + 1);
  return { studio: N.studio(await findOne(cloud, STUDIO, STUDIO_ID)), queued: queued.length };
}

async function tempUrls({ cloud, req }: Ctx) {
  const raw = await body(req);
  const ids = (Array.isArray(raw.fileIds) ? raw.fileIds : [])
    .filter((v): v is string => typeof v === 'string' && v.startsWith('cloud://'))
    .slice(0, 500);
  return { urls: await cloud.tempUrls([...new Set(ids)]) };
}

function checkPath(path: string): string {
  if (!UPLOAD_PATH.test(path)) throw new AppError('BAD_PATH', '上传路径不合法', 400);
  return path;
}

async function upload({ cloud, req }: Ctx) {
  const form = await req.formData();
  const file = form.get('file');
  const path = checkPath(String(form.get('path') || ''));
  if (!file || typeof file === 'string') throw new AppError('NO_FILE', '缺少文件', 400);
  return { fileId: await cloud.upload(path, file) };
}

async function uploadTicket({ cloud, req }: Ctx) {
  const raw = await body(req);
  return cloud.uploadTicket(checkPath(N.text(raw.path, 300)));
}

/** 浏览器丢弃的上传：不立即删除，进入回收列表，到期后确认无引用再删除。 */
async function deleteFiles(ctx: Ctx) {
  const raw = await body(ctx.req);
  const ids = [...new Set((Array.isArray(raw.fileIds) ? raw.fileIds : [])
    .filter((v): v is string => typeof v === 'string' && ownFile(ctx.cloud.cfg, v)))]
    .slice(0, 200);
  await ctx.collab.trash(ids, 'unsaved-upload', ctx.user.email, nowSec(), UPLOAD_GRACE);
  return { queued: ids.length };
}

// ---------- 在线状态 ----------

const VIEWS: ViewKind[] = ['list', 'portfolio', 'series', 'studio', 'setup'];
const STATES: EditState[] = ['viewing', 'editing', 'unsaved'];

function tabIdOf(value: unknown): string {
  const v = typeof value === 'string' ? value : '';
  if (!TAB_ID.test(v)) throw new AppError('BAD_TAB', '窗口标识无效', 400);
  return v;
}

/** 心跳：登记本窗口正在查看 / 编辑的内容，返回其他窗口的状态与最近的修改记录。 */
async function presence(ctx: Ctx) {
  const raw = await body(ctx.req);
  const tabId = tabIdOf(raw.tabId);
  const view = VIEWS.includes(raw.view as ViewKind) ? (raw.view as ViewKind) : 'list';
  const viewId = typeof raw.viewId === 'string' && N.ID_PATTERN.test(raw.viewId) ? raw.viewId : null;
  const state = STATES.includes(raw.state as EditState) ? (raw.state as EditState) : 'viewing';
  const now = nowSec();
  await ctx.collab.heartbeat(ctx.user.sessionHash, ctx.user.email, { tabId, view, viewId, state, visible: raw.visible !== false }, now);
  const [rows, logged] = await Promise.all([ctx.collab.presence(now), ctx.collab.loggedIn(now)]);
  const since = typeof raw.since === 'number' && Number.isInteger(raw.since) && raw.since >= 0 ? raw.since : null;
  const changes = since === null ? [] : await ctx.collab.changesSince(since);
  const cursor = changes.length ? changes[changes.length - 1].seq : since ?? await ctx.collab.lastSeq();
  const tabs = rows.map((r) => ({
    // 不返回会话或窗口标识，只说明与当前请求的关系
    self: r.tab_id === tabId,
    sameSession: r.session_hash === ctx.user.sessionHash,
    email: r.email,
    view: r.view_kind,
    viewId: r.view_id,
    state: r.state,
    visible: !!r.visible,
    online: now - r.seen_at <= ONLINE_TTL,
    seenAgo: now - r.seen_at,
    since: r.started_at,
  }));
  return {
    now,
    onlineTtl: ONLINE_TTL,
    lingerTtl: LINGER_TTL,
    tabs,
    accounts: logged.map((a) => ({
      email: a.email,
      sessions: a.sessions,
      onlineTabs: tabs.filter((t) => t.email === a.email && t.online).length,
    })),
    changes: changes.map((c) => ({
      seq: c.seq, kind: c.kind, id: c.item_id, action: c.action, rev: c.rev, email: c.email, at: c.at,
      self: c.tab_id === tabId,
    })),
    cursor,
  };
}

async function leave(ctx: Ctx) {
  const raw = await body(ctx.req);
  await ctx.collab.leave(ctx.user.sessionHash, tabIdOf(raw.tabId));
  return { left: true };
}

// ---------- 定时清理 ----------

/** 删除回收列表中到期、且经完整扫描确认没有任何文档引用的文件。 */
export async function purgeTrash(env: Env, now = nowSec()): Promise<{ deleted: number; kept: number; retry: number }> {
  const collab = new CollabStore(env.AUTH_DB);
  const claimed = await collab.claim(now);
  if (!claimed.length) return { deleted: 0, kept: 0, retry: 0 };
  let refs: Set<string>;
  let cloud: WxCloud;
  try {
    cloud = new WxCloud(parseConfig(env));
    refs = new Set<string>();
    // 认领发生在扫描之前：认领后任何保存都无法再引用这些文件（会被拒绝），所以扫描结果可靠
    for (const name of [PORTFOLIOS, SERIES, STUDIO]) {
      for (const doc of await findAll(cloud, name, [{ field: '_id', dir: 'asc' }], undefined, true)) N.collectFileIds(doc, refs);
    }
  } catch (err) {
    await collab.retry(claimed, now);
    throw err;
  }
  const keep = claimed.filter((f) => refs.has(f));
  const drop = claimed.filter((f) => !refs.has(f));
  await collab.forget(keep);
  const result = drop.length ? await cloud.deleteFiles(drop) : { deleted: [], failed: [] };
  await collab.forget(result.deleted);
  await collab.retry(result.failed.map((f) => f.fileId), now);
  return { deleted: result.deleted.length, kept: keep.length, retry: result.failed.length };
}

// ---------- 路由 ----------

const routes: [string, RegExp, Handler, boolean?][] = [
  ['POST', /^\/api\/verify$/, verify],
  ['GET', /^\/api\/portfolios$/, listPortfolios],
  ['POST', /^\/api\/portfolios$/, createPortfolio],
  ['GET', /^\/api\/portfolios\/([^/]+)$/, getPortfolio],
  ['PUT', /^\/api\/portfolios\/([^/]+)$/, updatePortfolio],
  ['DELETE', /^\/api\/portfolios\/([^/]+)$/, deletePortfolio],
  ['GET', /^\/api\/series$/, listSeries],
  ['POST', /^\/api\/series$/, createSeries],
  ['PUT', /^\/api\/series\/([^/]+)$/, updateSeries],
  ['DELETE', /^\/api\/series\/([^/]+)$/, deleteSeries],
  ['GET', /^\/api\/studio$/, getStudio],
  ['PUT', /^\/api\/studio$/, saveStudio],
  ['POST', /^\/api\/files\/urls$/, tempUrls],
  ['POST', /^\/api\/files\/upload$/, upload],
  ['POST', /^\/api\/files\/ticket$/, uploadTicket],
  ['POST', /^\/api\/files\/delete$/, deleteFiles],
  // 在线状态不依赖云开发配置
  ['POST', /^\/api\/presence$/, presence, true],
  ['POST', /^\/api\/presence\/leave$/, leave, true],
];

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/api/meta' && req.method === 'GET') return json({ ok: true, data: { authRequired: true } });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // 防止其他网站借用已登录浏览器发起写操作。
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) throw new AppError('BAD_ORIGIN', '不允许跨站请求', 403);
  }
  const authResponse = await handleAuth(req, env);
  if (authResponse) return authResponse;
  const user = await requireUser(req, env);
  const tab = req.headers.get('x-tab-id');

  for (const [method, pattern, handler, local] of routes) {
    if (method !== req.method) continue;
    const m = url.pathname.match(pattern);
    if (!m) continue;
    const cloud = local ? (null as unknown as WxCloud) : new WxCloud(parseConfig(env));
    const ctx: Ctx = { cloud, req, url, params: m.slice(1), collab: new CollabStore(env.AUTH_DB), user, tabId: tab && TAB_ID.test(tab) ? tab : null };
    return json({ ok: true, data: await handler(ctx) });
  }
  throw new AppError('NOT_FOUND', '接口不存在', 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env);
    } catch (err) {
      if (err instanceof AppError) {
        return json({ ok: false, code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) }, err.status);
      }
      console.error('unhandled', err);
      return json({ ok: false, code: 'INTERNAL', message: '服务器错误，请稍后重试' }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgeTrash(env).then((r) => console.log('trash_purge', JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
