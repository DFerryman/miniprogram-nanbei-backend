// 小程序页面的网页版复刻，尺寸按 375pt 屏宽换算（750rpx = 375px），样式取自小程序 wxss。
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONTACT_LABELS, type Contact, type Studio } from '../../shared/types.ts';
import { contactVisible } from '../../shared/normalize.ts';
import { displayUrl, useMediaUrls } from '../lib/media.ts';
import { coverOf, formatCount, metaLine, type PreviewPortfolio } from './model.ts';

export const SCREEN_WIDTH = 375;

function Img({ src, color, className, fit = 'cover', height }: { src: string; color?: string; className?: string; fit?: 'cover' | 'contain'; height?: number }) {
  useMediaUrls();
  const url = displayUrl(src);
  // 与小程序一致：加载前显示主色占位，加载完成后淡入。每个地址一个新元素，已缓存的图片在挂载时直接显示。
  const show = (el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth) el.classList.add('on');
  };
  return (
    <div className={`mp-ph ${className || ''}`} style={{ background: color || '#f2f2f2', height }}>
      {url && <img key={url} ref={show} src={url} alt="" className="fade" style={{ objectFit: fit }} onLoad={(e) => e.currentTarget.classList.add('on')} />}
    </div>
  );
}

// ---------- 作品（瀑布流） ----------

const M_PADDING = 8;
const M_GAP = 8;
const CAPTION = 50;

function masonryHeight(width: number, height: number, colWidth: number) {
  const known = width > 0 && height > 0;
  const ratio = known ? Math.min(2, Math.max(0.5, height / width)) : 4 / 3;
  return Math.round(colWidth * ratio);
}

interface GalleryProps {
  items: PreviewPortfolio[];
  series: { id: string; title: string }[];
  highlightId?: string;
  onOpen?: (id: string) => void;
}

