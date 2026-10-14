import { useEffect, useMemo, useRef, useState } from 'react';
import { collectFileIds, ID_PATTERN, newId, portfolioInput } from '../../shared/normalize.ts';
import type { Cover, MediaItem, Portfolio, PortfolioInput } from '../../shared/types.ts';
import { api, errorText } from '../lib/api.ts';
import { useData } from '../lib/data.tsx';
import { displayUrl, extOf, fileName, knownColors, probe, upload, uniqueBase, uploadMedia, useMediaUrls } from '../lib/media.ts';
import { navigate } from '../lib/router.ts';
import { sortPortfolios } from '../preview/model.ts';
import { AlbumPage, FeedPage, GalleryPage } from '../preview/Pages.tsx';
import { Phone } from '../preview/Phone.tsx';
import { STATUS_TEXT } from './Portfolios.tsx';

const EMPTY: PortfolioInput = {
  title: '',
  seriesId: null,
  location: '',
  shootDate: '',
  description: '',
  tags: [],
  cover: null,
  media: [],
  weight: 0,
  status: 'draft',
};

// 新建作品保存后会切换到编辑地址并重新挂载，用它把提示带过去
let flash = '';

interface Pending {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

function imageOf(m: MediaItem): string {
  return m.type === 'video' ? m.poster || '' : m.src;
}

function coverFrom(m: MediaItem, prev: Cover | null): Cover {
  const src = imageOf(m);
  const cover: Cover = { src, width: m.width, height: m.height };
  if (m.type === 'image' && m.thumb) cover.thumb = m.thumb;
  const color = knownColors.get(src) || (prev && prev.src === src ? prev.color : '') || '';
  if (color) cover.color = color;
  return cover;
}

function MediaTile({ m, index, isCover, onMove, onRemove, onCover, onPoster, dragProps }: {
  m: MediaItem;
  index: number;
  isCover: boolean;
  onMove: (d: number) => void;
  onRemove: () => void;
  onCover: () => void;
  onPoster: (f: File) => void;
  dragProps: React.HTMLAttributes<HTMLDivElement>;
}) {
  useMediaUrls();
  const preview = displayUrl(m.type === 'video' ? m.poster : m.thumb || m.src);
  const posterInput = useRef<HTMLInputElement>(null);
  return (
    <div className={`tile ${isCover ? 'is-cover' : ''}`} draggable {...dragProps}>
      <div className="tile-img" style={{ aspectRatio: m.width && m.height ? `${m.width} / ${m.height}` : '3 / 4' }}>
        {preview ? <img src={preview} alt="" /> : <span className="muted small">{m.type === 'video' ? '无封面帧' : '加载中'}</span>}
        <span className="tile-index">{index + 1}</span>
        {m.type === 'video' && <span className="badge-video">视频{m.duration ? ` ${Math.round(m.duration)}s` : ''}</span>}
        {isCover && <span className="badge-cover">封面</span>}
      </div>
      <div className="tile-meta muted small">{m.width && m.height ? `${m.width}×${m.height}` : '尺寸未知'}</div>
      <div className="tile-actions">
        <button type="button" className="icon-btn" title="前移" onClick={() => onMove(-1)}>←</button>
        <button type="button" className="icon-btn" title="后移" onClick={() => onMove(1)}>→</button>
        <button type="button" className="icon-btn" title="设为封面" onClick={onCover} disabled={!imageOf(m)}>★</button>
        {m.type === 'video' && (
          <>
            <button type="button" className="icon-btn" title="更换视频封面帧" onClick={() => posterInput.current?.click()}>🖼</button>
            <input ref={posterInput} type="file" accept="image/*" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPoster(f);
              e.target.value = '';
            }} />
          </>
        )}
        <button type="button" className="icon-btn danger" title="移除" onClick={onRemove}>✕</button>
      </div>
    </div>
  );
}

