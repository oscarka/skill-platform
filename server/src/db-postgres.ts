/**
 * db.ts — PostgreSQL (Supabase) 版本
 *
 * 接口与 SQLite 版本保持兼容：
 *   run(sql, params)  → void (sync-like via execSync wrapper)
 *   get<T>(sql, params) → T | undefined
 *   all<T>(sql, params) → T[]
 *
 * 注意：内部是 async，外部调用方需要 await runAsync/getAsync/allAsync
 * 为了兼容现有大量同步调用，提供两套接口：
 *   - runAsync / getAsync / allAsync  (推荐，await 调用)
 *   - run / get / all  (同步包装，仅在 initDb 阶段可用，生产代码请用 async 版)
 */

import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:lnZbMyimxpMYgUp5@db.feaeonavsqzewadgoqeh.supabase.co:5432/postgres';

// Schema 名称 — 所有表都在 skill_platform schema 下，与其他项目隔离
const DB_SCHEMA = process.env.DB_SCHEMA || 'skill_platform';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  // 强制使用代码级 SSL 配置，避免连接串里的 sslmode 被新版 pg 解析为 verify-full
  ssl: DATABASE_URL.includes('supabase.co')
    ? { rejectUnauthorized: false, checkServerIdentity: () => undefined }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

// 每个连接建立后设置 search_path，让 SQL 无需写 schema 前缀
pool.on('connect', (client) => {
  client.query(`SET search_path TO ${DB_SCHEMA}, public`);
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

console.log(`[DB] PostgreSQL pool initialized → schema: ${DB_SCHEMA}`);


// ─── Async helpers ─────────────────────────────────────────────────────────────

/** Execute INSERT/UPDATE/DELETE */
export async function runAsync(sql: string, params: any[] = []): Promise<void> {
  const pgSql = toPostgresSql(sql, params);
  await pool.query(pgSql.sql, pgSql.params);
}

/** Fetch single row */
export async function getAsync<T>(sql: string, params: any[] = []): Promise<T | undefined> {
  const pgSql = toPostgresSql(sql, params);
  const result = await pool.query(pgSql.sql, pgSql.params);
  return result.rows[0] as T | undefined;
}

/** Fetch all rows */
export async function allAsync<T>(sql: string, params: any[] = []): Promise<T[]> {
  const pgSql = toPostgresSql(sql, params);
  const result = await pool.query(pgSql.sql, pgSql.params);
  return result.rows as T[];
}

/** Execute raw SQL (for schema creation) */
export async function execAsync(sql: string): Promise<void> {
  await pool.query(sql);
}

// ─── SQLite → PostgreSQL SQL 转换 ──────────────────────────────────────────────

// 各表的主键（用于 INSERT OR REPLACE → ON CONFLICT DO UPDATE 转换）
const TABLE_PK: Record<string, string> = {
  settings:          'key',
  skills:            'id',
  tickets:           'id',
  ticket_inputs:     'id',
  ticket_results:    'ticket_id',
  revision_memories: 'id',
  skill_test_runs:   'id',
};

/**
 * 把 SQLite 风格 SQL 转换为 PostgreSQL：
 * 1. ? → $1 $2 $3...
 * 2. INSERT OR REPLACE INTO → INSERT INTO ... ON CONFLICT (pk) DO UPDATE SET ...
 */
function toPostgresSql(sql: string, params: any[]): { sql: string; params: any[] } {
  let pgSql = sql;

  // INSERT OR REPLACE INTO table (col1,col2,...) VALUES (?,?...)
  const insertMatch = pgSql.match(/INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const table   = insertMatch[1].toLowerCase();
    const cols    = insertMatch[2].split(',').map(c => c.trim());
    const pk      = TABLE_PK[table] || cols[0];
    const setCols = cols.filter(c => c !== pk);
    const setClause = setCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
    pgSql = pgSql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/i, 'INSERT INTO')
      + ` ON CONFLICT (${pk}) DO UPDATE SET ${setClause}`;
  }

  // ? → $1, $2, $3...
  let i = 0;
  pgSql = pgSql.replace(/\?/g, () => `$${++i}`);

  return { sql: pgSql, params };
}

// ─── 同步兼容层（仅用于向后兼容，新代码请用 async 版本）──────────────────────

let _syncWarned = false;
function warnSync() {
  if (!_syncWarned) {
    _syncWarned = true;
    console.warn('[DB] Warning: sync db.run/get/all called — these are no-ops in PostgreSQL mode. Migrate to runAsync/getAsync/allAsync.');
  }
}

/** @deprecated 使用 runAsync */
export function run(sql: string, params: any[] = []): void {
  warnSync();
  // 异步执行，不等待（仅用于向后兼容非关键路径）
  runAsync(sql, params).catch(e => console.error('[DB] async run error:', e.message));
}

/** @deprecated 使用 getAsync */
export function get<T>(sql: string, params: any[] = []): T | undefined {
  warnSync();
  return undefined; // 同步无法返回异步结果
}

/** @deprecated 使用 allAsync */
export function all<T>(sql: string, params: any[] = []): T[] {
  warnSync();
  return [];
}

// ─── Schema 初始化 ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
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
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  published_at    BIGINT,
  sandbox_status  TEXT NOT NULL DEFAULT 'none',
  sandbox_test    TEXT,
  sandbox_progress TEXT,
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
  h5_submitted_at BIGINT,
  ai_started_at   BIGINT,
  ai_completed_at BIGINT,
  expires_at      BIGINT NOT NULL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
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
  created_at  BIGINT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS ticket_results (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT UNIQUE NOT NULL,
  raw_result      TEXT,
  revised_result  TEXT,
  revision_notes  TEXT,
  revised_by      TEXT,
  revised_at      BIGINT,
  report_path     TEXT,
  report_type     TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS revision_memories (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL,
  ticket_id       TEXT,
  original_output TEXT,
  revised_output  TEXT,
  revision_notes  TEXT,
  created_at      BIGINT NOT NULL
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
  run_at         BIGINT NOT NULL,
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_runs (
  id          TEXT PRIMARY KEY,
  skill_id    TEXT NOT NULL,
  inputs      TEXT,
  model       TEXT,
  raw_result  TEXT,
  error       TEXT,
  duration_ms INTEGER,
  created_by  TEXT,
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS mcp_configs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  command     TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '',
  env         TEXT,
  description TEXT,
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  UNIQUE(name)
);
`;

export async function initDb(): Promise<void> {
  try {
    await pool.query(SCHEMA_SQL);

    // 迁移：为已存在的表加新列（PostgreSQL 用 IF NOT EXISTS 语法）
    const migrations = [
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS sandbox_status TEXT NOT NULL DEFAULT 'none'`,
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS sandbox_test TEXT`,
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS sandbox_progress TEXT`,
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS scripts_path TEXT`,
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS plugin_config TEXT`,
    ];
    for (const sql of migrations) {
      try { await pool.query(sql); } catch { /* ignore */ }
    }

    console.log('[DB] PostgreSQL schema initialized.');
  } catch (err: any) {
    console.error('[DB] Schema init error:', err.message);
    throw err;
  }
}
