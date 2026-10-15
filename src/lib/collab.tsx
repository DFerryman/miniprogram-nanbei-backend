// 在线状态与修改通知：每个窗口定时发送心跳，登记自己正在查看 / 编辑的内容，
// 同时取回其他窗口的状态和最近的保存记录。这些只是提示，数据安全由服务端的版本号检查保证。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type ChangeEvent, type EditState, type PresenceResult, type PresenceTab, type ViewKind } from './api.ts';

const VISIBLE_INTERVAL = 15_000;
const HIDDEN_INTERVAL = 30_000;
/** 有未保存修改、且这段时间内有输入，视为“正在编辑”；否则为“有未保存修改”（可能已离开座位）。 */
const ACTIVE_WINDOW = 120_000;

interface Report {
  view: ViewKind;
  viewId: string | null;
  state: EditState;
}

interface CollabState {
  presence: PresenceResult | null;
  /** 最近一次心跳失败（断网或服务异常）。 */
  offline: boolean;
  report: (r: Report) => void;
  subscribe: (fn: (c: ChangeEvent) => void) => () => void;
}

const Ctx = createContext<CollabState | null>(null);

export function CollabProvider({ children }: { children: ReactNode }) {
  const [presence, setPresence] = useState<PresenceResult | null>(null);
  const [offline, setOffline] = useState(false);
  const current = useRef<Report>({ view: 'list', viewId: null, state: 'viewing' });
  const cursor = useRef<number | null>(null);
  const listeners = useRef(new Set<(c: ChangeEvent) => void>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);

  const beat = useCallback(async () => {
    if (stopped.current) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    clearTimeout(timer.current);
    try {
      const r = await api.presence({ ...current.current, visible: document.visibilityState === 'visible', since: cursor.current });
      const first = cursor.current === null;
      cursor.current = r.cursor;
      setPresence(r);
      setOffline(false);
      if (!first) r.changes.forEach((c) => listeners.current.forEach((fn) => fn(c)));
    } catch {
      setOffline(true);
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void beat();
      } else if (!stopped.current) {
        timer.current = setTimeout(beat, document.visibilityState === 'visible' ? VISIBLE_INTERVAL : HIDDEN_INTERVAL);
      }
    }
  }, []);

  useEffect(() => {
    stopped.current = false;
    void beat();
    const onVisible = () => void beat();
    const onOnline = () => void beat();
    const onLeave = () => api.leave();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onLeave);
    return () => {
      stopped.current = true;
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onLeave);
    };
  }, [beat]);

  const report = useCallback((r: Report) => {
    const c = current.current;
    if (c.view === r.view && c.viewId === r.viewId && c.state === r.state) return;
    current.current = r;
    void beat();
  }, [beat]);

  const subscribe = useCallback((fn: (c: ChangeEvent) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  const value = useMemo(() => ({ presence, offline, report, subscribe }), [presence, offline, report, subscribe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCollab(): CollabState {
  const v = useContext(Ctx);
  if (!v) throw new Error('CollabProvider missing');
  return v;
}

/** 页面登记自己正在查看 / 编辑的内容。 */
export function usePresenceReport(view: ViewKind, viewId: string | null, state: EditState = 'viewing') {
  const { report } = useCollab();
  useEffect(() => { report({ view, viewId, state }); }, [report, view, viewId, state]);
}

/** 订阅其他窗口（含同账号的其他窗口）的保存记录。 */
export function useRemoteChanges(fn: (c: ChangeEvent) => void) {
  const { subscribe } = useCollab();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((c) => { if (!c.self) ref.current(c); }), [subscribe]);
}

/** 根据是否有未保存修改和最近的输入，得出 viewing / editing / unsaved。 */
export function useEditState(dirty: boolean): EditState {
  const last = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => {
    const touch = () => { last.current = Date.now(); };
    window.addEventListener('input', touch, true);
    window.addEventListener('keydown', touch, true);
    window.addEventListener('pointerdown', touch, true);
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => {
      window.removeEventListener('input', touch, true);
      window.removeEventListener('keydown', touch, true);
      window.removeEventListener('pointerdown', touch, true);
      clearInterval(t);
    };
  }, []);
  if (!dirty) return 'viewing';
  return Date.now() - last.current < ACTIVE_WINDOW ? 'editing' : 'unsaved';
}

/** 其他窗口中正在查看同一内容的状态（不含本窗口）。 */
export function useOthersOn(view: ViewKind, viewId: string | null): PresenceTab[] {
  const { presence } = useCollab();
  return useMemo(
    () => (presence?.tabs || []).filter((t) => !t.self && t.view === view && (viewId === null || t.viewId === viewId)),
    [presence, view, viewId],
  );
}

export const STATE_TEXT: Record<EditState, string> = { viewing: '查看中', editing: '正在编辑', unsaved: '有未保存修改' };

/** 描述“谁”。共用账号时同一邮箱可能是不同的人，因此只描述窗口与账号的关系，不推断具体是谁。 */
export function whoText(t: Pick<PresenceTab, 'self' | 'sameSession' | 'email'>, me: string): string {
  if (t.self) return '本窗口';
  if (t.email === me) return t.sameSession ? '你在此浏览器的另一个窗口' : `同一账号（${t.email}）在另一处登录的窗口`;
  return t.email;
}

export function tabStatus(t: PresenceTab): string {
  if (!t.online) return `连接中断（${Math.round(t.seenAgo / 60) || 1} 分钟前）`;
  return `${STATE_TEXT[t.state]}${t.visible ? '' : ' · 窗口在后台'}`;
}

/** 编辑页顶部：其他窗口也打开了这项内容时的提示。 */
export function OthersBanner({ others, me, noun }: { others: PresenceTab[]; me: string; noun: string }) {
  if (!others.length) return null;
  const risky = others.some((t) => t.state !== 'viewing');
  return (
    <div className={`alert ${risky ? 'warn' : 'info'} presence-banner`} role="status">
      <strong>{risky ? `其他窗口也在编辑此${noun}` : `其他窗口也打开了此${noun}`}</strong>
      <ul>
        {others.map((t, i) => (
          <li key={i}><span className={`dot ${t.online ? t.state : 'lost'}`} />{whoText(t, me)} · {tabStatus(t)}</li>
        ))}
      </ul>
      <small>可以同时打开。保存时系统会检查版本：若对方先保存，你的修改不会丢失，会提示你查看最新内容并合并。</small>
    </div>
  );
}
