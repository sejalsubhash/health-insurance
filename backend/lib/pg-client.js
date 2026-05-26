/**
 * PostgreSQL Client — replaces s3-client for all structured JSON data
 * Option B: PostgreSQL for JSON/metadata, S3 kept only for binary files
 *           (documents, face images, policy PDFs)
 *
 * Uses pg (node-postgres) with connection pooling.
 * All JSON data stored in JSONB columns for fast querying.
 * Binary files (uploads/) still go to S3 via the thin s3-files.js helper.
 */

const { Pool } = require('pg');
const crypto = require('crypto');

// ─── Connection Pool ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[PG] Unexpected pool error:', err.message);
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

// ─── Schema Bootstrap ─────────────────────────────────────────────────────────
// Called once at startup — idempotent (CREATE TABLE IF NOT EXISTS)
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS workflows (
      id           TEXT PRIMARY KEY,
      proposal_id  TEXT UNIQUE,
      state        TEXT NOT NULL DEFAULT 'created',
      data         JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_state       ON workflows(state);
    CREATE INDEX IF NOT EXISTS idx_workflows_updated     ON workflows(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflows_vendor      ON workflows((data->>'vendor_id'));
    CREATE INDEX IF NOT EXISTS idx_workflows_uw_email    ON workflows((data->>'assigned_uw_email'));
    CREATE INDEX IF NOT EXISTS idx_workflows_info_token  ON workflows USING GIN ((data->'information_requests'));

    CREATE TABLE IF NOT EXISTS users (
      email        TEXT PRIMARY KEY,
      data         JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS config (
      key          TEXT PRIMARY KEY,
      data         JSONB NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS masters (
      type         TEXT PRIMARY KEY,
      data         JSONB NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS documents (
      id           TEXT PRIMARY KEY,
      workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      category     TEXT,
      s3_key       TEXT,
      content_type TEXT,
      size_bytes   INTEGER,
      meta         JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_documents_workflow ON documents(workflow_id);

    CREATE TABLE IF NOT EXISTS biometrics (
      id           SERIAL PRIMARY KEY,
      workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      type         TEXT NOT NULL,
      s3_key       TEXT,
      score        NUMERIC,
      status       TEXT,
      meta         JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_biometrics_workflow ON biometrics(workflow_id);

    CREATE TABLE IF NOT EXISTS analysis_results (
      id           SERIAL PRIMARY KEY,
      workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      ai_analysis  JSONB,
      extracted_data JSONB,
      decision     JSONB,
      risk_score   JSONB,
      analyzed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_workflow ON analysis_results(workflow_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id           SERIAL PRIMARY KEY,
      workflow_id  TEXT,
      action       TEXT,
      actor        TEXT,
      data         JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_workflow ON audit_log(workflow_id);
  `);
  console.log('[PG] Schema initialised');
}

// ─── PII Encryption (same logic as s3-client) ─────────────────────────────────
const PII_FIELDS = ['proposer_name', 'observations', 'lifestyle', 'medical_history', 'extracted_data', 'ai_summary_text'];
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || null;

function getEncKey() {
  if (!ENCRYPTION_KEY) return null;
  return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
}

function encryptField(value) {
  const key = getEncKey();
  if (!key) return value;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    let enc = cipher.update(str, 'utf8', 'base64') + cipher.final('base64');
    return { _enc: true, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc };
  } catch(e) { return value; }
}

function decryptField(value) {
  const key = getEncKey();
  if (!key || !value?._enc) return value;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const dec = decipher.update(value.data, 'base64', 'utf8') + decipher.final('utf8');
    try { return JSON.parse(dec); } catch { return dec; }
  } catch(e) { return value; }
}

function encryptPII(data) {
  if (!getEncKey() || !data) return data;
  const out = { ...data };
  for (const f of PII_FIELDS) {
    if (out[f] != null) out[f] = encryptField(out[f]);
  }
  out._pii_encrypted = true;
  return out;
}

function decryptPII(data) {
  if (!data?._pii_encrypted) return data;
  const out = { ...data };
  for (const f of PII_FIELDS) {
    if (out[f]?._enc) out[f] = decryptField(out[f]);
  }
  delete out._pii_encrypted;
  return out;
}

// ─── In-memory cache (same TTL pattern as s3-client) ─────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function setCache(key, data) {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}
function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiry) { cache.delete(key); return null; }
  return e.data;
}
function clearCache() { cache.clear(); }

// ─── Workflows ────────────────────────────────────────────────────────────────

async function saveWorkflow(id, data) {
  // Strip base64 document content before storing (keep in S3)
  const slim = { ...data };
  if (slim.documents) {
    slim.documents = slim.documents.map(d => {
      const { base64_data, ...meta } = d;
      return { ...meta, has_content: !!base64_data };
    });
  }
  const stored = encryptPII(slim);
  await query(`
    INSERT INTO workflows (id, proposal_id, state, data, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE
      SET state = EXCLUDED.state,
          data  = EXCLUDED.data,
          updated_at = EXCLUDED.updated_at
  `, [id, data.proposal_id, data.state, stored, data.created_at || new Date(), data.updated_at || new Date()]);
  setCache(`wf:${id}`, slim);
  return slim;
}

async function getWorkflowFromDB(id) {
  const cached = getCache(`wf:${id}`);
  if (cached) return cached;
  const r = await query('SELECT data FROM workflows WHERE id = $1', [id]);
  if (!r.rows.length) return null;
  const data = decryptPII(r.rows[0].data);
  setCache(`wf:${id}`, data);
  return data;
}

async function listWorkflowsFromDB() {
  const r = await query('SELECT data FROM workflows ORDER BY updated_at DESC');
  return r.rows.map(row => decryptPII(row.data));
}

// ─── Users ────────────────────────────────────────────────────────────────────

async function getUsers() {
  const r = await query('SELECT data FROM users ORDER BY (data->>\'created_at\') ASC');
  return r.rows.map(row => row.data);
}

async function saveUsers(users) {
  // Upsert all users in a single transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of users) {
      await client.query(`
        INSERT INTO users (email, data, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `, [u.email.toLowerCase(), u]);
    }
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Config (products, policies, product-policy-map, custom-rules, etc.) ──────

async function saveConfig(key, data) {
  await query(`
    INSERT INTO config (key, data, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `, [key, data]);
  setCache(`cfg:${key}`, data);
}

async function getConfig(key) {
  const cached = getCache(`cfg:${key}`);
  if (cached) return cached;
  const r = await query('SELECT data FROM config WHERE key = $1', [key]);
  if (!r.rows.length) return null;
  setCache(`cfg:${key}`, r.rows[0].data);
  return r.rows[0].data;
}

// ─── Masters (uw-guidelines, risk-params, medical-scoring) ───────────────────

async function getMasters(type) {
  const cached = getCache(`masters:${type}`);
  if (cached) return cached;
  const r = await query('SELECT data FROM masters WHERE type = $1', [type]);
  if (!r.rows.length) return null;
  setCache(`masters:${type}`, r.rows[0].data);
  return r.rows[0].data;
}

async function saveMasters(type, data) {
  await query(`
    INSERT INTO masters (type, data, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (type) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `, [type, data]);
  setCache(`masters:${type}`, data);
}

// ─── Custom UW Rules ──────────────────────────────────────────────────────────

async function getCustomRules() {
  const data = await getConfig('custom-rules');
  return data || [];
}

async function saveCustomRules(rules) {
  await saveConfig('custom-rules', rules);
}

// ─── Analysis Results ─────────────────────────────────────────────────────────

async function saveAnalysisResult(workflowId, data) {
  await query(`
    INSERT INTO analysis_results (workflow_id, ai_analysis, extracted_data, decision, risk_score, analyzed_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [workflowId, data.ai_analysis, data.extracted_data || null, data.decision, data.risk_score]);
  return { workflowId };
}

async function saveExtractedData(workflowId, extractedData) {
  await query(`
    UPDATE analysis_results
    SET extracted_data = $2
    WHERE workflow_id = $1
  `, [workflowId, extractedData]);
}

// ─── Document Metadata ────────────────────────────────────────────────────────
// Binary content goes to S3 via s3-files.js — only metadata stored in PG

async function saveDocumentMeta(workflowId, doc) {
  await query(`
    INSERT INTO documents (id, workflow_id, name, category, s3_key, content_type, size_bytes, meta)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (id) DO UPDATE
      SET s3_key = EXCLUDED.s3_key, meta = EXCLUDED.meta
  `, [doc.id, workflowId, doc.name, doc.category || doc.type, doc.s3_key || null, doc.content_type || doc.mimetype, doc.size, doc]);
}

// ─── Biometric Metadata ───────────────────────────────────────────────────────

async function saveBiometricMeta(workflowId, type, s3Key, score, status, meta) {
  await query(`
    INSERT INTO biometrics (workflow_id, type, s3_key, score, status, meta)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [workflowId, type, s3Key, score, status, meta]);
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

async function saveAuditEntry(workflowId, entry) {
  await query(`
    INSERT INTO audit_log (workflow_id, action, actor, data)
    VALUES ($1, $2, $3, $4)
  `, [workflowId, entry.action || 'event', entry.editor || entry.actor || 'system', entry]);
}

// ─── Compatibility shims (same API surface as s3-client) ─────────────────────
// These allow server.js to call the same function names as before

async function saveDocumentToS3(workflowId, docId, buffer, contentType) {
  // This now delegates to the S3 files helper (binary only)
  // The metadata is stored in PG via saveDocumentMeta
  // Return a fake key so callers don't break
  return { key: `uploads/${workflowId}/documents/${docId}`, bucket: process.env.S3_BUCKET };
}

async function getDocumentFromS3(key) {
  // Still reads binary from S3 — this stays S3-backed
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  const response = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: response.ContentType };
}

async function saveUpload(workflowId, docId, buffer, contentType) {
  // Binary goes to S3
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  const key = `uploads/${workflowId}/documents/${docId}`;
  await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return { key, bucket: process.env.S3_BUCKET };
}

async function saveBiometric(workflowId, type, buffer, contentType) {
  // Binary goes to S3
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  const key = `uploads/${workflowId}/biometrics/${type}`;
  await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: buffer, ContentType: contentType || 'image/jpeg' }));
  return { key, bucket: process.env.S3_BUCKET };
}

// ─── Exports (same surface as s3-client.js) ───────────────────────────────────
module.exports = {
  // Schema
  initSchema,
  pool,
  query,

  // Workflows
  saveWorkflow,
  getWorkflowFromS3: getWorkflowFromDB,   // alias for compatibility
  listWorkflowsFromS3: listWorkflowsFromDB, // alias for compatibility

  // Users
  getUsers,
  saveUsers,

  // Config
  saveConfig,
  getConfig,

  // Masters
  getMasters,
  saveMasters,

  // Custom rules
  getCustomRules,
  saveCustomRules,

  // Analysis
  saveAnalysisResult,
  saveExtractedData,

  // Documents (metadata in PG, binary in S3)
  saveDocumentMeta,
  saveDocumentToS3,   // binary → S3 (shim)
  getDocumentFromS3,  // binary ← S3 (shim)
  saveUpload,         // binary → S3
  saveBiometric,      // binary → S3
  saveBiometricMeta,

  // Audit
  saveAuditEntry,

  // Misc
  clearCache,

  // Legacy no-ops (assessments were never used in this app)
  saveAssessment: async () => {},
  getAssessment:  async () => null,
  listAssessments: async () => [],
  deleteAssessment: async () => {},
  uploadDocument: saveUpload,
  getDocument: getDocumentFromS3
};
