import { useEffect, useMemo, useState } from 'react';
import { applyMerge, diffFields, same, type FieldMerge } from '../../shared/merge.ts';
import { ID_PATTERN, newId, seriesInput } from '../../shared/normalize.ts';
import type { Portfolio, Series, SeriesInput, Status } from '../../shared/types.ts';
import { api, ApiError, errorText } from '../lib/api.ts';
import { OthersBanner, STATE_TEXT, useCollab, useEditState, useOthersOn, usePresenceReport } from '../lib/collab.tsx';
import { useData } from '../lib/data.tsx';
import { displayUrl, useMediaUrls } from '../lib/media.ts';
import { coverOf, sortPortfolios } from '../preview/model.ts';
import { GalleryPage } from '../preview/Pages.tsx';
import { Phone } from '../preview/Phone.tsx';
import { MergeDialog, type FieldDef } from './MergeDialog.tsx';
import { STATUS_TEXT } from './Portfolios.tsx';

interface Draft extends SeriesInput {
  _id: string;
  isNew: boolean;
  /** 打开编辑框时的版本，保存时据此检查是否有人先保存了。 */
  base: Series | null;
}

const KEYS = ['title', 'description', 'status', 'weight', 'cover'] as const;
const EMPTY_INPUT: SeriesInput = { title: '', description: '', cover: null, weight: 0, status: 'published' };

function inputOf(d: Draft): SeriesInput {
  return seriesInput(d);
}

const STATUS_HINT: Record<Status, string> = {
  published: '显示在小程序筛选栏中',
  draft: '不显示，作品仍可正常浏览',
  hidden: '不显示，作品仍可正常浏览',
};

function toDraft(s?: Series): Draft {
  return s
    ? { _id: s._id, title: s.title, description: s.description, cover: s.cover, weight: s.weight, status: s.status, isNew: false, base: s }
    : { _id: newId('s'), ...EMPTY_INPUT, isNew: true, base: null };
}

/** 系列中最靠前的几件作品封面，拼成缩略图。 */
function Mosaic({ items }: { items: Portfolio[] }) {
  useMediaUrls();
  const covers = items.slice(0, 3).map((p) => coverOf(p.cover, p.media));
  if (!covers.length) return <div className="mosaic empty"><span>暂无作品</span></div>;
  return (
    <div className={`mosaic n${covers.length}`}>
      {covers.map((c, i) => {
        const url = displayUrl(c.thumb || c.src);
        return (
          <div key={i} className="mosaic-cell" style={{ background: c.color || 'var(--placeholder)' }}>
            {url && <img src={url} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />}
          </div>
        );
      })}
    </div>
  );
}

