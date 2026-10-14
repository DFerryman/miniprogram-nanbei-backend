// 预览所需的数据整理，逻辑与小程序 content 云函数（normalizeCover / toPortfolio）和 utils/format.js 一致。
import type { Cover, MediaItem, PortfolioInput, Stats } from '../../shared/types.ts';

export interface PreviewPortfolio extends PortfolioInput {
  _id: string;
  stats?: Stats;
}

export interface ResolvedCover {
  src: string;
  thumb: string;
  width: number;
  height: number;
  color: string;
  first: boolean;
}

function mediaImage(m: MediaItem | undefined): string {
  return m ? (m.type === 'video' ? m.poster || '' : m.src) : '';
}

/** 封面可选；未设置时取第一个媒体（视频取其封面帧）。 */
export function coverOf(cover: Cover | null, media: MediaItem[]): ResolvedCover {
  const first = media[0];
  const firstSrc = mediaImage(first);
  if (!cover || !cover.src) {
    return {
      src: firstSrc,
      thumb: first?.thumb || '',
      width: first?.width || 0,
      height: first?.height || 0,
      color: '',
      first: !!firstSrc,
    };
  }
  const isFirst = !!firstSrc && cover.src === firstSrc;
  return {
    src: cover.src,
    thumb: cover.thumb || '',
    width: cover.width || (isFirst ? first.width : 0),
    height: cover.height || (isFirst ? first.height : 0),
    color: cover.color || '',
    first: isFirst,
  };
}

export function formatDate(value: string): string {
  return value ? value.replace(/-/g, '.') : '';
}

export function metaLine(p: { location?: string; shootDate?: string }): string {
  return [p.location, formatDate(p.shootDate || '')].filter(Boolean).join(' · ');
}

/** 计数显示：不足一万显示原数，否则显示「1.2万」（utils/count.wxs）。 */
export function formatCount(n: number | undefined): string {
  const v = n && n > 0 ? Math.floor(n) : 0;
  if (v < 10000) return String(v);
  const w = Math.floor(v / 1000) / 10;
  return `${w >= 1000 ? Math.floor(w) : w}万`;
}

/** 小程序瀑布流 / 相册排序：weight 倒序，createdAt 倒序。 */
export function sortPortfolios<T extends { weight: number; createdAt?: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.weight - a.weight) || (b.createdAt || '').localeCompare(a.createdAt || ''));
}
