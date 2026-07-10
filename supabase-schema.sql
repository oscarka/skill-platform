-- Skill Platform PostgreSQL Schema
-- 在 Supabase SQL 编辑器里运行这个
-- 用独立 schema "skill_platform" 与其他项目隔离

-- 1. 创建 schema
CREATE SCHEMA IF NOT EXISTS skill_platform;

-- 2. 以下所有表都在 skill_platform schema 下

CREATE TABLE IF NOT EXISTS skill_platform.skills (
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
  scripts_path    TEXT
);

CREATE TABLE IF NOT EXISTS skill_platform.tickets (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL REFERENCES skill_platform.skills(id),
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
  updated_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_platform.ticket_inputs (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES skill_platform.tickets(id),
  field_key   TEXT NOT NULL,
  field_type  TEXT NOT NULL DEFAULT 'text',
  value       TEXT,
  file_path   TEXT,
  file_name   TEXT,
  mime_type   TEXT,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_platform.ticket_results (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT UNIQUE NOT NULL REFERENCES skill_platform.tickets(id),
  raw_result      TEXT,
  revised_result  TEXT,
  revision_notes  TEXT,
  revised_by      TEXT,
  revised_at      BIGINT,
  report_path     TEXT,
  report_type     TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_platform.revision_memories (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL,
  ticket_id       TEXT,
  original_output TEXT,
  revised_output  TEXT,
  revision_notes  TEXT,
  created_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_platform.skill_test_runs (
  id             TEXT PRIMARY KEY,
  skill_id       TEXT NOT NULL REFERENCES skill_platform.skills(id),
  description    TEXT,
  mock_inputs    TEXT,
  actual_output  TEXT,
  expected_keys  TEXT,
  pass           INTEGER,
  ai_comment     TEXT,
  run_at         BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_platform.settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- 初始化默认配置
INSERT INTO skill_platform.settings (key, value, updated_at) VALUES
  ('default_model', 'doubao-seed-1-8-251228', extract(epoch from now())::bigint * 1000)
ON CONFLICT (key) DO NOTHING;

-- 验证
SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'skill_platform' ORDER BY tablename;
