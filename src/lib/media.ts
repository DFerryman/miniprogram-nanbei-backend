// 媒体工具：cloud:// 文件 ID 换临时链接（批量 + 缓存）、读取宽高 / 时长、生成缩略图与视频封面、上传。
import { useSyncExternalStore } from 'react';
import type { MediaItem } from '../../shared/types.ts';
import { api, ApiError, headersFor } from './api.ts';
import { activeProfile } from './config.ts';

// ---------- 临时链接 ----------

const URL_TTL = 100 * 60 * 1000; // 临时链接有效期 2 小时，提前刷新
const resolved = new Map<string, { url: string; expires: number }>();
const local = new Map<string, string>(); // 本次会话上传的文件：直接用本地 blob 地址预览
const pending = new Set<string>();
const failed = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}

function flush() {
  timer = null;
  const ids = [...pending];
  pending.clear();
  if (!ids.length) return;
  api.tempUrls(ids)
    .then(({ urls }) => {
      const expires = Date.now() + URL_TTL;
      ids.forEach((id) => {
        if (urls[id]) resolved.set(id, { url: urls[id], expires });
        else failed.add(id);
      });
    })
    .catch(() => ids.forEach((id) => failed.add(id)))
    .finally(emit);
}

/** 同步返回可显示的地址；cloud:// 尚未换取时返回空字符串并排队批量换取。 */
export function displayUrl(src: string | undefined): string {
  if (!src) return '';
  if (!src.startsWith('cloud://')) return src;
  const blob = local.get(src);
  if (blob) return blob;
  const hit = resolved.get(src);
  if (hit && hit.expires > Date.now()) return hit.url;
  if (!failed.has(src) && !pending.has(src)) {
    pending.add(src);
    if (!timer) timer = setTimeout(flush, 30);
  }
  return '';
}

export function rememberLocal(fileId: string, blobUrl: string) {
  local.set(fileId, blobUrl);
  emit();
}

export function clearUrlCache() {
  resolved.clear();
  failed.clear();
  emit();
}

/** 订阅链接变化：组件中调用后，displayUrl 的结果更新时会重新渲染。 */
export function useMediaUrls(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

// ---------- 读取本地文件信息 ----------

export interface Probe {
  type: 'image' | 'video';
  width: number;
  height: number;
  duration?: number;
  blobUrl: string;
  color?: string;
  thumb?: Blob; // 图片缩略图（宽 720）
  poster?: Blob; // 视频封面帧
  posterColor?: string;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法解析'));
    img.src = url;
  });
}

function canvasOf(source: CanvasImageSource, w: number, h: number, maxW: number) {
  const scale = Math.min(1, maxW / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality = 0.82): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('无法生成图片'))), 'image/jpeg', quality),
  );
}

/** 平均色作为图片加载前的占位底色，略微提亮，与小程序中浅色占位一致。 */
function averageColor(source: CanvasImageSource): string {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, 0, 0, 8, 8);
  const d = ctx.getImageData(0, 0, 8, 8).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
  }
  const n = d.length / 4;
  const mix = (v: number) => Math.round(v / n * 0.6 + 255 * 0.4);
  return `#${[r, g, b].map((v) => mix(v).toString(16).padStart(2, '0')).join('')}`;
}

function videoFrame(url: string): Promise<{ video: HTMLVideoElement; width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 3);
    };
    video.onseeked = () => resolve({ video, width: video.videoWidth, height: video.videoHeight, duration: video.duration });
    video.onerror = () => reject(new Error('视频无法解析，请使用 H.264 编码的 MP4'));
  });
}

export async function probe(file: File): Promise<Probe> {
  const blobUrl = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    const { video, width, height, duration } = await videoFrame(blobUrl);
    const canvas = canvasOf(video, width, height, 1280);
    return {
      type: 'video',
      width,
      height,
      duration: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : undefined,
      blobUrl,
      poster: await toBlob(canvas),
      posterColor: averageColor(canvas),
    };
  }
  if (!file.type.startsWith('image/')) throw new Error(`不支持的文件类型：${file.type || file.name}`);
  const img = await loadImage(blobUrl);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  return {
    type: 'image',
    width,
    height,
    blobUrl,
    color: averageColor(img),
    thumb: width > 900 ? await toBlob(canvasOf(img, width, height, 720), 0.8) : undefined,
  };
}

