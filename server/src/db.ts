/**
 * db.ts — 智能路由层
 *
 * - 本地开发 (DATABASE_URL 未设置): 使用 SQLite (better-sqlite3)
 * - 生产环境 (DATABASE_URL 已设置): 使用 PostgreSQL (Supabase via pg)
 *
 * 对外导出的接口完全一致，调用方无需感知底层差异。
 */

const USE_POSTGRES = !!process.env.DATABASE_URL;

if (USE_POSTGRES) {
  console.log('[DB] Mode: PostgreSQL (Supabase)');
} else {
  console.log('[DB] Mode: SQLite (local dev)');
}

// ─── 导出统一接口 ─────────────────────────────────────────────────────────────

export async function runAsync(sql: string, params: any[] = []): Promise<void> {
  if (USE_POSTGRES) {
    const pg = await import('./db-postgres');
    return pg.runAsync(sql, params);
  } else {
    const sq = await import('./db-sqlite');
    sq.run(sql, params);
  }
}

export async function getAsync<T>(sql: string, params: any[] = []): Promise<T | undefined> {
  if (USE_POSTGRES) {
    const pg = await import('./db-postgres');
    return pg.getAsync(sql, params) as Promise<T | undefined>;
  } else {
    const sq = await import('./db-sqlite');
    return (sq as any).get(sql, params) as T | undefined;
  }
}

export async function allAsync<T>(sql: string, params: any[] = []): Promise<T[]> {
  if (USE_POSTGRES) {
    const pg = await import('./db-postgres');
    return pg.allAsync(sql, params) as Promise<T[]>;
  } else {
    const sq = await import('./db-sqlite');
    return (sq as any).all(sql, params) as T[];
  }
}

/** 同步兼容层（仅用于少数遗留同步调用） */
export function run(sql: string, params: any[] = []): void {
  runAsync(sql, params).catch(e => console.error('[DB] run error:', e.message));
}

export function get<T>(sql: string, params: any[] = []): T | undefined {
  if (!USE_POSTGRES) {
    try {
      const sq = require('./db-sqlite');
      return (sq.get(sql, params)) as T | undefined;
    } catch { return undefined; }
  }
  console.warn('[DB] get() called synchronously in PostgreSQL mode — use getAsync() instead');
  return undefined;
}

export function all<T>(sql: string, params: any[] = []): T[] {
  if (!USE_POSTGRES) {
    try {
      const sq = require('./db-sqlite');
      return (sq.all(sql, params)) as T[];
    } catch { return []; }
  }
  console.warn('[DB] all() called synchronously in PostgreSQL mode — use allAsync() instead');
  return [];
}

export async function initDb(): Promise<void> {
  if (USE_POSTGRES) {
    const pg = await import('./db-postgres');
    return pg.initDb();
  } else {
    const sq = await import('./db-sqlite');
    sq.initDb();
  }
}
