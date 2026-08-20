"use strict";
/**
 * db-sqlite.ts — SQLite 实现（本地开发用）
 * 原 db.ts 内容，保持同步接口
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
exports.get = get;
exports.all = all;
exports.initDb = initDb;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const DB_PATH = path_1.default.join(__dirname, '..', 'skill-platform.db');
const db = new better_sqlite3_1.default(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log('[DB] Connected to SQLite at', DB_PATH);
function run(sql, params = []) {
    db.prepare(sql).run(...params);
}
function get(sql, params = []) {
    return db.prepare(sql).get(...params);
}
function all(sql, params = []) {
    return db.prepare(sql).all(...params);
}
function initDb() {
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
      scripts_path    TEXT,
      mcp_names       TEXT DEFAULT NULL
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
      delivery_info   TEXT,
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
        `ALTER TABLE skills ADD COLUMN mcp_names TEXT DEFAULT NULL`,
        // Agent Profile 表（v2）
        `CREATE TABLE IF NOT EXISTS agent_profiles (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL DEFAULT '服务助理',
      role_desc           TEXT NOT NULL DEFAULT '',
      reply_style         TEXT NOT NULL DEFAULT '',
      service_flow        TEXT NOT NULL DEFAULT '',
      taboos              TEXT NOT NULL DEFAULT '[]',
      reassurance_mode    TEXT NOT NULL DEFAULT 'ai',
      reassurance_tpl     TEXT NOT NULL DEFAULT '',
      skill_mode          TEXT NOT NULL DEFAULT 'auto',
      skill_ids           TEXT NOT NULL DEFAULT '[]',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    )`,
        // Ticket: wiki 确认时间戳（NULL=未确认，>0=用户点了「认可并执行」）
        `ALTER TABLE tickets ADD COLUMN wiki_confirmed_at INTEGER DEFAULT NULL`,
        // Ticket: wiki 取消标记（用户点了「取消」）
        `ALTER TABLE tickets ADD COLUMN wiki_declined INTEGER NOT NULL DEFAULT 0`,
        // Skill 确认守卫表 —— skill_suggest 后激活，三值判断监听用户是否确认
        `CREATE TABLE IF NOT EXISTS skill_confirm_guards (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      skill_id     TEXT NOT NULL,
      skill_name   TEXT NOT NULL,
      suggest_msg  TEXT,
      suggest_ts   INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      close_reason TEXT,
      check_count  INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    )`,
        `CREATE INDEX IF NOT EXISTS idx_skill_guards_session ON skill_confirm_guards(session_id, status)`,
        // 为已有表添加 check_count列
        `ALTER TABLE skill_confirm_guards ADD COLUMN check_count INTEGER NOT NULL DEFAULT 0`,
        // 为已有 tickets 表添加 delivery_info 列（存储 callback_url + delivery 供 AI 处理完后通知用户）
        `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS delivery_info TEXT`,
        // prefilled_values: 建票时从 wiki 提取的预填字段 JSON
        `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS prefilled_values TEXT`,
        `CREATE TABLE IF NOT EXISTS user_recent_files (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      file_url    TEXT NOT NULL,
      file_name   TEXT NOT NULL,
      file_type   TEXT NOT NULL DEFAULT 'file',
      summary     TEXT,
      content_hash TEXT,
      created_at  INTEGER NOT NULL
    )`,
        `CREATE INDEX IF NOT EXISTS idx_user_recent_files_user ON user_recent_files(user_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_user_recent_files_hash ON user_recent_files(user_id, content_hash)`,
        // 已存在的表加列迁移（SQLite 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS，catch 会忽略"duplicate column"错误）
        `ALTER TABLE user_recent_files ADD COLUMN content_hash TEXT`,
        // ── Multi-Agent 改造 v1：agent_profiles 新增分诊示例与知识库工具配置字段 ──
        `ALTER TABLE agent_profiles ADD COLUMN routing_examples TEXT DEFAULT NULL`,
        `ALTER TABLE agent_profiles ADD COLUMN knowledge_config TEXT DEFAULT NULL`,
        // agent_id：守卫与工单绑定到具体 Agent 实例（多 Agent 隔离用）
        `ALTER TABLE skill_confirm_guards ADD COLUMN agent_id TEXT DEFAULT 'default'`,
        `ALTER TABLE tickets ADD COLUMN agent_id TEXT DEFAULT 'default'`,
        // ── Skill 标签系统：tags 用于过滤哪些 Skill 可配置给 Agent ──
        `ALTER TABLE skills ADD COLUMN tags TEXT DEFAULT NULL`,
    ];
    for (const sql of migrations) {
        try {
            db.prepare(sql).run();
        }
        catch { /* column already exists, ignore */ }
    }
    console.log('[DB] SQLite schema initialized.');
}
