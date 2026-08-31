CREATE TABLE skills (
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
      h5_config       TEXT,
      preferred_model TEXT,
      fallback_model  TEXT,
      test_inputs     TEXT,
      ai_review       TEXT,
      reject_reason   TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      published_at    INTEGER
    , plugin_config TEXT, sandbox_status TEXT NOT NULL DEFAULT 'none', sandbox_test TEXT, scripts_path TEXT, mcp_names TEXT DEFAULT NULL, tags TEXT DEFAULT NULL);
CREATE TABLE tickets (
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
      updated_at      INTEGER NOT NULL, wiki_confirmed_at INTEGER DEFAULT NULL, wiki_declined INTEGER NOT NULL DEFAULT 0, agent_id TEXT DEFAULT 'default',
      FOREIGN KEY (skill_id) REFERENCES skills(id)
    );
CREATE TABLE ticket_inputs (
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
CREATE TABLE ticket_results (
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
CREATE TABLE revision_memories (
      id              TEXT PRIMARY KEY,
      skill_id        TEXT NOT NULL,
      ticket_id       TEXT,
      original_output TEXT,
      revised_output  TEXT,
      revision_notes  TEXT,
      created_at      INTEGER NOT NULL
    );
CREATE TABLE skill_test_runs (
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
CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
CREATE TABLE test_runs (
      id          TEXT PRIMARY KEY,
      skill_id    TEXT NOT NULL,
      inputs      TEXT,
      model       TEXT,
      raw_result  TEXT,
      error       TEXT,
      duration_ms INTEGER,
      created_by  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
CREATE TABLE agent_profiles (
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
    , routing_examples TEXT DEFAULT NULL, knowledge_config TEXT DEFAULT NULL);
CREATE TABLE skill_confirm_guards (
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
    , agent_id TEXT DEFAULT 'default');
CREATE INDEX idx_skill_guards_session ON skill_confirm_guards(session_id, status);
CREATE TABLE user_recent_files (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      file_url    TEXT NOT NULL,
      file_name   TEXT NOT NULL,
      file_type   TEXT NOT NULL DEFAULT 'file',
      summary     TEXT,
      content_hash TEXT,
      created_at  INTEGER NOT NULL
    );
CREATE INDEX idx_user_recent_files_user ON user_recent_files(user_id, created_at);
CREATE INDEX idx_user_recent_files_hash ON user_recent_files(user_id, content_hash);
CREATE TABLE meta_agents (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      role_desc         TEXT NOT NULL,
      reply_style       TEXT NOT NULL,
      service_flow      TEXT DEFAULT '',
      taboos            TEXT DEFAULT '[]',
      reassurance_tpl   TEXT DEFAULT '',
      skill_ids         TEXT DEFAULT '[]',
      routing_examples  TEXT DEFAULT '[]',
      delivery_config   TEXT DEFAULT '{}',
      knowledge_domain  TEXT DEFAULT '',
      intent_prompt     TEXT DEFAULT '',
      status            TEXT DEFAULT 'draft',
      current_score     REAL DEFAULT 0,
      best_score        REAL DEFAULT 0,
      total_eval_rounds INTEGER DEFAULT 0,
      reject_reason     TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
CREATE TABLE meta_agent_eval_runs (
      run_id              TEXT PRIMARY KEY,
      agent_id            TEXT NOT NULL REFERENCES meta_agents(id) ON DELETE CASCADE,
      round               INTEGER NOT NULL,
      agent_version       TEXT NOT NULL,
      total_score         REAL DEFAULT 0,
      score_compliance    REAL DEFAULT 0,
      score_business      REAL DEFAULT 0,
      score_ticket_skill  REAL DEFAULT 0,
      score_memory        REAL DEFAULT 0,
      passed_cases        INTEGER DEFAULT 0,
      total_cases         INTEGER DEFAULT 0,
      taboo_violated      INTEGER DEFAULT 0,
      diagnosis_report    TEXT,
      case_results        TEXT,
      created_at          INTEGER NOT NULL
    , taboo_violations TEXT DEFAULT '[]', failed_cases INTEGER DEFAULT 0, diagnosis TEXT);
CREATE INDEX idx_meta_eval_runs_agent ON meta_agent_eval_runs(agent_id, round DESC);
