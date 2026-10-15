import type { ApiResult, Portfolio, PortfolioInput, Series, SeriesInput, Studio } from '../../shared/types.ts';

export const AUTH_REQUIRED_EVENT = 'nanbei-admin:auth-required';

export interface AuthUser {
  email: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function notifyUnauthorized(status: number) {
  if (status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
}

async function parse<T>(res: Response): Promise<T> {
  notifyUnauthorized(res.status);
  let json: ApiResult<T>;
  try {
    json = await res.json();
  } catch {
    throw new ApiError('BAD_RESPONSE', `服务返回异常（HTTP ${res.status}）`, res.status);
  }
  if (!json.ok) throw new ApiError(json.code, json.message, res.status);
  return json.data;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
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
  updatePortfolio: (id: string, input: PortfolioInput, cleanup: boolean) =>
    request<{ item: Portfolio; cleaned: string[] }>('PUT', `/api/portfolios/${encodeURIComponent(id)}${cleanup ? '?cleanup=1' : ''}`, input),
  deletePortfolio: (id: string, files: boolean) =>
    request<{ deleted: string; cleaned: string[] }>('DELETE', `/api/portfolios/${encodeURIComponent(id)}${files ? '?files=1' : ''}`),

  series: () => request<{ items: Series[] }>('GET', '/api/series'),
  createSeries: (id: string, input: SeriesInput) => request<{ item: Series }>('POST', '/api/series', { _id: id, ...input }),
  updateSeries: (id: string, input: SeriesInput) => request<{ item: Series }>('PUT', `/api/series/${encodeURIComponent(id)}`, input),
  deleteSeries: (id: string) => request<{ deleted: string; detached: number }>('DELETE', `/api/series/${encodeURIComponent(id)}`),

  studio: () => request<{ studio: Studio | null }>('GET', '/api/studio'),
  saveStudio: (studio: Studio) => request<{ studio: Studio }>('PUT', '/api/studio', studio),

  tempUrls: (fileIds: string[]) => request<{ urls: Record<string, string> }>('POST', '/api/files/urls', { fileIds }),
  uploadTicket: (path: string) =>
    request<{ url: string; fileId: string; fields: Record<string, string> }>('POST', '/api/files/ticket', { path }),
  deleteFiles: (fileIds: string[]) =>
    request<{ deleted: string[]; failed: { fileId: string; message: string }[] }>('POST', '/api/files/delete', { fileIds }),
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