export function GalleryPage({ items, series, highlightId, onOpen }: GalleryProps) {
  const [active, setActive] = useState('');
  const colWidth = Math.floor((SCREEN_WIDTH - M_PADDING * 2 - M_GAP) / 2);
  const cols = useMemo(() => {
    const out: { p: PreviewPortfolio; h: number; src: string; color: string }[][] = [[], []];
    const heights = [0, 0];
    items
      .filter((p) => !active || p.seriesId === active)
      .forEach((p) => {
        const cover = coverOf(p.cover, p.media);
        const h = masonryHeight(cover.width, cover.height, colWidth);
        const c = heights[0] <= heights[1] ? 0 : 1;
        out[c].push({ p, h, src: cover.thumb || cover.src, color: cover.color });
        heights[c] += h + CAPTION + M_GAP;
      });
    return out;
  }, [items, active, colWidth]);

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 只滚动手机屏幕内部，不带动整个页面
    const cell = root.current?.querySelector<HTMLElement>('.cell.highlight');
    const body = root.current?.closest('.mp-body');
    if (cell && body) body.scrollTop = cell.offsetTop - body.clientHeight / 2 + cell.offsetHeight / 2;
  }, [highlightId]);

  return (
    <div className="mp-gallery" ref={root}>
      {series.length > 0 && (
        <div className="series-bar">
          <span className={`series-item ${active === '' ? 'on' : ''}`} onClick={() => setActive('')}>全部</span>
          {series.map((s) => (
            <span key={s.id} className={`series-item ${active === s.id ? 'on' : ''}`} onClick={() => setActive(s.id)}>{s.title}</span>
          ))}
        </div>
      )}
      <div className="masonry" style={{ padding: `${M_PADDING}px ${M_PADDING}px 0` }}>
        {cols.map((col, c) => (
          <div key={c} className="col" style={{ width: colWidth }}>
            {col.map(({ p, h, src, color }) => (
              <div
                key={p._id}
                className={`cell ${p._id === highlightId ? 'highlight' : ''}`}
                style={{ marginBottom: M_GAP }}
                onClick={() => onOpen?.(p._id)}
              >
                <Img src={src} color={color} height={h} />
                <div className="cap">
                  <span className="title">{p.title || '未命名作品'}</span>
                  {metaLine(p) && <span className="meta">{metaLine(p)}</span>}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="foot">{items.length ? <div className="end" /> : <span className="foot-text">暂无作品</span>}</div>
    </div>
  );
}

// ---------- 作品相册 ----------

const A_GAP = 5;

function Icon({ name, size }: { name: string; size: number }) {
  return <img src={`/icons/${name}.svg`} width={size} height={size} alt="" />;
}

export function AlbumPage({ p, seriesTitle, onPreview }: { p: PreviewPortfolio; seriesTitle: string; onPreview?: (i: number) => void }) {
  const [layout, setLayout] = useState<'single' | 'masonry'>('single');
  const cover = coverOf(p.cover, p.media);
  const color = cover.color;
  const colWidth = Math.floor((SCREEN_WIDTH - A_GAP * 3) / 2);
  const meta = metaLine(p);

  const cols = useMemo(() => {
    const out: { i: number; h: number }[][] = [[], []];
    const heights = [0, 0];
    p.media.forEach((m, i) => {
      const ratio = m.width > 0 && m.height > 0 ? m.height / m.width : 4 / 3;
      const h = Math.round(colWidth * ratio);
      const c = heights[0] <= heights[1] ? 0 : 1;
      out[c].push({ i, h });
      heights[c] += h + A_GAP;
    });
    return out;
  }, [p.media, colWidth]);

  const cell = (i: number, h: number, style: React.CSSProperties, small: boolean) => {
    const m = p.media[i];
    return (
      <div key={i} className="album-cell" style={{ height: h, ...style }} onClick={() => onPreview?.(i)}>
        <Img src={m.type === 'video' ? m.poster || '' : m.thumb && small ? m.thumb : m.src} color={color} />
        {m.type === 'video' && <img className={`play ${small ? 'small' : ''}`} src="/icons/play.svg" alt="" />}
      </div>
    );
  };

  return (
    <div className="mp-album">
      <div className="head">
        {seriesTitle && <span className="series">{seriesTitle}</span>}
        <span className="title">{p.title || '未命名作品'}</span>
        {meta && <span className="meta">{meta}</span>}
        {p.description && <span className="desc">{p.description}</span>}
      </div>
      <div className="bar">
        <div className="acts">
          <span className="tool"><Icon name="heart-dark" size={20} /><span className="tool-count">{formatCount(p.stats?.likes)}</span></span>
          <span className="tool"><Icon name="star-dark" size={20} /><span className="tool-count">{formatCount(p.stats?.favorites)}</span></span>
          <span className="tool"><Icon name="send-dark" size={20} /><span className="tool-count">{formatCount(p.stats?.shares)}</span></span>
        </div>
        <div className="layouts">
          <span className={`switch ${layout === 'single' ? 'on' : ''}`} onClick={() => setLayout('single')}><Icon name="layout-single" size={20} /></span>
          <span className={`switch ${layout === 'masonry' ? 'on' : ''}`} onClick={() => setLayout('masonry')}><Icon name="layout-masonry" size={20} /></span>
        </div>
      </div>
      {layout === 'single' ? (
        <div>
          {p.media.map((m, i) => {
            const ratio = m.width > 0 && m.height > 0 ? m.height / m.width : 4 / 3;
            return cell(i, Math.round(SCREEN_WIDTH * ratio), { marginTop: i ? A_GAP : 0 }, false);
          })}
        </div>
      ) : (
        <div className="album-masonry" style={{ padding: `0 ${A_GAP}px` }}>
          {cols.map((col, c) => (
            <div key={c} style={{ width: colWidth }}>
              {col.map(({ i, h }) => cell(i, h, { marginBottom: A_GAP }, true))}
            </div>
          ))}
        </div>
      )}
      <div className="foot">{p.media.length ? <div className="end" /> : <span className="foot-text">还没有图片或视频</span>}</div>
    </div>
  );
}

// ---------- 发现（全屏浏览） ----------

export function FeedPage({ p, seriesTitle, index = 0 }: { p: PreviewPortfolio; seriesTitle: string; index?: number }) {
  useMediaUrls();
  const [cur, setCur] = useState(index);
  const [overlay, setOverlay] = useState(true);
  const [expand, setExpand] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  useEffect(() => setCur(Math.min(index, Math.max(0, p.media.length - 1))), [index, p.media.length]);
  const m = p.media[cur];
  const meta = metaLine(p);
  const go = (d: number) => setCur((c) => Math.max(0, Math.min(p.media.length - 1, c + d)));

  return (
    <div className="mp-feed">
      {!m && <div className="state">暂无作品</div>}
      {m && (
        <div className="stage" onClick={() => {
          if (m.type === 'video' && videoRef.current) {
            if (videoRef.current.paused) videoRef.current.play();
            else videoRef.current.pause();
          } else {
            setOverlay((o) => !o);
          }
        }}>
          {m.type === 'video' ? (
            <video
              key={m.src}
              ref={videoRef}
              className="fill"
              src={displayUrl(m.src)}
              poster={displayUrl(m.poster)}
              autoPlay
              muted
              loop
              playsInline
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                setProgress(v.duration ? (v.currentTime / v.duration) * 100 : 0);
              }}
            />
          ) : (
            <Img key={m.src} src={m.src} color="#000" className="fill" fit="contain" />
          )}
          {m.type === 'video' && paused && <img className="play" src="/icons/play.svg" alt="" />}
          {m.type === 'video' && <div className="progress"><div className="progress-bar" style={{ width: `${progress}%` }} /></div>}
          {cur > 0 && <button type="button" className="feed-nav prev" onClick={(e) => { e.stopPropagation(); go(-1); }} aria-label="上一张">‹</button>}
          {cur < p.media.length - 1 && <button type="button" className="feed-nav next" onClick={(e) => { e.stopPropagation(); go(1); }} aria-label="下一张">›</button>}
        </div>
      )}
      <div className={`scrim ${overlay ? '' : 'hide'}`} />
      <div className={`info ${overlay ? '' : 'hide'}`}>
        {p.media.length > 1 && p.media.length <= 12 && (
          <div className="segs">{p.media.map((_, j) => <span key={j} className={`seg ${j === cur ? 'on' : ''}`} />)}</div>
        )}
        {p.media.length > 12 && <span className="count">{cur + 1} / {p.media.length}</span>}
        {seriesTitle && <span className="series">{seriesTitle}</span>}
        <span className="title">{p.title || '未命名作品'}</span>
        {meta && <span className="meta">{meta}</span>}
        {p.description && <span className={`desc ${expand ? 'open' : ''}`} onClick={() => setExpand((v) => !v)}>{p.description}</span>}
      </div>
      <div className={`acts ${overlay ? '' : 'hide'}`}>
        <span className="act"><Icon name="heart" size={30} /><span className="act-count">{formatCount(p.stats?.likes)}</span></span>
        <span className="act"><Icon name="star" size={30} /><span className="act-count">{formatCount(p.stats?.favorites)}</span></span>
        <span className="act"><Icon name="send" size={30} /><span className="act-count">{formatCount(p.stats?.shares)}</span></span>
      </div>
    </div>
  );
}

// ---------- 关于 ----------

const ICONS = ['phone', 'wechat', 'wecom', 'xiaohongshu', 'douyin', 'weibo', 'email', 'link'];

export function AboutPage({ studio }: { studio: Studio }) {
  useMediaUrls();
  const [sheet, setSheet] = useState<Contact | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const cover = studio.cover;
  const ratio = cover && cover.width && cover.height ? (cover.height / cover.width) * 100 : 66.67;
  const contacts = studio.contacts.filter(contactVisible).map((c) => ({
    ...c,
    icon: ICONS.includes(c.type) ? c.type : 'link',
    label: c.label || CONTACT_LABELS[c.type] || '链接',
  }));
  const sections = studio.sections
    .map((s) => ({ ...s, body: s.body.split(/\n+/).map((t) => t.trim()).filter(Boolean) }))
    .filter((s) => s.title || s.body.length || s.items.length);

  if (!studio.name && !studio.intro.length && !contacts.length) {
    return <div className="mp-state">暂无工作室信息</div>;
  }

  return (
    <div className="mp-about">
      {cover && (
        <div className="cover" style={{ paddingTop: `${ratio}%` }}>
          <Img src={cover.src} color={cover.color} className="cover-img" />
        </div>
      )}
      <div className="head">
        <span className="name">{studio.name}</span>
        {studio.nameEn && <span className="en">{studio.nameEn}</span>}
        {studio.slogan && <span className="slogan">{studio.slogan}</span>}
      </div>
      {contacts.length > 0 && (
        <div className="contacts">
          {contacts.map((c, i) => (
            <div key={i} className="contact" onClick={() => {
              if (c.type === 'phone') return;
              setSheet(c);
              setSheetOpen(true);
            }}>
              <img className="contact-icon" src={`/icons/${c.icon}.svg`} alt="" />
              <span className="contact-label">{c.label}</span>
            </div>
          ))}
        </div>
      )}
      {studio.intro.length > 0 && (
        <div className="block">{studio.intro.map((t, i) => <span key={i} className="p">{t}</span>)}</div>
      )}
      {sections.map((s, i) => (
        <div key={i} className="block">
          {s.title && <span className="h">{s.title}</span>}
          {s.body.map((t, j) => <span key={j} className="p">{t}</span>)}
          {s.items.length > 0 && <div className="list">{s.items.map((t, j) => <span key={j} className="li">{t}</span>)}</div>}
        </div>
      ))}
      {(studio.address || studio.hours) && (
        <div className="block">
          {studio.address && (
            <div className="row">
              <span className="k">地址</span>
              <span className="v">{studio.address}</span>
              {studio.location && <img className="row-icon" src="/icons/location.svg" alt="" />}
            </div>
          )}
          {studio.hours && (
            <div className="row"><span className="k">时间</span><span className="v">{studio.hours}</span></div>
          )}
        </div>
      )}
      <div className={`mask ${sheetOpen ? 'on' : ''}`} onClick={() => setSheetOpen(false)} />
      <div className={`sheet ${sheetOpen ? 'on' : ''}`}>
        {sheet && (
          <>
            <span className="sheet-title">{sheet.label}</span>
            {sheet.qrcode && (
              <>
                <Img src={sheet.qrcode} color="#fff" className="qrcode" fit="contain" />
                <span className="hint">长按识别二维码</span>
              </>
            )}
            {sheet.value && <span className="value">{sheet.value}</span>}
            <div className="sheet-btns">
              {sheet.value && <span className="btn">复制</span>}
              {sheet.appId && <span className="btn">打开</span>}
              <span className="btn ghost" onClick={() => setSheetOpen(false)}>关闭</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
