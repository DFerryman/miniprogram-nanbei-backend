import { useMemo, useState } from 'react';
import type { Portfolio, Status } from '../../shared/types.ts';
import { api, errorText } from '../lib/api.ts';
import { useData } from '../lib/data.tsx';
import { displayUrl, useMediaUrls } from '../lib/media.ts';
import { navigate } from '../lib/router.ts';
import { coverOf, formatCount, metaLine, sortPortfolios } from '../preview/model.ts';
import { AlbumPage, FeedPage, GalleryPage } from '../preview/Pages.tsx';
import { Phone, type Tab } from '../preview/Phone.tsx';

export const STATUS_TEXT: Record<Status, string> = { published: '已发布', draft: '草稿', hidden: '已下架' };

function Thumb({ p }: { p: Portfolio }) {
  useMediaUrls();
  const cover = coverOf(p.cover, p.media);
  const url = displayUrl(cover.thumb || cover.src);
  return (
    <div className="card-cover" style={{ background: cover.color || 'var(--placeholder)' }}>
      {url ? <img src={url} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="muted">{cover.src ? '' : '无封面'}</span>}
      {p.media.some((m) => m.type === 'video') && <span className="badge-video">视频</span>}
    </div>
  );
}

export function Portfolios() {
  const { portfolios, series, loading, error, reload, removePortfolio } = useData();
  const [status, setStatus] = useState<'' | Status>('');
  const [seriesId, setSeriesId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [deleting, setDeleting] = useState<Portfolio | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<Tab>('gallery');
  const [openId, setOpenId] = useState('');

  const seriesTitle = useMemo(() => new Map(series.map((s) => [s._id, s.title])), [series]);
  const publishedSeries = series.filter((s) => s.status === 'published').map((s) => ({ id: s._id, title: s.title }));
  const publishedSeriesIds = new Set(publishedSeries.map((s) => s.id));
  // 小程序只展示已发布作品，系列标题只取已发布系列
  const published = useMemo(() => sortPortfolios(portfolios.filter((p) => p.status === 'published')), [portfolios]);

  const list = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return portfolios.filter((p) =>
      (!status || p.status === status)
      && (!seriesId || (seriesId === '-' ? !p.seriesId : p.seriesId === seriesId))
      && (!k || [p.title, p.location, p.description, p._id].some((t) => t.toLowerCase().includes(k))));
  }, [portfolios, status, seriesId, keyword]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { published: 0, draft: 0, hidden: 0 };
    portfolios.forEach((p) => (c[p.status] += 1));
    return c;
  }, [portfolios]);

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      const r = await api.deletePortfolio(deleting._id, deleteFiles);
      removePortfolio(deleting._id);
      setNotice(`已删除「${deleting.title}」${r.cleaned.length ? `，并清理 ${r.cleaned.length} 个云存储文件` : ''}`);
      setDeleting(null);
    } catch (err) {
      alert(`删除失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const open = openId ? published.find((p) => p._id === openId) : null;
  const feedItem = published[0];
  const titleOf = (id: string | null) => (id && publishedSeriesIds.has(id) ? seriesTitle.get(id) || '' : '');

  return (
    <div className="split">
      <section className="main">
        <div className="page-head">
          <div>
            <h2>作品</h2>
            <p className="muted">
              共 {portfolios.length} 件 · 已发布 {counts.published} · 草稿 {counts.draft} · 已下架 {counts.hidden}
            </p>
          </div>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={reload} disabled={loading}>{loading ? '加载中…' : '刷新'}</button>
            <button type="button" className="btn" onClick={() => navigate('/portfolios/new')}>+ 新建作品</button>
          </div>
        </div>

        <div className="filters">
          <input placeholder="搜索标题、地点、说明或 ID" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value as Status | '')}>
            <option value="">全部状态</option>
            <option value="published">已发布</option>
            <option value="draft">草稿</option>
            <option value="hidden">已下架</option>
          </select>
          <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
            <option value="">全部系列</option>
            <option value="-">未分组</option>
            {series.map((s) => <option key={s._id} value={s._id}>{s.title}</option>)}
          </select>
        </div>

        {notice && <div className="alert ok" onClick={() => setNotice('')}>{notice}</div>}
        {error && <div className="alert error">加载失败：{error} <button type="button" className="link" onClick={reload}>重试</button></div>}
        {!loading && !error && !portfolios.length && (
          <div className="empty">
            <p>当前环境还没有作品。</p>
            <button type="button" className="btn" onClick={() => navigate('/portfolios/new')}>创建第一件作品</button>
          </div>
        )}

        <div className="cards">
          {list.map((p) => (
            <article key={p._id} className="card">
              <button type="button" className="card-open" onClick={() => navigate(`/portfolios/${encodeURIComponent(p._id)}`)}>
                <Thumb p={p} />
              </button>
              <div className="card-body">
                <div className="card-title">
                  <span className={`status ${p.status}`}>{STATUS_TEXT[p.status]}</span>
                  <strong>{p.title || '未命名作品'}</strong>
                </div>
                <div className="muted small">{metaLine(p) || '未填写地点和日期'}</div>
                <div className="muted small">
                  {p.seriesId ? seriesTitle.get(p.seriesId) || `系列 ${p.seriesId}` : '未分组'} · {p.media.length} 个媒体 · 权重 {p.weight}
                </div>
                <div className="muted small">♡ {formatCount(p.stats.likes)} · ☆ {formatCount(p.stats.favorites)} · ↗ {formatCount(p.stats.shares)}</div>
                <div className="card-actions">
                  <button type="button" className="btn small" onClick={() => navigate(`/portfolios/${encodeURIComponent(p._id)}`)}>编辑</button>
                  {p.status === 'published' && (
                    <button type="button" className="btn small ghost" onClick={() => { setOpenId(p._id); setTab('gallery'); }}>预览</button>
                  )}
                  <button type="button" className="btn small ghost danger" onClick={() => { setDeleting(p); setDeleteFiles(true); }}>删除</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <aside className="preview-pane">
        <div className="preview-head">
          <strong>小程序预览</strong>
          <span className="muted small">仅显示已发布作品，排序与小程序一致</span>
        </div>
        {open ? (
          <Phone navigation="back" onBack={() => setOpenId('')}>
            <AlbumPage p={open} seriesTitle={titleOf(open.seriesId)} />
          </Phone>
        ) : (
          <Phone
            title="摄影工作室"
            navigation={tab === 'discover' ? 'custom' : 'default'}
            tab={tab}
            dark={tab === 'discover'}
            onTab={(t) => (t === 'about' ? navigate('/about') : t !== 'mine' && setTab(t))}
          >
            {tab === 'discover' ? (
              feedItem ? <FeedPage p={feedItem} seriesTitle={titleOf(feedItem.seriesId)} /> : <div className="mp-feed"><div className="state">暂无作品</div></div>
            ) : (
              <GalleryPage items={published} series={publishedSeries} onOpen={setOpenId} />
            )}
          </Phone>
        )}
      </aside>

      {deleting && (
        <div className="modal-mask" onClick={() => !busy && setDeleting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>删除作品</h3>
            <p>确定删除「{deleting.title || deleting._id}」？删除后小程序中将无法再访问该作品，用户收藏列表中也不再显示。</p>
            <label className="check">
              <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
              同时删除云存储 portfolios/{deleting._id}/ 目录下该作品引用的图片和视频
            </label>
            <div className="actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setDeleting(null)}>取消</button>
              <button type="button" className="btn danger" disabled={busy} onClick={confirmDelete}>{busy ? '删除中…' : '删除'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