/** 系列：小程序「作品」页顶部的筛选栏，存在已发布系列时才显示。 */
export function SeriesPage({ me }: { me: string }) {
  const { series, portfolios, reload } = useData();
  const { presence } = useCollab();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [merge, setMerge] = useState<{ theirs: Series; fields: FieldMerge[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');

  // 与小程序一致：按权重倒序、创建时间倒序
  const ordered = useMemo(() => sortPortfolios(series), [series]);
  const byId = useMemo(() => {
    const map = new Map<string, Portfolio[]>();
    sortPortfolios(portfolios).forEach((p) => {
      const key = p.seriesId || '';
      map.set(key, [...(map.get(key) || []), p]);
    });
    return map;
  }, [portfolios]);

  const published = useMemo(() => sortPortfolios(portfolios.filter((p) => p.status === 'published')), [portfolios]);
  const barSeries = ordered.filter((s) => s.status === 'published').map((s) => ({ id: s._id, title: s.title }));
  const ungrouped = byId.get('')?.length || 0;

  const dirty = !!draft && !same(inputOf(draft), draft.base ? seriesInput(draft.base) : EMPTY_INPUT);
  const editState = useEditState(dirty);
  usePresenceReport('series', draft && !draft.isNew ? draft._id : null, draft ? editState : 'viewing');
  const others = useOthersOn('series', draft && !draft.isNew ? draft._id : '');
  // 编辑框打开期间，列表（其他窗口保存后会自动刷新）中的版本比编辑框的新：说明有人先保存了
  const latest = draft?.base ? series.find((s) => s._id === draft.base!._id) : undefined;
  const staleBy = draft?.base && latest && latest.rev > draft.base.rev ? latest : null;
  const deletedMeanwhile = !!draft?.base && !series.some((s) => s._id === draft.base!._id);
  const busySeries = useMemo(() => {
    const map = new Map<string, string>();
    (presence?.tabs || []).filter((t) => !t.self && t.online && t.view === 'series' && t.viewId).forEach((t) => map.set(t.viewId!, STATE_TEXT[t.state]));
    return map;
  }, [presence]);

  // 没有修改时，直接把编辑框更新为最新内容
  useEffect(() => {
    if (staleBy && !dirty) setDraft(toDraft(staleBy));
  }, [staleBy, dirty]);

  function close() {
    if (busy) return;
    if (dirty && !confirm('有未保存的修改，确定关闭？')) return;
    setDraft(null);
    setMerge(null);
  }

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !merge && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function open(s?: Series) {
    setDraft(toDraft(s));
    setMerge(null);
    setError('');
  }

  function startMerge(theirs: Series) {
    if (!draft) return;
    const base = draft.base ? seriesInput(draft.base) : EMPTY_INPUT;
    const fields = diffFields(base, inputOf(draft), seriesInput(theirs), KEYS);
    if (!fields.some((f) => f.state === 'mine' || f.state === 'conflict')) {
      setDraft(toDraft(theirs));
      setError('');
      return;
    }
    setMerge({ theirs, fields });
  }

  function applyChoice(choice: Record<string, 'mine' | 'theirs'>) {
    if (!draft || !merge) return;
    const merged = applyMerge(merge.fields as FieldMerge<(typeof KEYS)[number]>[], inputOf(draft), seriesInput(merge.theirs), choice);
    setDraft({ ...merged, _id: merge.theirs._id, isNew: false, base: merge.theirs });
    setMerge(null);
    setError(`已合并到最新版本（第 ${merge.theirs.rev} 版），请检查后保存。`);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    if (!draft.title.trim()) return setError('请填写系列名称');
    if (!ID_PATTERN.test(draft._id)) return setError('系列 ID 只能包含字母、数字、下划线和短横线，最长 64 位');
    setBusy(true);
    setError('');
    try {
      const { _id, isNew, base } = draft;
      const input = inputOf(draft);
      if (isNew || !base) await api.createSeries(_id, input);
      else await api.updateSeries(_id, base.rev, input);
      setDraft(null);
      setNotice(`已保存「${input.title.trim()}」`);
      setSelected(_id);
      await reload(true);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError && (err.code === 'CONFLICT' || err.code === 'EXISTS') && err.data?.current) startMerge(err.data.current as Series);
      if (err instanceof ApiError && err.code === 'GONE') void reload(true);
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Series) {
    const n = byId.get(s._id)?.length || 0;
    const editing = busySeries.get(s._id);
    if (!confirm(`删除系列「${s.title}」？${n ? `其中 ${n} 件作品将变为未分组，作品本身不受影响。` : ''}${editing ? `\n\n注意：其他窗口${editing}此系列。` : ''}`)) return;
    try {
      const r = await api.deleteSeries(s._id, s.rev);
      setNotice(r.already ? `「${s.title}」已被其他窗口删除` : `已删除「${s.title}」${r.detached ? `，${r.detached} 件作品变为未分组` : ''}`);
      if (selected === s._id) setSelected('');
      await reload(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        await reload(true);
        alert(`「${s.title}」刚被其他窗口修改，已刷新。请确认最新内容后再删除。`);
      } else {
        alert(`删除失败：${errorText(err)}`);
      }
    }
  }

  return (
    <div className="split">
      <section className="main">
        <div className="page-head">
          <div>
            <h2>系列</h2>
            <p className="muted">
              共 {series.length} 个系列，{barSeries.length} 个已发布。已发布的系列按权重从高到低显示在小程序「作品」页顶部的筛选栏中。
            </p>
          </div>
          <button type="button" className="btn" onClick={() => open()}>+ 新建系列</button>
        </div>

        {notice && <div className="alert ok" onClick={() => setNotice('')}>{notice}</div>}

        {!series.length ? (
          <div className="empty">
            <p>还没有系列。没有已发布的系列时，小程序不显示筛选栏。</p>
            <button type="button" className="btn" onClick={() => open()}>创建第一个系列</button>
          </div>
        ) : (
          <ol className="series-list">
            {ordered.map((s, i) => {
              const items = byId.get(s._id) || [];
              const live = items.filter((p) => p.status === 'published').length;
              return (
                <li
                  key={s._id}
                  className={`series-card ${selected === s._id ? 'on' : ''} ${s.status !== 'published' ? 'off' : ''}`}
                  onClick={() => setSelected(selected === s._id ? '' : s._id)}
                >
                  <span className="series-rank">{String(i + 1).padStart(2, '0')}</span>
                  <Mosaic items={items} />
                  <div className="series-info">
                    <div className="series-name">
                      <h3>{s.title}</h3>
                      <span className={`status ${s.status}`}>{STATUS_TEXT[s.status]}</span>
                    </div>
                    <p className="series-desc">{s.description || <span className="muted">未填写说明</span>}</p>
                    {busySeries.has(s._id) && <div className="busy-chip"><span className="dot editing" />其他窗口{busySeries.get(s._id)}</div>}
                    <dl className="series-meta">
                      <div><dt>作品</dt><dd>{items.length}<small> 件 · {live} 件已发布</small></dd></div>
                      <div><dt>权重</dt><dd>{s.weight}</dd></div>
                      <div><dt>ID</dt><dd className="mono">{s._id}</dd></div>
                    </dl>
                  </div>
                  <div className="series-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn small" onClick={() => open(s)}>编辑</button>
                    <button type="button" className="btn small ghost danger" onClick={() => remove(s)}>删除</button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {ungrouped > 0 && (
          <p className="muted small">另有 {ungrouped} 件作品未归入任何系列，只在「全部」中显示。可在作品编辑页选择系列。</p>
        )}
      </section>

      <aside className="preview-pane">
        <div className="preview-head">
          <strong>筛选栏预览</strong>
          <span className="muted small">点选左侧系列，查看小程序中筛选后的作品</span>
        </div>
        <Phone title="摄影工作室" tab="gallery">
          <GalleryPage items={published} series={barSeries} activeSeries={barSeries.some((b) => b.id === selected) ? selected : ''} />
        </Phone>
      </aside>

      {draft && (
        <div className="modal-mask" onClick={close}>
          <form className="modal series-modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <div className="modal-head">
              <h3>{draft.isNew ? '新建系列' : '编辑系列'}</h3>
              <button type="button" className="icon-btn" aria-label="关闭" onClick={close} disabled={busy}>✕</button>
            </div>
            <OthersBanner others={others} me={me} noun="系列" />
            {deletedMeanwhile && (
              <div className="alert error">
                此系列已被其他窗口删除，你的修改尚未保存。
                <div className="inline-buttons">
                  <button type="button" className="btn small" onClick={() => setDraft({ ...draft, isNew: true, base: null })}>以相同 ID 重新创建</button>
                </div>
              </div>
            )}
            {staleBy && dirty && !merge && (
              <div className="alert warn">
                此系列已被其他窗口保存为第 {staleBy.rev} 版，你的修改尚未保存。
                <div className="inline-buttons">
                  <button type="button" className="btn small" onClick={() => startMerge(staleBy)}>查看最新内容并合并</button>
                </div>
              </div>
            )}
            <label className="field">
              <span>名称 *</span>
              <input autoFocus value={draft.title} maxLength={20} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="例如：山野" />
              <small>显示在筛选栏中，建议 2–6 个字</small>
            </label>
            <label className="field">
              <span>说明</span>
              <textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="可选，供后台识别" />
            </label>
            <div className="field">
              <span>状态</span>
              <div className="seg-control full">
                {(['published', 'draft', 'hidden'] as const).map((st) => (
                  <button type="button" key={st} className={draft.status === st ? 'on' : ''} onClick={() => setDraft({ ...draft, status: st })}>
                    {STATUS_TEXT[st]}
                  </button>
                ))}
              </div>
              <small>{STATUS_HINT[draft.status]}</small>
            </div>
            <div className="field-row">
              <label className="field">
                <span>排序权重</span>
                <input type="number" value={draft.weight} onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) || 0 })} />
                <small>越大越靠前</small>
              </label>
              <label className="field">
                <span>系列 ID</span>
                <input className="mono" value={draft._id} disabled={!draft.isNew} onChange={(e) => setDraft({ ...draft, _id: e.target.value.trim() })} />
                <small>{draft.isNew ? '作品通过此 ID 关联系列' : '创建后不可修改'}</small>
              </label>
            </div>
            {error && <div className="alert error">{error}</div>}
            <div className="actions">
              <button type="button" className="btn ghost" onClick={close} disabled={busy}>取消</button>
              <button type="submit" className="btn" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
            </div>
          </form>
        </div>
      )}
      {draft && merge && (
        <MergeDialog
          title="合并系列修改"
          subtitle={<>其他窗口已保存第 {merge.theirs.rev} 版（{new Date(merge.theirs.updatedAt).toLocaleString()}）。</>}
          fields={merge.fields}
          defs={SERIES_FIELDS}
          onApply={applyChoice}
          onDiscardMine={() => { setDraft(toDraft(merge.theirs)); setMerge(null); setError(''); }}
          onCancel={() => setMerge(null)}
        />
      )}
    </div>
  );
}

const SERIES_FIELDS: FieldDef[] = [
  { key: 'title', label: '名称' },
  { key: 'description', label: '说明' },
  { key: 'status', label: '状态', render: (v) => STATUS_TEXT[v as Status] },
  { key: 'weight', label: '排序权重' },
  { key: 'cover', label: '封面', render: (v) => (v ? String((v as { src: string }).src).split('/').pop() : '无') },
];
