// 输入校验与数据库文档整理。Worker 写库前和读库后都经过这里，前端也复用同一套规则。
import {
  CONTACT_TYPES,
  STATUSES,
  type Contact,
  type ContactType,
  type Cover,
  type MediaItem,
  type Portfolio,
  type PortfolioInput,
  type Series,
  type SeriesInput,
  type Stats,
  type Status,
  type Studio,
  type StudioSection,
} from './types.ts';

type Raw = Record<string, unknown>;

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const LIMITS = {
  text: 200,
  longText: 10000,
  media: 200,
  tags: 30,
  sections: 30,
  items: 100,
  contacts: 20,
};

function obj(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

export function text(value: unknown, max = LIMITS.text): string {
  if (typeof value === 'string') return value.trim().slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function longText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => text(v, LIMITS.longText)).filter(Boolean).join('\n');
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, LIMITS.longText) : '';
}

function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function int(value: unknown, fallback = 0): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(-1e9, Math.min(1e9, n)) : fallback;
}

export function rev(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1e12) : 0;
}

function status(value: unknown): Status {
  return STATUSES.includes(value as Status) ? (value as Status) : 'draft';
}

/** 媒体地址只接受云存储文件 ID 或 https 链接。 */
export function mediaUrl(value: unknown): string {
  const s = text(value, 1024);
  return s.startsWith('cloud://') || s.startsWith('https://') ? s : '';
}

/** 数据库日期可能是 Date、{$date}、时间戳或字符串，统一为 ISO 字符串。 */
export function toIso(value: unknown): string {
  if (!value) return '';
  let v: unknown = value;
  if (typeof v === 'object' && v !== null && '$date' in v) v = (v as Raw).$date;
  if (typeof v === 'object' && v !== null && '$numberLong' in v) v = Number((v as Raw).$numberLong);
  const d = v instanceof Date ? v : new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** 拍摄日期为 YYYY-MM-DD（北京时间），与 content 云函数的格式化方式一致。 */
export function shootDate(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string' && DATE_PATTERN.test(value.slice(0, 10))) return value.slice(0, 10);
  const iso = toIso(value);
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function media(raw: unknown): MediaItem | null {
  const m = typeof raw === 'string' ? { src: raw } : obj(raw);
  const src = mediaUrl(m.src || m.fileID || m.url);
  if (!src) return null;
  const type = m.type === 'video' || (!m.type && /\.(mp4|mov|m4v|m3u8)(\?|$)/i.test(src)) ? 'video' : 'image';
  const item: MediaItem = { type, src, width: Math.round(positive(m.width)), height: Math.round(positive(m.height)) };
  const thumb = mediaUrl(m.thumb);
  if (thumb) item.thumb = thumb;
  if (type === 'video') {
    const poster = mediaUrl(m.poster);
    if (poster) item.poster = poster;
    const duration = positive(m.duration);
    if (duration) item.duration = Math.round(duration * 10) / 10;
  }
  return item;
}

export function cover(raw: unknown): Cover | null {
  const c = typeof raw === 'string' ? { src: raw } : obj(raw);
  const src = mediaUrl(c.src || c.fileID || c.url);
  if (!src) return null;
  const out: Cover = { src, width: Math.round(positive(c.width)), height: Math.round(positive(c.height)) };
  const thumb = mediaUrl(c.thumb);
  if (thumb) out.thumb = thumb;
  const color = text(c.color, 16);
  if (COLOR_PATTERN.test(color)) out.color = color;
  return out;
}

function list<T>(value: unknown, map: (v: unknown) => T | null, max: number): T[] {
  return (Array.isArray(value) ? value : []).slice(0, max).map(map).filter((v): v is T => v != null);
}

function stats(raw: unknown): Stats {
  const s = obj(raw);
  return { likes: int(s.likes), favorites: int(s.favorites), shares: int(s.shares) };
}

export function portfolioInput(raw: unknown): PortfolioInput {
  const p = obj(raw);
  const seriesId = text(p.seriesId, 64);
  return {
    title: text(p.title),
    seriesId: seriesId && ID_PATTERN.test(seriesId) ? seriesId : null,
    location: text(p.location),
    shootDate: shootDate(p.shootDate),
    description: longText(p.description),
    tags: list(p.tags, (t) => text(t, 30) || null, LIMITS.tags),
    cover: cover(p.cover),
    media: list(p.media, media, LIMITS.media),
    weight: int(p.weight),
    status: status(p.status),
  };
}

export function portfolio(raw: unknown): Portfolio {
  const p = obj(raw);
  return {
    _id: text(p._id, 64),
    rev: rev(p.rev),
    ...portfolioInput(p),
    stats: stats(p.stats),
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
  };
}

export function seriesInput(raw: unknown): SeriesInput {
  const s = obj(raw);
  return {
    title: text(s.title),
    description: longText(s.description),
    cover: cover(s.cover),
    weight: int(s.weight),
    status: status(s.status),
  };
}

export function series(raw: unknown): Series {
  const s = obj(raw);
  return { _id: text(s._id, 64), rev: rev(s.rev), ...seriesInput(s), createdAt: toIso(s.createdAt), updatedAt: toIso(s.updatedAt) };
}

export function contact(raw: unknown): Contact | null {
  const c = obj(raw);
  const type = (CONTACT_TYPES as readonly string[]).includes(c.type as string) ? (c.type as ContactType) : 'link';
  return {
    type,
    label: text(c.label, 20),
    value: text(c.value),
    qrcode: mediaUrl(c.qrcode),
    appId: text(c.appId, 64),
    path: text(c.path, 512),
    corpId: text(c.corpId, 64),
    url: text(c.url, 512),
  };
}

/** 小程序只显示 value / qrcode / appId / url 至少有一项的联系方式。 */
export function contactVisible(c: Contact): boolean {
  return !!(c.value || c.qrcode || c.appId || c.url);
}

function section(raw: unknown): StudioSection | null {
  const s = obj(raw);
  const out = {
    title: text(s.title),
    body: longText(s.body),
    items: list(s.items, (t) => text(t) || null, LIMITS.items),
  };
  return out.title || out.body || out.items.length ? out : null;
}

export function paragraphs(value: unknown): string[] {
  const all = Array.isArray(value) ? value.map((v) => text(v, LIMITS.longText)) : longText(value).split(/\n+/);
  return all.map((s) => s.trim()).filter(Boolean);
}

export function studio(raw: unknown): Studio {
  const s = obj(raw);
  const loc = obj(s.location);
  const latitude = Number(loc.latitude);
  const longitude = Number(loc.longitude);
  const hasLoc = loc.latitude !== '' && loc.longitude !== '' && Number.isFinite(latitude) && Number.isFinite(longitude)
    && (latitude !== 0 || longitude !== 0) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  return {
    name: text(s.name),
    nameEn: text(s.nameEn),
    slogan: text(s.slogan),
    cover: cover(s.cover),
    intro: paragraphs(s.intro),
    sections: list(s.sections, section, LIMITS.sections),
    address: text(s.address),
    location: hasLoc ? { latitude, longitude, name: text(loc.name) } : null,
    hours: text(s.hours),
    contacts: list(s.contacts, contact, LIMITS.contacts),
    updatedAt: toIso(s.updatedAt) || undefined,
    rev: rev(s.rev),
  };
}

/** 递归收集文档中的云存储文件 ID。 */
export function collectFileIds(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (value.startsWith('cloud://')) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectFileIds(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectFileIds(v, out));
  }
  return out;
}

/** 新作品 ID：p_ + 日期 + 随机串，满足云函数对 ID 的长度限制。 */
export function newId(prefix: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${rand}`;
}
