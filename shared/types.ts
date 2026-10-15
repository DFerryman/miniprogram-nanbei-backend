// 与小程序仓库 docs/data-model.md 保持一致的数据结构。
// 媒体地址可以是云存储文件 ID（cloud://…）或 https 地址。

export type Status = 'published' | 'draft' | 'hidden';
export const STATUSES: Status[] = ['published', 'draft', 'hidden'];

export interface MediaItem {
  type: 'image' | 'video';
  src: string;
  width: number;
  height: number;
  thumb?: string;
  poster?: string; // 仅视频：封面帧
  duration?: number; // 仅视频：秒
}

export interface Cover {
  src: string;
  thumb?: string;
  width: number;
  height: number;
  color?: string;
}

export interface Stats {
  likes: number;
  favorites: number;
  shares: number;
}

export interface PortfolioInput {
  title: string;
  seriesId: string | null;
  location: string;
  shootDate: string; // YYYY-MM-DD
  description: string;
  tags: string[];
  cover: Cover | null; // null：使用第一个媒体
  media: MediaItem[];
  weight: number;
  status: Status;
}

export interface Portfolio extends PortfolioInput {
  _id: string;
  /** 文档版本号，每次后台写入加 1；旧数据没有该字段时为 0。用于检测并发修改。 */
  rev: number;
  stats: Stats;
  createdAt: string; // ISO
  updatedAt: string;
}

export interface SeriesInput {
  title: string;
  description: string;
  cover: Cover | null;
  weight: number;
  status: Status;
}

export interface Series extends SeriesInput {
  _id: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export const CONTACT_TYPES = ['phone', 'wechat', 'wecom', 'xiaohongshu', 'douyin', 'weibo', 'email', 'link'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const CONTACT_LABELS: Record<ContactType, string> = {
  phone: '电话',
  wechat: '微信',
  wecom: '企业微信',
  xiaohongshu: '小红书',
  douyin: '抖音',
  weibo: '微博',
  email: '邮箱',
  link: '链接',
};

export interface Contact {
  type: ContactType;
  label: string;
  value: string;
  qrcode: string;
  appId: string;
  path: string;
  corpId: string;
  url: string;
}

export interface StudioSection {
  title: string;
  body: string; // 换行分段
  items: string[];
}

export interface StudioLocation {
  latitude: number;
  longitude: number;
  name: string;
}

export interface Studio {
  name: string;
  nameEn: string;
  slogan: string;
  cover: Cover | null;
  intro: string[];
  sections: StudioSection[];
  address: string;
  location: StudioLocation | null;
  hours: string;
  contacts: Contact[];
  updatedAt?: string;
  /** 文档版本号；尚未创建时为 0。 */
  rev?: number;
}

/** 仅供 Worker 内部使用的连接配置，凭据从服务端环境变量读取。 */
export interface CloudConfig {
  apiBase: string; // 微信开放接口地址，或部署在固定 IP 上的转发地址
  envId: string; // 云开发环境 ID
  appId: string; // 小程序 AppID
  appSecret: string; // 小程序 AppSecret
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiFail {
  ok: false;
  code: string;
  message: string;
}

export type ApiResult<T> = ApiOk<T> | ApiFail;
