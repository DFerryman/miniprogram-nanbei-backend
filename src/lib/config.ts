// 连接配置保存在浏览器：勾选「记住」时存 localStorage，否则只存 sessionStorage（关闭标签页即清除）。
import type { CloudConfig } from '../../shared/types.ts';

export type UploadMode = 'proxy' | 'direct';

export interface Profile {
  id: string;
  name: string;
  config: CloudConfig;
  uploadMode: UploadMode;
  adminToken: string;
  remember: boolean;
}

const KEY = 'nanbei-admin.profiles';
const ACTIVE = 'nanbei-admin.active';

function read(storage: Storage): Profile[] {
  try {
    const v = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(storage: Storage, list: Profile[]) {
  try {
    if (list.length) storage.setItem(KEY, JSON.stringify(list));
    else storage.removeItem(KEY);
  } catch {
    // 存储不可用（隐私模式等）时仅本次会话有效
  }
}

let memory: Profile[] | null = null;

export function loadProfiles(): Profile[] {
  if (memory) return memory;
  const local = read(localStorage).map((p) => ({ ...p, remember: true }));
  const session = read(sessionStorage).map((p) => ({ ...p, remember: false }));
  const ids = new Set(local.map((p) => p.id));
  memory = [...local, ...session.filter((p) => !ids.has(p.id))];
  return memory;
}

function persist(list: Profile[]) {
  memory = list;
  write(localStorage, list.filter((p) => p.remember));
  write(sessionStorage, list.filter((p) => !p.remember));
}

export function saveProfile(profile: Profile) {
  const list = loadProfiles().filter((p) => p.id !== profile.id);
  persist([...list, profile]);
  setActiveId(profile.id);
}

export function removeProfile(id: string) {
  persist(loadProfiles().filter((p) => p.id !== id));
  if (getActiveId() === id) setActiveId('');
}

export function getActiveId(): string {
  try {
    return sessionStorage.getItem(ACTIVE) || localStorage.getItem(ACTIVE) || '';
  } catch {
    return '';
  }
}

export function setActiveId(id: string) {
  try {
    sessionStorage.setItem(ACTIVE, id);
    localStorage.setItem(ACTIVE, id);
  } catch {
    // 忽略
  }
}

export function activeProfile(): Profile | null {
  const id = getActiveId();
  return loadProfiles().find((p) => p.id === id) || null;
}

/** 请求头只能携带 ASCII，先 UTF-8 编码再 base64。 */
export function encodeConfig(cfg: CloudConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cfg));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
