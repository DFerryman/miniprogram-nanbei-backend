import { useEffect, useState } from 'react';
import { api, AUTH_REQUIRED_EVENT, errorText, type AuthUser } from './lib/api.ts';
import { clearLegacyConfig } from './lib/config.ts';
import { DataProvider } from './lib/data.tsx';
import { clearUrlCache } from './lib/media.ts';
import { navigate, useRoute } from './lib/router.ts';
import { AboutEditor } from './pages/AboutEditor.tsx';
import { Login } from './pages/Login.tsx';
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
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const route = useRoute();
  const [section = 'portfolios', param] = route;

  useEffect(() => {
    const expired = () => {
      setUser(null);
      clearUrlCache();
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, expired);
  }, []);

  useEffect(() => {
    let cancelled = false;
    clearLegacyConfig();
    setChecking(true);
    setSessionError('');
    api.session()
      .then(({ user: currentUser }) => { if (!cancelled) setUser(currentUser); })
      .catch((error) => { if (!cancelled) setSessionError(errorText(error)); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [sessionAttempt]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      await api.logout();
      setUser(null);
      clearUrlCache();
      navigate('/portfolios');
    } catch (error) {
      setLogoutError(errorText(error));
    } finally {
      setLoggingOut(false);
    }
  }

  if (checking) return <main className="center"><div className="brand">摄影工作室 · 内容管理</div><p className="muted" role="status">正在确认登录状态…</p></main>;
  if (sessionError) {
    return <main className="center"><div className="alert error" role="alert">{sessionError}</div><button type="button" className="btn" onClick={() => setSessionAttempt((value) => value + 1)}>重新连接</button></main>;
  }
  if (!user) {
    return <Login onReady={(currentUser) => { clearUrlCache(); setUser(currentUser); setLogoutError(''); navigate('/portfolios'); }} />;
  }

  let page;
  if (section === 'setup') page = <Setup onDone={() => navigate('/portfolios')} />;
  else if (section === 'portfolios' && param) page = <PortfolioEditor key={param} id={param} />;
  else if (section === 'series') page = <SeriesPage />;
  else if (section === 'about') page = <AboutEditor />;
  else page = <Portfolios />;

  return (
    <DataProvider key={user.email} sessionKey={user.email}>
      <header className="topbar">
        <div className="brand">摄影工作室 · 内容管理</div>
        <nav aria-label="内容管理">
          {NAV.map((n) => (
            <a key={n.path} href={`#/${n.path}`} className={section === n.path ? 'on' : ''}>{n.text}</a>
          ))}
        </nav>
        <div className="account-actions">
          <span className="account-email small" title={user.email}>{user.email}</span>
          <button type="button" className={`btn small ${section === 'setup' ? '' : 'ghost'}`} onClick={() => navigate('/setup')}>设置</button>
          <button type="button" className="btn small ghost" disabled={loggingOut} onClick={logout}>{loggingOut ? '退出中…' : '退出登录'}</button>
        </div>
      </header>
      <main className="content">
        {logoutError && <div className="alert error" role="alert">{logoutError}</div>}
        {page}
      </main>
    </DataProvider>
  );
}
