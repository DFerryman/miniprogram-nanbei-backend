// 多人协作的辅助数据（D1）：在线状态、修改记录、延迟删除的文件。
// 内容本身在微信云数据库中，两个数据库之间没有事务，这里的数据只用于提示和兜底，
// 不作为内容是否可以写入的依据（写入由云数据库中文档的 rev 版本号决定）。

export type ViewKind = 'list' | 'portfolio' | 'series' | 'studio' | 'setup';
export type EditState = 'viewing' | 'editing' | 'unsaved';

export interface Heartbeat {
  tabId: string;
  view: ViewKind;
  viewId: string | null;
  state: EditState;
  visible: boolean;
}

export interface PresenceRow {
  tab_id: string;
  email: string;
  view_kind: ViewKind;
  view_id: string | null;
  state: EditState;
  visible: number;
  started_at: number;
  seen_at: number;
  session_hash: string;
}

export interface ChangeRow {
  seq: number;
  kind: string;
  item_id: string;
  action: 'create' | 'update' | 'delete';
  rev: number | null;
  email: string;
  tab_id: string | null;
  at: number;
}

/** 超过这个时间没有心跳，视为窗口已关闭或断线。后台窗口的定时器可能被浏览器限流到每分钟一次，留出余量。 */
export const ONLINE_TTL = 75;
/** 断线后仍在列表中保留（标为“连接中断”）的时间，便于发现有人带着未保存修改掉线。 */
export const LINGER_TTL = 180;
const CHANGE_TTL = 86400;
/** 已保存内容中移除的文件保留一天再删除，旧页面重新引用时仍可恢复。 */
export const TRASH_GRACE = 86400;
/** 上传后从未保存进内容的文件。 */
export const UPLOAD_GRACE = 3600;
/** 清理任务中途失败时，认领超过这个时间的记录可重新处理。 */
const CLAIM_TTL = 1800;
const MAX_ATTEMPTS = 10;
/** D1 单条语句最多绑定 100 个参数。 */
const CHUNK = 90;

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

export class CollabStore {
  private readonly db: D1DatabaseSession;

  constructor(db: D1Database) {
    this.db = db.withSession('first-primary');
  }

  // ---------- 在线状态 ----------

  async heartbeat(sessionHash: string, email: string, beat: Heartbeat, now: number): Promise<void> {
    await this.db.batch([
      // 同一个 tabId 只能属于最初的会话，防止猜测他人 tabId 覆盖其状态
      this.db.prepare(`INSERT INTO collab_presence
        (tab_id, session_hash, email, view_kind, view_id, state, visible, started_at, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tab_id) DO UPDATE SET view_kind = excluded.view_kind, view_id = excluded.view_id,
          state = excluded.state, visible = excluded.visible, seen_at = excluded.seen_at,
          started_at = CASE WHEN collab_presence.view_kind = excluded.view_kind
            AND IFNULL(collab_presence.view_id, '') = IFNULL(excluded.view_id, '') THEN collab_presence.started_at ELSE excluded.started_at END
        WHERE collab_presence.session_hash = excluded.session_hash`)
        .bind(beat.tabId, sessionHash, email, beat.view, beat.viewId, beat.state, beat.visible ? 1 : 0, now, now),
      this.db.prepare('DELETE FROM collab_presence WHERE tab_id IN (SELECT tab_id FROM collab_presence WHERE seen_at <= ? LIMIT 200)')
        .bind(now - 86400),
      this.db.prepare('DELETE FROM collab_changes WHERE seq IN (SELECT seq FROM collab_changes WHERE at <= ? LIMIT 200)')
        .bind(now - CHANGE_TTL),
    ]);
  }

  async leave(sessionHash: string, tabId: string): Promise<void> {
    await this.db.prepare('DELETE FROM collab_presence WHERE tab_id = ? AND session_hash = ?').bind(tabId, sessionHash).run();
  }

  /** 最近仍有心跳（含刚断线）的窗口，只包含会话仍然有效、邮箱仍被批准的。 */
  async presence(now: number): Promise<PresenceRow[]> {
    const { results } = await this.db.prepare(`SELECT p.tab_id, p.email, p.view_kind, p.view_id, p.state, p.visible,
        p.started_at, p.seen_at, p.session_hash
      FROM collab_presence p
      JOIN auth_sessions s ON s.token_hash = p.session_hash
      JOIN auth_users u ON u.email = s.email
      WHERE p.seen_at > ? AND s.expires_at > ? AND u.status = 'approved'
      ORDER BY p.email, p.started_at LIMIT 200`).bind(now - LINGER_TTL, now).all<PresenceRow>();
    return results;
  }

  /** 每个账号仍有效的登录会话数量（不代表正在使用）。 */
  async loggedIn(now: number): Promise<{ email: string; sessions: number }[]> {
    const { results } = await this.db.prepare(`SELECT s.email, COUNT(*) AS sessions FROM auth_sessions s
      JOIN auth_users u ON u.email = s.email
      WHERE s.expires_at > ? AND u.status = 'approved' GROUP BY s.email ORDER BY s.email LIMIT 200`)
      .bind(now).all<{ email: string; sessions: number }>();
    return results;
  }

