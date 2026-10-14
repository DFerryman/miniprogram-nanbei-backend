// 微信开放接口中的云开发 HTTP API 客户端。
// 文档：小程序「服务端 API → 云开发」：数据库 databasequery / databaseadd / databaseupdate /
// databasedelete / databasecount，存储 uploadfile / batchdownloadfile / batchdeletefile。
// 鉴权使用 AppID + AppSecret 换取的稳定版接口调用凭证（cgi-bin/stable_token）。
import type { CloudConfig } from '../shared/types.ts';

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface WxBase {
  errcode?: number;
  errmsg?: string;
}

// 同一 Worker 实例内缓存凭证；稳定版凭证在有效期内重复获取会返回同一个值，不影响其他调用方。
const tokens = new Map<string, { token: string; expires: number }>();

// 凭证失效 / 过期，需要重新获取后重试一次
const TOKEN_ERRORS = new Set([40001, 40014, 42001]);

const ERROR_HINTS: Record<number, string> = {
  40013: 'AppID 无效，请检查配置',
  40125: 'AppSecret 无效，请检查配置',
  40164: '当前出口 IP 不在小程序后台的 IP 白名单中。Cloudflare Workers 出口 IP 不固定，请关闭白名单或在配置中使用固定 IP 的转发地址',
  61004: '当前出口 IP 不在白名单中',
  89503: '调用需要管理员确认，请在微信中确认后重试',
  [-501000]: '云开发环境 ID 无效，或该环境不属于此小程序',
  [-501001]: '云开发环境不存在',
  [-502005]: '数据库集合不存在，请先在云开发控制台创建',
};

function cacheKey(cfg: CloudConfig): string {
  return `${cfg.apiBase}|${cfg.appId}|${cfg.appSecret}`;
}

function wxError(res: WxBase): AppError {
  const code = res.errcode ?? -1;
  const hint = ERROR_HINTS[code];
  const message = hint ? `${hint}（${code}: ${res.errmsg || ''}）` : `微信接口错误 ${code}: ${res.errmsg || '未知错误'}`;
  return new AppError(`WX_${code}`, message, 502);
}

async function post<T extends WxBase>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppError('NETWORK', `无法连接 ${new URL(url).host}：${(err as Error).message}`, 502);
  }
  const textBody = await res.text();
  let json: T;
  try {
    json = JSON.parse(textBody) as T;
  } catch {
    throw new AppError('BAD_RESPONSE', `接口返回了非 JSON 内容（HTTP ${res.status}）：${textBody.slice(0, 120)}`, 502);
  }
  return json;
}

async function getToken(cfg: CloudConfig, fresh = false): Promise<string> {
  const key = cacheKey(cfg);
  const hit = tokens.get(key);
  if (!fresh && hit && hit.expires > Date.now()) return hit.token;

  const res = await post<WxBase & { access_token?: string; expires_in?: number }>(`${cfg.apiBase}/cgi-bin/stable_token`, {
    grant_type: 'client_credential',
    appid: cfg.appId,
    secret: cfg.appSecret,
    force_refresh: false,
  });
  if (!res.access_token) throw wxError(res);
  // 提前 5 分钟过期，避免使用即将失效的凭证
  const ttl = Math.max(60, (res.expires_in || 7200) - 300) * 1000;
  tokens.set(key, { token: res.access_token, expires: Date.now() + ttl });
  if (tokens.size > 50) tokens.delete(tokens.keys().next().value as string);
  return res.access_token;
}

export class WxCloud {
  readonly cfg: CloudConfig;
  constructor(cfg: CloudConfig) {
    this.cfg = cfg;
  }

  async call<T extends WxBase>(path: string, body: Record<string, unknown>, retried = false): Promise<T> {
    const token = await getToken(this.cfg, retried);
    const res = await post<T>(`${this.cfg.apiBase}${path}?access_token=${encodeURIComponent(token)}`, {
      env: this.cfg.envId,
      ...body,
    });
    if (res.errcode && TOKEN_ERRORS.has(res.errcode) && !retried) {
      tokens.delete(cacheKey(this.cfg));
      return this.call<T>(path, body, true);
    }
    if (res.errcode) throw wxError(res);
    return res;
  }

