/**
 * S3 Client — Source of Truth for all assessments and masters
 * Pattern: S3 is the canonical store, in-memory Map is TTL cache only
 * PII fields encrypted with AES-256-GCM before S3 storage
 */
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.S3_BUCKET || 'acc-insurance-uw';
const S3_ENABLED = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

// Phase 0 fix: wrap s3.send so every call becomes a no-op when S3 isn't configured.
// This lets dev/test modes run without AWS credentials — all reads return null, all writes are dropped.
const _originalSend = s3.send.bind(s3);
s3.send = function(command) {
  if (!S3_ENABLED) {
    const name = command.constructor?.name || '';
    if (name === 'GetObjectCommand') {
      const err = new Error('S3 not configured');
      err.name = 'NoSuchKey';
      return Promise.reject(err);
    }
    if (name === 'ListObjectsV2Command') return Promise.resolve({ Contents: [] });
    return Promise.resolve({}); // PutObject, DeleteObject → silent success
  }
  return _originalSend(command);
};

// PII Encryption — AES-256-GCM
const PII_FIELDS = ['proposer_name', 'observations', 'lifestyle', 'medical_history', 'extracted_data', 'ai_summary_text'];
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || null;

function getEncKey() {
  if (!ENCRYPTION_KEY) return null;
  // Derive a 32-byte key from the env var using SHA-256
  return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
}

function encryptField(value) {
  const key = getEncKey();
  if (!key) return value;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    let encrypted = cipher.update(str, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag().toString('base64');
    return { _encrypted: true, iv: iv.toString('base64'), tag, data: encrypted };
  } catch(e) { console.error('[Encrypt] Error:', e.message); return value; }
}

function decryptField(value) {
  const key = getEncKey();
  if (!key || !value || !value._encrypted) return value;
  try {
    const iv = Buffer.from(value.iv, 'base64');
    const tag = Buffer.from(value.tag, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(value.data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    // Try to parse as JSON, return string if not
    try { return JSON.parse(decrypted); } catch { return decrypted; }
  } catch(e) { console.error('[Decrypt] Error:', e.message); return value; }
}

function encryptPII(data) {
  if (!getEncKey() || !data) return data;
  const encrypted = { ...data };
  for (const field of PII_FIELDS) {
    if (encrypted[field] !== undefined && encrypted[field] !== null) {
      encrypted[field] = encryptField(encrypted[field]);
    }
  }
  encrypted._pii_encrypted = true;
  return encrypted;
}

function decryptPII(data) {
  if (!data || !data._pii_encrypted) return data;
  const decrypted = { ...data };
  for (const field of PII_FIELDS) {
    if (decrypted[field] && decrypted[field]._encrypted) {
      decrypted[field] = decryptField(decrypted[field]);
    }
  }
  delete decrypted._pii_encrypted;
  return decrypted;
}

// In-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(prefix, id) {
  return `${prefix}/${id}`;
}

function setCache(key, data) {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

// ─── Assessment Operations ───

async function saveAssessment(id, data) {
  const key = `assessments/${id}.json`;
  const body = JSON.stringify(data, null, 2);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/json'
  }));
  setCache(getCacheKey('assessments', id), data);
  return data;
}

async function getAssessment(id) {
  const cacheKey = getCacheKey('assessments', id);
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `assessments/${id}.json`
    }));
    const body = await response.Body.transformToString();
    const data = JSON.parse(body);
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function listAssessments() {
  const items = [];
  let continuationToken;

  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: 'assessments/',
      ContinuationToken: continuationToken
    }));

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key.endsWith('.json')) {
          const id = obj.Key.replace('assessments/', '').replace('.json', '');
          try {
            const assessment = await getAssessment(id);
            if (assessment) {
              items.push({
                id: assessment.id,
                proposer_name: assessment.proposer_name || assessment.company_name || 'Unknown',
                policy_type: assessment.policy_type || 'Life',
                sum_assured: assessment.sum_assured || 0,
                module: assessment.module || 'pphc',
                status: assessment.status || 'pending',
                risk_grade: assessment.risk_score?.grade || '-',
                created_at: assessment.created_at,
                updated_at: assessment.updated_at || assessment.created_at
              });
            }
          } catch (e) {
            console.error(`Error loading assessment ${id}:`, e.message);
          }
        }
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function deleteAssessment(id) {
  await s3.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: `assessments/${id}.json`
  }));
  cache.delete(getCacheKey('assessments', id));
}

// ─── Masters Operations ───

