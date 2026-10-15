import { useState } from 'react';
import { api, errorText, type VerifyResult } from '../lib/api.ts';
import { getUploadMode, saveUploadMode, type UploadMode } from '../lib/config.ts';

const COLLECTION_LABELS: Record<string, string> = {
  portfolios: '作品',
  series: '系列',
  studio: '工作室信息',
  users: '用户',
  likes: '点赞',
};

export function Setup({ onDone }: { onDone: () => void }) {
  const [uploadMode, setUploadMode] = useState(getUploadMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VerifyResult | null>(null);

  async function test() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api.verify());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    saveUploadMode(uploadMode);
    onDone();
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>后台设置</h1>
        <p className="muted">云开发连接已由管理员统一配置。这里的上传偏好仅保存在当前浏览器中。</p>
        <form onSubmit={submit} className="form">
          <label className="field">
            <span>上传方式</span>
            <select value={uploadMode} disabled={busy} onChange={(e) => setUploadMode(e.target.value as UploadMode)}>
              <option value="proxy">经 Worker 中转（默认，单个文件不超过约 95 MB）</option>
              <option value="direct">浏览器直传云存储（需配置本站域名的 CORS）</option>
            </select>
            <small>通常保持默认即可。大文件可选择直传，并请管理员在云开发控制台配置安全域名与存储 CORS。</small>
          </label>

          {error && <div className="alert error" role="alert">{error}</div>}
          {result && (
            <div className={`alert ${result.missing.length ? 'warn' : 'ok'}`} role="status">
              <div>连接成功：环境 {result.envId}</div>
              <div className="counts">
                {Object.entries(result.counts).map(([k, v]) => (
                  <span key={k}>{COLLECTION_LABELS[k] || k}：{v == null ? '集合不存在' : `${v} 条`}</span>
                ))}
              </div>
              {result.missing.length > 0 && (
                <div>请管理员在云开发控制台创建缺少的集合（权限设为「仅管理端可读写」）：{result.missing.join('、')}</div>
              )}
            </div>
          )}

          <div className="actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={onDone}>返回</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={test}>{busy ? '连接中…' : '测试连接'}</button>
            <button type="submit" className="btn" disabled={busy}>保存设置</button>
          </div>
        </form>
      </div>
    </div>
  );
}