// ---------- 上传 ----------

export function extOf(file: File): string {
  const fromName = (file.name.match(/\.([A-Za-z0-9]{1,8})$/) || [])[1];
  if (fromName) return fromName.toLowerCase();
  const fromType = file.type.split('/')[1];
  return (fromType || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
}

export function fileName(base: string, ext: string): string {
  return `${base}.${ext}`.replace(/[^A-Za-z0-9_.-]/g, '');
}

export function uniqueBase(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function xhr(url: string, form: FormData, headers: Record<string, string>, onProgress?: (p: number) => void): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open('POST', url);
    Object.entries(headers).forEach(([k, v]) => req.setRequestHeader(k, v));
    req.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    req.onload = () => resolve(req);
    req.onerror = () => reject(new ApiError('NETWORK', '上传失败：网络错误（直传模式请检查云开发「安全域名」与存储 CORS 配置）', 0));
    req.send(form);
  });
}

/** 上传到云存储，返回 cloud:// 文件 ID。path 形如 portfolios/<作品ID>/<文件名>。 */
export async function upload(path: string, file: Blob, onProgress?: (p: number) => void): Promise<string> {
  const profile = activeProfile();
  const name = path.split('/').pop() || 'file';
  let fileId: string;
  if (profile?.uploadMode === 'direct') {
    const ticket = await api.uploadTicket(path);
    const form = new FormData();
    Object.entries(ticket.fields).forEach(([k, v]) => form.append(k, v));
    form.append('file', file, name);
    const res = await xhr(ticket.url, form, {}, onProgress);
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError('UPLOAD_FAILED', `上传到云存储失败（HTTP ${res.status}）`, res.status);
    }
    fileId = ticket.fileId;
  } else {
    const form = new FormData();
    form.append('path', path);
    form.append('file', file, name);
    const res = await xhr('/api/files/upload', form, headersFor(profile), onProgress);
    let json: { ok: boolean; data?: { fileId: string }; code?: string; message?: string };
    try {
      json = JSON.parse(res.responseText);
    } catch {
      throw new ApiError('UPLOAD_FAILED', `上传失败（HTTP ${res.status}）${res.status === 413 ? '：文件超过 Worker 请求体上限，请改用直传模式' : ''}`, res.status);
    }
    if (!json.ok || !json.data) throw new ApiError(json.code || 'UPLOAD_FAILED', json.message || '上传失败', res.status);
    fileId = json.data.fileId;
  }
  rememberLocal(fileId, URL.createObjectURL(file));
  return fileId;
}

export interface UploadedMedia {
  item: MediaItem;
  color?: string;
  uploaded: string[];
}

/** 上传一个图片或视频文件，连同自动生成的缩略图 / 封面帧，返回符合数据模型的媒体项。 */
export async function uploadMedia(dir: string, file: File, onProgress?: (p: number) => void): Promise<UploadedMedia> {
  const info = await probe(file);
  const base = uniqueBase();
  const uploaded: string[] = [];
  const src = await upload(`${dir}/${fileName(base, extOf(file))}`, file, (p) => onProgress?.(p * 0.9));
  uploaded.push(src);
  rememberLocal(src, info.blobUrl);
  const item: MediaItem = { type: info.type, src, width: info.width, height: info.height };
  if (info.thumb) {
    item.thumb = await upload(`${dir}/${fileName(`${base}_thumb`, 'jpg')}`, info.thumb);
    uploaded.push(item.thumb);
  }
  if (info.poster) {
    item.poster = await upload(`${dir}/${fileName(`${base}_poster`, 'jpg')}`, info.poster);
    uploaded.push(item.poster);
    if (info.duration) item.duration = info.duration;
  }
  onProgress?.(1);
  return { item, color: info.color || info.posterColor, uploaded };
}

/** 本次会话中上传的媒体主色，用于设置封面占位底色。 */
export const knownColors = new Map<string, string>();