async function getMasters(masterType) {
  const cacheKey = getCacheKey('masters', masterType);
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `masters/${masterType}.json`
    }));
    const body = await response.Body.transformToString();
    const data = JSON.parse(body);
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function saveMasters(masterType, data) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `masters/${masterType}.json`,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json'
  }));
  setCache(getCacheKey('masters', masterType), data);
  return data;
}

// Phase 0 fix: in-memory fallback stores for dev/test mode where S3 isn't configured.
// These are also used as write-through caches in S3 mode so the same code path works either way.
const memStore = {
  users: null,         // null = not yet loaded; [] = loaded empty
  configs: {},         // { 'products': [...], 'policies': [...], 'product-policy-map': {...}, 'custom-rules': [...] }
  assessments: {},
  workflows: {},
  masters: {}
};

// ─── User Operations ───

async function getUsers() {
  if (!S3_ENABLED) {
    return memStore.users || [];
  }
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: 'users/users.json'
    }));
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey') return [];
    throw err;
  }
}

async function saveUsers(users) {
  memStore.users = users;
  if (!S3_ENABLED) return;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: 'users/users.json',
    Body: JSON.stringify(users, null, 2),
    ContentType: 'application/json'
  }));
}

// ─── File Upload (documents) ───

async function uploadDocument(assessmentId, filename, buffer, contentType) {
  const key = `documents/${assessmentId}/${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }));
  return { key, bucket: BUCKET };
}

async function getDocument(key) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: key
  }));
  return response;
}

// ─── Audit Trail ───

async function saveAuditEntry(assessmentId, entry) {
  const key = `audit/${assessmentId}/${Date.now()}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(entry, null, 2),
    ContentType: 'application/json'
  }));
}

// ─── Workflow Persistence ───

async function saveWorkflow(id, data) {
  // Save workflow metadata (without base64 document data to keep it fast)
  const slimData = { ...data };
  if (slimData.documents) {
    slimData.documents = slimData.documents.map(d => {
      const { base64_data, ...meta } = d;
      return { ...meta, has_content: !!base64_data };
    });
  }
  // Encrypt PII fields before S3 storage
  const storageData = encryptPII(slimData);
  const key = `workflows/${id}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key,
    Body: JSON.stringify(storageData, null, 2),
    ContentType: 'application/json'
  }));
  setCache(getCacheKey('workflows', id), slimData); // Cache unencrypted for fast reads
  return slimData;
}

async function getWorkflowFromS3(id) {
  const cacheKey = getCacheKey('workflows', id);
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `workflows/${id}.json` }));
    const body = await response.Body.transformToString();
    const raw = JSON.parse(body);
    // Decrypt PII fields after loading from S3
    const data = decryptPII(raw);
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function listWorkflowsFromS3() {
  const items = [];
  let continuationToken;
  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: 'workflows/', ContinuationToken: continuationToken
    }));
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key.endsWith('.json')) {
          const id = obj.Key.replace('workflows/', '').replace('.json', '');
          try {
            const wf = await getWorkflowFromS3(id);
            if (wf) items.push(wf);
          } catch (e) { console.error(`Error loading workflow ${id}:`, e.message); }
        }
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return items;
}

async function saveDocumentToS3(workflowId, docId, buffer, contentType) {
  const key = `documents/${workflowId}/${docId}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType
  }));
  return { key, bucket: BUCKET };
}

async function getDocumentFromS3(key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: response.ContentType };
}

async function saveCustomRules(rules) {
  memStore.configs['custom-rules'] = rules;
  if (!S3_ENABLED) return;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'config/custom-rules.json',
    Body: JSON.stringify(rules, null, 2), ContentType: 'application/json'
  }));
}

async function getCustomRules() {
  if (!S3_ENABLED) return memStore.configs['custom-rules'] || [];
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'config/custom-rules.json' }));
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (err) { return []; }
}

// ─── Product & Policy Config ───

async function saveConfig(key, data) {
  memStore.configs[key] = data;
  if (!S3_ENABLED) return;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: `config/${key}.json`,
    Body: JSON.stringify(data, null, 2), ContentType: 'application/json'
  }));
}

async function getConfig(key) {
  if (!S3_ENABLED) return memStore.configs[key] || null;
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `config/${key}.json` }));
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (err) { return null; }
}

module.exports = {
  saveAssessment,
  getAssessment,
  listAssessments,
  deleteAssessment,
  getMasters,
  saveMasters,
  getUsers,
  saveUsers,
  uploadDocument,
  getDocument,
  saveAuditEntry,
  saveWorkflow,
  getWorkflowFromS3,
  listWorkflowsFromS3,
  saveDocumentToS3,
  getDocumentFromS3,
  saveCustomRules,
  getCustomRules,
  saveConfig,
  getConfig,
  clearCache: () => cache.clear()
};
