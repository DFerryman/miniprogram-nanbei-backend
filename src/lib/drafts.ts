// 未保存修改的本地备份：浏览器崩溃、误关窗口或断网后重新打开时可以恢复。
// 同时保存“基于哪个版本”，恢复时若云端已有新版本，会走与保存冲突相同的合并流程。
import { useEffect } from 'react';

export interface Draft<B, F> {
  base: B;
  form: F;
  at: number;
}

const PREFIX = 'nanbei-draft:';
const MAX_AGE = 14 * 86400_000;

export function draftKey(email: string, kind: string, id: string): string {
  return `${PREFIX}${email}:${kind}:${id}`;
}

export function loadDraft<B, F>(key: string): Draft<B, F> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft<B, F>;
    if (!d || typeof d.at !== 'number' || Date.now() - d.at > MAX_AGE) {
      localStorage.removeItem(key);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function clearDraft(key: string) {
  try { localStorage.removeItem(key); } catch { /* 存储不可用时忽略 */ }
}

/** 有未保存修改时把表单写入本地（稍作延迟），没有修改时清除。 */
export function useDraftBackup<B, F>(key: string | null, dirty: boolean, base: B, form: F) {
  useEffect(() => {
    if (!key) return;
    if (!dirty) {
      clearDraft(key);
      return;
    }
    const t = setTimeout(() => {
      try { localStorage.setItem(key, JSON.stringify({ base, form, at: Date.now() })); } catch { /* 存储已满或不可用 */ }
    }, 600);
    return () => clearTimeout(t);
  }, [key, dirty, base, form]);
}
