import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresenceTab } from '../lib/api.ts';
import { tabStatus, useCollab, whoText } from '../lib/collab.tsx';
import { useData } from '../lib/data.tsx';

/** 顶栏中的在线状态：紧凑显示数量，展开后列出每个窗口在看 / 编辑什么。 */
export function PresenceIndicator({ me }: { me: string }) {
  const { presence, offline } = useCollab();
  const { portfolios, series } = useData();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const tabs = presence?.tabs || [];
  const online = tabs.filter((t) => t.online);
  const editingOthers = online.filter((t) => !t.self && t.state !== 'viewing').length;
  const groups = useMemo(() => {
    const map = new Map<string, PresenceTab[]>();
    tabs.forEach((t) => map.set(t.email, [...(map.get(t.email) || []), t]));
    return [...map.entries()].sort(([a], [b]) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b)));
  }, [tabs, me]);
  const idle = (presence?.accounts || []).filter((a) => !tabs.some((t) => t.email === a.email));
  const accounts = new Set(online.map((t) => t.email)).size;

  function where(t: PresenceTab): string {
    if (t.view === 'portfolio') {
      const p = portfolios.find((x) => x._id === t.viewId);
      return p ? `作品《${p.title}》` : t.viewId ? `作品 ${t.viewId}（新建或未加载）` : '新建作品';
    }
    if (t.view === 'series') {
      const s = series.find((x) => x._id === t.viewId);
      return t.viewId ? `系列「${s?.title || t.viewId}」` : '系列列表';
    }
    if (t.view === 'studio') return '关于我们';
    if (t.view === 'setup') return '设置';
    return '作品列表';
  }

  return (
    <div className="presence" ref={box}>
      <button
        type="button"
        className={`presence-btn ${offline ? 'offline' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="在线的账号与窗口"
      >
        <span className={`dot ${offline ? 'lost' : 'viewing'}`} />
        {offline ? '连接中断' : `${accounts} 个账号 · ${online.length} 个窗口在线`}
        {editingOthers > 0 && <span className="presence-badge">{editingOthers} 个在编辑</span>}
      </button>
      {open && (
        <div className="presence-panel" role="dialog" aria-label="在线状态">
          {offline && <div className="alert error small">无法连接服务器，以下信息可能已过期。保存前请确认网络恢复。</div>}
          {groups.map(([email, list]) => (
            <section key={email}>
              <h4>{email}{email === me && <span className="muted small">（当前账号）</span>}</h4>
              <ul>
                {list.map((t, i) => (
                  <li key={i} className={t.online ? '' : 'lost'}>
                    <span className={`dot ${t.online ? t.state : 'lost'}`} />
                    <div>
                      <div>{where(t)}</div>
                      <div className="muted small">{whoText(t, me)} · {tabStatus(t)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {idle.length > 0 && (
            <section>
              <h4>已登录，但没有打开的页面</h4>
              <ul>
                {idle.map((a) => (
                  <li key={a.email}><span className="dot idle" /><div>{a.email}<div className="muted small">{a.sessions} 个有效登录</div></div></li>
                ))}
              </ul>
            </section>
          )}
          <p className="muted small presence-note">
            按窗口统计。多人共用一个账号时，系统无法区分是谁，只能区分不同的浏览器窗口和登录。
          </p>
        </div>
      )}
    </div>
  );
}
