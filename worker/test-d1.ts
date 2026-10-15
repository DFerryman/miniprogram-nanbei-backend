import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Run the production SQL against SQLite. Only the asynchronous D1 transport is
// adapted; no auth query or state transition is reproduced by this test helper.
class SqliteStatement {
  readonly database: DatabaseSync;
  readonly query: string;
  readonly values: unknown[];

  constructor(database: DatabaseSync, query: string, values: unknown[] = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]) { return new SqliteStatement(this.database, this.query, values); }

  execute() {
    const statement = this.database.prepare(this.query);
    const values = this.values as (string | number | null | Uint8Array)[];
    const before = this.database.prepare('SELECT total_changes() AS changes').get()!.changes as number;
    const results = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    const after = this.database.prepare('SELECT total_changes() AS changes').get()!.changes as number;
    return { success: true, results, meta: { changes: after - before } };
  }

  async first(column?: string) {
    const row = this.execute().results[0];
    return row ? (column ? row[column] : row) : null;
  }

  async all() { return this.execute(); }
  async run() { return this.execute(); }
}

export class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter((n) => n.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
  }

  prepare(query: string) { return new SqliteStatement(this.sqlite, query); }

  withSession(constraint: string) {
    assert.equal(constraint, 'first-primary', 'Auth reads must observe the current authorization state');
    return this;
  }

  async batch(statements: SqliteStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

