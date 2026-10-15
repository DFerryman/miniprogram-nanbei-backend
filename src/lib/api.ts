import type { ApiResult, Portfolio, PortfolioInput, Series, SeriesInput, Studio } from '../../shared/types.ts';

export const AUTH_REQUIRED_EVENT = 'nanbei-admin:auth-required';

export interface AuthUser {
  email: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  /** 冲突时为 { current }，文件缺失时为 { missing } 等。 */
  data?: any;
  constructor(code: string, message: string, status: number, data?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/** 本窗口的标识：每次打开页面随机生成，只用于在线状态和修改记录中区分窗口，不代表具体的人。 */
export const TAB_ID = `t_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

export function notifyUnauthorized(status: number) {
  if (status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
}

async function parse<T>(res: Response): Promise<T> {
  notifyUnauthorized(res.status);
  let json: ApiResult<T> & { data?: unknown };
  try {
    json = await res.json();
  } catch {
    throw new ApiError('BAD_RESPONSE', `服务返回异常（HTTP ${res.status}）`, res.status);
  }
  if (!json.ok) throw new ApiError(json.code, json.message, res.status, json.data);
  return json.data as T;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-tab-id': TAB_ID };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    throw new ApiError('NETWORK', `网络错误：${(err as Error).message}`, 0);
  }
  return parse<T>(res);
}

export interface VerifyResult {
  envId: string;
  counts: Record<string, number | null>;
  missing: string[];
}

export type ViewKind = 'list' | 'portfolio' | 'series' | 'studio' | 'setup';
export type EditState = 'viewing' | 'editing' | 'unsaved';

export interface PresenceTab {
  self: boolean;
  /** 同一浏览器登录会话（同一 Cookie）中的其他窗口。 */
  sameSession: boolean;
  email: string;
  view: ViewKind;
  viewId: string | null;
  state: EditState;
  visible: boolean;
  online: boolean;
  seenAgo: number;
  since: number;
}

export interface ChangeEvent {
  seq: number;
  kind: 'portfolio' | 'series' | 'studio';
  id: string;
  action: 'create' | 'update' | 'delete';
  rev: number | null;
  email: string;
  at: number;
  self: boolean;
}

export interface PresenceResult {
  now: number;
  tabs: PresenceTab[];
  accounts: { email: string; sessions: number; onlineTabs: number }[];
  changes: ChangeEvent[];
  cursor: number;
}

export interface Heartbeat {
  view: ViewKind;
  viewId: string | null;
  state: EditState;
  visible: boolean;
  since: number | null;
}

export const api = {
  meta: () => request<{ authRequired: true }>('GET', '/api/meta'),
  session: () => request<{ user: AuthUser | null }>('GET', '/api/auth/session'),
  requestAccess: (email: string) => request<{ message: string }>('POST', '/api/auth/request-access', { email }),
  sendCode: (email: string) => request<{ message: string }>('POST', '/api/auth/send-code', { email }),
  verifyCode: (email: string, code: string) => request<{ user: AuthUser }>('POST', '/api/auth/verify-code', { email, code }),
  logout: () => request<{ message: string }>('POST', '/api/auth/logout'),
  verify: () => request<VerifyResult>('POST', '/api/verify'),

  portfolios: () => request<{ items: Portfolio[] }>('GET', '/api/portfolios'),
  portfolio: (id: string) => request<{ item: Portfolio }>('GET', `/api/portfolios/${encodeURIComponent(id)}`),
  createPortfolio: (id: string, input: PortfolioInput) =>
    request<{ item: Portfolio }>('POST', '/api/portfolios', { _id: id, ...input }),
  updatePortfolio: (id: string, rev: number, input: PortfolioInput, cleanup: boolean) =>
    request<{ item: Portfolio; queued: number }>('PUT', `/api/portfolios/${encodeURIComponent(id)}${cleanup ? '?cleanup=1' : ''}`, { ...input, rev }),
  deletePortfolio: (id: string, rev: number, files: boolean) =>
    request<{ deleted: string; already?: boolean; queued: number }>('DELETE', `/api/portfolios/${encodeURIComponent(id)}?rev=${rev}${files ? '&files=1' : ''}`),

  series: () => request<{ items: Series[] }>('GET', '/api/series'),
  createSeries: (id: string, input: SeriesInput) => request<{ item: Series }>('POST', '/api/series', { _id: id, ...input }),
  updateSeries: (id: string, rev: number, input: SeriesInput) =>
    request<{ item: Series }>('PUT', `/api/series/${encodeURIComponent(id)}`, { ...input, rev }),
  deleteSeries: (id: string, rev: number) =>
    request<{ deleted: string; already: boolean; detached: number }>('DELETE', `/api/series/${encodeURIComponent(id)}?rev=${rev}`),

  studio: () => request<{ studio: Studio | null }>('GET', '/api/studio'),
  saveStudio: (rev: number, studio: Studio) => request<{ studio: Studio; queued: number }>('PUT', '/api/studio', { ...studio, rev }),

  tempUrls: (fileIds: string[]) => request<{ urls: Record<string, string> }>('POST', '/api/files/urls', { fileIds }),
  uploadTicket: (path: string) =>
    request<{ url: string; fileId: string; fields: Record<string, string> }>('POST', '/api/files/ticket', { path }),
  /** 丢弃的上传：服务端放入回收列表，确认无引用后才删除。 */
  deleteFiles: (fileIds: string[]) => request<{ queued: number }>('POST', '/api/files/delete', { fileIds }),

  presence: (beat: Heartbeat) => request<PresenceResult>('POST', '/api/presence', { tabId: TAB_ID, ...beat }),
  /** 关闭窗口时通知离开；keepalive 保证页面卸载时请求仍能发出。 */
  leave: () => {
    fetch('/api/presence/leave', {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-tab-id': TAB_ID },
      body: JSON.stringify({ tabId: TAB_ID }),
    }).catch(() => undefined);
  },
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
