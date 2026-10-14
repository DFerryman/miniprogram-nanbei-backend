import { useState } from 'react';
import { ID_PATTERN, newId } from '../../shared/normalize.ts';
import type { Series, SeriesInput } from '../../shared/types.ts';
import { api, errorText } from '../lib/api.ts';
import { useData } from '../lib/data.tsx';
import { STATUS_TEXT } from './Portfolios.tsx';

interface Draft extends SeriesInput {
  _id: string;
  isNew: boolean;
}

function toDraft(s?: Series): Draft {
  return s
    ? { _id: s._id, title: s.title, description: s.description, cover: s.cover, weight: s.weight, status: s.status, isNew: false }
    : { _id: newId('s'), title: '', description: '', cover: null, weight: 0, status: 'published', isNew: true };
}

/** 系列：作品页顶部的筛选栏，存在已发布系列时才在小程序中显示。 */
export function SeriesPage() {
  const { series, portfolios, reload } = useData();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const countOf = (id: string) => portfolios.filter((p) => p.seriesId === id).length;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    if (!draft.title.trim()) return setError('请填写系列名称');
    if (!ID_PATTERN.test(draft._id)) return setError('系列 ID 只能包含字母、数字、下划线和短横线');
    setBusy(true);
    setError('');
    try {
      const { _id, isNew, ...input } = draft;
      if (isNew) await api.createSeries(_id, input);
      else await api.updateSeries(_id, input);
      setDraft(null);
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Series) {
    const n = countOf(s._id);
    if (!confirm(`删除系列「${s.title}」？${n ? `其中 ${n} 件作品将变为未分组，作品本身不受影响。` : ''}`)) return;
    try {
      await api.deleteSeries(s._id);
      await reload();
    } catch (err) {
      alert(`删除失败：${errorText(err)}`);
    }
  }

  return (
    <section className="main narrow">
      <div className="page-head">
        <div>
          <h2>系列</h2>
          <p className="muted">已发布的系列会显示在小程序「作品」页顶部的筛选栏中，按权重倒序排列。</p>
        </div>
        <button type="button" className="btn" onClick={() => { setDraft(toDraft()); setError(''); }}>+ 新建系列</button>
      </div>

      {draft && (
        <form className="form panel" onSubmit={save}>
          <h3>{draft.isNew ? '新建系列' : `编辑「${draft.title}」`}</h3>
          <div className="field-row">
            <label className="field grow">
              <span>名称 *</span>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="例如：山野" />
            </label>
            <label className="field">
              <span>系列 ID</span>
              <input value={draft._id} disabled={!draft.isNew} onChange={(e) => setDraft({ ...draft, _id: e.target.value.trim() })} />
            </label>
          </div>
          <label className="field">
            <span>说明</span>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>状态</span>
              <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Series['status'] })}>
                {(['published', 'draft', 'hidden'] as const).map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}
              </select>
            </label>
            <label className="field">
              <span>排序权重</span>
              <input type="number" value={draft.weight} onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) || 0 })} />
            </label>
          </div>
          {error && <div className="alert error">{error}</div>}
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>取消</button>
            <button type="submit" className="btn" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
          </div>
        </form>
      )}

      <table className="table">
        <thead>
          <tr><th>名称</th><th>ID</th><th>状态</th><th>权重</th><th>作品数</th><th /></tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s._id}>
              <td><strong>{s.title}</strong>{s.description && <div className="muted small">{s.description}</div>}</td>
              <td className="muted small">{s._id}</td>
              <td><span className={`status ${s.status}`}>{STATUS_TEXT[s.status]}</span></td>
              <td>{s.weight}</td>
              <td>{countOf(s._id)}</td>
              <td className="row-actions">
                <button type="button" className="link" onClick={() => { setDraft(toDraft(s)); setError(''); }}>编辑</button>
                <button type="button" className="link danger" onClick={() => remove(s)}>删除</button>
              </td>
            </tr>
          ))}
          {!series.length && <tr><td colSpan={6} className="muted">还没有系列</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
