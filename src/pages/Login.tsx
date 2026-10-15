import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorText, type AuthUser } from '../lib/api.ts';

export function Login({ onReady }: { onReady: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<'login' | 'request'>('login');
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'verify' | 'request' | null>(null);
  const [error, setError] = useState('');
  const [needsAccess, setNeedsAccess] = useState(false);
  const [message, setMessage] = useState('');
  const [nextSendAt, setNextSendAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const normalizedEmail = email.trim().toLowerCase();
  const hasCode = Boolean(sentTo && sentTo === normalizedEmail);
  const remaining = Math.max(0, Math.ceil((nextSendAt - now) / 1000));

  useEffect(() => {
    if (!nextSendAt) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= nextSendAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [nextSendAt]);

  useEffect(() => {
    if (hasCode && mode === 'login') codeInput.current?.focus();
  }, [hasCode, mode]);

  function changeMode(value: 'login' | 'request') {
    setMode(value);
    setError('');
    setNeedsAccess(false);
    setMessage('');
  }

  async function sendCode() {
    if (remaining || busy || !emailInput.current?.reportValidity()) return;
    setBusy('send');
    setError('');
    setNeedsAccess(false);
    setMessage('');
    try {
      const response = await api.sendCode(normalizedEmail);
      setSentTo(normalizedEmail);
      setCode('');
      const time = Date.now();
      setNow(time);
      setNextSendAt(time + 60_000);
      setMessage(response.message);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ACCESS_REQUIRED') {
        setSentTo('');
        setCode('');
        setNextSendAt(0);
        setNeedsAccess(true);
      }
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (mode === 'login' && !hasCode) {
      await sendCode();
      return;
    }
    setError('');
    setMessage('');
    setBusy(mode === 'request' ? 'request' : 'verify');
    try {
      if (mode === 'request') {
        const response = await api.requestAccess(normalizedEmail);
        setMessage(response.message);
      } else {
        const { user } = await api.verifyCode(normalizedEmail, code);
        onReady(user);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="setup auth-page">
      <div className="setup-card auth-card">
        <div className="auth-heading">
          <div className="muted small">摄影工作室 · 内容管理</div>
          <h1>{mode === 'login' ? '邮箱登录' : '申请访问权限'}</h1>
          <p className="muted">仅已获管理员授权的邮箱可以登录。</p>
        </div>

        <div className="seg-control full" aria-label="登录或申请权限">
          <button type="button" className={mode === 'login' ? 'on' : ''} aria-pressed={mode === 'login'} disabled={Boolean(busy)} onClick={() => changeMode('login')}>邮箱登录</button>
          <button type="button" className={mode === 'request' ? 'on' : ''} aria-pressed={mode === 'request'} disabled={Boolean(busy)} onClick={() => changeMode('request')}>申请访问权限</button>
        </div>

        <form onSubmit={submit} className="form">
          <label className="field">
            <span>邮箱</span>
            <input
              ref={emailInput}
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              disabled={Boolean(busy)}
              onChange={(event) => { setEmail(event.target.value); setSentTo(''); setCode(''); setNeedsAccess(false); setError(''); setMessage(''); }}
            />
          </label>

          {mode === 'request' ? (
            <p className="muted small auth-hint">提交后，管理员会收到申请邮件。获得批准后，请返回邮箱登录，使用同一邮箱获取登录码。</p>
          ) : (
            <>
              {hasCode && (
                <label className="field">
                  <span>6 位登录码</span>
                  <input
                    ref={codeInput}
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    autoComplete="one-time-code"
                    placeholder="输入邮箱收到的 6 位数字"
                    value={code}
                    disabled={Boolean(busy)}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                  <small>登录码 10 分钟内有效。请检查收件箱和垃圾邮件。</small>
                </label>
              )}
              {!hasCode && <p className="muted small auth-hint">已获授权后，点击下方按钮获取登录码。登录码 10 分钟内有效。</p>}
            </>
          )}

          {error && <div className="alert error" role="alert">{error}</div>}
          {needsAccess && <button type="button" className="btn ghost" onClick={() => changeMode('request')}>申请访问权限</button>}
          {message && <div className="alert ok" role="status">{message}</div>}

          <div className="actions">
            {mode === 'request' ? (
              <button type="submit" className="btn" disabled={Boolean(busy)}>{busy === 'request' ? '提交中…' : '申请权限'}</button>
            ) : (
              <>
                {hasCode && <button type="button" className="btn ghost" disabled={Boolean(busy) || remaining > 0} onClick={sendCode}>{busy === 'send' ? '发送中…' : remaining > 0 ? `${remaining} 秒后重新发送` : '重新发送登录码'}</button>}
                <button type="submit" className="btn" disabled={Boolean(busy) || (!hasCode && remaining > 0)}>
                  {busy === 'verify' ? '登录中…' : busy === 'send' ? '发送中…' : hasCode ? '登录' : remaining > 0 ? `${remaining} 秒后可发送` : '发送登录码'}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}