  async token(): Promise<void> {
    await getToken(this.cfg);
  }

  // ---------- 数据库 ----------

  async query(query: string): Promise<{ data: unknown[]; total: number }> {
    const res = await this.call<WxBase & { data?: string[]; pager?: { Total?: number } }>('/tcb/databasequery', { query });
    return {
      data: (res.data || []).map((s) => JSON.parse(s)),
      total: res.pager?.Total ?? 0,
    };
  }

  async add(query: string): Promise<string[]> {
    const res = await this.call<WxBase & { id_list?: string[] }>('/tcb/databaseadd', { query });
    return res.id_list || [];
  }

  async update(query: string): Promise<{ matched: number; modified: number }> {
    const res = await this.call<WxBase & { matched?: number; modified?: number }>('/tcb/databaseupdate', { query });
    return { matched: res.matched ?? 0, modified: res.modified ?? 0 };
  }

  async remove(query: string): Promise<number> {
    const res = await this.call<WxBase & { deleted?: number }>('/tcb/databasedelete', { query });
    return res.deleted ?? 0;
  }

  async count(query: string): Promise<number> {
    const res = await this.call<WxBase & { count?: number }>('/tcb/databasecount', { query });
    return res.count ?? 0;
  }

  // ---------- 云存储 ----------

  /** 获取上传凭证：返回 COS 上传地址与表单签名，文件 ID 在上传成功后生效。 */
  async uploadTicket(path: string): Promise<{ url: string; fileId: string; fields: Record<string, string> }> {
    const res = await this.call<WxBase & {
      url: string;
      token: string;
      authorization: string;
      file_id: string;
      cos_file_id: string;
    }>('/tcb/uploadfile', { path });
    return {
      url: res.url,
      fileId: res.file_id,
      // 字段顺序与名称按微信文档：key、Signature、x-cos-security-token、x-cos-meta-fileid，文件放在最后
      fields: {
        key: path,
        Signature: res.authorization,
        'x-cos-security-token': res.token,
        'x-cos-meta-fileid': res.cos_file_id,
      },
    };
  }

  async upload(path: string, file: File): Promise<string> {
    const ticket = await this.uploadTicket(path);
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
    form.append('file', file, file.name || path.split('/').pop());
    const res = await fetch(ticket.url, { method: 'POST', body: form });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new AppError('UPLOAD_FAILED', `上传到云存储失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, 502);
    }
    return ticket.fileId;
  }

  /** 换取临时下载链接，每批最多 50 个。 */
  async tempUrls(fileIds: string[], maxAge = 7200): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (let i = 0; i < fileIds.length; i += 50) {
      const chunk = fileIds.slice(i, i + 50);
      const res = await this.call<WxBase & { file_list?: { fileid: string; download_url: string; status: number }[] }>(
        '/tcb/batchdownloadfile',
        { file_list: chunk.map((fileid) => ({ fileid, max_age: maxAge })) },
      );
      for (const f of res.file_list || []) {
        if (f.status === 0 && f.download_url) out[f.fileid] = f.download_url;
      }
    }
    return out;
  }

  async deleteFiles(fileIds: string[]): Promise<{ deleted: string[]; failed: { fileId: string; message: string }[] }> {
    const deleted: string[] = [];
    const failed: { fileId: string; message: string }[] = [];
    for (let i = 0; i < fileIds.length; i += 50) {
      const chunk = fileIds.slice(i, i + 50);
      const res = await this.call<WxBase & { delete_list?: { fileid: string; status: number; errmsg: string }[] }>(
        '/tcb/batchdeletefile',
        { fileid_list: chunk },
      );
      for (const f of res.delete_list || []) {
        if (f.status === 0) deleted.push(f.fileid);
        else failed.push({ fileId: f.fileid, message: f.errmsg });
      }
    }
    return { deleted, failed };
  }
}