  // ---------- 修改记录 ----------

  async recordChange(change: Omit<ChangeRow, 'seq'>): Promise<void> {
    await this.db.prepare('INSERT INTO collab_changes (kind, item_id, action, rev, email, tab_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(change.kind, change.item_id, change.action, change.rev, change.email, change.tab_id, change.at).run();
  }

  async changesSince(seq: number): Promise<ChangeRow[]> {
    const { results } = await this.db.prepare('SELECT seq, kind, item_id, action, rev, email, tab_id, at FROM collab_changes WHERE seq > ? ORDER BY seq LIMIT 200')
      .bind(seq).all<ChangeRow>();
    return results;
  }

  async lastSeq(): Promise<number> {
    const row = await this.db.prepare('SELECT MAX(seq) AS seq FROM collab_changes').first<{ seq: number | null }>();
    return row?.seq ?? 0;
  }

  // ---------- 延迟删除 ----------

  async trash(fileIds: string[], reason: string, email: string | null, now: number, grace: number): Promise<void> {
    if (!fileIds.length) return;
    // 已在等待删除的文件推迟到新的截止时间；正在删除的保持不变
    await this.db.batch(fileIds.map((id) => this.db.prepare(`INSERT INTO file_trash (file_id, state, reason, email, queued_at, due_at)
      VALUES (?, 'pending', ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET due_at = MAX(file_trash.due_at, excluded.due_at), reason = excluded.reason,
        email = excluded.email, queued_at = excluded.queued_at
      WHERE file_trash.state = 'pending'`).bind(id, reason, email, now, now + grace)));
  }

  /**
   * 文件即将被重新引用：从回收列表中取回。restored 是本次从列表中取回的文件（写入失败时应放回）；
   * blocked 是清理任务已认领、可能已从云存储删除的文件，调用方必须拒绝这次写入。
   */
  async restore(fileIds: string[]): Promise<{ restored: string[]; blocked: string[] }> {
    const restored: string[] = [];
    const blocked: string[] = [];
    for (const part of chunks(fileIds)) {
      const marks = part.map(() => '?').join(',');
      const results = await this.db.batch([
        this.db.prepare(`DELETE FROM file_trash WHERE state = 'pending' AND file_id IN (${marks}) RETURNING file_id`).bind(...part),
        this.db.prepare(`SELECT file_id FROM file_trash WHERE file_id IN (${marks})`).bind(...part),
      ]);
      restored.push(...(results[0].results as { file_id: string }[]).map((r) => r.file_id));
      blocked.push(...(results[1].results as { file_id: string }[]).map((r) => r.file_id));
    }
    return { restored, blocked };
  }

  /** 认领到期的文件。认领之后保存操作不能再取回它们，因此之后的引用扫描是可靠的。 */
  async claim(now: number, limit = 200): Promise<string[]> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE file_trash SET state = 'deleting', claimed_at = ?, attempts = attempts + 1
        WHERE file_id IN (SELECT file_id FROM file_trash
          WHERE (state = 'pending' AND due_at <= ?) OR (state = 'deleting' AND claimed_at <= ?) LIMIT ?)`)
        .bind(now, now, now - CLAIM_TTL, limit),
      this.db.prepare("SELECT file_id FROM file_trash WHERE state = 'deleting' AND claimed_at = ?").bind(now),
    ]);
    return (results[1].results as { file_id: string }[]).map((r) => r.file_id);
  }

  async forget(fileIds: string[]): Promise<void> {
    for (const part of chunks(fileIds)) {
      await this.db.prepare(`DELETE FROM file_trash WHERE file_id IN (${part.map(() => '?').join(',')})`).bind(...part).run();
    }
  }

  /** 删除失败的文件稍后重试，多次失败后放弃（文件留在云存储中，不会误删）。 */
  async retry(fileIds: string[], now: number): Promise<void> {
    for (const part of chunks(fileIds)) {
      const marks = part.map(() => '?').join(',');
      await this.db.batch([
        this.db.prepare(`DELETE FROM file_trash WHERE attempts >= ? AND file_id IN (${marks})`).bind(MAX_ATTEMPTS, ...part),
        this.db.prepare(`UPDATE file_trash SET state = 'pending', claimed_at = NULL, due_at = ? WHERE file_id IN (${marks})`)
          .bind(now + 3600, ...part),
      ]);
    }
  }

  async pendingTrash(): Promise<{ file_id: string; state: string; due_at: number; reason: string }[]> {
    const { results } = await this.db.prepare('SELECT file_id, state, due_at, reason FROM file_trash ORDER BY due_at LIMIT 500')
      .all<{ file_id: string; state: string; due_at: number; reason: string }>();
    return results;
  }
}