export function PortfolioEditor({ id: routeId }: { id: string }) {
  const isNew = routeId === 'new';
  const { portfolios, series, upsertPortfolio } = useData();
  const [id, setId] = useState(() => (isNew ? newId('p') : routeId));
  const [form, setForm] = useState<PortfolioInput>(EMPTY);
  const [saved, setSaved] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(() => {
    const v = flash;
    flash = '';
    return v;
  });
  const [cleanup, setCleanup] = useState(true);
  const [tab, setTab] = useState<'album' | 'gallery' | 'feed'>('album');
  const [feedIndex, setFeedIndex] = useState(0);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const sessionUploads = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) {
      setForm(EMPTY);
      setSaved(null);
      return;
    }
    const cached = portfolios.find((p) => p._id === routeId);
    const apply = (p: Portfolio) => {
      setSaved(p);
      setForm(portfolioInput(p));
      setId(p._id);
      setLoading(false);
    };
    setLoading(true);
    // 编辑前总是从云端读取最新数据，避免覆盖他人刚做的修改
    api.portfolio(routeId).then((r) => apply(r.item)).catch((err) => {
      if (cached) apply(cached);
      else {
        setLoadError(errorText(err));
        setLoading(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const dirty = useMemo(() => {
    const base = saved ? portfolioInput(saved) : EMPTY;
    return JSON.stringify(base) !== JSON.stringify(form);
  }, [form, saved]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty || pending.length) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pending.length]);

  const set = <K extends keyof PortfolioInput>(k: K, v: PortfolioInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dir = `portfolios/${id}`;

  async function addFiles(files: FileList | File[]) {
    if (!ID_PATTERN.test(id)) {
      setError('请先填写合法的作品 ID');
      return;
    }
    const list = [...files].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (!list.length) return;
    const items: Pending[] = list.map((f) => ({ key: `${f.name}-${Math.random()}`, name: f.name, progress: 0 }));
    setPending((p) => [...p, ...items]);
    // 依次上传，保持选择顺序
    for (let i = 0; i < list.length; i++) {
      const key = items[i].key;
      try {
        const r = await uploadMedia(dir, list[i], (progress) =>
          setPending((p) => p.map((x) => (x.key === key ? { ...x, progress } : x))));
        r.uploaded.forEach((f) => sessionUploads.current.add(f));
        if (r.color) knownColors.set(imageOf(r.item), r.color);
        setForm((f) => ({ ...f, media: [...f.media, r.item] }));
        setPending((p) => p.filter((x) => x.key !== key));
      } catch (err) {
        setPending((p) => p.map((x) => (x.key === key ? { ...x, error: errorText(err) } : x)));
      }
    }
  }

  async function replacePoster(index: number, file: File) {
    try {
      const info = await probe(file);
      const fileId = await upload(`${dir}/${fileName(`${uniqueBase()}_poster`, extOf(file))}`, file);
      sessionUploads.current.add(fileId);
      if (info.color) knownColors.set(fileId, info.color);
      setForm((f) => {
        const old = f.media[index];
        const media = f.media.map((m, i) => (i === index ? { ...m, poster: fileId } : m));
        // 封面正在使用这个视频的旧封面帧时同步更新
        const cover = f.cover && old && f.cover.src === old.poster ? coverFrom(media[index], f.cover) : f.cover;
        return { ...f, media, cover };
      });
    } catch (err) {
      setError(`封面帧上传失败：${errorText(err)}`);
    }
  }

  function move(from: number, to: number) {
    setForm((f) => {
      if (to < 0 || to >= f.media.length || from === to) return f;
      const media = [...f.media];
      const [m] = media.splice(from, 1);
      media.splice(to, 0, m);
      return { ...f, media };
    });
  }

  function removeMedia(index: number) {
    setForm((f) => {
      const m = f.media[index];
      const media = f.media.filter((_, i) => i !== index);
      const cover = f.cover && m && f.cover.src === imageOf(m) ? null : f.cover;
      return { ...f, media, cover };
    });
  }

  /** 删除本次会话上传、但最终没有保存进作品的文件。 */
  async function dropUnused(keep: PortfolioInput | null) {
    const used = keep ? collectFileIds(keep) : new Set<string>();
    const unused = [...sessionUploads.current].filter((f) => !used.has(f));
    if (!unused.length) return;
    try {
      await api.deleteFiles(unused);
      unused.forEach((f) => sessionUploads.current.delete(f));
    } catch {
      // 清理失败不影响保存结果
    }
  }

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    setError('');
    setNotice('');
    if (!form.title.trim()) {
      setError('请填写作品标题');
      return;
    }
    if (!ID_PATTERN.test(id)) {
      setError('作品 ID 只能包含字母、数字、下划线和短横线，最长 64 位');
      return;
    }
    if (pending.some((p) => !p.error)) {
      setError('还有文件正在上传，请稍候');
      return;
    }
    if (form.status === 'published' && !form.media.length) {
      if (!confirm('该作品还没有图片或视频，确定发布吗？')) return;
    }
    setSaving(true);
    try {
      const input = portfolioInput(form);
      const r = isNew && !saved ? await api.createPortfolio(id, input) : await api.updatePortfolio(id, input, cleanup);
      await dropUnused(input);
      sessionUploads.current.clear();
      setSaved(r.item);
      setForm(portfolioInput(r.item));
      upsertPortfolio(r.item);
      const cleaned = 'cleaned' in r ? (r as { cleaned: string[] }).cleaned.length : 0;
      const message = `已保存${cleaned ? `，并清理 ${cleaned} 个不再使用的文件` : ''}。小程序用户下拉刷新或重新进入即可看到。`;
      setNotice(message);
      if (isNew) {
        flash = message;
        navigate(`/portfolios/${encodeURIComponent(id)}`);
      }
    } catch (err) {
      setError(`保存失败：${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function leave() {
    if (dirty && !confirm('有未保存的修改，确定离开？')) return;
    await dropUnused(saved ? portfolioInput(saved) : null);
    navigate('/portfolios');
  }

  const seriesTitle = useMemo(() => {
    const s = series.find((x) => x._id === form.seriesId && x.status === 'published');
    return s ? s.title : '';
  }, [series, form.seriesId]);

  const previewItem = useMemo(() => ({
    ...form,
    _id: id,
    stats: saved?.stats,
    createdAt: saved?.createdAt || new Date().toISOString(),
  }), [form, id, saved]);

  const galleryItems = useMemo(() => sortPortfolios([
    ...portfolios.filter((p) => p.status === 'published' && p._id !== id),
    previewItem,
  ]), [portfolios, previewItem, id]);

  const publishedSeries = series.filter((s) => s.status === 'published').map((s) => ({ id: s._id, title: s.title }));
  const coverSrc = form.cover?.src || '';

  if (loading) return <div className="center muted">加载中…</div>;
  if (loadError) {
    return (
      <div className="center">
        <div className="alert error">作品加载失败：{loadError}</div>
        <button type="button" className="btn ghost" onClick={() => navigate('/portfolios')}>返回列表</button>
      </div>
    );
  }

  return (
    <div className="split">
      <section className="main">
        <div className="page-head">
          <div>
            <button type="button" className="link" onClick={leave}>← 作品列表</button>
            <h2>{isNew && !saved ? '新建作品' : form.title || '编辑作品'}</h2>
            {saved && <p className="muted small">创建于 {new Date(saved.createdAt).toLocaleString()} · 更新于 {new Date(saved.updatedAt).toLocaleString()}</p>}
          </div>
          <div className="actions">
            {dirty && <span className="tag">未保存</span>}
            <button type="button" className="btn" disabled={saving} onClick={() => save()}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>

        {error && <div className="alert error">{error}</div>}
        {notice && <div className="alert ok">{notice}</div>}

        <form className="form" onSubmit={save}>
          <div className="field-row">
            <label className="field grow">
              <span>标题 *</span>
              <input value={form.title} maxLength={200} onChange={(e) => set('title', e.target.value)} placeholder="例如：山间晨雾" />
            </label>
            <label className="field">
              <span>状态</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value as PortfolioInput['status'])}>
                {(['published', 'draft', 'hidden'] as const).map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field grow">
              <span>拍摄地点</span>
              <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="例如：云南 · 苍山" />
            </label>
            <label className="field">
              <span>拍摄日期</span>
              <input type="date" value={form.shootDate} onChange={(e) => set('shootDate', e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>作品说明</span>
            <textarea rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="可多行，换行会原样显示在作品相册页" />
          </label>
          <div className="field-row">
            <label className="field grow">
              <span>系列</span>
              <select value={form.seriesId || ''} onChange={(e) => set('seriesId', e.target.value || null)}>
                <option value="">不属于任何系列</option>
                {series.map((s) => <option key={s._id} value={s._id}>{s.title}{s.status !== 'published' ? `（${STATUS_TEXT[s.status]}）` : ''}</option>)}
              </select>
            </label>
            <label className="field">
              <span>排序权重</span>
              <input type="number" value={form.weight} onChange={(e) => set('weight', Number(e.target.value) || 0)} />
              <small>越大越靠前；相同时按创建时间倒序</small>
            </label>
          </div>
          <div className="field-row">
            <label className="field grow">
              <span>标签</span>
              <input
                value={form.tags.join('，')}
                onChange={(e) => set('tags', e.target.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean))}
                placeholder="用逗号分隔，可选"
              />
            </label>
            <label className="field">
              <span>作品 ID</span>
              <input value={id} disabled={!isNew || !!saved || form.media.length > 0 || pending.length > 0} onChange={(e) => setId(e.target.value.trim())} />
              <small>{isNew && !saved ? '上传文件前可修改，用于分享链接与存储目录' : '创建后不可修改'}</small>
            </label>
          </div>

          <div className="section-head">
            <h3>图片与视频（{form.media.length}）</h3>
            <span className="muted small">拖动排序；第一张默认作为瀑布流封面。上传时自动读取宽高、生成缩略图和视频封面帧。</span>
          </div>
          <div
            className={`dropzone ${dropActive ? 'on' : ''}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropActive(true); } }}
            onDragLeave={() => setDropActive(false)}
            onDrop={(e) => {
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              setDropActive(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInput.current?.click()}
          >
            <strong>点击选择或拖入图片 / 视频</strong>
            <span className="muted small">支持多选。视频建议 H.264 编码的 MP4。</span>
            <input ref={fileInput} type="file" multiple accept="image/*,video/*" hidden onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }} />
          </div>

          {pending.length > 0 && (
            <div className="uploads">
              {pending.map((p) => (
                <div key={p.key} className={`upload-row ${p.error ? 'error' : ''}`}>
                  <span className="grow">{p.name}</span>
                  {p.error ? (
                    <>
                      <span className="small">{p.error}</span>
                      <button type="button" className="link" onClick={() => setPending((l) => l.filter((x) => x.key !== p.key))}>关闭</button>
                    </>
                  ) : (
                    <progress value={p.progress} max={1} />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="tiles">
            {form.media.map((m, i) => (
              <MediaTile
                key={`${m.src}-${i}`}
                m={m}
                index={i}
                isCover={coverSrc ? coverSrc === imageOf(m) : i === 0}
                onMove={(d) => move(i, i + d)}
                onRemove={() => removeMedia(i)}
                onCover={() => set('cover', i === 0 && !form.cover ? null : coverFrom(m, form.cover))}
                onPoster={(f) => replacePoster(i, f)}
                dragProps={{
                  onDragStart: (e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; },
                  onDragOver: (e) => { if (dragFrom !== null) e.preventDefault(); },
                  onDrop: (e) => {
                    if (dragFrom === null) return;
                    e.preventDefault();
                    e.stopPropagation();
                    move(dragFrom, i);
                    setDragFrom(null);
                  },
                  onDragEnd: () => setDragFrom(null),
                  onClick: () => { setTab('feed'); setFeedIndex(i); },
                }}
              />
            ))}
          </div>

          <div className="section-head">
            <h3>封面</h3>
          </div>
          <div className="field-row">
            <label className="field grow">
              <span>封面来源</span>
              <select
                value={form.cover ? 'custom' : 'first'}
                onChange={(e) => set('cover', e.target.value === 'first' || !form.media[0] ? null : coverFrom(form.media[0], form.cover))}
              >
                <option value="first">自动使用第一个媒体</option>
                <option value="custom" disabled={!form.media.length}>指定（在上方媒体上点 ★）</option>
              </select>
            </label>
            <label className="field">
              <span>占位底色</span>
              <div className="input-with-btn">
                <input
                  type="color"
                  value={form.cover?.color || '#f2f2f2'}
                  disabled={!form.cover}
                  onChange={(e) => form.cover && set('cover', { ...form.cover, color: e.target.value })}
                />
                <span className="muted small">{form.cover ? form.cover.color || '默认' : '指定封面后可设置'}</span>
              </div>
            </label>
          </div>

          {saved && (
            <label className="check">
              <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} />
              保存时从云存储删除已移除的媒体文件（仅限 portfolios/{id}/ 目录）
            </label>
          )}
          <div className="actions">
            <button type="button" className="btn ghost" onClick={leave}>返回</button>
            <button type="submit" className="btn" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </form>
      </section>

      <aside className="preview-pane">
        <div className="preview-head">
          <div className="seg-control">
            <button type="button" className={tab === 'album' ? 'on' : ''} onClick={() => setTab('album')}>作品相册</button>
            <button type="button" className={tab === 'gallery' ? 'on' : ''} onClick={() => setTab('gallery')}>作品瀑布流</button>
            <button type="button" className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>发现</button>
          </div>
          {form.status !== 'published' && <span className="muted small">当前为「{STATUS_TEXT[form.status]}」，发布后小程序中才可见</span>}
        </div>
        {tab === 'album' && (
          <Phone navigation="back" onBack={() => setTab('gallery')}>
            <AlbumPage p={previewItem} seriesTitle={seriesTitle} onPreview={(i) => { setFeedIndex(i); setTab('feed'); }} />
          </Phone>
        )}
        {tab === 'gallery' && (
          <Phone title="南北摄影" tab="gallery" onTab={(t) => t === 'discover' && setTab('feed')}>
            <GalleryPage items={galleryItems} series={publishedSeries} highlightId={id} onOpen={(oid) => oid === id && setTab('album')} />
          </Phone>
        )}
        {tab === 'feed' && (
          <Phone navigation="custom" tab="discover" dark onTab={(t) => t === 'gallery' && setTab('gallery')}>
            <FeedPage p={previewItem} seriesTitle={seriesTitle} index={feedIndex} />
          </Phone>
        )}
      </aside>
    </div>
  );
}
