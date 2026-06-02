-- SBI Health Insurance UW Agent — PostgreSQL Schema
-- Run: sudo docker exec -i sbi-postgres psql -U sbi_app -d sbi_uw < schema.sql

CREATE TABLE IF NOT EXISTS workflows (
  id           TEXT PRIMARY KEY,
  proposal_id  TEXT UNIQUE,
  state        TEXT NOT NULL DEFAULT 'created',
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflows_state   ON workflows(state);
CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at DESC);

CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL,
  name         TEXT,
  category     TEXT,
  s3_key       TEXT,
  content_type TEXT,
  size_bytes   INTEGER,
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_workflow ON documents(workflow_id);

CREATE TABLE IF NOT EXISTS analysis_results (
  id             SERIAL PRIMARY KEY,
  workflow_id    TEXT NOT NULL,
  ai_analysis    JSONB,
  extracted_data JSONB,
  decision       JSONB,
  risk_score     JSONB,
  analyzed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analysis_workflow ON analysis_results(workflow_id);

CREATE TABLE IF NOT EXISTS biometrics (
  id          SERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  type        TEXT,
  s3_key      TEXT,
  score       NUMERIC,
  status      TEXT,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_biometrics_workflow ON biometrics(workflow_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  workflow_id TEXT,
  action      TEXT,
  actor       TEXT,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_workflow ON audit_log(workflow_id);

-- Verify
\dt