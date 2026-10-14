import { useEffect, useState } from 'react';
import { api, errorText, type VerifyResult } from '../lib/api.ts';
import { getActiveId, loadProfiles, removeProfile, saveProfile, setActiveId, type Profile } from '../lib/config.ts';
import { clearUrlCache } from '../lib/media.ts';

// 微信开放接口的公共地址，仅作为表单建议值；可改为自建的固定 IP 转发地址。
const SUGGESTED_API_BASE = 'https://api.weixin.qq.com';

const COLLECTION_LABELS: Record<string, string> = {
  portfolios: '作品',
  series: '系列',
  studio: '工作室信息',
  users: '用户',
  likes: '点赞',
};

function blank(): Profile {
  return {
    id: `env_${Date.now().toString(36)}`,
    name: '',
    config: { apiBase: SUGGESTED_API_BASE, envId: '', appId: '', appSecret: '' },
    uploadMode: 'proxy',
    adminToken: '',
    remember: true,
  };
}

export function Setup({ onReady, onCancel }: { onReady: (p: Profile) => void; onCancel?: () => void }) {
  const [profiles, setProfiles] = useState(loadProfiles);
  const [draft, setDraft] = useState<Profile>(() => {
    const active = profiles.find((p) => p.id === getActiveId());
    return active ? { ...active, config: { ...active.config } } : blank();
  });
  const [needsToken, setNeedsToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    api.meta().then((m) => setNeedsToken(m.requiresAdminToken)).catch(() => {});
  }, []);

  const setCfg = (k: keyof Profile['config'], v: string) => {
    setDraft((d) => ({ ...d, config: { ...d.config, [k]: v.trim() } }));
    setResult(null);
  };

  async function test(): Promise<VerifyResult | null> {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const r = await api.verify(draft);
      setResult(r);
      return r;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = result || (await test());
    if (!r) return;
    const profile = { ...draft, name: draft.name.trim() || draft.config.envId };
    saveProfile(profile);
    clearUrlCache();
    onReady(profile);
  }

  function use(p: Profile) {
    setActiveId(p.id);
    setDraft({ ...p, config: { ...p.config } });
    setResult(null);
    setError('');
  }

  function remove(p: Profile) {
    if (!confirm(`删除已保存的环境「${p.name}」？只删除本浏览器中的配置，不影响云端数据。`)) return;
    removeProfile(p.id);
    const list = loadProfiles();
    setProfiles([...list]);
    if (draft.id === p.id) setDraft(blank());
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>连接云开发环境</h1>
        <p className="muted">
          填写小程序与云开发环境信息。配置只保存在当前浏览器中，每次请求随请求头发送给本站的 Worker，
          由 Worker 调用微信云开发 HTTP API；Worker 不保存任何配置。
        </p>

        {profiles.length > 0 && (
          <div className="profiles">
            <div className="label">已保存的环境</div>
            {profiles.map((p) => (
              <div key={p.id} className={`profile-row ${p.id === draft.id ? 'on' : ''}`}>
                <button type="button" className="link" onClick={() => use(p)}>
                  <strong>{p.name}</strong> <span className="muted">{p.config.envId}</span>
                </button>
                {!p.remember && <span className="tag">仅本次会话</span>}
                <button type="button" className="link danger" onClick={() => remove(p)}>删除</button>
              </div>
            ))}
            <button type="button" className="btn small ghost" onClick={() => { setDraft(blank()); setResult(null); }}>+ 新环境</button>
          </div>
        )}

        <form onSubmit={submit} className="form">
          <label className="field">
            <span>名称</span>
            <input value={draft.name} placeholder="例如：正式环境（留空则使用环境 ID）" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field">
            <span>接口地址 *</span>
            <input required value={draft.config.apiBase} onChange={(e) => setCfg('apiBase', e.target.value)} placeholder={SUGGESTED_API_BASE} />
            <small>微信服务端 API 地址。若小程序后台开启了 IP 白名单，可填写部署在固定 IP 上的转发服务地址（需转发 /cgi-bin 与 /tcb 路径）。</small>
          </label>
          <label className="field">
            <span>云开发环境 ID *</span>
            <input required value={draft.config.envId} onChange={(e) => setCfg('envId', e.target.value)} placeholder="在云开发控制台「设置 → 环境设置」中复制" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>小程序 AppID *</span>
              <input required value={draft.config.appId} onChange={(e) => setCfg('appId', e.target.value)} placeholder="wx…" />
            </label>
            <label className="field">
              <span>AppSecret *</span>
              <div className="input-with-btn">
                <input
                  required
                  type={showSecret ? 'text' : 'password'}
                  autoComplete="off"
                  value={draft.config.appSecret}
                  onChange={(e) => setCfg('appSecret', e.target.value)}
                  placeholder="小程序后台「开发管理 → 开发设置」"
                />
                <button type="button" className="btn small ghost" onClick={() => setShowSecret((v) => !v)}>{showSecret ? '隐藏' : '显示'}</button>
              </div>
            </label>
          </div>
          <label className="field">
            <span>上传方式</span>
            <select value={draft.uploadMode} onChange={(e) => setDraft({ ...draft, uploadMode: e.target.value as Profile['uploadMode'] })}>
              <option value="proxy">经 Worker 中转（默认，单个文件不超过约 95 MB）</option>
              <option value="direct">浏览器直传云存储（需在云开发控制台把本站域名加入安全域名 / CORS）</option>
            </select>
          </label>
          {(needsToken || draft.adminToken) && (
            <label className="field">
              <span>后台访问口令{needsToken ? ' *' : ''}</span>
              <input required={needsToken} type="password" value={draft.adminToken} onChange={(e) => setDraft({ ...draft, adminToken: e.target.value })} />
              <small>部署者在 Worker 中设置了 ADMIN_TOKEN，需要输入相同口令。</small>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={draft.remember} onChange={(e) => setDraft({ ...draft, remember: e.target.checked })} />
            在此浏览器中记住（不勾选时关闭标签页即清除；公共电脑请勿勾选）
          </label>

          {error && <div className="alert error">{error}</div>}
          {result && (
            <div className={`alert ${result.missing.length ? 'warn' : 'ok'}`}>
              <div>连接成功：环境 {result.envId}</div>
              <div className="counts">
                {Object.entries(result.counts).map(([k, v]) => (
                  <span key={k}>{COLLECTION_LABELS[k] || k}：{v == null ? '集合不存在' : `${v} 条`}</span>
                ))}
              </div>
              {result.missing.length > 0 && (
                <div>请先在云开发控制台创建缺少的集合（权限设为「仅管理端可读写」）：{result.missing.join('、')}</div>
              )}
            </div>
          )}

          <div className="actions">
            {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>返回</button>}
            <button type="button" className="btn ghost" disabled={busy} onClick={test}>{busy ? '连接中…' : '测试连接'}</button>
            <button type="submit" className="btn" disabled={busy}>保存并进入后台</button>
          </div>
        </form>

        <details className="help">
          <summary>需要哪些准备？</summary>
          <ol>
            <li>小程序已开通云开发，并已按小程序仓库 <code>docs/data-model.md</code> 创建 <code>portfolios</code>、<code>series</code>、<code>studio</code> 等集合。</li>
            <li>在微信公众平台「开发管理 → 开发设置」获取 AppSecret。若启用了「IP 白名单」，Cloudflare Workers 的出口 IP 不固定，需要关闭白名单或使用固定 IP 的转发地址。</li>
            <li>本后台通过微信服务端接口 <code>cgi-bin/stable_token</code> 获取调用凭证，再调用 <code>tcb/database*</code> 读写数据库、<code>tcb/uploadfile</code> 上传、<code>tcb/batchdownloadfile</code> 预览、<code>tcb/batchdeletefile</code> 删除文件。</li>
          </ol>
        </details>
      </div>
    </div>
  );
}
