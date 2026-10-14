import { useState } from 'react';
import { activeProfile, type Profile } from './lib/config.ts';
import { DataProvider } from './lib/data.tsx';
import { navigate, useRoute } from './lib/router.ts';
import { AboutEditor } from './pages/AboutEditor.tsx';
import { PortfolioEditor } from './pages/PortfolioEditor.tsx';
import { Portfolios } from './pages/Portfolios.tsx';
import { SeriesPage } from './pages/SeriesPage.tsx';
import { Setup } from './pages/Setup.tsx';

const NAV = [
  { path: 'portfolios', text: '作品' },
  { path: 'series', text: '系列' },
  { path: 'about', text: '关于我们' },
];

export function App() {
  const [profile, setProfile] = useState<Profile | null>(activeProfile);
  const route = useRoute();
  const [section = 'portfolios', param] = route;

  // 未配置环境时先进入设置页
  if (!profile || section === 'setup') {
    return (
      <Setup
        onReady={(p) => {
          setProfile(p);
          navigate('/portfolios');
        }}
        onCancel={profile ? () => navigate('/portfolios') : undefined}
      />
    );
  }

  let page;
  if (section === 'portfolios' && param) page = <PortfolioEditor key={param} id={param} />;
  else if (section === 'series') page = <SeriesPage />;
  else if (section === 'about') page = <AboutEditor />;
  else page = <Portfolios />;

  return (
    <DataProvider profileId={profile.id}>
      <header className="topbar">
        <div className="brand">摄影工作室 · 内容管理</div>
        <nav>
          {NAV.map((n) => (
            <a key={n.path} href={`#/${n.path}`} className={section === n.path ? 'on' : ''}>{n.text}</a>
          ))}
        </nav>
        <button type="button" className="env" onClick={() => navigate('/setup')} title="切换或修改环境">
          <span className="dot" />
          {profile.name}
          <span className="muted small">{profile.config.envId}</span>
        </button>
      </header>
      <main className="content">{page}</main>
    </DataProvider>
  );
}
