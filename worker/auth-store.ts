/** Auth queries run against the D1 primary; batch mutations are transactions. */
export class AuthStore {
  private readonly db: D1DatabaseSession;

  constructor(db: D1Database) {
    this.db = db.withSession('first-primary');
  }

  async approved(email: string): Promise<boolean> {
    return !!await this.db.prepare("SELECT email FROM auth_users WHERE email = ? AND status = 'approved'").bind(email).first();
  }

  async ensureAdmin(email: string, now: number): Promise<void> {
    await this.db.prepare(`INSERT INTO auth_users (email, status, created_at, updated_at)
      VALUES (?, 'approved', ?, ?)
      ON CONFLICT(email) DO UPDATE SET status = 'approved', updated_at = excluded.updated_at
      WHERE auth_users.status != 'approved'`).bind(email, now, now).run();
  }

  async prune(now: number): Promise<void> {
    // One caller per hour wins this lease, even across concurrent Worker isolates.
    const lease = await this.db.prepare(`INSERT INTO auth_limits (key, count, expires_at)
      VALUES ('maintenance:prune', 1, ?) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at
      WHERE auth_limits.expires_at <= ?`).bind(now + 3600, now).run();
    if (lease.meta.changes !== 1) return;
    await this.db.batch([
      this.db.prepare('DELETE FROM auth_requests WHERE token_hash IN (SELECT token_hash FROM auth_requests WHERE expires_at <= ? LIMIT 500)').bind(now),
      this.db.prepare('DELETE FROM auth_codes WHERE email IN (SELECT email FROM auth_codes WHERE expires_at <= ? LIMIT 500)').bind(now),
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at <= ? LIMIT 500)').bind(now),
      this.db.prepare('DELETE FROM auth_dispatch WHERE rowid IN (SELECT rowid FROM auth_dispatch WHERE day < ? LIMIT 500)').bind(Math.floor(now / 86400) - 30),
      this.db.prepare(`DELETE FROM auth_users WHERE email IN (SELECT u.email FROM auth_users u
        WHERE u.status != 'approved' AND u.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM auth_requests r WHERE r.email = u.email)
          AND NOT EXISTS (SELECT 1 FROM auth_codes c WHERE c.email = u.email)
          AND NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.email = u.email) LIMIT 500)`).bind(now - 30 * 86400),
    ]);
  }

  async takeLimit(key: string, expires: number, maximum: number, now: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare('DELETE FROM auth_limits WHERE key IN (SELECT key FROM auth_limits WHERE expires_at <= ? LIMIT 500)').bind(now),
      this.db.prepare(`INSERT INTO auth_limits (key, count, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET count = auth_limits.count + 1
        WHERE auth_limits.count < ?`).bind(key, expires, maximum),
    ]);
    return results[1].meta.changes === 1;
  }

  async reserveDispatch(email: string, purpose: 'access' | 'otp', id: string, maximum: number, now: number): Promise<boolean> {
    const day = Math.floor(now / 86400);
    const result = await this.db.prepare(`INSERT INTO auth_dispatch
      (email, purpose, last_attempt, day, day_count, active_id) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(email, purpose) DO UPDATE SET
        last_attempt = excluded.last_attempt, day = excluded.day,
        day_count = CASE WHEN auth_dispatch.day = excluded.day THEN auth_dispatch.day_count + 1 ELSE 1 END,
        active_id = excluded.active_id
      WHERE auth_dispatch.last_attempt <= ?
        AND (auth_dispatch.active_id IS NULL OR auth_dispatch.last_attempt <= ?)
        AND (auth_dispatch.day != excluded.day OR auth_dispatch.day_count < ?)`)
      .bind(email, purpose, now, day, id, now - 60, now - 300, maximum).run();
    return result.meta.changes === 1;
  }

  async finishDispatch(email: string, purpose: 'access' | 'otp', id: string, failed: boolean): Promise<void> {
    await this.db.prepare(`UPDATE auth_dispatch SET active_id = NULL,
      last_attempt = CASE WHEN ? THEN 0 ELSE last_attempt END,
      day_count = CASE WHEN ? THEN MAX(0, day_count - 1) ELSE day_count END
      WHERE email = ? AND purpose = ? AND active_id = ?`).bind(failed ? 1 : 0, failed ? 1 : 0, email, purpose, id).run();
  }

  async reserveRequest(email: string, hash: string, expires: number, now: number): Promise<{ status: string; current_request_hash: string | null } | null> {
    const previous = await this.db.prepare('SELECT status, current_request_hash FROM auth_users WHERE email = ?')
      .bind(email).first<{ status: string; current_request_hash: string | null }>();
    const result = await this.db.batch([
      this.db.prepare(`INSERT INTO auth_users (email, status, current_request_hash, created_at, updated_at)
        VALUES (?, 'pending', ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET current_request_hash = excluded.current_request_hash, updated_at = excluded.updated_at
        WHERE auth_users.status != 'approved'`).bind(email, hash, now, now),
      this.db.prepare(`INSERT INTO auth_requests (token_hash, email, state, created_at, expires_at)
        SELECT ?, email, 'sending', ?, ? FROM auth_users WHERE email = ? AND current_request_hash = ? AND status != 'approved'`)
        .bind(hash, now, expires, email, hash),
    ]);
    if (result[1].meta.changes !== 1) return null;
    return previous ?? { status: 'pending', current_request_hash: null };
  }

  async finishRequest(email: string, hash: string, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE auth_requests SET state = 'pending' WHERE token_hash = ? AND state = 'sending'
        AND EXISTS (SELECT 1 FROM auth_users WHERE email = ? AND current_request_hash = ? AND status != 'approved')`)
        .bind(hash, email, hash),
      this.db.prepare(`UPDATE auth_users SET status = 'pending', updated_at = ? WHERE email = ? AND current_request_hash = ?
        AND status != 'approved' AND EXISTS (SELECT 1 FROM auth_requests WHERE token_hash = ? AND state = 'pending')`)
        .bind(now, email, hash, hash),
    ]);
  }

  async cancelRequest(email: string, hash: string, previous: { status: string; current_request_hash: string | null }, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM auth_requests WHERE token_hash = ? AND state = 'sending'").bind(hash),
      this.db.prepare(`UPDATE auth_users SET status = ?, current_request_hash = ?, updated_at = ?
        WHERE email = ? AND current_request_hash = ? AND status != 'approved'`)
        .bind(previous.status, previous.current_request_hash, now, email, hash),
    ]);
  }

  async review(hash: string, now: number): Promise<{ email: string } | null> {
    return this.db.prepare(`SELECT r.email FROM auth_requests r JOIN auth_users u ON u.email = r.email
      WHERE r.token_hash = ? AND r.state = 'pending' AND r.expires_at > ?
        AND u.current_request_hash = r.token_hash AND u.status = 'pending'`).bind(hash, now).first<{ email: string }>();
  }

  async decide(hash: string, decision: 'approved' | 'rejected', nonce: string, now: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE auth_requests SET state = ?, consumed_at = ?, decision_nonce = ?
        WHERE token_hash = ? AND state = 'pending' AND expires_at > ?
          AND EXISTS (SELECT 1 FROM auth_users WHERE email = auth_requests.email
            AND current_request_hash = auth_requests.token_hash AND status = 'pending')`)
        .bind(decision, now, nonce, hash, now),
      this.db.prepare(`UPDATE auth_users SET status = ?, updated_at = ?
        WHERE current_request_hash = ? AND status = 'pending'
          AND EXISTS (SELECT 1 FROM auth_requests WHERE token_hash = ? AND decision_nonce = ? AND state = ?)`)
        .bind(decision, now, hash, hash, nonce, decision),
    ]);
    return results[0].meta.changes === 1 && results[1].meta.changes === 1;
  }

  async reserveCode(email: string, nonce: string, hash: string, expires: number, now: number): Promise<boolean> {
    const result = await this.db.prepare(`INSERT INTO auth_codes (email, nonce, code_hash, state, attempts, created_at, expires_at)
      SELECT email, ?, ?, 'sending', 0, ?, ? FROM auth_users WHERE email = ? AND status = 'approved'
      ON CONFLICT(email) DO UPDATE SET nonce = excluded.nonce, code_hash = excluded.code_hash,
        state = 'sending', attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at, session_hash = NULL`)
      .bind(nonce, hash, now, expires, email).run();
    return result.meta.changes === 1;
  }

  async finishCode(email: string, nonce: string, failed: boolean): Promise<void> {
    if (failed) {
      await this.db.prepare("DELETE FROM auth_codes WHERE email = ? AND nonce = ? AND state = 'sending'").bind(email, nonce).run();
    } else {
      await this.db.prepare("UPDATE auth_codes SET state = 'sent' WHERE email = ? AND nonce = ? AND state = 'sending'").bind(email, nonce).run();
    }
  }

  async code(email: string, now: number): Promise<{ nonce: string } | null> {
    return this.db.prepare(`SELECT c.nonce FROM auth_codes c JOIN auth_users u ON u.email = c.email
      WHERE c.email = ? AND c.state = 'sent' AND c.expires_at > ? AND c.attempts < 5 AND u.status = 'approved'`)
      .bind(email, now).first<{ nonce: string }>();
  }

  async consumeCode(email: string, nonce: string, hash: string, session: string, expires: number, now: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE auth_codes SET attempts = attempts + 1,
        state = CASE WHEN code_hash = ? THEN 'consumed' WHEN attempts + 1 >= 5 THEN 'locked' ELSE 'sent' END,
        session_hash = CASE WHEN code_hash = ? THEN ? ELSE NULL END
        WHERE email = ? AND nonce = ? AND state = 'sent' AND expires_at > ? AND attempts < 5
          AND EXISTS (SELECT 1 FROM auth_users WHERE email = ? AND status = 'approved')`)
        .bind(hash, hash, session, email, nonce, now, email),
      this.db.prepare(`INSERT INTO auth_sessions (token_hash, email, created_at, expires_at)
        SELECT ?, c.email, ?, ? FROM auth_codes c JOIN auth_users u ON u.email = c.email
        WHERE c.email = ? AND c.nonce = ? AND c.state = 'consumed' AND c.session_hash = ? AND u.status = 'approved'`)
        .bind(session, now, expires, email, nonce, session),
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at <= ? LIMIT 500)').bind(now),
    ]);
    return results[1].meta.changes === 1;
  }

  async session(hash: string, now: number): Promise<{ email: string } | null> {
    return this.db.prepare(`SELECT s.email FROM auth_sessions s JOIN auth_users u ON u.email = s.email
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'approved'`).bind(hash, now).first<{ email: string }>();
  }

  async logout(hash: string): Promise<void> {
    await this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(hash).run();
  }
}
