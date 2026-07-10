/**
 * db-sqlite.ts — SQLite 实现（本地开发用）
 * 原 db.ts 内容，保持同步接口
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '..', 'skill-platform.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('[DB] Connected to SQLite at', DB_PATH);

export function run(sql: string, params: any[] = []): void {
  db.prepare(sql).run(...params);
}

export function get<T>(sql: string, params: any[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, params: any[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      version         TEXT NOT NULL DEFAULT '1.0.0',
      description     TEXT,
      category        TEXT,
      type            TEXT NOT NULL DEFAULT 'internal',
      skill_type      TEXT NOT NULL DEFAULT 'prompt',
      author_name     TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      prompt_template TEXT,
      code            TEXT,
      plugin_config   TEXT,
      h5_config       TEXT,
      preferred_model TEXT,
      fallback_model  TEXT,
      test_inputs     TEXT,
      ai_review       TEXT,
      reject_reason   TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      published_at    INTEGER,
      sandbox_status  TEXT NOT NULL DEFAULT 'none',
      sandbox_test    TEXT,
      scripts_path    TEXT
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id              TEXT PRIMARY KEY,
      skill_id        TEXT NOT NULL,
      token           TEXT UNIQUE NOT NULL,
      title           TEXT,
      patient_name    TEXT,
      patient_phone   TEXT,
      notes           TEXT,
      created_by      TEXT,
      status          TEXT NOT NULL DEFAULT 'created',
      return_reason   TEXT,
      return_count    INTEGER NOT NULL DEFAULT 0,
      h5_submitted_at INTEGER,
      ai_started_at   INTEGER,
      ai_completed_at INTEGER,
      expires_at      INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id)
    );

    CREATE TABLE IF NOT EXISTS ticket_inputs (
      id          TEXT PRIMARY KEY,
      ticket_id   TEXT NOT NULL,
      field_key   TEXT NOT NULL,
      field_type  TEXT NOT NULL DEFAULT 'text',
      value       TEXT,
      file_path   TEXT,
      file_name   TEXT,
      mime_type   TEXT,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id)
    );

    CREATE TABLE IF NOT EXISTS ticket_results (
      id              TEXT PRIMARY KEY,
      ticket_id       TEXT UNIQUE NOT NULL,
      raw_result      TEXT,
      revised_result  TEXT,
      revision_notes  TEXT,
      revised_by      TEXT,
      revised_at      INTEGER,
      report_path     TEXT,
      report_type     TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id)
    );

    CREATE TABLE IF NOT EXISTS revision_memories (
      id              TEXT PRIMARY KEY,
      skill_id        TEXT NOT NULL,
      ticket_id       TEXT,
      original_output TEXT,
      revised_output  TEXT,
      revision_notes  TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_test_runs (
      id             TEXT PRIMARY KEY,
      skill_id       TEXT NOT NULL,
      description    TEXT,
      mock_inputs    TEXT,
      actual_output  TEXT,
      expected_keys  TEXT,
      pass           INTEGER,
      ai_comment     TEXT,
      run_at         INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // 迁移：加新列（SQLite 忽略已存在列的错误）
  const migrations = [
    `ALTER TABLE skills ADD COLUMN sandbox_status TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE skills ADD COLUMN sandbox_test TEXT`,
    `ALTER TABLE skills ADD COLUMN scripts_path TEXT`,
    `ALTER TABLE skills ADD COLUMN plugin_config TEXT`,
  ];
  for (const sql of migrations) {
    try { db.prepare(sql).run(); } catch { /* column already exists, ignore */ }
  }

  console.log('[DB] SQLite schema initialized.');
}
