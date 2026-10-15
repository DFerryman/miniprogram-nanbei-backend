import * as N from '../shared/normalize.ts';
import type { CloudConfig } from '../shared/types.ts';
import { AppError } from './wechat.ts';

export interface CloudEnvironment {
  WECHAT_API_BASE?: string;
  CLOUDBASE_ENV_ID?: string;
  WECHAT_APP_ID?: string;
  WECHAT_APP_SECRET?: string;
  ALLOWED_API_HOSTS?: string;
  ALLOW_INSECURE_LOCALHOST?: string;
}

/** 连接信息只能来自 Worker 绑定，忽略浏览器携带的旧配置请求头。 */
export function parseConfig(env: CloudEnvironment): CloudConfig {
  if (!env.WECHAT_APP_SECRET) {
    throw new AppError('SERVER_CONFIG', '请部署者在 Cloudflare 设置 WECHAT_APP_SECRET 后再使用云开发功能', 503);
  }
  const cfg: CloudConfig = {
    apiBase: N.text(env.WECHAT_API_BASE || 'https://api.weixin.qq.com', 300).replace(/\/+$/, ''),
    envId: N.text(env.CLOUDBASE_ENV_ID, 100),
    appId: N.text(env.WECHAT_APP_ID, 64),
    appSecret: N.text(env.WECHAT_APP_SECRET, 128),
  };
  let api: URL;
  try { api = new URL(cfg.apiBase); } catch {
    throw new AppError('SERVER_CONFIG', '服务端 WECHAT_API_BASE 无效', 503);
  }
  const localDev = env.ALLOW_INSECURE_LOCALHOST === '1' && api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname);
  if ((api.protocol !== 'https:' && !localDev) || api.search || api.hash || api.username || api.password) {
    throw new AppError('SERVER_CONFIG', '服务端接口地址必须是 HTTPS 地址，且不能包含查询参数或账号信息', 503);
  }
  const allowed = (env.ALLOWED_API_HOSTS || 'api.weixin.qq.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(api.hostname.toLowerCase())) {
    throw new AppError('HOST_NOT_ALLOWED', '服务端接口主机不在 ALLOWED_API_HOSTS 白名单中', 503);
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(cfg.envId)) throw new AppError('SERVER_CONFIG', '服务端 CLOUDBASE_ENV_ID 格式不正确', 503);
  if (!/^wx[0-9a-f]{16}$/i.test(cfg.appId)) throw new AppError('SERVER_CONFIG', '服务端 WECHAT_APP_ID 格式不正确', 503);
  if (!/^[A-Za-z0-9]{16,64}$/.test(cfg.appSecret)) throw new AppError('SERVER_CONFIG', '服务端 WECHAT_APP_SECRET 格式不正确', 503);
  return cfg;
}
