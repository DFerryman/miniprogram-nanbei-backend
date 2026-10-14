import type { ReactNode } from 'react';

export type Tab = 'gallery' | 'discover' | 'about' | 'mine';

const TABS: { key: Tab; text: string }[] = [
  { key: 'gallery', text: '作品' },
  { key: 'discover', text: '发现' },
  { key: 'about', text: '关于' },
  { key: 'mine', text: '我的' },
];

interface Props {
  /** 默认导航栏标题；navigation 为 custom 时不显示导航栏（发现页） */
  title?: string;
  navigation?: 'default' | 'back' | 'custom';
  tab?: Tab | null;
  dark?: boolean;
  onTab?: (tab: Tab) => void;
  onBack?: () => void;
  children: ReactNode;
}

/** 375pt 宽的手机外框，模拟微信小程序的状态栏、导航栏（含右上角胶囊）和文字 tabBar。 */
export function Phone({ title = '', navigation = 'default', tab = null, dark, onTab, onBack, children }: Props) {
  const custom = navigation === 'custom';
  return (
    <div className={`phone ${dark ? 'dark' : ''}`}>
      <div className="phone-screen">
        <div className={`mp-status ${custom ? 'overlay' : ''}`}>
          <span>9:41</span>
          <span className="mp-status-icons">
            <i />
            <i />
            <i className="battery" />
          </span>
        </div>
        {!custom && (
          <div className="mp-nav">
            {navigation === 'back' && (
              <button type="button" className="mp-nav-back" onClick={onBack} aria-label="返回">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#111" strokeWidth="1.8"><path d="M15 5l-7 7 7 7" /></svg>
              </button>
            )}
            <span className="mp-nav-title">{title}</span>
          </div>
        )}
        <div className={`mp-capsule ${custom ? 'light' : ''}`}>
          <span>•••</span>
          <i />
          <span className="ring" />
        </div>
        <div className={`mp-body ${custom ? 'full' : ''}`}>{children}</div>
        {tab && (
          <div className="mp-tabbar">
            {TABS.map((t) => (
              <button
                type="button"
                key={t.key}
                className={`mp-tab ${t.key === tab ? 'on' : ''}`}
                onClick={() => onTab?.(t.key)}
              >
                {t.text}
              </button>
            ))}
          </div>
        )}
        <div className="mp-home" />
      </div>
    </div>
  );
}
