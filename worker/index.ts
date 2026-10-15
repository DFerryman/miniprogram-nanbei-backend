// Cloudflare Worker：静态页面由 assets 提供，/api/* 由这里处理。
// 云开发凭据仅从服务端绑定读取，所有业务接口均要求已授权的邮箱会话。
import * as N from '../shared/normalize.ts';
import type { CloudConfig } from '../shared/types.ts';
import * as Q from './query.ts';
import { AppError, WxCloud } from './wechat.ts';

import { handleAuth, requireUser } from './auth.ts';
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

type Ctx = { cloud: WxCloud; req: Request; url: URL; params: string[] };
type Handler = (ctx: Ctx) => Promise<unknown>;

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

async function findAll(cloud: WxCloud, name: string, orderBy: Q.Order[], where?: Q.QueryValue): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let skip = 0; skip < MAX_DOCS; skip += PAGE) {
    const { data } = await cloud.query(Q.find(name, { where, orderBy, skip, limit: PAGE }));
    out.push(...data);
    if (data.length < PAGE) break;
  }
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

async function createPortfolio({ cloud, req }: Ctx) {
  const raw = await body(req);
  const id = checkId(N.text(raw._id, 64), '作品 ID');
  const input = N.portfolioInput(raw);
  if (!input.title) throw new AppError('INVALID', '请填写作品标题', 400);
  if (await findOne(cloud, PORTFOLIOS, id)) throw new AppError('EXISTS', `作品 ID ${id} 已存在`, 409);
  const now = Q.date();
  await cloud.add(Q.add(PORTFOLIOS, {
    _id: id,
    ...portfolioData(input),
    stats: { likes: 0, favorites: 0, shares: 0 },
    createdAt: now,
    updatedAt: now,
  }));
  return { item: N.portfolio(await findOne(cloud, PORTFOLIOS, id)) };
}

async function updatePortfolio({ cloud, req, url, params }: Ctx) {
  const id = checkId(params[0]);
  const before = await findOne(cloud, PORTFOLIOS, id);
  if (!before) throw new AppError('NOT_FOUND', '作品不存在', 404);
  const input = N.portfolioInput(await body(req));
  if (!input.title) throw new AppError('INVALID', '请填写作品标题', 400);
  // stats 由小程序 user 云函数维护，这里不写入，避免覆盖并发产生的计数
  await cloud.update(Q.updateById(PORTFOLIOS, id, Q.replaceFields({ ...portfolioData(input), updatedAt: Q.date() })));

  let cleaned: string[] = [];
  if (url.searchParams.get('cleanup') === '1') {
    const now = N.collectFileIds(input);
    const removed = [...N.collectFileIds(before)].filter((f) => !now.has(f) && ownFile(cloud.cfg, f, `portfolios/${id}/`));
    if (removed.length) cleaned = (await cloud.deleteFiles(removed)).deleted;
  }
  return { item: N.portfolio(await findOne(cloud, PORTFOLIOS, id)), cleaned };
}

async function deletePortfolio({ cloud, url, params }: Ctx) {
  const id = checkId(params[0]);
  const before = await findOne(cloud, PORTFOLIOS, id);
  if (!before) throw new AppError('NOT_FOUND', '作品不存在', 404);
  await cloud.remove(Q.removeById(PORTFOLIOS, id));
  let cleaned: string[] = [];
  if (url.searchParams.get('files') === '1') {
    const files = [...N.collectFileIds(before)].filter((f) => ownFile(cloud.cfg, f, `portfolios/${id}/`));
    if (files.length) cleaned = (await cloud.deleteFiles(files)).deleted;
  }
  return { deleted: id, cleaned };
}

async function listSeries({ cloud }: Ctx) {
  const docs = await findAll(cloud, SERIES, SORT);
  return { items: docs.map(N.series) };
}

async function createSeries({ cloud, req }: Ctx) {
  const raw = await body(req);
  const id = checkId(N.text(raw._id, 64), '系列 ID');
  const input = N.seriesInput(raw);
  if (!input.title) throw new AppError('INVALID', '请填写系列名称', 400);
  if (await findOne(cloud, SERIES, id)) throw new AppError('EXISTS', `系列 ID ${id} 已存在`, 409);
  const now = Q.date();
  await cloud.add(Q.add(SERIES, { _id: id, ...(input as unknown as Record<string, Q.QueryValue>), createdAt: now, updatedAt: now }));
  return { item: N.series(await findOne(cloud, SERIES, id)) };
}

async function updateSeries({ cloud, req, params }: Ctx) {
  const id = checkId(params[0]);
  if (!(await findOne(cloud, SERIES, id))) throw new AppError('NOT_FOUND', '系列不存在', 404);
  const input = N.seriesInput(await body(req));
  if (!input.title) throw new AppError('INVALID', '请填写系列名称', 400);
  await cloud.update(Q.updateById(SERIES, id, Q.replaceFields({ ...(input as unknown as Record<string, Q.QueryValue>), updatedAt: Q.date() })));
  return { item: N.series(await findOne(cloud, SERIES, id)) };
}

async function deleteSeries({ cloud, params }: Ctx) {
  const id = checkId(params[0]);
  await cloud.remove(Q.removeById(SERIES, id));
  // 作品不再属于该系列
  const { modified } = await cloud.update(Q.updateWhere(PORTFOLIOS, { seriesId: id }, { seriesId: null, updatedAt: Q.date() }));
  return { deleted: id, detached: modified };
}

async function getStudio({ cloud }: Ctx) {
  const doc = await findOne(cloud, STUDIO, STUDIO_ID);
  return { studio: doc ? N.studio(doc) : null };
}

async function saveStudio({ cloud, req }: Ctx) {
  const input = N.studio(await body(req));
  if (!input.name) throw new AppError('INVALID', '请填写工作室名称', 400);
  const { updatedAt: _ignored, ...rest } = input;
  const data = {
    ...(rest as unknown as Record<string, Q.QueryValue>),
    // 小程序以字符串数组读取 intro，sections.body 支持换行分段的字符串
    updatedAt: Q.date(),
  };
  const exists = await findOne(cloud, STUDIO, STUDIO_ID);
  if (exists) await cloud.update(Q.updateById(STUDIO, STUDIO_ID, Q.replaceFields(data)));
  else await cloud.add(Q.add(STUDIO, { _id: STUDIO_ID, ...data }));
  return { studio: N.studio(await findOne(cloud, STUDIO, STUDIO_ID)) };
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

async function deleteFiles({ cloud, req }: Ctx) {
  const raw = await body(req);
  const ids = (Array.isArray(raw.fileIds) ? raw.fileIds : [])
    .filter((v): v is string => typeof v === 'string' && ownFile(cloud.cfg, v))
    .slice(0, 200);
  return cloud.deleteFiles(ids);
}

// ---------- 路由 ----------

const routes: [string, RegExp, Handler][] = [
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
  await requireUser(req, env);

  for (const [method, pattern, handler] of routes) {
    if (method !== req.method) continue;
    const m = url.pathname.match(pattern);
    if (!m) continue;
    const cloud = new WxCloud(parseConfig(env));
    return json({ ok: true, data: await handler({ cloud, req, url, params: m.slice(1) }) });
  }
  throw new AppError('NOT_FOUND', '接口不存在', 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env);
    } catch (err) {
      if (err instanceof AppError) return json({ ok: false, code: err.code, message: err.message }, err.status);
      console.error('unhandled', err);
      return json({ ok: false, code: 'INTERNAL', message: '服务器错误，请稍后重试' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
