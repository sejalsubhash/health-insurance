/**
 * ACC Health Insurance Underwriting Automation Platform
 * v4.0.0 — STP Fast-Lane + Custom Rules Enforcement + UW Routing Foundation
 */
require('dotenv').config();
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const __bedrockClient = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-south-1' });
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const s3Client = require('./lib/pg-client');  // PostgreSQL for JSON + S3 for binary files
const socketManager = require('./lib/socket-manager');
const bullQueue = require('./lib/bull-queue');
const riskEngine = require('./lib/medical-risk-engine');
const vendorApi = require('./lib/vendor-api');
const workflowEngine = require('./lib/workflow-engine');
const commsEngine = require('./lib/comms-engine');
const stpClassifier = require('./lib/stp-classifier');
const uwRouter = require('./lib/uw-router');
const infoRequestSuggester = require('./lib/info-request-suggester');
const commsDispatcher = require('./lib/integrations/comms-dispatcher');
const pasAdapter = require('./lib/integrations/pas-adapter');
const webhookDispatcher = require('./lib/integrations/webhook-dispatcher');
const { configureAuth, requireAuth, requireRole } = require('./lib/auth-config');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const NODE_ENV = process.env.NODE_ENV || 'development';

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors({ origin: [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173', /\.acc\.ltd$/], credentials: true, methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 500, standardHeaders: true, legacyHeaders: false }));

// Trust ALB proxy so secure cookies and real IPs work behind it
app.set('trust proxy', 1);

// Session store: Redis in prod (shared across instances, survives restarts), memory in dev
let sessionStore;
if (NODE_ENV === 'production' && process.env.REDIS_URL) {
  try {
    const { RedisStore } = require('connect-redis');
    const IORedis = require('ioredis');
    const redisUrl = process.env.REDIS_URL;
    const sessionRedis = new IORedis(redisUrl, { tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined });
    sessionStore = new RedisStore({ client: sessionRedis, prefix: 'sess:' });
    console.log('[Session] Redis store enabled');
  } catch (e) {
    console.error('[Session] Redis store init failed, falling back to memory:', e.message);
  }
}

if (!process.env.SESSION_SECRET) {
  console.warn('[Session] SESSION_SECRET not set — generating random secret. Sessions will not persist across restarts.');
}

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || require('crypto').randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 86400000,
    sameSite: 'lax',
    // Single container deployment — cookies are same-origin; keep .acc.ltd for custom domain compat
    domain: NODE_ENV === 'production' ? (process.env.COOKIE_DOMAIN || undefined) : undefined
  }
}));

// Input sanitization — strip HTML tags from all string fields in request body
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;').replace(/javascript:/gi, '').replace(/on\w+\s*=/gi, '');
}
function sanitizeObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObj);
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    clean[k] = typeof v === 'string' ? sanitizeString(v) : typeof v === 'object' ? sanitizeObj(v) : v;
  }
  return clean;
}
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') req.body = sanitizeObj(req.body);
  next();
});

if (process.env.AZURE_AD_CLIENT_ID && process.env.AZURE_AD_CLIENT_SECRET && process.env.AZURE_AD_TENANT_ID && process.env.AZURE_AD_REDIRECT_URI) {
  configureAuth(app);
}

// File upload config with type validation
const ALLOWED_MIMETYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/gif', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
const MAGIC_BYTES = { '%PDF': 'application/pdf', '\xFF\xD8\xFF': 'image/jpeg', '\x89PNG': 'image/png' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15*1024*1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
      return cb(new Error(`File type not allowed: ${file.mimetype}. Allowed: PDF, JPEG, PNG, TIFF, DOC, DOCX, XLS, XLSX`));
    }
    cb(null, true);
  }
});
// Magic byte validation middleware — call after multer
function validateFileContent(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  for (const file of files) {
    if (!file.buffer || file.buffer.length < 4) continue;
    const header = file.buffer.slice(0, 4).toString('latin1');
    if (file.mimetype === 'application/pdf' && !header.startsWith('%PDF')) {
      return res.status(400).json({ error: `File "${file.originalname}" claims to be PDF but has invalid content. Possible malicious file.` });
    }
    if (file.mimetype === 'image/jpeg' && !header.startsWith('\xFF\xD8\xFF')) {
      return res.status(400).json({ error: `File "${file.originalname}" claims to be JPEG but has invalid content.` });
    }
    if (file.mimetype === 'image/png' && !header.startsWith('\x89PNG')) {
      return res.status(400).json({ error: `File "${file.originalname}" claims to be PNG but has invalid content.` });
    }
  }
  next();
}
socketManager.init(server, [FRONTEND_URL, 'http://localhost:3000', /\.acc\.ltd$/]);
bullQueue.setSocketManager(socketManager);

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', version: '4.0.0', platform: 'ACC Health UW Automation', features: ['stp_fast_lane','custom_rules','nstp_full_pipeline'], timestamp: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', services: { s3: !!process.env.AWS_ACCESS_KEY_ID, redis: !!process.env.REDIS_URL, auth: !!process.env.AZURE_AD_CLIENT_ID, anthropic_api_key: !!process.env.ANTHROPIC_API_KEY, vendors: Object.keys(vendorApi.VENDORS).length }, anthropic_configured: !!process.env.ANTHROPIC_API_KEY }));

// S3 Diagnostic — actually tests read/write to confirm S3 is working
app.get('/api/s3-diagnostic', async (req, res) => {
  const results = {
    timestamp: new Date().toISOString(),
    env_vars: {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ? `SET (${process.env.AWS_ACCESS_KEY_ID.substring(0,4)}...${process.env.AWS_ACCESS_KEY_ID.slice(-4)})` : 'NOT SET [FAIL]',
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ? `SET (${process.env.AWS_SECRET_ACCESS_KEY.length} chars)` : 'NOT SET [FAIL]',
      AWS_REGION: process.env.AWS_REGION || 'NOT SET (defaults to ap-south-1)',
      S3_BUCKET: process.env.S3_BUCKET || 'NOT SET (defaults to acc-insurance-uw)'
    },
    bucket_name: process.env.S3_BUCKET || 'acc-insurance-uw',
    tests: {}
  };

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    results.diagnosis = 'FAIL — AWS credentials not set. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in Render environment variables.';
    return res.json(results);
  }

  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const testS3 = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
  const bucket = process.env.S3_BUCKET || 'acc-insurance-uw';
  const testKey = '_diagnostic/test-' + Date.now() + '.json';
  const testData = JSON.stringify({ test: true, timestamp: new Date().toISOString() });

  // Test 1: Write
  try {
    await testS3.send(new PutObjectCommand({ Bucket: bucket, Key: testKey, Body: testData, ContentType: 'application/json' }));
    results.tests.write = '[OK] SUCCESS — wrote test object to S3';
  } catch(e) {
    results.tests.write = `[FAIL] FAIL — ${e.name}: ${e.message}`;
    if (e.name === 'NoSuchBucket') results.tests.write_fix = `Bucket "${bucket}" does not exist. Create it in AWS Console → S3 → Create bucket → name: ${bucket} → region: ${process.env.AWS_REGION || 'ap-south-1'}`;
    else if (e.name === 'AccessDenied' || e.name === 'InvalidAccessKeyId' || e.name === 'SignatureDoesNotMatch') results.tests.write_fix = 'IAM credentials are invalid or lack s3:PutObject permission. Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in Render, and ensure the IAM user has S3 write permissions.';
    else if (e.name === 'CredentialsError' || e.message.includes('credentials')) results.tests.write_fix = 'AWS credentials format is wrong. Verify AWS_ACCESS_KEY_ID (starts with AKIA, 20 chars) and AWS_SECRET_ACCESS_KEY (40 chars).';
    else results.tests.write_fix = `Unexpected error: ${e.name}. Check AWS credentials and bucket configuration.`;
  }

  // Test 2: Read
  try {
    const getResult = await testS3.send(new GetObjectCommand({ Bucket: bucket, Key: testKey }));
    const body = await getResult.Body.transformToString();
    results.tests.read = `[OK] SUCCESS — read test object back (${body.length} bytes)`;
  } catch(e) {
    results.tests.read = `[FAIL] FAIL — ${e.name}: ${e.message}`;
    if (e.name === 'NoSuchKey') results.tests.read = '[WARN] Write may have failed — test object not found';
    else results.tests.read_fix = 'IAM user may lack s3:GetObject permission.';
  }

  // Test 3: List
  try {
    const listResult = await testS3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 10 }));
    const count = listResult.KeyCount || 0;
    const keys = (listResult.Contents || []).map(o => o.Key);
    results.tests.list = `[OK] SUCCESS — bucket has ${count} object(s)`;
    results.tests.list_sample = keys.slice(0, 5);
  } catch(e) {
    results.tests.list = `[FAIL] FAIL — ${e.name}: ${e.message}`;
    results.tests.list_fix = 'IAM user may lack s3:ListBucket permission.';
  }

  // Test 4: Delete test object
  try {
    await testS3.send(new DeleteObjectCommand({ Bucket: bucket, Key: testKey }));
    results.tests.delete = '[OK] SUCCESS — cleaned up test object';
  } catch(e) {
    results.tests.delete = `[WARN] Cleanup failed — ${e.message} (non-critical)`;
  }

  // Test 5: Check existing data
  try {
    const wfList = await testS3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'workflows/', MaxKeys: 5 }));
    results.tests.existing_workflows = `${wfList.KeyCount || 0} workflow(s) in S3`;
    const cfgList = await testS3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'config/', MaxKeys: 5 }));
    results.tests.existing_configs = `${cfgList.KeyCount || 0} config file(s) in S3`;
    const usrList = await testS3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'users/', MaxKeys: 5 }));
    results.tests.existing_users = `${usrList.KeyCount || 0} user file(s) in S3`;
  } catch(e) {
    results.tests.existing_data = `Could not check: ${e.message}`;
  }

  // Overall diagnosis
  const allPassed = results.tests.write?.startsWith('[OK]') && results.tests.read?.startsWith('[OK]') && results.tests.list?.startsWith('[OK]');
  if (allPassed) {
    results.diagnosis = '[OK] ALL TESTS PASSED — S3 is fully working. Data should persist across restarts.';
    results.next_steps = 'If data still disappears after restart, check Render logs for [Persist] Error messages. The issue may be in how the workflow engine calls persist().';
  } else {
    results.diagnosis = '[FAIL] S3 IS NOT WORKING — see individual test results above for the specific failure.';
    results.next_steps = 'Fix the failing test(s), then visit this endpoint again to re-test.';
  }

  res.json(results);
});

// Auth
const passport = require('passport');
app.get('/auth/login', (req, res, next) => passport.authenticate('azuread-openidconnect', { response: res, failureRedirect: '/auth/failure' })(req, res, next));
app.post('/auth/callback', (req, res, next) => passport.authenticate('azuread-openidconnect', { response: res, failureRedirect: '/auth/failure' })(req, res, next), async (req, res) => {
  try {
    const users = await getActiveUsers();
    const existing = users.find(u => u.email.toLowerCase() === req.user.email.toLowerCase());
    const isSuperAdmin = req.user.email.toLowerCase() === (process.env.SUPER_ADMIN_EMAIL||'').toLowerCase();
    if (!existing) {
      const newUser = { email: req.user.email, name: req.user.name, role: isSuperAdmin ? 'Super Admin' : 'Viewer', status: 'active', created_at: new Date().toISOString(), last_login: new Date().toISOString() };
      users.push(newUser);
      await s3Client.saveUsers(users);
      req.user.role = newUser.role;
    } else {
      if (existing.status === 'disabled') return res.redirect(FRONTEND_URL + '/login?error=disabled');
      existing.last_login = new Date().toISOString();
      existing.name = req.user.name || existing.name;
      await s3Client.saveUsers(users);
      req.user.role = isSuperAdmin ? 'Super Admin' : existing.role;
      req.user.vendor_id = existing.vendor_id || null;
    }
    res.redirect(FRONTEND_URL + '/app');
  } catch(e) { console.error('Auth callback error:', e.message); res.redirect(FRONTEND_URL + '/app'); }
});
app.get('/auth/user', requireAuth, async (req, res) => {
  // Enrich user data with role info from S3
  try {
    const users = await getActiveUsers();
    const u = users.find(u => u.email.toLowerCase() === req.user.email.toLowerCase());
    const isSuperAdmin = req.user.email.toLowerCase() === (process.env.SUPER_ADMIN_EMAIL||'').toLowerCase();
    res.json({ user: { ...req.user, role: isSuperAdmin ? 'Super Admin' : (u?.role || req.user.role || 'Viewer'), vendor_id: u?.vendor_id || null, status: u?.status || 'active', authority_tier: u?.authority_tier || req.user.authority_tier } });
  } catch(e) { res.json({ user: req.user }); }
});
app.get('/auth/logout', (req, res) => { if (req.session) req.session.demoUser = null; req.logout?.(() => {}); res.redirect(FRONTEND_URL + '/login'); });
app.get('/auth/failure', (req, res) => res.status(401).json({ error: 'Authentication failed' }));

// ─── Demo Login System ───
const DEMO_USERS = {
  'admin@sbigic.com':     { password: 'Admin@123',     name: 'Rajesh Kumar',   role: 'Super Admin',    authority_tier: null,              authority_limit_sa: null,      authority_limit_loading_pct: null, specialties: null, max_concurrent_cases: null },
  'uwadmin@sbigic.com':   { password: 'UWAdmin@123',   name: 'Priya Sharma',   role: 'UW Admin',       authority_tier: 'chief',           authority_limit_sa: 100000000, authority_limit_loading_pct: 200,  specialties: ['general','cardiac','metabolic','renal','hepatic','oncology','neurological'], max_concurrent_cases: 30 },
  'senioruw@sbigic.com':  { password: 'SeniorUW@123',  name: 'Amit Patel',     role: 'Senior UW',      authority_tier: 'senior',          authority_limit_sa: 25000000,  authority_limit_loading_pct: 100,  specialties: ['general','cardiac','metabolic','renal','hepatic'], max_concurrent_cases: 15 },
  'junioruw@sbigic.com':  { password: 'JuniorUW@123',  name: 'Neha Gupta',     role: 'Junior UW',      authority_tier: 'junior',          authority_limit_sa: 5000000,   authority_limit_loading_pct: 50,   specialties: ['general','metabolic'], max_concurrent_cases: 10 },
  'cmo@sbigic.com':       { password: 'CMO@123',       name: 'Dr. Suresh Iyer',role: 'Medical Officer', authority_tier: 'medical_officer', authority_limit_sa: null,      authority_limit_loading_pct: null,  specialties: ['general','cardiac','metabolic','renal','hepatic','oncology','neurological'], max_concurrent_cases: 20 },
  'vendor@medcheck.com':  { password: 'Vendor@123',    name: 'MedCheck Ops',   role: 'Vendor User',    authority_tier: null,              vendor_id: 'VEND-001' }
};

// Helper: get users from S3 with fallback to DEMO_USERS
async function getActiveUsers() {
  try {
    const s3Users = await s3Client.getUsers();
    if (s3Users && s3Users.length > 0) return s3Users;
  } catch(e) { /* S3 failed — use demo fallback */ }
  // Fallback to in-memory demo users
  return Object.entries(DEMO_USERS).map(([email, cfg]) => ({
    email, name: cfg.name, role: cfg.role, status: 'active',
    authority_tier: cfg.authority_tier, authority_limit_sa: cfg.authority_limit_sa,
    authority_limit_loading_pct: cfg.authority_limit_loading_pct,
    specialties: cfg.specialties, max_concurrent_cases: cfg.max_concurrent_cases,
    vendor_id: cfg.vendor_id || null
  }));
}

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const emailLower = email.toLowerCase().trim();
  const user = DEMO_USERS[emailLower];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid email or password' });

  const sessionUser = {
    email: emailLower, name: user.name, role: user.role,
    authority_tier: user.authority_tier, vendor_id: user.vendor_id || null
  };
  req.session.demoUser = sessionUser;
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Session save failed' });
    res.json({ success: true, user: sessionUser });
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) req.session.demoUser = null;
  res.json({ success: true });
});

// Seed demo UW users to S3 on startup (so UW routing can find them)
async function seedDemoUsers() {
  try {
    const existing = await getActiveUsers();
    const demoEmails = Object.keys(DEMO_USERS);
    let seeded = 0;
    for (const [email, cfg] of Object.entries(DEMO_USERS)) {
      if (existing.find(u => u.email.toLowerCase() === email)) continue;
      existing.push({
        email, name: cfg.name, role: cfg.role, status: 'active',
        authority_tier: cfg.authority_tier, authority_limit_sa: cfg.authority_limit_sa,
        authority_limit_loading_pct: cfg.authority_limit_loading_pct,
        specialties: cfg.specialties, max_concurrent_cases: cfg.max_concurrent_cases,
        vendor_id: cfg.vendor_id || null, created_at: new Date().toISOString(), source: 'demo_seed'
      });
      seeded++;
    }
    if (seeded > 0) {
      await s3Client.saveUsers(existing);
      console.log(`[Demo] Seeded ${seeded} demo UW users to S3`);
    }
  } catch(e) { console.error('[Demo] User seeding error:', e.message); }
}
seedDemoUsers();

// Document type detection helper
function detectDocType(filename) {
  const l = filename.toLowerCase();
  // Blood work / Chemistry
  if (l.includes('blood')||l.includes('chemistry')||l.includes('biochem')||l.includes('lipid')||l.includes('glucose')||l.includes('sugar')||l.includes('hba1c')||l.includes('cholesterol')||l.includes('liver_function')||l.includes('lft')||l.includes('kidney')||l.includes('kft')||l.includes('rft')||l.includes('thyroid')||l.includes('tft')) return 'blood_chemistry';
  // Hematology / CBC
  if (l.includes('cbc')||l.includes('hematology')||l.includes('haemoglobin')||l.includes('hemoglobin')||l.includes('complete_blood')) return 'hematology';
  // Urine
  if (l.includes('urine')||l.includes('urinalysis')||l.includes('urin')) return 'urine_analysis';
  // Cardiac / ECG
  if (l.includes('ecg')||l.includes('echo')||l.includes('cardiac')||l.includes('tmt')||l.includes('treadmill')||l.includes('stress_test')||l.includes('2d_echo')||l.includes('ekg')||l.includes('electrocardiogram')) return 'cardiac';
  // Physical examination
  if (l.includes('physical')||l.includes('examination')||l.includes('medical_exam')||l.includes('general_exam')) return 'physical_exam';
  // Imaging / Radiology
  if (l.includes('xray')||l.includes('x-ray')||l.includes('usg')||l.includes('imaging')||l.includes('ultrasound')||l.includes('mri')||l.includes('ct_scan')||l.includes('radiology')||l.includes('chest')) return 'imaging';
  // Telemer / Transcript
  if (l.includes('telemer')||l.includes('transcript')||l.includes('video_mer')) return 'telemer_transcript';
  // Biometric / KYC
  if (l.includes('biometric')||l.includes('kyc')||l.includes('aadhaar')||l.includes('pan_card')) return 'biometric_report';
  // Prescription
  if (l.includes('prescription')||l.includes('rx')||l.includes('medication')) return 'prescription';
  // Default: treat as lab report (covers generic names like 'report.pdf', 'scan.jpg')
  return 'lab_report';
}

// Workflow audit trail endpoint
app.get('/api/workflow/:id/audit-trail', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json(wf.audit_trail || []);
});

// Workflow API log endpoint
app.get('/api/workflow/:id/api-log', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json(wf.api_log || []);
});

// Document preview — returns base64 data for inline viewing
app.get('/api/workflow/:id/document/:docId/preview', requireAuth, async (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const doc = (wf.documents || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Lazy-load from S3 if content not in memory (after server restart)
  if (!doc.base64_data && doc.has_content && process.env.AWS_ACCESS_KEY_ID) {
    try {
      const s3Doc = await s3Client.getDocumentFromS3(`documents/${req.params.id}/${req.params.docId}`);
      if (s3Doc && s3Doc.buffer) {
        doc.base64_data = s3Doc.buffer.toString('base64');
        doc.content_type = doc.content_type || s3Doc.contentType;
      }
    } catch(e) { console.error('S3 doc lazy-load error:', e.message); }
  }

  if (!doc.base64_data) return res.status(404).json({ error: 'Document content not available. The document may not have been saved to S3.' });
  const isImage = ['image/jpeg','image/png','image/gif','image/webp'].includes(doc.content_type || doc.mimetype);
  const isPdf = (doc.content_type || doc.mimetype) === 'application/pdf';
  res.json({ id: doc.id, name: doc.name, content_type: doc.content_type || doc.mimetype, base64_data: doc.base64_data, is_image: isImage, is_pdf: isPdf, size: doc.size });
});

// Export workflow as PDF report
app.get('/api/workflow/:id/export-pdf', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });

  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 } });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=UW-Report-${wf.proposal_id}.pdf`);
  doc.pipe(res);

  const a = wf.ai_analysis || {};
  const score = a.risk_score?.normalized || 0;
  const grade = a.risk_score?.grade || 'N/A';
  const rec = a.recommendation || 'pending';
  const vendorNames = {'VEND-001':'MedCheck India','VEND-002':'HealthAssure','VEND-003':'DigiMedic','VEND-004':'ClinAssure Diagnostics','VEND-005':'MedElite Advanced Diagnostics'};
  const recLabels = { accept_standard:'APPROVED — Standard Rates', accept_with_loading:'APPROVED — With Loading', refer:'REFERRED — Senior UW Review', decline:'DECLINED', pending:'PENDING' };
  // Phase 1: override banner for auto_issued STP workflows
  const isAutoIssued = wf.state === 'auto_issued' || wf.state === 'policy_issued' || wf.route_type === 'stp_auto_issue';
  const isPolicyIssued = !!wf.policy?.policy_number;
  const effectiveRec = isPolicyIssued ? 'policy_issued' : isAutoIssued && wf.policy_number ? 'auto_issued' : rec;
  const effectiveLabel = isPolicyIssued
    ? `POLICY ISSUED — ${wf.policy.policy_number}`
    : isAutoIssued && wf.policy_number
    ? `AUTO-ISSUED — Policy ${wf.policy_number}`
    : wf.state === 'counter_offer_accepted'
    ? 'COUNTER-OFFER ACCEPTED — Awaiting Policy Issuance'
    : (recLabels[rec] || rec.toUpperCase());
  const bannerColor = isPolicyIssued || effectiveRec === 'auto_issued' ? '#1E8449'
    : wf.state === 'counter_offer_accepted' ? '#1E8449'
    : rec === 'accept_standard' ? '#2ECC71'
    : rec === 'accept_with_loading' ? '#E8A838'
    : rec === 'decline' ? '#E74C3C' : '#3498DB';

  // Header
  doc.rect(0, 0, 595, 80).fill('#0F1B42');
  doc.fontSize(16).fillColor('#FFFFFF').text('SBI General Insurance', 50, 20, { continued: true }).fontSize(16).fillColor('#4B9CD3').text(' Co. Ltd.', { continued: false });
  doc.fontSize(10).fillColor('rgba(255,255,255,0.8)').text('Health Underwriting Assessment Report', 50, 42);
  doc.fontSize(8).fillColor('rgba(255,255,255,0.5)').text(`Generated: ${new Date().toLocaleString('en-IN')}`, 380, 22);
  doc.text(`Proposal: ${wf.proposal_id}`, 380, 34);
  if (wf.policy?.policy_number) doc.fontSize(9).fillColor('#4B9CD3').text(`Policy: ${wf.policy.policy_number}`, 380, 48);

  let y = 100;

  // Decision banner
  doc.rect(50, y, 495, 35).fill(bannerColor);
  doc.fontSize(14).fillColor('#FFFFFF').text(effectiveLabel, 60, y + 10, { width: 380 });
  if (score > 0) doc.fontSize(12).text(`Score: ${Math.round(score)}/100 (${grade})`, 440, y + 10, { width: 100, align: 'right' });
  y += 50;

  // Section helper
  function sectionHeader(title) {
    doc.rect(50, y, 495, 20).fill('#F0F4F8');
    doc.fontSize(10).fillColor('#0F4C75').text(title, 56, y + 5, { width: 480 });
    y += 28;
  }
  function row(label, value) {
    doc.fontSize(9).fillColor('#6B7B8D').text(label, 56, y, { width: 150, continued: false });
    doc.fontSize(9).fillColor('#1A2332').text(String(value || '—'), 210, y, { width: 330 });
    y += 16;
    if (y > 750) { doc.addPage(); y = 50; }
  }

  // 1. Proposer Profile
  sectionHeader('1. PROPOSER PROFILE');
  row('Name', wf.proposer_name);
  row('Age / Gender', `${wf.age} / ${wf.gender}`);
  row('Product', wf.product_name || 'Health Shield');
  row('Sum Assured', `INR ${(wf.sum_assured||0).toLocaleString('en-IN')}`);
  row('Routing', (wf.route_type || 'nstp_full_pphc').replace(/_/g, ' '));
  row('NSTP Reason', (wf.nstp_reason || '').replace(/_/g, ' '));
  if (wf.policy_number) row('Policy Number', wf.policy_number);
  row('Assigned Vendor', vendorNames[wf.vendor_id] || wf.vendor_id || '—');
  row('SLA Deadline', wf.sla_deadline ? new Date(wf.sla_deadline).toLocaleDateString('en-IN') : '—');
  if (wf.observations) row('Observations', wf.observations);
  y += 8;

  // Phase 1: STP Evaluation block (only if this workflow went through STP classifier)
  if (wf.stp_evaluation) {
    sectionHeader('1A. STP EVALUATION');
    const e = wf.stp_evaluation;
    row('Eligible', e.eligible ? 'YES — auto-issued' : 'NO — routed to NSTP');
    row('Route', (e.route || '').replace(/_/g, ' '));
    row('Reason', e.reason || '—');
    if (e.duration_ms) row('Evaluation Time', `${e.duration_ms}ms`);
    if (e.policy_applied) row('Policy Applied', `${e.policy_applied.name} (${e.policy_applied.id})`);
    if (e.blocking_factors?.length) {
      e.blocking_factors.forEach(b => row(`  Block: ${b.code}`, b.detail));
    }
    if (e.soft_flags?.length) {
      e.soft_flags.forEach(f => row(`  Soft flag: ${f.code}`, f.detail));
    }
    if (wf.stp_shadow_mode) row('Shadow Mode', 'ACTIVE — STP decision logged but not enacted');
    y += 8;
  }

  // 2. Lifestyle & Medical History
  const ls = wf.lifestyle || {};
  const mh = wf.medical_history || {};
  if (Object.keys(ls).length || Object.keys(mh).length) {
    sectionHeader('2. LIFESTYLE & MEDICAL HISTORY');
    if (ls.smoking) row('Smoking', ls.smoking);
    if (ls.alcohol) row('Alcohol', ls.alcohol);
    if (ls.tobacco_chewing) row('Tobacco Chewing', ls.tobacco_chewing);
    if (ls.occupation_hazard) row('Occupation Hazard', ls.occupation_hazard);
    if (ls.exercise) row('Exercise', ls.exercise);
    if (ls.diet) row('Diet', ls.diet);
    if (mh.pre_existing_conditions?.length) row('Pre-existing Conditions', mh.pre_existing_conditions.join(', '));
    if (mh.family_history && mh.family_history !== 'none') row('Family History', mh.family_history);
    if (mh.hospitalizations && mh.hospitalizations !== '0') row('Hospitalizations', mh.hospitalizations);
    y += 8;
  }

  // 3. Risk Score & Decision
  if (a.risk_score) {
    sectionHeader('3. RISK ASSESSMENT');
    row('Health Risk Score', `${Math.round(score)}/100 (Grade ${grade})`);
    row('Decision', recLabels[rec] || rec);
    if (a.loading_percentage) row('Premium Loading', `+${a.loading_percentage}%`);
    row('Rules Checked', a.guidelines_compliance?.total_rules_checked || 0);
    row('Documents Analyzed', a.documents_analyzed || 0);
    row('Extraction Method', wf.extraction_method || 'N/A');
    y += 4;

    // Component scores
    if (a.component_analysis) {
      Object.entries(a.component_analysis).forEach(([name, comp]) => {
        row(`  ${name.replace(/_/g,' ')}`, `${comp.score}/${comp.max} (${comp.percentage}%)`);
      });
      y += 8;
    }
  }

  // 4. Key Findings
  if (a.findings?.length) {
    sectionHeader('4. KEY MEDICAL FINDINGS');
    a.findings.forEach(f => {
      doc.fontSize(9).fillColor(f.status === 'high' || f.status === 'abnormal' ? '#E74C3C' : '#1A2332').text(`${f.parameter}: ${f.value}`, 56, y, { width: 200 });
      doc.fontSize(8).fillColor('#6B7B8D').text(`[${f.status}] ${f.implication}`, 260, y, { width: 280 });
      y += 16;
      if (y > 750) { doc.addPage(); y = 50; }
    });
    y += 8;
  }

  // 5. Guideline Violations
  if (a.guidelines_compliance?.violations?.length) {
    sectionHeader('5. GUIDELINE VIOLATIONS');
    a.guidelines_compliance.violations.forEach(v => {
      doc.fontSize(9).fillColor('#E74C3C').text(`${v.rule_name}: value ${v.value} vs threshold ${v.threshold} — ${v.action}`, 56, y, { width: 480 });
      y += 14;
      if (y > 750) { doc.addPage(); y = 50; }
    });
    y += 8;
  }

  // 6. Loading Factors
  if (a.loading_factors?.length) {
    sectionHeader('6. LOADING FACTORS');
    a.loading_factors.forEach(l => {
      row(`  ${l.factor}`, l.loading);
    });
    row('Total Loading', `+${a.loading_percentage || 0}%`);
    y += 8;
  }

  // 7. Premium Calculation
  const prem = wf.premium_calculation;
  if (prem) {
    sectionHeader('7. PREMIUM CALCULATION');
    row('Product', prem.product || wf.product_name);
    row('Age Band', prem.age_band);
    row('Gender', prem.gender);
    row('Sum Assured', `INR ${(prem.sum_assured||0).toLocaleString('en-IN')}`);
    row('Base Premium', `INR ${(prem.base_premium||0).toLocaleString('en-IN')}/year`);
    if (prem.loading_pct > 0) {
      row('Loading Applied', `+${prem.loading_pct}%`);
      row('Loading Amount', `INR ${(prem.loading_amount||0).toLocaleString('en-IN')}`);
      row('Loaded Premium', `INR ${(prem.loaded_premium||0).toLocaleString('en-IN')}`);
    }
    row('GST', `${prem.gst_rate||18}% = INR ${(prem.gst_amount||0).toLocaleString('en-IN')}`);
    // Total premium in bold
    doc.fontSize(10).fillColor('#059669').text(`Total Annual Premium: INR ${(prem.total_annual_premium||0).toLocaleString('en-IN')}`, 56, y, { width: 480 });
    y += 20;
    if (prem.loading_breakdown?.length) {
      prem.loading_breakdown.forEach(l => row(`  Loading Factor`, `${l.factor}: ${l.loading}`));
    }
    y += 8;
  }

  // 8. Counter-Offer Details
  const co = wf.counter_offer;
  if (co) {
    sectionHeader('8. COUNTER-OFFER');
    row('Status', co.status?.toUpperCase() || 'PENDING');
    row('Sent On', co.sent_at ? new Date(co.sent_at).toLocaleString('en-IN') : '—');
    row('Deadline', co.deadline ? new Date(co.deadline).toLocaleDateString('en-IN') : '—');
    row('Sent By', co.sent_by || '—');
    if (co.responded_at) row('Customer Response', `${co.status} on ${new Date(co.responded_at).toLocaleString('en-IN')}`);
    if (co.exclusions?.length) row('Exclusions', co.exclusions.join(', '));
    y += 8;
  }

  // 9. Policy Details (if issued)
  const pol = wf.policy;
  if (pol?.policy_number) {
    if (y > 600) { doc.addPage(); y = 50; }
    // Policy certificate banner
    doc.rect(50, y, 495, 35).fill('#059669');
    doc.fontSize(12).fillColor('#FFFFFF').text(`POLICY ISSUED: ${pol.policy_number}`, 60, y + 10, { width: 480, align: 'center' });
    y += 50;

    sectionHeader('9. POLICY CERTIFICATE');
    row('Policy Number', pol.policy_number);
    row('Product', pol.product || wf.product_name);
    row('Policyholder', wf.proposer_name);
    row('Sum Assured', `INR ${(pol.sum_assured||0).toLocaleString('en-IN')}`);
    row('Annual Premium', `INR ${(pol.premium?.total_annual_premium||0).toLocaleString('en-IN')}`);
    row('Effective Date', pol.effective_date);
    row('Expiry Date', pol.expiry_date);
    row('Issued By', pol.issued_by);
    row('Issued On', pol.issued_at ? new Date(pol.issued_at).toLocaleString('en-IN') : '—');
    if (pol.loading_pct > 0) row('Loading Applied', `+${pol.loading_pct}%`);
    if (pol.exclusions?.length) row('Exclusions', pol.exclusions.join(', '));
    if (pol.waiting_periods && Object.keys(pol.waiting_periods).length) {
      Object.entries(pol.waiting_periods).forEach(([cond, wp]) => {
        row(`  Waiting Period: ${cond}`, `${wp.years || wp} years`);
      });
    }
    y += 8;
  }

  // 10. Payment Details
  if (wf.payment?.confirmed) {
    sectionHeader('10. PAYMENT CONFIRMATION');
    row('Amount', `INR ${(wf.payment.amount||0).toLocaleString('en-IN')}`);
    row('Mode', wf.payment.mode || '—');
    row('Reference', wf.payment.reference || '—');
    row('Confirmed By', wf.payment.confirmed_by || '—');
    row('Confirmed On', wf.payment.confirmed_at ? new Date(wf.payment.confirmed_at).toLocaleString('en-IN') : '—');
    y += 8;
  }

  // 11. Documents
  if (wf.documents?.length) {
    sectionHeader('11. DOCUMENTS (' + wf.documents.length + ')');
    wf.documents.forEach(d => {
      row(`  ${d.name}`, `${d.category || d.type} — ${Math.round((d.size||0)/1024)}KB — ${new Date(d.uploaded_at).toLocaleString('en-IN')}`);
    });
    y += 8;
  }

  // 8. AI Summary
  if (wf.ai_summary_text) {
    sectionHeader('12. AI UNDERWRITING SUMMARY');
    doc.fontSize(8).fillColor('#1A2332').text(wf.ai_summary_text, 56, y, { width: 480, lineGap: 3 });
    y = doc.y + 12;
  }

  // 9. Audit Trail
  if (wf.audit_trail?.length) {
    if (y > 650) { doc.addPage(); y = 50; }
    sectionHeader('13. AUDIT TRAIL');
    wf.audit_trail.forEach(t => {
      doc.fontSize(8).fillColor('#6B7B8D').text(`${new Date(t.timestamp).toLocaleString('en-IN')} — ${t.field_path}: ${t.old_value} → ${t.new_value} (${t.reason || 'no reason'}) by ${t.editor}`, 56, y, { width: 480 });
      y += 12;
      if (y > 750) { doc.addPage(); y = 50; }
    });
  }

  // Footer
  const pages = doc.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).fillColor('#6B7B8D').text(`SBI General Insurance Co. Ltd. — Health UW Report — ${wf.proposal_id} — Page ${i + 1} of ${pages.count}`, 50, 780, { width: 495, align: 'center' });
  }

  doc.end();
});

// Vendor APIs
app.get('/api/vendors', requireAuth, (req, res) => {
  const vendors = vendorApi.listVendors().map(v => {
    const cases = workflowEngine.listWorkflowsByVendor(v.id);
    const pending = cases.filter(w => !w.docs_submitted);
    const submitted = cases.filter(w => w.docs_submitted);
    return { ...v, case_count: cases.length, pending_cases: pending.length, submitted_cases: submitted.length };
  });
  res.json(vendors);
});
app.get('/api/vendors/:id', requireAuth, (req, res) => { const v = vendorApi.getVendor(req.params.id); if (!v) return res.status(404).json({ error: 'Not found' }); res.json(v); });

app.post('/api/vendors', requireRole('Super Admin'), async (req, res) => {
  try {
    const { id, name, code, type, regions, sla_hours, avg_tat_hours, compliance_rate, capabilities, status, description, cat_level } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'name and code required' });
    const vendorId = id || `VEND-${String(Date.now()).slice(-4)}`;
    const vendor = { id: vendorId, name, code, type: type||'full_pphc', regions: regions||[], sla_hours: sla_hours||48, avg_tat_hours: avg_tat_hours||36, compliance_rate: compliance_rate||95, capabilities: capabilities||[], status: status||'active', description: description||'', cat_level: cat_level||'', created_at: new Date().toISOString() };
    vendorApi.VENDORS[vendorId] = vendor;
    await s3Client.saveConfig('vendors', Object.values(vendorApi.VENDORS)).catch(()=>{});
    res.json({ success: true, ...vendor });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/vendors/:id', requireAuth, async (req, res) => {
  try {
    const v = vendorApi.VENDORS[req.params.id];
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    const { name, code, type, regions, sla_hours, avg_tat_hours, compliance_rate, capabilities, status, description, cat_level } = req.body;
    if (name) v.name = name; if (code) v.code = code; if (type) v.type = type;
    if (regions) v.regions = regions; if (sla_hours) v.sla_hours = sla_hours;
    if (avg_tat_hours) v.avg_tat_hours = avg_tat_hours; if (compliance_rate) v.compliance_rate = compliance_rate;
    if (capabilities) v.capabilities = capabilities; if (status) v.status = status;
    if (description !== undefined) v.description = description; if (cat_level !== undefined) v.cat_level = cat_level;
    v.updated_at = new Date().toISOString();
    await s3Client.saveConfig('vendors', Object.values(vendorApi.VENDORS)).catch(()=>{});
    res.json({ success: true, ...v });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/vendors/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    if (!vendorApi.VENDORS[req.params.id]) return res.status(404).json({ error: 'Vendor not found' });
    delete vendorApi.VENDORS[req.params.id];
    await s3Client.saveConfig('vendors', Object.values(vendorApi.VENDORS)).catch(()=>{});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/vendor-request', requireAuth, (req, res) => {
  try { const { vendor_id, proposal_id, proposer_name, age, gender, sum_assured } = req.body; const r = vendorApi.submitPPHCRequest(vendor_id, { proposal_id, proposer_name, age, gender, sum_assured }); res.json({ success: true, request: r }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/vendor-request/:id', requireAuth, (req, res) => { const r = vendorApi.getVendorRequestStatus(req.params.id); if (!r) return res.status(404).json({ error: 'Not found' }); res.json(r); });
app.get('/api/vendor-request/:id/report', requireAuth, (req, res) => { const r = vendorApi.getVendorReport(req.params.id); if (!r) return res.status(404).json({ error: 'Not ready' }); res.json(r); });
app.get('/api/vendor-requests', requireAuth, (req, res) => res.json(vendorApi.listVendorRequests(req.query)));

// Workflow
app.post('/api/workflow/create', requireAuth, async (req, res) => {
  try {
    const { proposer_name, age, gender, sum_assured, product_name, policy_type, nstp_reason, observations, required_tests, vendor_id, lifestyle, medical_history, height_cm, weight_kg, declared_bmi, pre_existing_conditions, detailed_ped } = req.body;
    if (!proposer_name) return res.status(400).json({ error: 'proposer_name required' });

    // Resolve CAT level first to determine correct vendor
    const productConfig0 = getProductScoringConfig(product_name);
    const hasPED0 = !!((pre_existing_conditions && pre_existing_conditions.length) ||
                       (medical_history?.pre_existing_conditions?.length) || detailed_ped);
    const catResult0 = resolveCAT(age || 35, sum_assured || 0, productConfig0?.overrides, hasPED0);

    // Auto-assign vendor based on CAT level
    const CAT_VENDOR_MAP = {
      'STP': 'VEND-001', 'tele_mer': 'VEND-003', 'CAT_1': 'VEND-001',
      'CAT_2': 'VEND-002', 'CAT_3': 'VEND-004', 'CAT_4': 'VEND-005'
    };
    const autoVendor = CAT_VENDOR_MAP[catResult0.cat] || 'VEND-001';
    const selectedVendor = vendor_id || autoVendor;
    const vendor = vendorApi.getVendor(selectedVendor);
    console.log(`[Vendor] CAT: ${catResult0.cat} → Assigned: ${selectedVendor} (${vendor?.name})`);

    // Layer 3: Historical PPHC-skip evaluation before creating workflow
    let pphcEvaluation = null;
    let historicalRouting = 'full_pphc';
    try {
      const proposalData = {
        age: age || 35, gender: gender || 'male', sum_assured: sum_assured || 500000,
        product_type: product_name || 'health', smoker: lifestyle?.smoking, alcohol: lifestyle?.alcohol,
        ...(medical_history?.pre_existing_conditions || []).reduce((o, c) => { o[c] = true; return o; }, {})
      };
      const historicalMatch = historicalEngine.findSimilarCases(proposalData);
      pphcEvaluation = historicalMatch;

      if (historicalMatch.confidence === 'HIGH' && historicalMatch.pphc_analysis?.pphc_recommendation === 'skip_pphc') {
        historicalRouting = 'stp_auto_approve';
      } else if (historicalMatch.confidence === 'MEDIUM') {
        historicalRouting = 'telemer';
      }
    } catch(e) { /* Historical evaluation not critical */ }

    // Step 1: Create workflow — merge product mandatory tests with UW-selected tests
    const catResult = catResult0;  // reuse the CAT resolved above
    const policyMandatoryTests = catResult.cat !== 'STP' && catResult.cat !== 'tele_mer'
      ? [catResult.cat.toLowerCase()]
      : (productConfig0?.overrides?.mandatory_tests || []);
    console.log(`[resolveCAT] ${product_name} | Age ${age} | SA ₹${sum_assured} | PED: ${hasPED0} → ${catResult.cat} | ${catResult.reason}`);
    const uwSelectedTests = required_tests || [];
    // Combine: policy mandatory tests + UW additional tests (deduplicated)
    const mergedTests = [...new Set([...policyMandatoryTests, ...uwSelectedTests])];

    const wf = workflowEngine.createWorkflow({ proposer_name, age: age||35, gender: gender||'male', sum_assured: sum_assured||0, product_name, policy_type, nstp_reason, observations: observations||'', required_tests: mergedTests, assigned_vendor_id: selectedVendor, cat_level: catResult.cat, cat_reason: catResult.reason, lifestyle: lifestyle||{}, medical_history: medical_history||{}, height_cm: height_cm||null, weight_kg: weight_kg||null, declared_bmi: declared_bmi||null });

    // Store historical evaluation on workflow
    if (pphcEvaluation && pphcEvaluation.match_count > 0) {
      wf.historical_pphc_evaluation = {
        routing: historicalRouting,
        confidence: pphcEvaluation.confidence,
        match_count: pphcEvaluation.match_count,
        approval_rate: pphcEvaluation.decision_distribution?.approval_rate,
        claim_rate: pphcEvaluation.claim_analysis?.claim_rate,
        pphc_recommendation: pphcEvaluation.pphc_analysis?.pphc_recommendation
      };
      wf.state_history.push({
        state: 'historical_evaluated', timestamp: new Date().toISOString(), actor: 'Historical Engine',
        note: `${pphcEvaluation.match_count} similar profiles found. Confidence: ${pphcEvaluation.confidence}. PPHC recommendation: ${historicalRouting.replace(/_/g, ' ')}.`
      });
    }

    // Step 2: Flag as NSTP
    workflowEngine.flagAsNSTP(wf.id, nstp_reason||'sum_assured_threshold');

    // Step 3: Route based on historical confidence
    if (historicalRouting === 'stp_auto_approve') {
      // HIGH confidence — skip PPHC, no vendor assignment needed
      wf.pphc_skipped = true;
      wf.pphc_skip_reason = `Historical: ${pphcEvaluation.match_count} similar profiles, ${pphcEvaluation.decision_distribution.approval_rate}% approved, ${pphcEvaluation.claim_analysis.claim_rate}% claim rate`;
      wf.state_history.push({ state: 'pphc_skipped', timestamp: new Date().toISOString(), actor: 'Historical Engine', note: 'PPHC skipped — historical data supports auto-approval for this profile type' });
      socketManager.emitGlobal('workflow_update', { workflow_id: wf.id, state: 'pphc_skipped', message: 'PPHC skipped by historical intelligence — pending auto-scoring' });

      const updatedWf = workflowEngine.getWorkflow(wf.id);
      return res.json({ success: true, workflow: updatedWf, routing: 'stp_auto_approve', pphc_required: false, historical_evaluation: wf.historical_pphc_evaluation,
        message: 'Historical intelligence: PPHC not required. Profile matches approved low-risk patterns.' });
    } else if (historicalRouting === 'telemer') {
      // MEDIUM confidence — suggest tele-MER instead of full PPHC
      wf.pphc_recommendation = 'telemer';
      wf.state_history.push({ state: 'telemer_recommended', timestamp: new Date().toISOString(), actor: 'Historical Engine', note: 'Tele-MER recommended instead of full PPHC based on historical patterns' });

      // Still assign vendor but flag as tele-MER
      workflowEngine.assignVendor(wf.id, selectedVendor, req.user?.email || 'system');
      if (vendor) {
        commsEngine.sendNotification('pphc_scheduled', { proposer_name: wf.proposer_name, proposal_id: wf.proposal_id, scheduled_date: new Date(Date.now()+86400000).toLocaleDateString('en-IN'), center_name: 'Tele-MER Interview', vendor_name: vendor.name, email: 'customer@example.com' }, ['email','sms']);
        socketManager.emitGlobal('vendor_case_assigned', { vendor_id: selectedVendor, vendor_name: vendor.name, workflow_id: wf.id, proposer_name: wf.proposer_name, proposal_id: wf.proposal_id });
      }

      const updatedWf = workflowEngine.getWorkflow(wf.id);
      return res.json({ success: true, workflow: updatedWf, vendor_assigned: vendor?.name || selectedVendor, routing: 'telemer', pphc_required: false, telemer_required: true, historical_evaluation: wf.historical_pphc_evaluation,
        message: 'Historical intelligence: Tele-MER sufficient. Full PPHC not required.' });
    }

    // Default: full PPHC — assign vendor normally
    workflowEngine.assignVendor(wf.id, selectedVendor, req.user?.email || 'system');

    // Step 4: Send notifications
    if (vendor) {
      commsEngine.sendNotification('pphc_scheduled', { proposer_name: wf.proposer_name, proposal_id: wf.proposal_id, scheduled_date: new Date(Date.now()+86400000).toLocaleDateString('en-IN'), center_name: vendor.regions[0]+' Diagnostic Center', vendor_name: vendor.name, email: 'customer@example.com' }, ['email','sms']);
      socketManager.emitGlobal('vendor_case_assigned', { vendor_id: selectedVendor, vendor_name: vendor.name, workflow_id: wf.id, proposer_name: wf.proposer_name, proposal_id: wf.proposal_id });
    }

    const updatedWf = workflowEngine.getWorkflow(wf.id);
    res.json({ success: true, workflow: updatedWf, vendor_assigned: vendor?.name || selectedVendor, routing: 'full_pphc', pphc_required: true, historical_evaluation: wf.historical_pphc_evaluation || null });
  } catch(e) { console.error('Workflow create error:', e); res.status(500).json({ error: e.message }); }
});

// ─── Phase 1: STP Fast-Lane ───
// POST /api/workflow/stp-evaluate — unified intake. Evaluates STP eligibility. If clean → auto-issues. Else → creates NSTP workflow (full PPHC or TeleMER).
app.post('/api/workflow/stp-evaluate', requireAuth, async (req, res) => {
  const evalStart = Date.now();
  try {
    const { proposer_name, age, gender, sum_assured, product_name, policy_type, observations, lifestyle, medical_history, height_cm, weight_kg, declared_bmi, vendor_id, shadow_mode } = req.body;
    if (!proposer_name) return res.status(400).json({ error: 'proposer_name required' });
    if (!product_name) return res.status(400).json({ error: 'product_name required (used to resolve STP-eligibility policy)' });
    if (!age) return res.status(400).json({ error: 'Age is required for STP evaluation' });
    if (!declared_bmi && (!height_cm || !weight_kg)) return res.status(400).json({ error: 'Height & Weight (or declared BMI) are required for STP evaluation — BMI is a critical risk factor' });

    const proposal = {
      proposer_name, age, gender: gender || 'male',
      sum_assured: sum_assured || 0, product_name, policy_type: policy_type || 'health',
      observations: observations || '',
      lifestyle: lifestyle || {}, medical_history: medical_history || {},
      height_cm: height_cm || null, weight_kg: weight_kg || null, declared_bmi: declared_bmi || null
    };

    // 1. Resolve policy to get per-product STP config
    const productConfig = getProductScoringConfig(product_name);
    const policyOverrides = productConfig?.overrides || {};

    // 2. Load STP rules from risk-params.json (hot-reload so admin edits take effect)
    const fs = require('fs');
    const riskParams = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'risk-params.json'), 'utf8'));
    const stpRules = riskParams.stp_eligibility_rules;

    // 3. Evaluate eligibility
    const evaluation = stpClassifier.evaluateSTPEligibility(proposal, policyOverrides, stpRules);
    evaluation.duration_ms = Date.now() - evalStart;
    evaluation.policy_applied = productConfig ? { id: productConfig.policy.id, name: productConfig.policy.name } : null;

    // 4. Shadow mode — log the decision but always fall through to NSTP
    const effectiveShadow = shadow_mode === true || process.env.STP_SHADOW_MODE === 'true';

    // 5. If eligible and NOT shadow mode → attempt auto-issue
    if (evaluation.eligible && !effectiveShadow) {
      // Run lightweight declared-only analysis as a final sanity check
      const uwGuidelines = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'uw-guidelines.json'), 'utf8'));
      const lightAnalysis = stpClassifier.runDeclaredDataAnalysis(proposal, riskParams, uwGuidelines, customRules, riskEngine);

      const stpScoreThreshold = stpRules.lightweight_score_min_for_stp || 85;
      const cleanScore = lightAnalysis.risk_score?.normalized >= stpScoreThreshold;
      const noCriticalViolations = (lightAnalysis.guidelines_compliance?.violations || []).length === 0;
      const noHighWarnings = !(lightAnalysis.guidelines_compliance?.warnings || []).some(w => w.severity === 'high');

      if (cleanScore && noCriticalViolations && noHighWarnings) {
        // → AUTO-ISSUE path
        const wf = workflowEngine.createWorkflow({
          ...proposal,
          nstp_reason: 'stp_auto_issued',
          assigned_vendor_id: null,
          route_type: 'stp_auto_issue',
          stp_evaluation: evaluation
        });

        workflowEngine.transitionState(wf.id, 'stp_evaluating', 'stp_classifier', `STP evaluation passed: ${evaluation.reason}`, {
          ai_analysis: lightAnalysis,
          risk_score: lightAnalysis.risk_score,
          decision: { recommendation: 'accept_standard', loading_percentage: 0, exclusions: [], rationale: 'Auto-issued via STP fast-lane. Declared-only analysis clean.' }
        });

        // Generate a placeholder policy number (Phase 4 will replace with real PAS call)
        const policyNumber = `STP-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        workflowEngine.transitionState(wf.id, 'auto_issued', 'stp_classifier', `Policy auto-issued: ${policyNumber}`, {
          policy_number: policyNumber,
          policy_issued_at: new Date().toISOString(),
          policy_effective_date: new Date().toISOString().split('T')[0]
        });

        // Send customer notification
        try {
          commsEngine.sendNotification('policy_issued', {
            proposer_name: wf.proposer_name,
            proposal_id: wf.proposal_id,
            policy_number: policyNumber,
            product_name: wf.product_name,
            sum_assured: (wf.sum_assured || 0).toLocaleString('en-IN'),
            effective_date: new Date().toLocaleDateString('en-IN'),
            email: req.body.email || 'customer@example.com'
          }, ['email', 'sms']);
        } catch (e) { console.error('STP notification error:', e.message); }

        socketManager.emitGlobal('stp_auto_issued', {
          workflow_id: wf.id, proposal_id: wf.proposal_id, proposer_name: wf.proposer_name,
          policy_number: policyNumber, sum_assured: wf.sum_assured, evaluation_ms: evaluation.duration_ms
        });

        const finalWf = workflowEngine.getWorkflow(wf.id);
        return res.json({
          success: true,
          route: 'stp_auto_issued',
          workflow: finalWf,
          policy_number: policyNumber,
          evaluation,
          lightweight_analysis: { score: lightAnalysis.risk_score?.normalized, grade: lightAnalysis.risk_score?.grade, violations: 0, warnings: lightAnalysis.guidelines_compliance?.warnings?.length || 0 },
          message: `Policy auto-issued in ${evaluation.duration_ms}ms. Policy number: ${policyNumber}.`
        });
      } else {
        // Eligible per classifier but lightweight analysis flagged something → downgrade to NSTP
        evaluation.eligible = false;
        evaluation.route = 'nstp_telemer';
        evaluation.reason = `STP eligibility passed but lightweight analysis flagged: score=${lightAnalysis.risk_score?.normalized}, violations=${lightAnalysis.guidelines_compliance?.violations?.length}, warnings=${lightAnalysis.guidelines_compliance?.warnings?.length}. Routing to NSTP TeleMER.`;
        evaluation.lightweight_analysis_snapshot = { score: lightAnalysis.risk_score?.normalized, violations: lightAnalysis.guidelines_compliance?.violations, warnings: lightAnalysis.guidelines_compliance?.warnings };
      }
    }

    // 6. Not eligible (or shadow mode or lightweight downgrade) → create NSTP workflow

    // Resolve the correct CAT level based on age + SA + policy rules
    const hasPED_stp = !!(proposal.pre_existing_conditions?.length || proposal.detailed_ped);
    const catResolved = resolveCAT(proposal.age, proposal.sum_assured, policyOverrides, hasPED_stp);
    console.log(`[resolveCAT] ${proposal.product_name} | Age ${proposal.age} | SA ₹${proposal.sum_assured} | PED: ${hasPED_stp} → ${catResolved.cat} | ${catResolved.reason}`);

    // Auto-assign vendor based on CAT level
    // CAT 1 → MedCheck India, CAT 2 → HealthAssure, CAT 3 → ClinAssure, CAT 4 → MedElite, TeleMER → DigiMedic
    const CAT_VENDOR_MAP = {
      'STP':      null,
      'tele_mer': 'VEND-003',  // DigiMedic — phone interview
      'CAT_1':    'VEND-001',  // MedCheck India — basic medical
      'CAT_2':    'VEND-002',  // HealthAssure — + ECG
      'CAT_3':    'VEND-004',  // ClinAssure Diagnostics — + Echo, TMT, LFT, KFT
      'CAT_4':    'VEND-005',  // MedElite Advanced — + Chest X-Ray, PSA/PAP, Thyroid
    };
    const autoVendor = CAT_VENDOR_MAP[catResolved.cat] || 'VEND-001';
    const selectedVendor = vendor_id || autoVendor;
    const vendor = vendorApi.getVendor(selectedVendor);
    console.log(`[Vendor] CAT: ${catResolved.cat} → Auto-assigned: ${selectedVendor}`);

    // Override route if resolveCAT says tele_mer and evaluation didn't already set it
    if (catResolved.cat === 'tele_mer' && evaluation.route !== 'nstp_telemer') {
      evaluation.route = 'nstp_telemer';
      evaluation.reason = `Policy rule override: ${catResolved.reason}`;
    }

    // Build required_tests list from CAT level per SBI guidelines
    const catTestsMap = {
      'STP':      [],
      'tele_mer': [],
      'CAT_1':    ['physical_exam', 'urine_analysis', 'hematology', 'esr', 'sgpt', 'hba1c', 'serum_creatinine', 'total_cholesterol'],
      'CAT_2':    ['physical_exam', 'urine_analysis', 'hematology', 'esr', 'ecg', 'sgpt', 'hba1c', 'serum_creatinine', 'total_cholesterol', 'serum_triglycerides', 'urine_microalbumin'],
      'CAT_3':    ['physical_exam', 'urine_analysis', 'hematology', 'esr', 'ecg', 'hba1c', 'urine_microalbumin', 'lipid_profile', 'lft', 'kft', 'cardiac_echo', 'tmt'],
      'CAT_4':    ['physical_exam', 'urine_analysis', 'hematology', 'esr', 'ecg', 'hba1c', 'urine_microalbumin', 'lipid_profile', 'lft', 'kft', 'cardiac_echo', 'tmt', 'chest_xray', 'psa_pap']
    };
    const requiredTests = catTestsMap[catResolved.cat] || (policyOverrides?.mandatory_tests || []);

    const wf = workflowEngine.createWorkflow({
      ...proposal,
      nstp_reason: effectiveShadow && evaluation.eligible ? 'stp_shadow_mode_forced_nstp' : (evaluation.blocking_factors[0]?.code || evaluation.route),
      assigned_vendor_id: selectedVendor,
      required_tests: requiredTests,
      cat_level: catResolved.cat,
      cat_reason: catResolved.reason,
      route_type: effectiveShadow && evaluation.eligible ? 'stp_auto_issue' : evaluation.route,
      stp_evaluation: evaluation,
      stp_shadow_mode: effectiveShadow
    });

    workflowEngine.flagAsNSTP(wf.id, evaluation.blocking_factors[0]?.code || evaluation.route);
    workflowEngine.assignVendor(wf.id, selectedVendor, req.user?.email || 'system');

    if (vendor) {
      commsEngine.sendNotification('pphc_scheduled', {
        proposer_name: wf.proposer_name, proposal_id: wf.proposal_id,
        scheduled_date: new Date(Date.now() + 86400000).toLocaleDateString('en-IN'),
        center_name: vendor.regions[0] + ' Diagnostic Center', vendor_name: vendor.name,
        email: req.body.email || 'customer@example.com'
      }, ['email', 'sms']);
      socketManager.emitGlobal('vendor_case_assigned', {
        vendor_id: selectedVendor, vendor_name: vendor.name, workflow_id: wf.id,
        proposer_name: wf.proposer_name, proposal_id: wf.proposal_id
      });
    }

    const finalWf = workflowEngine.getWorkflow(wf.id);
    return res.json({
      success: true,
      route: effectiveShadow && evaluation.eligible ? 'stp_shadow_logged' : evaluation.route,
      workflow: finalWf,
      evaluation,
      vendor_assigned: vendor?.name || selectedVendor,
      message: effectiveShadow && evaluation.eligible
        ? 'STP eligibility confirmed (shadow mode active — workflow forced to NSTP for observation)'
        : `Routed to ${evaluation.route}: ${evaluation.reason}`
    });
  } catch (e) {
    console.error('STP evaluate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stp-rules — expose STP rules for admin UI (read-only view of risk-params.json stp_eligibility_rules)
app.get('/api/stp-rules', requireAuth, (req, res) => {
  try {
    const fs = require('fs');
    const riskParams = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'risk-params.json'), 'utf8'));
    res.json(riskParams.stp_eligibility_rules || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/stp-rules — Super Admin only, update STP rules
app.put('/api/stp-rules', requireRole('Super Admin'), async (req, res) => {
  try {
    const fs = require('fs');
    const filePath = path.join(__dirname, 'config', 'risk-params.json');
    const riskParams = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    riskParams.stp_eligibility_rules = { ...riskParams.stp_eligibility_rules, ...req.body, version: (riskParams.stp_eligibility_rules?.version || '1.0.0') };
    fs.writeFileSync(filePath, JSON.stringify(riskParams, null, 2));
    // Also save to S3 for cross-instance sync
      await s3Client.saveMasters('risk-params', riskParams).catch(e => console.error('S3 risk-params sync error:', e.message));
    res.json({ success: true, stp_eligibility_rules: riskParams.stp_eligibility_rules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stp-evaluate-preview — evaluate a proposal WITHOUT creating a workflow (dry run for admin UI)
app.post('/api/stp-evaluate-preview', requireAuth, (req, res) => {
  try {
    const evalStart = Date.now();
    const proposal = req.body;
    const productConfig = getProductScoringConfig(proposal.product_name);
    const policyOverrides = productConfig?.overrides || {};
    const fs = require('fs');
    const riskParams = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'risk-params.json'), 'utf8'));
    const evaluation = stpClassifier.evaluateSTPEligibility(proposal, policyOverrides, riskParams.stp_eligibility_rules);
    evaluation.duration_ms = Date.now() - evalStart;
    let lightAnalysis = null;
    if (evaluation.eligible) {
      const uwGuidelines = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'uw-guidelines.json'), 'utf8'));
      lightAnalysis = stpClassifier.runDeclaredDataAnalysis(proposal, riskParams, uwGuidelines, customRules, riskEngine);
    }
    res.json({ evaluation, lightweight_analysis: lightAnalysis, policy: productConfig?.policy ? { id: productConfig.policy.id, name: productConfig.policy.name, stp_eligible: policyOverrides.stp_eligible === true } : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─── end Phase 1 STP block ───

app.get('/api/workflows', requireAuth, (req, res) => res.json(workflowEngine.listWorkflows(req.query)));
app.get('/api/workflow/:id', requireAuth, (req, res) => { const w = workflowEngine.getWorkflow(req.params.id); if (!w) return res.status(404).json({ error: 'Not found' }); res.json(w); });

app.post('/api/workflow/:id/assign-vendor', requireAuth, (req, res) => {
  try {
    const { vendor_id } = req.body;
    const wf = workflowEngine.assignVendor(req.params.id, vendor_id, req.user.email);
    const v = vendorApi.getVendor(vendor_id);
    commsEngine.sendNotification('pphc_scheduled', { proposer_name: wf.proposer_name, proposal_id: wf.proposal_id, scheduled_date: new Date(Date.now()+86400000).toLocaleDateString('en-IN'), center_name: v.regions[0]+' Diagnostic Center', vendor_name: v.name, email: 'customer@example.com' }, ['email','sms']);
    res.json({ success: true, workflow: wf });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit extracted data field on workflow (Human in Loop)
app.post('/api/workflow/:id/edit-field', requireAuth, (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const { field_path, new_value, reason } = req.body;
    if (!field_path) return res.status(400).json({ error: 'field_path required' });

    // Navigate to field in extracted_data and update
    const parts = field_path.split('.');
    let target = wf.extracted_data;
    if (!target) return res.status(400).json({ error: 'No extracted data available' });
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]]) target[parts[i]] = {};
      target = target[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    const old_value = target[lastKey];
    target[lastKey] = new_value;

    // Add to audit trail
    if (!wf.audit_trail) wf.audit_trail = [];
    const audit = { action: 'field_edit', field_path, old_value, new_value, reason: reason || '', editor: req.user?.email || 'UW Admin', timestamp: new Date().toISOString() };
    wf.audit_trail.push(audit);
    wf.updated_at = new Date().toISOString();
    wf.state_history.push({ state: 'field_edited', timestamp: new Date().toISOString(), actor: req.user?.email || 'UW Admin', note: `Edited ${field_path}: ${old_value} → ${new_value} (${reason||'no reason'})` });

    res.json({ success: true, audit, old_value, new_value });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reprocess analysis after human edits (re-runs risk engine with updated extracted_data)
app.post('/api/workflow/:id/reprocess-analysis', requireAuth, async (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    if (!wf.extracted_data) return res.status(400).json({ error: 'No extracted data to reprocess' });

    wf.state_history.push({ state: 'reprocessing', timestamp: new Date().toISOString(), actor: req.user?.email || 'UW Admin', note: 'Reprocessing after human edits' });

    const analysis = await runAIAnalysis(wf);
    wf.ai_analysis = analysis;
    wf.risk_score = analysis.risk_score;
    wf.decision = { recommendation: analysis.recommendation, loading_percentage: analysis.loading_percentage || 0, exclusions: analysis.exclusions || [], rationale: analysis.rationale };
    wf.updated_at = new Date().toISOString();
    wf.state_history.push({ state: 'reprocessed', timestamp: new Date().toISOString(), actor: 'Rule Engine', note: `Reprocessed — New decision: ${analysis.recommendation} (Score: ${analysis.risk_score?.normalized || 0}/100)` });

    socketManager.emitGlobal('workflow_update', { workflow_id: wf.id, state: 'reprocessed', decision: wf.decision });
    res.json({ success: true, ai_analysis: analysis, decision: wf.decision, risk_score: wf.risk_score });
  } catch(e) { console.error('Reprocess error:', e); res.status(500).json({ error: e.message }); }
});

// Reassign case back to vendor for document correction
app.post('/api/workflow/:id/reassign', requireAuth, (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || reason.trim().length === 0) return res.status(400).json({ error: 'Reason for reassignment is required' });
    const wf = workflowEngine.reassignToVendor(req.params.id, reason, req.user?.email || 'UW Admin');
    const vendorNames = {'VEND-001':'MedCheck India','VEND-002':'HealthAssure','VEND-003':'DigiMedic','VEND-004':'ClinAssure Diagnostics','VEND-005':'MedElite Advanced Diagnostics'};
    socketManager.emitGlobal('workflow_update', { workflow_id: wf.id, state: 'reassigned', reason });
    socketManager.emitGlobal('vendor_case_reassigned', { workflow_id: wf.id, vendor_id: wf.vendor_id, vendor_name: vendorNames[wf.vendor_id] || wf.vendor_id, reason });
    res.json({ success: true, workflow: wf, message: `Case reassigned to ${vendorNames[wf.vendor_id] || wf.vendor_id}. Reason: ${reason}` });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/workflow/:id/uw-review', requireAuth, async (req, res) => {
  try {
    const { decision, comments, loading_percentage } = req.body;
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });

    // Phase 2: authority enforcement. Super Admin bypasses all checks.
    if (req.user?.role !== 'Super Admin') {
      const tiers = uwRouter.loadTiers();
      const users = await getActiveUsers();
      const me = users.find(u => u.email.toLowerCase() === (req.user?.email || '').toLowerCase());
      if (me && me.authority_tier && tiers) {
        const tierDef = tiers.tiers[me.authority_tier];
        const saLimit = me.authority_limit_sa || tierDef?.authority_limit_sa || 0;
        const loadingLimit = me.authority_limit_loading_pct || tierDef?.authority_limit_loading_pct || 0;

        if ((wf.sum_assured || 0) > saLimit) {
          return res.status(403).json({
            error: `Decision exceeds your authority limit: SA ₹${(wf.sum_assured||0).toLocaleString('en-IN')} > your limit ₹${saLimit.toLocaleString('en-IN')}. Please escalate via POST /api/workflow/${wf.id}/escalate`,
            authority_limit_sa: saLimit, workflow_sa: wf.sum_assured
          });
        }
        if (decision === 'counter_offer' && (loading_percentage || 0) > loadingLimit) {
          return res.status(403).json({
            error: `Proposed loading ${loading_percentage}% exceeds your authority limit of ${loadingLimit}%. Please escalate.`,
            authority_limit_loading_pct: loadingLimit, proposed_loading: loading_percentage
          });
        }
        // Also enforce that the UW is the assigned one (unless admin)
        if (wf.assigned_uw_email && wf.assigned_uw_email.toLowerCase() !== (req.user?.email || '').toLowerCase() && req.user?.role !== 'UW Admin') {
          return res.status(403).json({
            error: `Case is assigned to ${wf.assigned_uw_email} — you cannot decide on behalf of another underwriter. Request reassignment first.`
          });
        }
      }
    }

    const updated = workflowEngine.uwReview(req.params.id, decision, comments, req.user.email);
    const tplMap = { approve: 'approved', reject: 'rejected', counter_offer: 'counter_offer' };
    commsEngine.sendNotification(tplMap[decision]||'approved', { proposer_name: updated.proposer_name, proposal_id: updated.proposal_id, product_name: updated.product_name, sum_assured: updated.sum_assured?.toLocaleString('en-IN'), loading_percentage: loading_percentage||0, rejection_reason: comments||'', exclusion_text: '', email: 'customer@example.com' }, ['email','sms']);
    res.json({ success: true, workflow: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Communications
app.get('/api/communications', requireAuth, (req, res) => res.json(commsEngine.getCommsLog(req.query)));

// Vendor Case Dashboard — list all workflows assigned to a vendor
app.get('/api/vendors/:id/cases', requireAuth, (req, res) => {
  const vendor = vendorApi.getVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  const cases = workflowEngine.listWorkflowsByVendor(req.params.id);
  const pending = cases.filter(c => !c.docs_submitted);
  const submitted = cases.filter(c => c.docs_submitted);
  res.json({ vendor, cases, pending_count: pending.length, submitted_count: submitted.length });
});

// Workflow Document Upload — vendor or UW uploads documents to a workflow
app.post('/api/workflow/:id/upload', requireAuth, upload.array('documents', 20), validateFileContent, async (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const docs = [];
    for (const file of req.files) {
      // Auto-detect document type and category from filename — no manual dropdown needed
      const detectedType = detectDocType(file.originalname);
      const docRecord = {
        id: uuidv4(),
        name: file.originalname,
        type: detectedType,
        category: detectedType,
        size: file.size,
        mimetype: file.mimetype,
        uploaded_by: req.user.email,
        uploaded_at: new Date().toISOString(),
        // Store base64 content for AI extraction
        base64_data: file.buffer.toString('base64'),
        content_type: file.mimetype
      };
      // Save raw upload to S3 uploads/ path (non-blocking, works via IAM role)
      s3Client.saveUpload(req.params.id, docRecord.id, file.buffer, file.mimetype)
        .then(r => { docRecord.s3_key = r.key; docRecord.s3_path = 'uploads'; })
        .catch(e => console.error('S3 upload save error:', e.message));
      workflowEngine.addDocument(req.params.id, docRecord);
      docs.push({ id: docRecord.id, name: docRecord.name, type: docRecord.type, category: docRecord.category, size: docRecord.size, mimetype: docRecord.mimetype });
    }
    res.json({ success: true, documents: docs, total: wf.documents.length });
  } catch(e) { console.error('Workflow upload error:', e); res.status(500).json({ error: e.message }); }
});

// Get workflow documents
app.get('/api/workflow/:id/documents', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json({ documents: wf.documents||[], docs_submitted: wf.docs_submitted||false, docs_submitted_at: wf.docs_submitted_at||null });
});

// Delete a document from workflow (before final submit)
app.delete('/api/workflow/:id/document/:docId', requireAuth, (req, res) => {
  try {
    const wf = workflowEngine.removeDocument(req.params.id, req.params.docId);
    res.json({ success: true, documents: wf.documents, total: wf.documents.length });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Final submit documents — triggers AI extraction + analysis
app.post('/api/workflow/:id/submit-documents', requireAuth, async (req, res) => {
  try {
    const wf = workflowEngine.finalizeDocuments(req.params.id, req.user?.email||'vendor');
    socketManager.emitGlobal('docs_submitted', { workflow_id: wf.id, proposer_name: wf.proposer_name, doc_count: wf.documents.length });

    // Step 1: Extract data from uploaded documents using AI extraction
    socketManager.emitGlobal('workflow_update', { workflow_id: wf.id, state: 'extracting', message: 'AI agent extracting data from uploaded documents...' });
    wf.state_history.push({ state: 'extraction_started', timestamp: new Date().toISOString(), actor: 'AI Engine', note: `Processing ${wf.documents.length} document(s) via AI extraction engine` });

    let extractedData = {};
    let extractionMethod = 'none';
    const apiLog = [];

    // Try AI extraction from actual document content
    if (true) { // Bedrock — no API key needed, uses IAM role
      try {
// using top-level __bedrockClient
        const claude = {
          messages: {
            create: async (params) => {
              const { model, temperature, ...rest } = params;
          if (!rest.anthropic_version) rest.anthropic_version = 'bedrock-2023-05-31';
              const cmd = new InvokeModelCommand({
                modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0',
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(rest)
              });
              const res = await __bedrockClient.send(cmd);
              return JSON.parse(Buffer.from(res.body).toString('utf8'));
            }
          }
        };

        // Build message content with all uploaded documents
        const contentParts = [];
        for (const doc of wf.documents) {
          // Lazy-load from S3 if content not in memory (after restart/reassignment)
          if (!doc.base64_data && doc.has_content && process.env.AWS_ACCESS_KEY_ID) {
            try {
              const s3Doc = await s3Client.getDocumentFromS3(`documents/${wf.id}/${doc.id}`);
              if (s3Doc && s3Doc.buffer) { doc.base64_data = s3Doc.buffer.toString('base64'); doc.content_type = doc.content_type || s3Doc.contentType; }
            } catch(e) { console.error('S3 doc reload for extraction:', e.message); }
          }
          if (doc.base64_data) {
            const isImage = ['image/jpeg','image/png','image/gif','image/webp'].includes(doc.content_type);
            const isPdf = doc.content_type === 'application/pdf';
            if (isImage) {
              contentParts.push({ type: 'image', source: { type: 'base64', media_type: doc.content_type, data: doc.base64_data } });
              contentParts.push({ type: 'text', text: `[Above is: ${doc.name} — ${doc.category}]` });
            } else if (isPdf) {
              contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.base64_data } });
              contentParts.push({ type: 'text', text: `[Above is: ${doc.name} — ${doc.category}]` });
            } else {
              // For non-image/pdf, try to decode as text
              try {
                const textContent = Buffer.from(doc.base64_data, 'base64').toString('utf8');
                contentParts.push({ type: 'text', text: `[Document: ${doc.name} — ${doc.category}]\n${textContent.substring(0, 5000)}` });
              } catch(e) {
                contentParts.push({ type: 'text', text: `[Document: ${doc.name} — ${doc.category} — binary file, cannot extract text]` });
              }
            }
          }
        }

        contentParts.push({ type: 'text', text: `
Customer Profile: ${wf.proposer_name}, Age: ${wf.age}, Gender: ${wf.gender}, Sum Assured: ₹${wf.sum_assured}
Declared Lifestyle: Smoking: ${wf.lifestyle?.smoking||'unknown'}, Alcohol: ${wf.lifestyle?.alcohol||'unknown'}
Declared Conditions: ${wf.medical_history?.pre_existing_conditions?.join(', ')||'None declared'}
Observations: ${wf.observations || 'None'}

Extract ALL medical data from the above documents. Return ONLY valid JSON with this structure:
{
  "blood_chemistry": { "fasting_glucose": {"value": null, "unit": "mg/dL", "flag": "normal|high|low"}, "hba1c": {"value": null, "unit": "%", "flag": ""}, "total_cholesterol": {"value": null, "unit": "mg/dL", "flag": ""}, "hdl": {"value": null, "unit": "mg/dL", "flag": ""}, "ldl": {"value": null, "unit": "mg/dL", "flag": ""}, "triglycerides": {"value": null, "unit": "mg/dL", "flag": ""}, "tc_hdl_ratio": {"value": null, "unit": "ratio", "flag": ""}, "sgot_ast": {"value": null, "unit": "U/L", "flag": ""}, "sgpt_alt": {"value": null, "unit": "U/L", "flag": ""}, "serum_creatinine": {"value": null, "unit": "mg/dL", "flag": ""}, "blood_urea": {"value": null, "unit": "mg/dL", "flag": ""}, "uric_acid": {"value": null, "unit": "mg/dL", "flag": ""}, "total_bilirubin": {"value": null, "unit": "mg/dL", "flag": ""}, "total_protein": {"value": null, "unit": "g/dL", "flag": ""}, "albumin": {"value": null, "unit": "g/dL", "flag": ""}, "hiv": {"value": "non_reactive", "flag": "normal"}, "hbsag": {"value": "non_reactive", "flag": "normal"} },
  "hematology": { "hemoglobin": {"value": null, "unit": "g/dL", "flag": ""}, "rbc_count": {"value": null, "unit": "million/cumm", "flag": ""}, "wbc_count": {"value": null, "unit": "/cumm", "flag": ""}, "platelet_count": {"value": null, "unit": "/cumm", "flag": ""}, "esr": {"value": null, "unit": "mm/hr", "flag": ""} },
  "physical_exam": { "bmi": {"value": null, "ref_range": "18.5-24.9", "flag": ""}, "blood_pressure": {"systolic": {"value": null, "unit": "mmHg", "flag": ""}, "diastolic": {"value": null, "unit": "mmHg", "flag": ""}} },
  "urine_analysis": { "protein": {"value": "nil", "flag": "normal"}, "glucose": {"value": "nil", "flag": "normal"} },
  "cardiac": { "ecg": {"overall_interpretation": "normal", "findings": ""} },
  "liver_extended": { "ggt": {"value": null, "unit": "U/L", "flag": ""}, "alp": {"value": null, "unit": "U/L", "flag": ""} },
  "thyroid": { "tsh": {"value": null, "unit": "mIU/L", "flag": ""} },
  "cardiac_extended": { "lvef": {"value": null, "unit": "%", "flag": ""}, "tmt": {"result": "not_done", "findings": ""} },
  "chest_xray": { "interpretation": "normal", "findings": "" },
  "correlation_data": {
    "medications_found": [],
    "drug_condition_mismatches": [],
    "multi_system_correlations": [],
    "cardiovascular_risk": { "framingham_risk_category": "low|moderate|high|very_high", "risk_factors_count": 0, "rationale": "" }
  },
  "summary": "Brief summary of all findings",
  "parameters_found": 0
}

IMPORTANT INSTRUCTIONS FOR correlation_data:
- medications_found: List any medications, drugs, or prescriptions mentioned anywhere in the documents. Each as {"name":"drug name","condition":"what it treats","disclosed":true/false} — set disclosed=false if the condition it treats was NOT in the declared conditions list above.
- drug_condition_mismatches: If a medication suggests a condition that was NOT declared (e.g., patient is on Metformin but diabetes was not declared), list it as {"drug":"Metformin","implied_condition":"Diabetes","disclosed":false,"clinical_significance":"high"}.
- multi_system_correlations: If findings across multiple organ systems are clinically related, list them. E.g., {"systems":["renal","metabolic"],"finding":"High glucose + elevated creatinine suggests diabetic nephropathy","clinical_significance":"high"}.
- cardiovascular_risk: Based on age (${wf.age}), gender (${wf.gender}), smoking (${wf.lifestyle?.smoking||'unknown'}), and available cholesterol/BP values, estimate Framingham risk category. Count risk factors (age>55M/65F, smoking, diabetes, hypertension, high cholesterol, family history cardiac).

Set values to null if not found. Only extract what is ACTUALLY present. Set "flag" based on reference ranges. Count non-null values in "parameters_found".` });

        const startTime = Date.now();
        const response = await claude.messages.create({
          model: 'claude-3-sonnet-20240229',
          max_tokens: 8000,
          temperature: 0,
          system: 'You are a medical document extraction AI. Extract structured lab values from medical reports. Return ONLY valid JSON, no markdown or explanation.',
          messages: [{ role: 'user', content: contentParts }]
        });

        const responseText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extractedData = JSON.parse(jsonMatch[0]);
          extractionMethod = 'ai_extraction';
          apiLog.push({ agent: 'AI Document Extraction', timestamp: new Date().toISOString(), tokens: { input: response.usage?.input_tokens, output: response.usage?.output_tokens }, duration_ms: Date.now() - startTime, status: 'success', parameters_found: extractedData.parameters_found || 0 });
        }
        wf.state_history.push({ state: 'extraction_complete', timestamp: new Date().toISOString(), actor: 'AI Engine', note: `Extracted ${extractedData.parameters_found||0} parameters from ${wf.documents.length} document(s)` });
      } catch(claudeErr) {
        console.error('Claude extraction error:', claudeErr.message);
        apiLog.push({ agent: 'AI Document Extraction', timestamp: new Date().toISOString(), status: 'error', error: claudeErr.message });
        wf.state_history.push({ state: 'extraction_fallback', timestamp: new Date().toISOString(), actor: 'System', note: 'Claude API error: ' + claudeErr.message + ' — using document metadata analysis' });
      }
    }

    // If extraction failed or no data extracted — block scoring, require manual intervention
    if (!extractedData || Object.keys(extractedData).length === 0 || extractionMethod === 'none') {
      extractionMethod = 'extraction_failed';
      wf.extraction_failed = true;
      wf.extraction_error = 'AI could not extract medical data from uploaded documents';
      wf.extracted_data = {};
      wf.extraction_method = extractionMethod;
      wf.api_log = apiLog;
      wf.state_history.push({ state: 'extraction_failed', timestamp: new Date().toISOString(), actor: 'System', note: `Extraction failed: ${wf.extraction_error}. Manual data entry required via Human-in-Loop.` });
      wf.state = 'extraction_failed';
      wf.updated_at = new Date().toISOString();
      socketManager.emitGlobal('workflow_update', { workflow_id: wf.id, state: 'extraction_failed', message: 'Extraction failed — manual review required' });
      return res.json({ success: true, workflow: wf, extraction_failed: true, message: 'AI extraction failed. Please use Human-in-Loop to enter medical data manually, then resubmit for processing.' });
    }

    // Store extracted data and method
    wf.extracted_data = extractedData;
    wf.extraction_method = extractionMethod;
    wf.api_log = apiLog;

    // Step 2: Run AI analysis against rules
    socketManager.emitGlobal('workflow_update', { workflow_id: wf.id, state: 'analyzing', message: 'Scoring against UW rules...' });
    wf.state_history.push({ state: 'rule_engine_started', timestamp: new Date().toISOString(), actor: 'Rule Engine', note: 'Evaluating against medical-scoring, uw-guidelines, risk-params' });

    const analysis = await runAIAnalysis(wf);
    wf.ai_analysis = analysis;
    wf.risk_score = analysis.risk_score;
    wf.decision = { recommendation: analysis.recommendation, loading_percentage: analysis.loading_percentage||0, exclusions: analysis.exclusions||[], rationale: analysis.rationale };
    wf.updated_at = new Date().toISOString();
    wf.state_history.push({ state: 'ai_analysis_complete', timestamp: new Date().toISOString(), actor: 'AI Agent', note: `Analysis complete — ${analysis.recommendation}` });
    // Save analysis result to results/ path in S3
    s3Client.saveAnalysisResult(wf.id, { ai_analysis: analysis, decision: wf.decision, risk_score: wf.risk_score, analyzed_at: wf.updated_at }).catch(e => console.error('S3 analysis save error:', e.message));
    // Save extracted medical data to results/ path
    if (wf.extracted_data) s3Client.saveExtractedData(wf.id, wf.extracted_data).catch(e => console.error('S3 extracted data save error:', e.message));

    // Step 3: Transition workflow state through the state machine to final decision
    try { workflowEngine.transitionState(wf.id, 'pphc_scheduled', 'system', 'PPHC completed via vendor'); } catch(e){}
    try { workflowEngine.transitionState(wf.id, 'pphc_completed', 'system', 'Documents received'); } catch(e){}
    try { workflowEngine.transitionState(wf.id, 'extraction_in_progress', 'system', 'Data extracted'); } catch(e){}
    try { workflowEngine.transitionState(wf.id, 'extraction_done', 'system', 'Extraction complete'); } catch(e){}
    try { workflowEngine.transitionState(wf.id, 'rule_engine_processing', 'system', 'Rules evaluated'); } catch(e){}

    // Final decision state
    const stateMap = { accept_standard: 'auto_approved', accept_with_loading: 'counter_offered', refer: 'referred', decline: 'auto_rejected' };
    const finalState = stateMap[analysis.recommendation] || 'referred';
    try { workflowEngine.transitionState(wf.id, finalState, 'AI Agent', `Decision: ${analysis.recommendation} (Score: ${Math.round(analysis.risk_score?.normalized||0)}/100)`); } catch(e){
      // If state machine rejects the transition, force the state directly
      console.error('Final state transition error:', e.message, '— forcing state to', finalState);
      wf.state = finalState;
      wf.state_history.push({ state: finalState, timestamp: new Date().toISOString(), actor: 'AI Agent', note: `Decision: ${analysis.recommendation} (Score: ${Math.round(analysis.risk_score?.normalized||0)}/100) [forced]` });
      workflowEngine.updateWorkflow(wf.id, wf);
    }

    // Explicit UW routing for referred cases (backup — in case transition hook didn't fire)
    if (finalState === 'referred' && !wf.assigned_uw_email) {
      try {
        const uwUsers = await getActiveUsers();
        if (uwUsers?.length) {
          const loadMap = {};
          const allWfs = workflowEngine.listWorkflows({});
          allWfs.forEach(w2 => { if (w2.assigned_uw_email && !['auto_approved','auto_rejected','uw_approved','uw_rejected','policy_issued','customer_notified','counter_offer_rejected'].includes(w2.state)) { const k = w2.assigned_uw_email.toLowerCase(); loadMap[k] = (loadMap[k]||0)+1; } });
          const routeResult = uwRouter.assignToUnderwriter(wf, uwUsers, null, loadMap);
          if (routeResult.success) {
            workflowEngine.updateWorkflowFields(wf.id, { assigned_uw_email: routeResult.assigned_email, assigned_uw_tier: routeResult.assigned_tier, assigned_uw_at: routeResult.assigned_at, uw_classification: routeResult.classification, assignment_reason: routeResult.reason, routing_failed: false }, 'uw_router');
            console.log(`[UW Router Direct] ${wf.id} → ${routeResult.assigned_tier} ${routeResult.assigned_email}`);
            socketManager.emitGlobal('uw_assigned', { workflow_id: wf.id, assigned_uw_email: routeResult.assigned_email, tier: routeResult.assigned_tier, specialty: routeResult.classification?.primary_specialty });
          } else {
            console.log(`[UW Router Direct] Failed for ${wf.id}: ${routeResult.reason}`);
            workflowEngine.updateWorkflowFields(wf.id, { routing_failed: true, routing_failure_reason: routeResult.reason, uw_classification: routeResult.classification }, 'uw_router');
          }
        }
      } catch(routeErr) { console.error('[UW Router Direct] Error:', routeErr.message); }
    }

    // Send decision notification
    const tplMap = { accept_standard: 'approved', accept_with_loading: 'counter_offer', refer: 'referred_uw', decline: 'rejected' };
    commsEngine.sendNotification(tplMap[analysis.recommendation]||'referred_uw', {
      proposer_name: wf.proposer_name, proposal_id: wf.proposal_id,
      product_name: wf.product_name, sum_assured: wf.sum_assured?.toLocaleString('en-IN'),
      loading_percentage: analysis.loading_percentage||0, rejection_reason: '',
      exclusion_text: '', email: 'customer@example.com'
    }, ['email','sms']);

    socketManager.emitGlobal('workflow_update', { workflow_id: wf.id, state: 'ai_analysis_complete', decision: wf.decision });

    // Step 4: Auto-generate AI summary (non-blocking — don't fail the request if summary fails)
    try {
      const summaryRes = await new Promise((resolve) => {
        const http = require('http');
        const reqBody = JSON.stringify({});
        const opts = { hostname: 'localhost', port: PORT, path: `/api/workflow/${wf.id}/ai-summary`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': reqBody.length } };
        // Skip internal HTTP call — directly generate summary inline
        (async () => {
          try {
            const a = wf.ai_analysis;
            const ed = wf.extracted_data || {};
            const profile = `${wf.proposer_name}, Age ${wf.age}, ${wf.gender}, Sum Assured INR ${(wf.sum_assured||0).toLocaleString('en-IN')}, Product: ${wf.product_name||'Health Shield'}`;
            const findingsText = (a.findings||[]).map(f => `${f.parameter}: ${f.value} (${f.status}) — ${f.implication}`).join('\n');
            const violationsText = (a.guidelines_compliance?.violations||[]).map(v => `${v.rule_name}: value ${v.value} vs threshold ${v.threshold} → ${v.action}`).join('\n');
            const loadingText = (a.loading_factors||[]).map(l => `${l.factor}: ${l.loading}`).join(', ');
            const lifestyleText = wf.lifestyle ? `Smoking: ${wf.lifestyle.smoking||'unknown'}, Alcohol: ${wf.lifestyle.alcohol||'unknown'}, Tobacco: ${wf.lifestyle.tobacco_chewing||'unknown'}, Occupation hazard: ${wf.lifestyle.occupation_hazard||'unknown'}` : 'Not declared';
            const medHistText = wf.medical_history?.pre_existing_conditions?.length ? `Pre-existing: ${wf.medical_history.pre_existing_conditions.join(', ')}` : 'No pre-existing conditions declared';
            const compScores = Object.entries(a.component_analysis||{}).map(([n,c]) => `${n.replace(/_/g,' ')}: ${c.score}/${c.max} (${c.percentage}%)`).join(', ');
            let summaryText = '';
            if (true) { // Bedrock — no API key needed, uses IAM role
// using top-level __bedrockClient
              const claude = {
                messages: {
                  create: async (params) => {
                    const { model, temperature, ...rest } = params;
          if (!rest.anthropic_version) rest.anthropic_version = 'bedrock-2023-05-31';
                    const cmd = new InvokeModelCommand({
                      modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0',
                      contentType: 'application/json',
                      accept: 'application/json',
                      body: JSON.stringify(rest)
                    });
                    const res = await __bedrockClient.send(cmd);
                    return JSON.parse(Buffer.from(res.body).toString('utf8'));
                  }
                }
              };
              const response = await claude.messages.create({
                model: 'claude-3-sonnet-20240229', max_tokens: 2000, temperature: 0.3,
                system: 'You are a senior insurance underwriter writing a professional assessment summary. Write in clear, concise professional English. Use specific values and clinical terminology. IMPORTANT: Do NOT use markdown formatting — no asterisks, no hashtags, no bold markers. Use ALL CAPS for section titles. Separate sections with a blank line. Keep each section to 2-3 sentences maximum.',
                messages: [{ role: 'user', content: `Write a professional underwriting assessment summary.\n\nPROPOSER: ${profile}\nNSTP REASON: ${(wf.nstp_reason||'').replace(/_/g,' ')}\nRISK SCORE: ${Math.round(a.risk_score?.normalized||0)}/100 (Grade ${a.risk_score?.grade||'N/A'})\nRECOMMENDATION: ${a.recommendation}\n${a.loading_percentage?'LOADING: +'+a.loading_percentage+'%':''}\nLIFESTYLE: ${lifestyleText}\nMEDICAL HISTORY: ${medHistText}\nFINDINGS:\n${findingsText||'No adverse findings'}\n${violationsText?'VIOLATIONS:\n'+violationsText:''}\n${loadingText?'LOADING FACTORS: '+loadingText:''}\n\nUse ALL CAPS section titles, NO markdown. Sections: PROPOSER PROFILE, MEDICAL ASSESSMENT, RISK FACTORS, FAVOURABLE INDICATORS, RECOMMENDATION, CONDITIONS` }]
              });
              summaryText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
            }
            if (!summaryText) {
              const score = Math.round(a.risk_score?.normalized||0);
              const recText = { accept_standard:'approved at standard rates', accept_with_loading:`approved with loading of +${a.loading_percentage||0}%`, refer:'referred to senior underwriter', decline:'declined' };
              summaryText = `PROPOSER PROFILE\n${wf.proposer_name}, aged ${wf.age} (${wf.gender}), applied for ${wf.product_name||'Health Shield'} with SA INR ${(wf.sum_assured||0).toLocaleString('en-IN')}. Flagged as NSTP: ${(wf.nstp_reason||'').replace(/_/g,' ')}.\n\nMEDICAL ASSESSMENT\n${ed.summary||'Data extracted from '+wf.documents?.length+' document(s).'} Scores: ${compScores}.\n\nRISK FACTORS\n${findingsText||'No adverse findings.'}\n\nFAVOURABLE INDICATORS\n${Object.entries(a.component_analysis||{}).filter(([n,c])=>c.percentage>=80).map(([n,c])=>n.replace(/_/g,' ')+' '+c.percentage+'%').join(', ')||'Standard parameters normal.'}\n\nRECOMMENDATION\nScore ${score}/100 (${a.risk_score?.grade}). Proposal ${recText[a.recommendation]||'under review'}.\n\nCONDITIONS\n${a.recommendation==='accept_standard'?'Standard terms.':a.recommendation==='decline'?'Cannot be accepted.':'Modified terms with noted loading and waiting periods per IRDAI.'}`;
            }
            wf.ai_summary_text = summaryText;
            wf.ai_summary_generated_at = new Date().toISOString();
            resolve(true);
          } catch(e) { console.error('Auto-summary error:', e.message); resolve(false); }
        })();
      });
      if (summaryRes) console.log(`[Auto-Summary] Generated for ${wf.proposal_id}`);
    } catch(e) { console.error('Auto-summary wrapper error:', e.message); }

    res.json({ success: true, workflow: wf, ai_analysis: wf.ai_analysis });
  } catch(e) { console.error('Submit-documents error:', e); res.status(400).json({ error: e.message }); }
});

// AI Analysis function
async function runAIAnalysis(wf) {
  const fs = require('fs');
  const configPath = require('path').join(__dirname, 'config');
  const medicalScoring = JSON.parse(fs.readFileSync(`${configPath}/medical-scoring.json`, 'utf8'));
  const uwGuidelines = JSON.parse(fs.readFileSync(`${configPath}/uw-guidelines.json`, 'utf8'));
  const riskParams = JSON.parse(fs.readFileSync(`${configPath}/risk-params.json`, 'utf8'));

  // Product-specific policy lookup and merge
  let appliedPolicy = null;
  const productConfig = getProductScoringConfig(wf.product_name);
  if (productConfig && productConfig.overrides) {
    appliedPolicy = { name: productConfig.policy.name, version: productConfig.policy.version, id: productConfig.policy.id };
    const ov = productConfig.overrides;
    // Merge score thresholds
    if (ov.score_thresholds) riskParams._score_thresholds = ov.score_thresholds;
    // Merge loading overrides
    if (ov.loading_overrides && Object.keys(ov.loading_overrides).length) {
      for (const [key, pct] of Object.entries(ov.loading_overrides)) {
        if (riskParams.loading_table[key]) riskParams.loading_table[key].loading_pct = pct;
      }
    }
    // Merge rule overrides (change thresholds or disable rules)
    if (ov.rule_overrides && Object.keys(ov.rule_overrides).length) {
      for (const [ruleId, override] of Object.entries(ov.rule_overrides)) {
        const rule = uwGuidelines.rules.find(r => r.id === ruleId);
        if (rule) {
          if (override.disabled) rule._disabled = true;
          if (override.threshold !== undefined) rule.threshold = override.threshold;
          if (override.action) rule.action = override.action;
        }
      }
    }
    // Merge age limits
    if (ov.age_limits) riskParams._age_limits = ov.age_limits;
    // Merge SA limits
    if (ov.sa_limits) riskParams._sa_limits = ov.sa_limits;
    // Store mandatory tests for checking — use resolveCAT for accurate CAT level
    const hasPED_ai = !!(wf.pre_existing_conditions?.length || wf.detailed_ped);
    const catForAI = resolveCAT(wf.age, wf.sum_assured, ov, hasPED_ai);
    const catTestsMapAI = {
      'STP':      [],
      'tele_mer': [],
      'CAT_1':    ['blood_work', 'urine_analysis', 'physical_exam', 'hematology'],
      'CAT_2':    ['blood_work', 'urine_analysis', 'physical_exam', 'hematology', 'ecg', 'blood_chemistry'],
      'CAT_3':    ['blood_work', 'urine_analysis', 'physical_exam', 'hematology', 'ecg', 'blood_chemistry', 'cardiac_echo', 'tmt'],
      'CAT_4':    ['blood_work', 'urine_analysis', 'physical_exam', 'hematology', 'ecg', 'blood_chemistry', 'cardiac_echo', 'tmt', 'chest_xray', 'thyroid', 'liver_function']
    };
    riskParams._mandatory_tests = catTestsMapAI[catForAI.cat] || ov.mandatory_tests || [];
    riskParams._cat_level = catForAI.cat;

    // ── Dynamic per-CAT scoring: pass full component/factor config to engine ────
    if (catScoringConfig && catScoringConfig[catForAI.cat]) {
      const catCfg = catScoringConfig[catForAI.cat];
      if (catCfg.thresholds) riskParams._score_thresholds = catCfg.thresholds;
      if (catCfg.components) {
        riskParams._scoring_components = catCfg.components;
        // Derive component weights map for the engine
        const w = {};
        for (const [k, c] of Object.entries(catCfg.components)) w[k] = c.weight;
        riskParams._component_weights = w;
        // Medical tests = factor ids in the medical component
        riskParams._cat_medical_tests = (catCfg.components.medical?.factors || []).map(f => f.id);
      }
      console.log(`[CAT Scoring] ${catForAI.cat} → weights:`, JSON.stringify(riskParams._component_weights), '| thresholds:', JSON.stringify(catCfg.thresholds));
    }
    console.log(`[resolveCAT AI] ${wf.product_name} | Age ${wf.age} | SA ₹${wf.sum_assured} | PED: ${hasPED_ai} → ${catForAI.cat}`);
  }

  // Build document summary for AI
  const docSummary = (wf.documents||[]).map(d => `- ${d.name} (${d.category||d.type}, ${d.size} bytes)`).join('\n');

  // Get extracted data
  const extractedData = wf.extracted_data || {};

  // Build customer profile
  const profile = {
    name: wf.proposer_name, age: wf.age, gender: wf.gender,
    sum_assured: wf.sum_assured, product: wf.product_name,
    nstp_reason: wf.nstp_reason, observations: wf.observations,
    required_tests: wf.required_tests,
    lifestyle: wf.lifestyle || {},
    medical_history: wf.medical_history || {}
  };

  // Inject lifestyle and medical history into extracted data for risk engine scoring
  if (extractedData && Object.keys(extractedData).length > 0) {
    // Inject declared BMI if no measured BMI was extracted from documents
    if (wf.declared_bmi && wf.declared_bmi > 0) {
      if (!extractedData.physical_exam) extractedData.physical_exam = {};
      if (!extractedData.physical_exam.bmi || extractedData.physical_exam.bmi.value === null) {
        const bmi = wf.declared_bmi;
        const bmiFlag = bmi < 18.5 ? 'low' : bmi < 25 ? 'normal' : bmi < 30 ? 'high' : 'high';
        extractedData.physical_exam.bmi = { value: bmi, ref_range: '18.5-24.9', flag: bmiFlag, source: 'declared' };
        extractedData.physical_exam.height = { value: wf.height_cm, unit: 'cm' };
        extractedData.physical_exam.weight = { value: wf.weight_kg, unit: 'kg' };
      } else {
        // Both declared and measured exist — store both for comparison
        extractedData.physical_exam.declared_bmi = { value: wf.declared_bmi, height_cm: wf.height_cm, weight_kg: wf.weight_kg };
      }
    }

    // Merge declared lifestyle data into extracted data so risk engine can score it
    if (wf.lifestyle && Object.keys(wf.lifestyle).length > 0) {
      if (!extractedData.telemer_data) extractedData.telemer_data = {};
      extractedData.telemer_data.lifestyle = {
        smoking: { status: wf.lifestyle.smoking || 'unknown' },
        alcohol: { status: wf.lifestyle.alcohol || 'unknown' },
        tobacco_chewing: { status: wf.lifestyle.tobacco_chewing || 'unknown' },
        occupation_hazard: wf.lifestyle.occupation_hazard || 'unknown',
        exercise: { frequency: wf.lifestyle.exercise || 'unknown' }
      };
      // Also set at top level for risk engine compatibility
      extractedData.lifestyle = extractedData.telemer_data.lifestyle;
    }
    // Merge declared medical history
    if (wf.medical_history && Object.keys(wf.medical_history).length > 0) {
      if (!extractedData.telemer_data) extractedData.telemer_data = {};
      extractedData.telemer_data.medical_history = {
        pre_existing_conditions: (wf.medical_history.pre_existing_conditions || []).map(c => ({
          condition: c, current_status: 'active'
        })),
        family_history: {
          cardiac: wf.medical_history.family_history === 'cardiac' || wf.medical_history.family_history === 'multiple',
          diabetes: wf.medical_history.family_history === 'diabetes' || wf.medical_history.family_history === 'multiple',
          cancer: wf.medical_history.family_history === 'cancer' || wf.medical_history.family_history === 'multiple'
        },
        hospitalizations: Array(parseInt(wf.medical_history.hospitalizations) || 0).fill({ reason: 'declared', year: new Date().getFullYear() }),
        surgical_history: (wf.medical_history.surgery_types || []).map(type => ({ type, year: new Date().getFullYear(), status: 'declared' }))
      };
      extractedData.medical_history = extractedData.telemer_data.medical_history;
    }
  }

  // If we have extracted medical data, run through risk engine
  if (extractedData && Object.keys(extractedData).length > 0) {
    // Use AI-extracted correlation data if available, otherwise empty
    const correlationData = extractedData.correlation_data || {};
    // Inject proposer demographics for CV risk calculation in clinical correlation
    extractedData._proposer_age = wf.age;
    extractedData._proposer_gender = wf.gender;
    const riskResult = riskEngine.calculateAll(extractedData, correlationData, {
      component_weights: riskParams._component_weights || null,
      scoring_components: riskParams._scoring_components || null
    });

    // EM-based scoring — scores ALL extracted parameters
    let emResult = null;
    try {
      emResult = riskEngine.calculateFullEM(extractedData, wf.gender);
    } catch(e) { console.error('EM scoring error:', e.message); }

    // Build detailed component analysis
    const componentAnalysis = {};
    for (const [name, comp] of Object.entries(riskResult.risk_score.components)) {
      componentAnalysis[name] = {
        score: comp.score, max: comp.max,
        percentage: Math.round((comp.score / comp.max) * 100),
        status: comp.score >= comp.max * 0.8 ? 'good' : comp.score >= comp.max * 0.5 ? 'moderate' : 'poor',
        breakdown: comp.breakdown || {}
      };
    }

    // Check UW guideline violations — Issue 2 fix: prioritize by severity per parameter path
    // Phase 0.1 fix: merge AI-extracted custom rules with built-in guidelines so they actually fire
    const violations = [];
    const warnings = [];
    const rulesByPath = {};
    const allRules = [...uwGuidelines.rules, ...(customRules || [])];
    for (const rule of allRules) {
      if (rule._disabled) continue;
      if (!rule.path || !rule.operator) continue; // skip malformed custom rules
      if (!rulesByPath[rule.path]) rulesByPath[rule.path] = [];
      rulesByPath[rule.path].push(rule);
    }
    // Sort each path's rules: critical first, then high, then medium
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    for (const path of Object.keys(rulesByPath)) {
      rulesByPath[path].sort((a, b) => (severityOrder[a.severity]||3) - (severityOrder[b.severity]||3));
    }
    // Evaluate rules — once a critical rule fires for a path, skip lower-severity rules for same path
    const firedPaths = new Set();
    for (const [path, rules] of Object.entries(rulesByPath)) {
      for (const rule of rules) {
        if (firedPaths.has(path)) break; // Skip lower-severity rules for same parameter
        let value;
        try { const parts = rule.path.split('.'); value = extractedData; for (const p of parts) value = value?.[p]; } catch(e) { value = null; }
        if (value !== null && value !== undefined) {
          let violated = false;
          switch (rule.operator) {
            case '<': violated = !(value < rule.threshold); break;
            case '<=': violated = !(value <= rule.threshold); break;
            case '>': violated = !(value > rule.threshold); break;
            case '>=': violated = !(value >= rule.threshold); break;
            case '==': violated = value !== rule.threshold; break;
            case 'in': violated = !rule.threshold.includes(value); break;
          }
          if (violated) {
            const item = { rule_id: rule.id, rule_name: rule.name, value, threshold: rule.threshold, action: rule.action, severity: rule.severity };
            if (rule.severity === 'critical') { violations.push(item); firedPaths.add(path); }
            else warnings.push(item);
          }
        }
      }
    }

    // Determine loading from risk params — Issue 1 fix: no double-counting smoking
    let totalLoading = 0;
    const loadingFactors = [];
    const loadedCategories = new Set(); // Track what's already loaded to prevent double-counting
    const pe = extractedData.physical_exam || {};
    const bmi = pe.bmi?.value;
    if (bmi) {
      for (const [key, val] of Object.entries(riskParams.loading_table)) {
        if (key.startsWith('bmi_') && val.min_bmi && bmi >= val.min_bmi && (!val.max_bmi || bmi < val.max_bmi)) {
          if (val.loading_pct > 0) { totalLoading += val.loading_pct; loadingFactors.push({ factor: key.replace(/_/g,' '), loading: val.loading_pct+'%' }); loadedCategories.add('bmi'); }
        }
      }
    }
    // Issue 1 fix: Check cotinine OR declared smoking — NOT both
    const cotinine = extractedData.blood_chemistry?.cotinine?.value;
    const ls = wf.lifestyle || {};
    if (typeof cotinine === 'number' && cotinine > 10) {
      const smokePct = riskParams.loading_table.smoker_current?.loading_pct || 75;
      totalLoading += smokePct;
      loadingFactors.push({ factor: 'Current smoker (cotinine confirmed)', loading: smokePct+'%' });
      loadedCategories.add('smoking');
    } else if (ls.smoking === 'current' && !loadedCategories.has('smoking')) {
      const smokePct = riskParams.loading_table.smoker_current?.loading_pct || 75;
      totalLoading += smokePct;
      loadingFactors.push({ factor: 'Current smoker (declared)', loading: smokePct+'%' });
      loadedCategories.add('smoking');
    }

    // Build detailed findings — all raw findings first, deduplicate later
    const rawFindings = [];
    const bc = extractedData.blood_chemistry || {};
    if (bc.fasting_glucose?.flag === 'high') rawFindings.push({ parameter: 'Fasting Glucose', value: bc.fasting_glucose.value+' mg/dL', status: 'high', implication: 'Indicates possible diabetes / impaired fasting glucose' });
    if (bc.hba1c?.flag === 'high' || bc.hba1c?.flag === 'borderline') rawFindings.push({ parameter: 'HbA1c', value: bc.hba1c.value+'%', status: bc.hba1c.flag, implication: 'Glycemic control indicator' });
    if (bc.tc_hdl_ratio?.flag === 'high') rawFindings.push({ parameter: 'TC/HDL Ratio', value: bc.tc_hdl_ratio.value, status: 'high', implication: 'Elevated cardiovascular risk' });
    if (bc.sgpt_alt?.flag === 'high') rawFindings.push({ parameter: 'SGPT/ALT', value: bc.sgpt_alt.value+' U/L', status: 'high', implication: 'Liver function concern' });
    if (bc.serum_creatinine?.flag === 'high') rawFindings.push({ parameter: 'Serum Creatinine', value: bc.serum_creatinine.value+' mg/dL', status: 'high', implication: 'Kidney function concern' });
    if (pe.blood_pressure?.systolic?.flag === 'high') rawFindings.push({ parameter: 'Blood Pressure', value: pe.blood_pressure.systolic.value+'/'+pe.blood_pressure.diastolic.value+' mmHg', status: 'high', implication: 'Hypertension detected' });
    // BMI findings
    const bmiVal = pe.bmi?.value;
    if (bmiVal !== null && bmiVal !== undefined) {
      const bmiSource = pe.bmi.source === 'declared' ? ' (Declared)' : pe.declared_bmi ? ' (Measured)' : '';
      if (bmiVal >= 40) rawFindings.push({ parameter: 'BMI'+bmiSource, value: bmiVal+' kg/m²', status: 'high', implication: 'Obese Class III — very high mortality risk' });
      else if (bmiVal >= 35) rawFindings.push({ parameter: 'BMI'+bmiSource, value: bmiVal+' kg/m²', status: 'high', implication: 'Obese Class II — high mortality risk' });
      else if (bmiVal >= 30) rawFindings.push({ parameter: 'BMI'+bmiSource, value: bmiVal+' kg/m²', status: 'high', implication: 'Obese Class I — elevated risk' });
      else if (bmiVal >= 25) rawFindings.push({ parameter: 'BMI'+bmiSource, value: bmiVal+' kg/m²', status: 'borderline', implication: 'Overweight — moderate risk' });
      else if (bmiVal < 18.5) rawFindings.push({ parameter: 'BMI'+bmiSource, value: bmiVal+' kg/m²', status: 'borderline', implication: 'Underweight — nutritional risk' });
      if (pe.declared_bmi && pe.bmi.source !== 'declared') {
        const diff = Math.abs(bmiVal - pe.declared_bmi.value);
        if (diff > 2) rawFindings.push({ parameter: 'BMI Discrepancy', value: `Declared: ${pe.declared_bmi.value}, Measured: ${bmiVal}`, status: 'high', implication: `Difference of ${diff.toFixed(1)} — possible non-disclosure` });
      }
    }
    const ecg = extractedData.cardiac?.ecg;
    if (ecg?.overall_interpretation === 'abnormal') rawFindings.push({ parameter: 'ECG', value: ecg.overall_interpretation, status: 'abnormal', implication: 'Cardiac abnormality detected' });

    // Clinical correlation findings
    if (correlationData.drug_condition_mismatches?.length) {
      correlationData.drug_condition_mismatches.forEach(m => {
        if (!m.disclosed) rawFindings.push({ parameter: 'Undisclosed Condition', value: `${m.drug} → ${m.implied_condition}`, status: 'high', implication: `Medication suggests undeclared ${m.implied_condition}` });
      });
    }
    if (correlationData.multi_system_correlations?.length) {
      correlationData.multi_system_correlations.filter(m => m.clinical_significance === 'high' || m.clinical_significance === 'critical').forEach(m => {
        rawFindings.push({ parameter: 'Multi-System Finding', value: m.systems?.join(' + ') || 'Multiple', status: 'high', implication: m.finding || 'Correlated findings across organ systems' });
      });
    }
    if (correlationData.cardiovascular_risk?.framingham_risk_category === 'high' || correlationData.cardiovascular_risk?.framingham_risk_category === 'very_high') {
      rawFindings.push({ parameter: 'CV Risk (Framingham)', value: correlationData.cardiovascular_risk.framingham_risk_category, status: 'high', implication: correlationData.cardiovascular_risk.rationale || 'Elevated cardiovascular event risk' });
    }
    if (correlationData.medications_found?.length) extractedData._medications = correlationData.medications_found;

    // Lifestyle findings — smoking already handled in loading, just add finding
    if (ls.smoking === 'current') rawFindings.push({ parameter: 'Smoking', value: 'Current smoker', status: 'high', implication: 'Significantly increases mortality risk' });
    if (ls.alcohol === 'heavy') rawFindings.push({ parameter: 'Alcohol', value: 'Heavy consumption', status: 'high', implication: 'Liver and cardiac risk factor' });
    if (ls.tobacco_chewing === 'current') rawFindings.push({ parameter: 'Tobacco Chewing', value: 'Current user', status: 'high', implication: 'Oral cancer and cardiovascular risk' });
    if (ls.occupation_hazard === 'high') rawFindings.push({ parameter: 'Occupation Hazard', value: 'High risk', status: 'high', implication: 'Elevated accidental death risk' });

    // Medical history findings + loading (no smoking double-count since it's tracked via loadedCategories)
    const mh = wf.medical_history || {};
    if (mh.pre_existing_conditions?.length) {
      const condLabels = { diabetes:'Diabetes',hypertension:'Hypertension',cardiac:'Heart Disease',asthma:'Asthma/COPD',thyroid:'Thyroid Disorder',cancer:'Cancer History',kidney:'Kidney Disease',liver:'Liver Disease' };
      mh.pre_existing_conditions.forEach(c => {
        rawFindings.push({ parameter: 'Pre-existing: '+(condLabels[c]||c), value: 'Declared', status: 'high', implication: 'Requires assessment and potential loading' });
        if (['diabetes','cardiac','cancer'].includes(c) && !loadedCategories.has(c)) {
          const loadPct = c==='cancer'?100:50;
          totalLoading += loadPct;
          loadingFactors.push({ factor: 'Declared '+(condLabels[c]||c), loading: loadPct+'%' });
          loadedCategories.add(c);
        }
      });
    }
    if (mh.family_history && mh.family_history !== 'none') rawFindings.push({ parameter: 'Family History', value: mh.family_history, status: 'borderline', implication: 'Genetic predisposition risk factor' });
    if (mh.hospitalizations && parseInt(mh.hospitalizations) >= 3) rawFindings.push({ parameter: 'Hospitalizations', value: mh.hospitalizations+' events', status: 'high', implication: 'Frequent hospitalization indicates chronic issues' });
    if (mh.surgery_types?.length) {
      const highRiskSurgeries = mh.surgery_types.filter(t => ['cardiac','neurological'].includes(t));
      if (highRiskSurgeries.length) rawFindings.push({ parameter: 'Surgical History (High Risk)', value: highRiskSurgeries.join(', '), status: 'high', implication: 'Previous high-risk surgery' });
      else rawFindings.push({ parameter: 'Surgical History', value: mh.surgery_types.join(', '), status: 'borderline', implication: `${mh.surgery_types.length} previous surgery(ies)` });
    }

    // Issue 3 fix: Interaction loading for compound risks
    const hasConditions = loadedCategories;
    if (hasConditions.has('diabetes') && hasConditions.has('smoking')) { totalLoading += 25; loadingFactors.push({ factor: 'Diabetic smoker interaction', loading: '25%' }); }
    if (hasConditions.has('cardiac') && hasConditions.has('smoking')) { totalLoading += 25; loadingFactors.push({ factor: 'Cardiac + smoker interaction', loading: '25%' }); }
    if (hasConditions.has('diabetes') && hasConditions.has('bmi')) { totalLoading += 15; loadingFactors.push({ factor: 'Diabetic + obesity interaction', loading: '15%' }); }

    // Issue 12 fix: Cross-document value discrepancy check
    // (AI extracts all docs together, but if correlation_data found mismatches, flag them)
    if (extractedData._medications?.length && mh.pre_existing_conditions?.length) {
      const declaredConds = new Set(mh.pre_existing_conditions.map(c => c.toLowerCase()));
      const medConds = extractedData._medications.filter(m => m.disclosed === false).map(m => m.implied_condition);
      medConds.forEach(mc => {
        if (!declaredConds.has(mc.toLowerCase())) {
          rawFindings.push({ parameter: 'Non-disclosure (Cross-check)', value: mc, status: 'high', implication: `Medication indicates ${mc} but not in declared conditions — cross-document verification failed` });
        }
      });
    }

    // Issue 5 fix: Deduplicate findings — keep most severe per parameter base name
    const findingsMap = new Map();
    const severityRank = { high: 3, abnormal: 3, borderline: 2, normal: 1 };
    for (const f of rawFindings) {
      const baseParam = f.parameter.replace(/\s*\(.*\)/, '').replace(/^Pre-existing:\s*/, 'PEC:');
      const existing = findingsMap.get(baseParam);
      if (!existing || (severityRank[f.status]||0) > (severityRank[existing.status]||0)) {
        findingsMap.set(baseParam, f);
      }
    }
    const findings = Array.from(findingsMap.values());

    // Age-based loading
    const age = wf.age || 35;
    const ageLoading = riskParams.age_loading || {};
    let ageLoadingPct = 0;
    let ageLabel = '';
    for (const [band, config] of Object.entries(ageLoading)) {
      const [minStr, maxStr] = band.split('-');
      const min = parseInt(minStr);
      const max = maxStr === '+' || !maxStr ? 999 : (maxStr.endsWith('+') ? 999 : parseInt(maxStr));
      if (age >= min && age <= max) {
        if (config.action === 'decline') {
          violations.push({ rule_id: 'AGE_LIMIT', rule_name: 'Age Beyond Entry Limit', value: age, threshold: min, action: 'decline', severity: 'critical' });
          findings.push({ parameter: 'Age', value: `${age} years`, status: 'high', implication: config.label || 'Beyond maximum entry age' });
        } else if (config.loading_pct > 0) {
          ageLoadingPct = config.loading_pct;
          totalLoading += ageLoadingPct;
          loadingFactors.push({ factor: `Age ${age} (${config.label || band})`, loading: ageLoadingPct + '%' });
          findings.push({ parameter: 'Age Factor', value: `${age} years`, status: age >= 56 ? 'high' : 'borderline', implication: `${config.label} — +${ageLoadingPct}% age loading applied` });
        }
        ageLabel = config.label || '';
        break;
      }
    }

    // Sum Assured tier check
    const sa = wf.sum_assured || 0;
    const saTiers = riskParams.sum_assured_tiers || {};
    let currentTier = null;
    for (const [tierKey, tier] of Object.entries(saTiers)) {
      if (sa <= tier.max_sum) { currentTier = tier; break; }
    }
    if (currentTier) {
      if (currentTier.reinsurance) {
        findings.push({ parameter: 'Sum Assured (Reinsurance)', value: `₹${sa.toLocaleString('en-IN')}`, status: 'high', implication: `SA exceeds retention limit — reinsurance facultative referral required (${currentTier.label})` });
      }
      // Check if required tests for this tier are present — use EXTRACTED DATA, not document categories
      const requiredTests = currentTier.required_tests || [];
      const extractedSections = {
        blood_work: !!(extractedData.blood_chemistry && Object.keys(extractedData.blood_chemistry).some(k => extractedData.blood_chemistry[k]?.value !== null && extractedData.blood_chemistry[k]?.value !== undefined)),
        blood_chemistry: !!(extractedData.blood_chemistry && Object.keys(extractedData.blood_chemistry).some(k => extractedData.blood_chemistry[k]?.value !== null && extractedData.blood_chemistry[k]?.value !== undefined)),
        ecg: !!(extractedData.cardiac?.ecg?.overall_interpretation && extractedData.cardiac.ecg.overall_interpretation !== 'not_tested' && extractedData.cardiac.ecg.overall_interpretation !== 'not_available' && extractedData.cardiac.ecg.overall_interpretation !== null),
        cardiac: !!(extractedData.cardiac && Object.keys(extractedData.cardiac).length > 0),
        urine_analysis: !!(extractedData.urine_analysis && Object.keys(extractedData.urine_analysis).some(k => extractedData.urine_analysis[k]?.value !== null && extractedData.urine_analysis[k]?.value !== undefined)),
        hematology: !!(extractedData.hematology && Object.keys(extractedData.hematology).some(k => extractedData.hematology[k]?.value !== null && extractedData.hematology[k]?.value !== undefined)),
        physical_exam: !!(extractedData.physical_exam && Object.keys(extractedData.physical_exam).length > 0),
        imaging: !!(extractedData.imaging && Object.keys(extractedData.imaging).length > 0),
        tmt: !!(extractedData.cardiac_extended?.tmt?.result),
        echo: !!(extractedData.cardiac_extended?.lvef?.value),
        thyroid: !!(extractedData.thyroid && Object.keys(extractedData.thyroid).some(k => extractedData.thyroid[k]?.value !== null))
      };
      const missingTests = requiredTests.filter(t => !extractedSections[t.toLowerCase()]);
      if (missingTests.length > 0 && wf.documents?.length > 0) {
        findings.push({ parameter: 'Missing Tests for SA Tier', value: missingTests.join(', '), status: 'borderline', implication: `SA tier ${currentTier.label} requires: ${requiredTests.join(', ')}` });
      }
    }

    // Gender-specific findings
    const genderThresholds = riskParams.gender_thresholds || {};
    const gender = (wf.gender || 'male').toLowerCase();
    const hb = extractedData.hematology?.hemoglobin?.value;
    if (hb && genderThresholds.hemoglobin?.[gender]) {
      const gt = genderThresholds.hemoglobin[gender];
      if (hb < gt.low) findings.push({ parameter: `Hemoglobin (${gender})`, value: `${hb} g/dL`, status: 'high', implication: `Below gender-specific threshold (${gender} low: <${gt.low} g/dL)` });
    }
    const creat = extractedData.blood_chemistry?.serum_creatinine?.value;
    if (creat && genderThresholds.creatinine?.[gender]) {
      const gt = genderThresholds.creatinine[gender];
      if (creat > gt.normal_max) findings.push({ parameter: `Creatinine (${gender})`, value: `${creat} mg/dL`, status: 'borderline', implication: `Above gender-specific limit (${gender} max: ${gt.normal_max} mg/dL)` });
    }

    // Extended parameter findings
    if (extractedData.liver_extended?.ggt?.value > 80) findings.push({ parameter: 'GGT', value: extractedData.liver_extended.ggt.value + ' U/L', status: 'high', implication: 'Elevated GGT — possible liver disease or alcohol-related damage' });
    if (extractedData.thyroid?.tsh?.value) {
      const tsh = extractedData.thyroid.tsh.value;
      if (tsh > 10) findings.push({ parameter: 'TSH', value: tsh + ' mIU/L', status: 'high', implication: 'Hypothyroidism — requires evaluation and loading' });
      else if (tsh < 0.4) findings.push({ parameter: 'TSH', value: tsh + ' mIU/L', status: 'high', implication: 'Hyperthyroidism — requires evaluation' });
    }
    if (extractedData.cardiac_extended?.lvef?.value && extractedData.cardiac_extended.lvef.value < 50) findings.push({ parameter: 'LVEF', value: extractedData.cardiac_extended.lvef.value + '%', status: 'high', implication: 'Reduced ejection fraction — cardiac function impaired' });
    if (extractedData.cardiac_extended?.tmt?.result && !['negative','normal','not_done'].includes(extractedData.cardiac_extended.tmt.result)) findings.push({ parameter: 'TMT/Stress Test', value: extractedData.cardiac_extended.tmt.result, status: 'high', implication: 'Positive stress test — ischemic heart disease suspected' });
    if (extractedData.chest_xray?.interpretation && !['normal','no abnormality','no abnormality detected'].includes(extractedData.chest_xray.interpretation.toLowerCase())) findings.push({ parameter: 'Chest X-Ray', value: extractedData.chest_xray.interpretation, status: 'high', implication: 'Abnormal chest X-ray findings — requires further evaluation' });

    // Loading cap check
    const loadingCap = riskParams.loading_cap || {};
    const maxLoadingPct = loadingCap.max_loading_pct || 200;
    let loadingCapped = false;
    if (totalLoading > maxLoadingPct) {
      loadingCapped = true;
      findings.push({ parameter: 'Loading Cap Exceeded', value: `${totalLoading}% (max ${maxLoadingPct}%)`, status: 'high', implication: `Total loading exceeds maximum permissible ${maxLoadingPct}%. Auto-decline triggered.` });
    }

    // Waiting periods for counter-offer
    const waitingPeriods = [];
    const wpConfig = riskParams.waiting_periods || {};
    if (mh.pre_existing_conditions?.length) {
      mh.pre_existing_conditions.forEach(cond => {
        if (wpConfig[cond]) waitingPeriods.push({ condition: cond, years: wpConfig[cond].years, description: wpConfig[cond].description });
        else waitingPeriods.push({ condition: cond, years: wpConfig.standard_ped?.years || 3, description: `${cond} — standard PED waiting period` });
      });
    }

    // Final recommendation — Issue 4: effective score combines base score with loading impact
    let recommendation;
    const score = riskResult.risk_score.normalized;
    const loadingPenalty = Math.min(totalLoading / 10, 20); // Loading reduces effective score: max -20 pts
    const effectiveScore = Math.max(0, Math.round(score - loadingPenalty));
    const thresholds = riskParams._score_thresholds || { approve: 80, refer: 65, decline_below: 50 };
    if (violations.length > 0 || loadingCapped) recommendation = 'decline';
    else if (score >= thresholds.approve && totalLoading === 0) recommendation = 'accept_standard';
    else if (effectiveScore >= thresholds.refer) recommendation = 'accept_with_loading';
    else if (effectiveScore >= thresholds.decline_below) recommendation = 'refer';
    else recommendation = 'decline';

    // Issue 6 fix: Referral reason and priority for nuanced referrals
    let referralReason = '';
    let referralPriority = 'standard';
    if (recommendation === 'refer') {
      const highFindings = findings.filter(f => f.status === 'high' || f.status === 'abnormal');
      const borderlineFindings = findings.filter(f => f.status === 'borderline');
      if (highFindings.length >= 3) { referralReason = `Multiple adverse findings (${highFindings.length}) across parameters: ${highFindings.slice(0,3).map(f=>f.parameter).join(', ')}. Comprehensive review needed.`; referralPriority = 'high'; }
      else if (highFindings.length > 0) { referralReason = `Adverse finding in ${highFindings[0].parameter} (${highFindings[0].value}). ${highFindings[0].implication}. Specialist review recommended.`; referralPriority = 'medium'; }
      else if (totalLoading > 100) { referralReason = `High cumulative loading (+${totalLoading}%) from multiple risk factors. Review loading appropriateness.`; referralPriority = 'medium'; }
      else if (borderlineFindings.length >= 3) { referralReason = `Multiple borderline findings (${borderlineFindings.length}). Individual values are marginal but cumulative risk may be significant.`; referralPriority = 'standard'; }
      else { referralReason = `Score ${Math.round(score)}/100 (effective: ${effectiveScore}) falls in review range. Manual assessment recommended.`; referralPriority = 'standard'; }
    }

    // If reinsurance required, force refer at minimum
    if (currentTier?.reinsurance && recommendation === 'accept_standard') { recommendation = 'refer'; referralReason = `Sum assured ₹${wf.sum_assured?.toLocaleString('en-IN')} exceeds retention limit. Reinsurance facultative referral required.`; referralPriority = 'high'; }

    // Check product-specific age limits
    if (riskParams._age_limits) {
      if (age > riskParams._age_limits.max) { recommendation = 'decline'; findings.push({ parameter: 'Product Age Limit', value: `${age} years (max: ${riskParams._age_limits.max})`, status: 'high', implication: `Exceeds maximum entry age for ${wf.product_name}` }); }
    }
    // Check product-specific SA limits
    if (riskParams._sa_limits) {
      if (wf.sum_assured > riskParams._sa_limits.max) findings.push({ parameter: 'Product SA Limit', value: `₹${wf.sum_assured.toLocaleString('en-IN')} (max: ₹${riskParams._sa_limits.max.toLocaleString('en-IN')})`, status: 'high', implication: `Exceeds maximum SA for ${wf.product_name}` });
    }
    // Check mandatory tests for product — use extracted data sections, not document categories
    if (riskParams._mandatory_tests?.length && wf.documents?.length) {
      const extractedSectionsForMandatory = {
        blood_work: !!(extractedData.blood_chemistry && Object.keys(extractedData.blood_chemistry).some(k => extractedData.blood_chemistry[k]?.value !== null && extractedData.blood_chemistry[k]?.value !== undefined)),
        blood_chemistry: !!(extractedData.blood_chemistry && Object.keys(extractedData.blood_chemistry).some(k => extractedData.blood_chemistry[k]?.value !== null && extractedData.blood_chemistry[k]?.value !== undefined)),
        ecg: !!(extractedData.cardiac?.ecg?.overall_interpretation && extractedData.cardiac.ecg.overall_interpretation !== 'not_tested' && extractedData.cardiac.ecg.overall_interpretation !== 'not_available' && extractedData.cardiac.ecg.overall_interpretation !== null),
        cardiac: !!(extractedData.cardiac && Object.keys(extractedData.cardiac).some(k => extractedData.cardiac[k]?.value !== null || (k === 'ecg' && extractedData.cardiac.ecg?.overall_interpretation))),
        urine_analysis: !!(extractedData.urine_analysis && Object.keys(extractedData.urine_analysis).some(k => extractedData.urine_analysis[k]?.value !== null && extractedData.urine_analysis[k]?.value !== undefined)),
        hematology: !!(extractedData.hematology && Object.keys(extractedData.hematology).some(k => extractedData.hematology[k]?.value !== null && extractedData.hematology[k]?.value !== undefined)),
        physical_exam: !!(extractedData.physical_exam && Object.keys(extractedData.physical_exam).length > 0),
        imaging: !!(extractedData.imaging && Object.keys(extractedData.imaging).length > 0),
        tmt: !!(extractedData.cardiac_extended?.tmt?.result && extractedData.cardiac_extended.tmt.result !== 'not_tested'),
        thyroid: !!(extractedData.thyroid && Object.keys(extractedData.thyroid).some(k => extractedData.thyroid[k]?.value !== null && extractedData.thyroid[k]?.value !== undefined))
      };
      const missingMandatory = riskParams._mandatory_tests.filter(t => !extractedSectionsForMandatory[t.toLowerCase()]);
      if (missingMandatory.length) {
        findings.push({ parameter: 'Mandatory Tests Missing', value: missingMandatory.join(', '), status: 'high', implication: `REQUIRED by ${wf.product_name} policy. Case cannot be auto-approved without these tests. Missing: ${missingMandatory.map(t => t.replace(/_/g, ' ')).join(', ')}.` });
        // Force referral — missing mandatory tests should never auto-approve or counter-offer
        if (recommendation !== 'decline') {
          recommendation = 'refer';
          referralReason = `Mandatory tests missing for ${wf.product_name}: ${missingMandatory.map(t => t.replace(/_/g, ' ')).join(', ')}. Cannot auto-approve without required medical evidence. Reassign to vendor for missing reports or make manual exception.`;
          referralPriority = 'high';
        }
      }
    }

    // Build rationale text
    const rationaleLines = [`Health Risk Score: ${Math.round(score)}/100 (Grade ${riskResult.risk_score.grade})${totalLoading>0?' | Effective: '+effectiveScore+'/100':''}`];
    if (appliedPolicy) rationaleLines.push(`Policy: ${appliedPolicy.name} v${appliedPolicy.version}`);
    if (age >= 46 && ageLoadingPct > 0) rationaleLines.push(`Age Factor: ${age} years — +${ageLoadingPct}% loading`);
    if (currentTier) rationaleLines.push(`SA Tier: ${currentTier.label} (${currentTier.scrutiny})`);
    if (findings.length) rationaleLines.push(`Key Findings: ${findings.length} parameter(s) flagged`);
    if (violations.length) rationaleLines.push(`Critical Violations: ${violations.map(v=>v.rule_name).join(', ')}`);
    if (totalLoading > 0) rationaleLines.push(`Total Loading: +${totalLoading}%${loadingCapped?' (EXCEEDS CAP — DECLINED)':''}`);
    if (waitingPeriods.length) rationaleLines.push(`Waiting Periods: ${waitingPeriods.length} condition(s)`);
    if (referralReason) rationaleLines.push(`Referral: ${referralReason}`);
    if (recommendation === 'accept_standard') rationaleLines.push('All parameters within acceptable limits. Standard rates applicable.');
    else if (recommendation === 'accept_with_loading') rationaleLines.push('Substandard risk factors identified. Extra premium recommended.');
    else if (recommendation === 'refer') rationaleLines.push('Case requires senior underwriter review.');
    else if (recommendation === 'decline') rationaleLines.push('Risk exceeds acceptable thresholds or critical violations found.');

    // Historical UW intelligence — find similar past decisions
    let historicalRef = null;
    try {
      const proposalForHistory = {
        age: wf.age, gender: wf.gender, sum_assured: wf.sum_assured,
        product_type: wf.product_name, smoker: wf.lifestyle?.smoking,
        alcohol: wf.lifestyle?.alcohol, bmi: extractedData.physical_exam?.bmi?.value,
        ...(wf.medical_history?.pre_existing_conditions || []).reduce((o, c) => { o[c] = true; return o; }, {})
      };
      historicalRef = historicalEngine.findSimilarCases(proposalForHistory);
      if (historicalRef.match_count > 0) {
        rationaleLines.push(`Historical Intelligence: ${historicalRef.match_count} similar profiles — ${historicalRef.decision_distribution.approval_rate}% approved, ${historicalRef.claim_analysis.claim_rate}% claim rate. PPHC: ${historicalRef.pphc_analysis.pphc_recommendation.replace(/_/g, ' ')}.`);
      }
    } catch(e) { /* Historical engine not critical — continue without it */ }

    // Layer 2: Apply calibration offsets from UW override patterns
    let calibrationResult = null;
    try {
      calibrationResult = historicalEngine.applyCalibrationOffset(wf, effectiveScore, totalLoading, recommendation);
      if (calibrationResult.adjusted) {
        effectiveScore = calibrationResult.score;
        totalLoading = calibrationResult.loading;
        recommendation = calibrationResult.recommendation;
        rationaleLines.push(`Calibration: ${calibrationResult.calibration.note}`);
      }
    } catch(e) { /* Calibration not critical */ }

    // Biometric verification gate — if face match failed, force referral
    if (wf.biometric_verification) {
      const bioScore = wf.biometric_verification.face_match_score;
      if (bioScore !== null && bioScore !== undefined) {
        if (bioScore < 75) {
          findings.push({ parameter: 'Face Match — Identity Verification', value: `${bioScore}% match`, status: 'high', implication: `FAILED — Face captured at PPHC does not match proposal face (${bioScore}% < 75% threshold). Possible proxy examination. Medical data reliability is compromised.` });
          if (recommendation !== 'decline') {
            recommendation = 'refer';
            referralReason = `Biometric verification FAILED: face match ${bioScore}%. Possible proxy examination — medical reports may belong to a different person. Manual identity verification required.`;
            referralPriority = 'high';
          }
        } else if (bioScore < 85) {
          findings.push({ parameter: 'Face Match — Identity Verification', value: `${bioScore}% match`, status: 'borderline', implication: `Partial match — confidence below high threshold. Visual review by UW recommended.` });
        } else {
          findings.push({ parameter: 'Face Match — Identity Verified', value: `${bioScore}% match`, status: 'normal', implication: `Identity confirmed — PPHC face matches proposal face with high confidence.` });
        }
        rationaleLines.push(`Biometric: Face match ${bioScore}% — ${bioScore >= 85 ? 'verified' : bioScore >= 75 ? 'partial match' : 'FAILED'}`);
      }
    }

    const analysisResult = {
      recommendation,
      risk_score: { ...riskResult.risk_score, effective_score: effectiveScore },
      guidelines_compliance: { violations, warnings, total_rules_checked: allRules.filter(r => !r._disabled && r.path && r.operator).length, custom_rules_count: (customRules || []).length },
      component_analysis: componentAnalysis,
      findings,
      loading_percentage: totalLoading,
      loading_factors: loadingFactors,
      loading_capped: loadingCapped,
      max_loading: maxLoadingPct,
      effective_score: effectiveScore,
      referral: recommendation === 'refer' ? { reason: referralReason, priority: referralPriority } : null,
      exclusions: violations.filter(v => v.action === 'exclusion').map(v => v.rule_name),
      waiting_periods: waitingPeriods,
      applied_policy: appliedPolicy,
      sa_tier: currentTier ? { label: currentTier.label, scrutiny: currentTier.scrutiny, reinsurance: currentTier.reinsurance } : null,
      age_loading: ageLoadingPct > 0 ? { age, loading_pct: ageLoadingPct, label: ageLabel } : null,
      historical_reference: historicalRef && historicalRef.match_count > 0 ? historicalRef : null,
      calibration_applied: calibrationResult?.adjusted ? calibrationResult.calibration : null,
      em_scoring: emResult ? {
        total_medical_em: emResult.total_medical_em,
        param_em: emResult.param_em,
        interaction_em: emResult.interaction_em,
        params_scored: emResult.total_params_scored,
        adverse_count: emResult.adverse_count,
        normal_count: emResult.normal_count,
        by_section: emResult.by_section,
        interactions: emResult.interactions.filter(i => i.applied),
        param_details: emResult.param_results.filter(r => r.em > 0).map(r => ({ param: r.paramKey, value: r.value, unit: r.unit, level: r.level, em: r.em, section: r.section }))
      } : null,
      rationale: rationaleLines.join('\n'),
      customer_profile: profile,
      documents_analyzed: wf.documents.length,
      analyzed_at: new Date().toISOString(),
      engine: 'Hybrid — Rule-based + AI + Historical Intelligence + Calibration'
    };

    // Auto-feed this decision into the historical corpus (feedback loop)
    try { historicalEngine.addLiveDecision({ ...wf, ai_analysis: analysisResult }); } catch(e) { /* non-critical */ }

    return analysisResult;
  }

  // Fallback: no extracted data available — return basic analysis
  return {
    recommendation: 'refer',
    risk_score: { normalized: 0, grade: 'N/A', components: {} },
    guidelines_compliance: { violations: [], warnings: [], total_rules_checked: uwGuidelines.rules.length },
    component_analysis: {},
    findings: [{ parameter: 'Data Extraction', value: 'Pending', status: 'pending', implication: 'Documents uploaded but OCR/NLP extraction not yet performed. Manual review required.' }],
    loading_percentage: 0,
    loading_factors: [],
    exclusions: [],
    rationale: 'Documents received but automated extraction not yet available. Refer to senior underwriter for manual review.',
    customer_profile: profile,
    documents_analyzed: wf.documents.length,
    analyzed_at: new Date().toISOString(),
    engine: 'Fallback — Manual review required'
  };
}
app.get('/api/communications/stats', requireAuth, (req, res) => res.json(commsEngine.getCommsStats()));

// Get AI analysis for a workflow
app.get('/api/workflow/:id/analysis', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  if (!wf.ai_analysis) return res.json({ available: false, message: 'No analysis available. Submit documents first.' });
  res.json({ available: true, analysis: wf.ai_analysis, decision: wf.decision, risk_score: wf.risk_score });
});

// Generate AI Summary
app.post('/api/workflow/:id/ai-summary', requireAuth, async (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Not found' });
    if (!wf.ai_analysis) return res.status(400).json({ error: 'No analysis available' });

    const a = wf.ai_analysis;
    const ed = wf.extracted_data || {};
    const profile = `${wf.proposer_name}, Age ${wf.age}, ${wf.gender}, Sum Assured ₹${(wf.sum_assured||0).toLocaleString('en-IN')}, Product: ${wf.product_name||'Health Shield'}`;
    const findingsText = (a.findings||[]).map(f => `${f.parameter}: ${f.value} (${f.status}) — ${f.implication}`).join('\n');
    const violationsText = (a.guidelines_compliance?.violations||[]).map(v => `${v.rule_name}: value ${v.value} vs threshold ${v.threshold} → ${v.action}`).join('\n');
    const loadingText = (a.loading_factors||[]).map(l => `${l.factor}: ${l.loading}`).join(', ');
    const lifestyleText = wf.lifestyle ? `Smoking: ${wf.lifestyle.smoking||'unknown'}, Alcohol: ${wf.lifestyle.alcohol||'unknown'}, Tobacco: ${wf.lifestyle.tobacco_chewing||'unknown'}, Occupation hazard: ${wf.lifestyle.occupation_hazard||'unknown'}` : 'Not declared';
    const medHistText = wf.medical_history?.pre_existing_conditions?.length ? `Pre-existing: ${wf.medical_history.pre_existing_conditions.join(', ')}` : 'No pre-existing conditions declared';
    const compScores = Object.entries(a.component_analysis||{}).map(([n,c]) => `${n.replace(/_/g,' ')}: ${c.score}/${c.max} (${c.percentage}%)`).join(', ');

    let summaryText = '';

    if (true) { // Bedrock — no API key needed, uses IAM role
      try {
// using top-level __bedrockClient
        const claude = {
          messages: {
            create: async (params) => {
              const { model, temperature, ...rest } = params;
          if (!rest.anthropic_version) rest.anthropic_version = 'bedrock-2023-05-31';
              const cmd = new InvokeModelCommand({
                modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0',
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(rest)
              });
              const res = await __bedrockClient.send(cmd);
              return JSON.parse(Buffer.from(res.body).toString('utf8'));
            }
          }
        };
        const response = await claude.messages.create({
          model: 'claude-3-sonnet-20240229', max_tokens: 2000, temperature: 0.3,
          system: 'You are a senior insurance underwriter writing a professional assessment summary. Write in clear, concise professional English. Use specific values and clinical terminology. IMPORTANT: Do NOT use markdown formatting — no asterisks, no hashtags, no bold markers. Use ALL CAPS for section titles. Separate sections with a blank line. Keep each section to 2-3 sentences maximum. Be direct and clinical.',
          messages: [{ role: 'user', content: `Write a professional underwriting assessment summary for this health insurance NSTP case.

PROPOSER: ${profile}
NSTP REASON: ${(wf.nstp_reason||'').replace(/_/g,' ')}
OBSERVATIONS: ${wf.observations||'None'}

RISK SCORE: ${Math.round(a.risk_score?.normalized||0)}/100 (Grade ${a.risk_score?.grade||'N/A'})
COMPONENT SCORES: ${compScores}
RECOMMENDATION: ${a.recommendation}
${a.loading_percentage ? 'LOADING: +'+a.loading_percentage+'%' : ''}

LIFESTYLE: ${lifestyleText}
MEDICAL HISTORY: ${medHistText}

KEY FINDINGS:
${findingsText || 'No adverse findings'}

${violationsText ? 'GUIDELINE VIOLATIONS:\n'+violationsText : 'No guideline violations'}

${loadingText ? 'LOADING FACTORS: '+loadingText : ''}

EXTRACTED DATA SUMMARY: ${ed.summary || 'Data extracted from '+wf.documents?.length+' document(s)'}

Write the summary in these sections. Use ALL CAPS section titles on their own line, NO markdown, NO asterisks, NO hashtags:

PROPOSER PROFILE
One paragraph about the proposer and reason for NSTP referral.

MEDICAL ASSESSMENT
What the lab results show. Mention specific values with units.

RISK FACTORS
List adverse findings with clinical significance. Be specific.

FAVOURABLE INDICATORS
What works in the proposer's favour.

RECOMMENDATION
Clear recommendation with rationale.

CONDITIONS
Any conditions, exclusions, waiting periods, or loading applicable.` }]
        });
        summaryText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      } catch(claudeErr) {
        console.error('Claude summary error:', claudeErr.message);
      }
    }

    // Fallback if no API key or API failed
    if (!summaryText) {
      const score = Math.round(a.risk_score?.normalized||0);
      const recText = { accept_standard:'approved at standard rates', accept_with_loading:`approved with premium loading of +${a.loading_percentage||0}%`, refer:'referred to senior underwriter for manual review', decline:'declined due to risk profile exceeding acceptable thresholds' };
      summaryText = `PROPOSER PROFILE\n${wf.proposer_name}, aged ${wf.age} (${wf.gender}), has applied for ${wf.product_name||'Health Shield'} with sum assured ₹${(wf.sum_assured||0).toLocaleString('en-IN')}. The proposal was flagged as NSTP due to ${(wf.nstp_reason||'').replace(/_/g,' ')}. ${wf.observations?'Observations: '+wf.observations:''}\n\nMEDICAL ASSESSMENT\n${ed.summary||'Medical data extracted from '+wf.documents?.length+' document(s).'} Component scores: ${compScores}.\n\nRISK FACTORS\n${findingsText||'No adverse findings identified.'}\n${violationsText?'\nGuideline violations: '+violationsText:''}\n\nFAVOURABLE INDICATORS\n${Object.entries(a.component_analysis||{}).filter(([n,c])=>c.percentage>=80).map(([n,c])=>n.replace(/_/g,' ')+' scored '+c.percentage+'%').join(', ')||'Standard parameters within normal ranges.'}\n\nRECOMMENDATION\nBased on a health risk score of ${score}/100 (Grade ${a.risk_score?.grade||'N/A'}), the proposal is ${recText[a.recommendation]||'under review'}. ${loadingText?'Loading factors: '+loadingText+'.':(a.recommendation==='accept_standard'?'No additional loading or exclusions required.':'')}\n\nCONDITIONS\n${a.recommendation==='accept_standard'?'No special conditions. Standard policy terms apply.':a.recommendation==='decline'?'Proposal cannot be accepted under current health profile.':'Policy may be issued with modified terms as noted above. Standard exclusions and waiting periods apply as per IRDAI guidelines.'}`;
    }

    wf.ai_summary_text = summaryText;
    wf.ai_summary_generated_at = new Date().toISOString();
    res.json({ success: true, summary: summaryText, generated_at: wf.ai_summary_generated_at });
  } catch(e) { console.error('AI summary error:', e); res.status(500).json({ error: e.message }); }
});
app.post('/api/communications/send', requireAuth, (req, res) => {
  try { const { template, recipient_data, channels } = req.body; res.json({ success: true, notifications: commsEngine.sendNotification(template, recipient_data, channels||['email']) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Masters Configuration APIs ───

// UW Guidelines — full rules list + CRUD
app.get('/api/masters/uw-rules', requireAuth, (req, res) => {
  const fs = require('fs');
  const rules = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'config/uw-guidelines.json'), 'utf8'));
  res.json({ built_in: rules.rules, custom: customRules, total: rules.rules.length + customRules.length });
});
app.post('/api/masters/uw-rules', requireRole('Super Admin'), async (req, res) => {
  try {
    const { name, path: rulePath, operator, threshold, action, severity } = req.body;
    if (!name || !rulePath || !operator || threshold === undefined || !action) return res.status(400).json({ error: 'name, path, operator, threshold, action required' });
    const rule = { id: `CUSTOM-${String(customRules.length + 100).padStart(3,'0')}`, name, path: rulePath, operator, threshold, action, severity: severity || 'medium', source: 'admin', created_at: new Date().toISOString() };
    customRules.push(rule);
    await s3Client.saveCustomRules(customRules);
    res.json({ success: true, rule });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/masters/uw-rules/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const rule = customRules.find(r => r.id === req.params.id);
    if (!rule) return res.status(404).json({ error: 'Custom rule not found (built-in rules cannot be edited via API)' });
    const { name, threshold, action, severity, disabled } = req.body;
    if (name) rule.name = name;
    if (threshold !== undefined) rule.threshold = threshold;
    if (action) rule.action = action;
    if (severity) rule.severity = severity;
    if (disabled !== undefined) rule.disabled = disabled;
    await s3Client.saveCustomRules(customRules);
    res.json({ success: true, rule });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/masters/uw-rules/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const idx = customRules.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Custom rule not found' });
    customRules.splice(idx, 1);
    await s3Client.saveCustomRules(customRules);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Loading Table — read & update
app.get('/api/masters/loading-table', requireAuth, (req, res) => {
  const fs = require('fs');
  const riskParams = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'config/risk-params.json'), 'utf8'));
  res.json({ loading_table: riskParams.loading_table, age_loading: riskParams.age_loading, loading_cap: riskParams.loading_cap, waiting_periods: riskParams.waiting_periods, gender_thresholds: riskParams.gender_thresholds });
});
app.put('/api/masters/loading-table', requireRole('Super Admin'), async (req, res) => {
  try {
    const fs = require('fs');
    const configPath = require('path').join(__dirname, 'config/risk-params.json');
    const riskParams = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { loading_table, age_loading, loading_cap, waiting_periods } = req.body;
    if (loading_table) riskParams.loading_table = loading_table;
    if (age_loading) riskParams.age_loading = age_loading;
    if (loading_cap) riskParams.loading_cap = loading_cap;
    if (waiting_periods) riskParams.waiting_periods = waiting_periods;
    fs.writeFileSync(configPath, JSON.stringify(riskParams, null, 2));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Medical Scoring — read & update component weights
app.get('/api/masters/medical-scoring', requireAuth, (req, res) => {
  const fs = require('fs');
  const scoring = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'config/medical-scoring.json'), 'utf8'));
  res.json(scoring);
});

// Policy document upload
app.post('/api/policies/:id/document', requireRole('Super Admin'), upload.single('document'), validateFileContent, async (req, res) => {
  try {
    const policy = policiesConfig.find(p => p.id === req.params.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Store the document
    const docKey = `config/policy-documents/${policy.id}/${req.file.originalname}`;
      await s3Client.saveDocumentToS3(policy.id, req.file.originalname, req.file.buffer, req.file.mimetype);
    policy.document = { name: req.file.originalname, s3_key: docKey, content_type: req.file.mimetype, size: req.file.size, uploaded_at: new Date().toISOString(), base64_data: req.file.buffer.toString('base64') };

    // AI extraction of policy overrides from the uploaded document
    let extractedOverrides = null;
    let extractionStatus = 'skipped';
    if (true) { // Bedrock — no API key needed, uses IAM role
      try {
// using top-level __bedrockClient
        const claude = {
          messages: {
            create: async (params) => {
              const { model, temperature, ...rest } = params;
          if (!rest.anthropic_version) rest.anthropic_version = 'bedrock-2023-05-31';
              const cmd = new InvokeModelCommand({
                modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0',
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(rest)
              });
              const res = await __bedrockClient.send(cmd);
              return JSON.parse(Buffer.from(res.body).toString('utf8'));
            }
          }
        };
        const contentParts = [];
        const b64 = req.file.buffer.toString('base64');
        if (['image/jpeg','image/png','image/gif','image/webp'].includes(req.file.mimetype)) {
          contentParts.push({ type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: b64 } });
        } else if (req.file.mimetype === 'application/pdf') {
          contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
        } else {
          contentParts.push({ type: 'text', text: req.file.buffer.toString('utf8').substring(0, 15000) });
        }

        contentParts.push({ type: 'text', text: `You are an insurance underwriting policy analyst. Read this policy document carefully and extract the scoring configuration as structured JSON.

Extract the following from the document. If a value is not mentioned in the document, set it to null (do NOT guess). Only extract what is explicitly stated.

Return ONLY valid JSON:
{
  "policy_name": "name of the policy if mentioned",
  "score_thresholds": {
    "approve": null,
    "refer": null,
    "decline_below": null
  },
  "age_limits": {
    "min": null,
    "max": null
  },
  "sa_limits": {
    "min": null,
    "max": null
  },
  "loading_overrides": {
    "smoker_current": null,
    "bmi_obese_1": null,
    "bmi_obese_2": null,
    "diabetes_controlled": null,
    "diabetes_uncontrolled": null,
    "cardiac_history": null,
    "hypertension_controlled": null,
    "hypertension_uncontrolled": null
  },
  "mandatory_tests": [],
  "exclusion_text": "",
  "waiting_periods": {},
  "rule_overrides": {},
  "extracted_rules": [
    {
      "name": "rule name",
      "description": "what it checks",
      "path": "e.g. blood_chemistry.fasting_glucose.value",
      "operator": "<|>|==",
      "threshold": 0,
      "action": "decline|refer|loading",
      "severity": "critical|high|medium",
      "loading_pct": 0
    }
  ],
  "summary": "Brief summary of the policy's key requirements"
}

Known parameter paths: physical_exam.bmi.value, physical_exam.blood_pressure.systolic.value, blood_chemistry.fasting_glucose.value, blood_chemistry.hba1c.value, blood_chemistry.serum_creatinine.value, blood_chemistry.sgpt_alt.value, blood_chemistry.total_cholesterol.value, blood_chemistry.hdl.value, blood_chemistry.ldl.value, blood_chemistry.triglycerides.value, blood_chemistry.tc_hdl_ratio.value, blood_chemistry.hiv.value, blood_chemistry.hbsag.value, hematology.hemoglobin.value, cardiac.ecg.overall_interpretation, cardiac_extended.lvef.value, cardiac_extended.tmt.result, urine_analysis.protein.value, thyroid.tsh.value, liver_extended.ggt.value

For loading_overrides: only include values that differ from these defaults — smoker: 75%, BMI obese I: 50%, BMI obese II: 100%, diabetes controlled: 50%, diabetes uncontrolled: 100%, cardiac: 100%, hypertension controlled: 25%, hypertension uncontrolled: 75%. If the document specifies a different percentage, include it. If not mentioned, set to null.` });

        const response = await claude.messages.create({
          model: 'claude-3-sonnet-20240229', max_tokens: 4000, temperature: 0,
          system: 'You are a policy document analyzer. Extract structured scoring parameters from insurance underwriting policy documents. Return ONLY valid JSON, no markdown.',
          messages: [{ role: 'user', content: contentParts }]
        });

        const responseText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extractedOverrides = JSON.parse(jsonMatch[0]);
          extractionStatus = 'success';

          // Merge extracted overrides into the policy — only non-null values
          if (!policy.overrides) policy.overrides = {};

          if (extractedOverrides.score_thresholds) {
            if (!policy.overrides.score_thresholds) policy.overrides.score_thresholds = {};
            if (extractedOverrides.score_thresholds.approve) policy.overrides.score_thresholds.approve = extractedOverrides.score_thresholds.approve;
            if (extractedOverrides.score_thresholds.refer) policy.overrides.score_thresholds.refer = extractedOverrides.score_thresholds.refer;
            if (extractedOverrides.score_thresholds.decline_below) policy.overrides.score_thresholds.decline_below = extractedOverrides.score_thresholds.decline_below;
          }

          if (extractedOverrides.age_limits) {
            if (!policy.overrides.age_limits) policy.overrides.age_limits = {};
            if (extractedOverrides.age_limits.min) policy.overrides.age_limits.min = extractedOverrides.age_limits.min;
            if (extractedOverrides.age_limits.max) policy.overrides.age_limits.max = extractedOverrides.age_limits.max;
          }

          if (extractedOverrides.sa_limits) {
            if (!policy.overrides.sa_limits) policy.overrides.sa_limits = {};
            if (extractedOverrides.sa_limits.min) policy.overrides.sa_limits.min = extractedOverrides.sa_limits.min;
            if (extractedOverrides.sa_limits.max) policy.overrides.sa_limits.max = extractedOverrides.sa_limits.max;
          }

          if (extractedOverrides.loading_overrides) {
            if (!policy.overrides.loading_overrides) policy.overrides.loading_overrides = {};
            for (const [key, val] of Object.entries(extractedOverrides.loading_overrides)) {
              if (val !== null && val !== undefined) policy.overrides.loading_overrides[key] = val;
            }
          }

          if (extractedOverrides.mandatory_tests?.length) {
            policy.overrides.mandatory_tests = extractedOverrides.mandatory_tests;
          }

          if (extractedOverrides.exclusion_text) {
            policy.overrides.exclusion_text = extractedOverrides.exclusion_text;
          }

          if (extractedOverrides.waiting_periods && Object.keys(extractedOverrides.waiting_periods).length) {
            policy.overrides.waiting_periods = extractedOverrides.waiting_periods;
          }

          // Store extracted rules as custom rules linked to this policy
          if (extractedOverrides.extracted_rules?.length) {
            policy.extracted_rules = extractedOverrides.extracted_rules.map((r, i) => ({
              ...r,
              id: `${policy.id}-RULE-${String(i+1).padStart(3,'0')}`,
              source: req.file.originalname,
              policy_id: policy.id,
              ai_extracted: true,
              extracted_at: new Date().toISOString()
            }));
          }

          if (extractedOverrides.summary) {
            policy.ai_extraction_summary = extractedOverrides.summary;
          }

          policy.overrides_extracted_from = req.file.originalname;
          policy.overrides_extracted_at = new Date().toISOString();
        }
      } catch(claudeErr) {
        console.error('Claude policy extraction error:', claudeErr.message);
        extractionStatus = 'error: ' + claudeErr.message;
      }
    }

    await s3Client.saveConfig('policies', policiesConfig);
    res.json({
      success: true,
      document: { name: policy.document.name, size: policy.document.size },
      extraction: {
        status: extractionStatus,
        overrides_extracted: extractedOverrides ? true : false,
        summary: extractedOverrides?.summary || null,
        score_thresholds: extractedOverrides?.score_thresholds || null,
        age_limits: extractedOverrides?.age_limits || null,
        loading_overrides_count: extractedOverrides?.loading_overrides ? Object.values(extractedOverrides.loading_overrides).filter(v => v !== null).length : 0,
        rules_extracted: extractedOverrides?.extracted_rules?.length || 0,
        mandatory_tests: extractedOverrides?.mandatory_tests || [],
        message: extractionStatus === 'success' ? 'Policy document analyzed. Scoring overrides extracted and merged into the policy configuration.' : extractionStatus === 'skipped' ? 'Document stored. AI extraction skipped (no API key).' : 'Document stored. AI extraction failed — configure overrides manually.'
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Product & Policy Management ───
let productsConfig = [];
let policiesConfig = [];
let productPolicyMap = {};
let catScoringConfig = {};  // Dynamic per-CAT scoring: components → factors (add/edit/delete)

// ── Dynamic scoring config structure ─────────────────────────────────────────
// Each CAT has: thresholds + 5 components. Each component has a weight + factors[].
// Each factor: { id, label, max, bands:[{label,value,points}] }
// The engine scores every factor, sums per component, scales to weight, sums to 100.
const SCORING_VERSION = 'dynamic-v3';

function mkFactor(id, label, max, bands) { return { id, label, max, bands }; }

// ─── PER-CAT COMPONENT WEIGHTS ────────────────────────────────────────────────
// Medical weight increases as CAT level rises — more lab data available.
// Lifestyle weight decreases — physical test evidence overrides self-declaration.
// Tele MER has NO physical tests — lifestyle+history dominate entirely.
const CAT_WEIGHTS = {
  'CAT_1':    { medical:35, lifestyle:20, history:15, clinical:15, documentation:15 },
  'CAT_2':    { medical:38, lifestyle:18, history:15, clinical:15, documentation:14 },
  'CAT_3':    { medical:42, lifestyle:15, history:15, clinical:16, documentation:12 },
  'CAT_4':    { medical:45, lifestyle:12, history:15, clinical:16, documentation:12 },
  'tele_mer': { medical:0,  lifestyle:35, history:30, clinical:25, documentation:10 }
};

// ─── PER-CAT DECISION THRESHOLDS ─────────────────────────────────────────────
// Higher CAT = more tests = more failure risk = lower approval bar
const CAT_THRESHOLDS = {
  'CAT_1':    { approve:80, refer:65, decline_below:50 },
  'CAT_2':    { approve:78, refer:62, decline_below:46 },
  'CAT_3':    { approve:75, refer:58, decline_below:42 },
  'CAT_4':    { approve:72, refer:55, decline_below:40 },
  'tele_mer': { approve:85, refer:65, decline_below:50 }
};

// ─── RAW MAX POINTS PER TEST, PER CAT ────────────────────────────────────────
// Based on SBI Superhealth UW Guidelines test table image.
// Each CAT's factor maxes sum EXACTLY to that CAT's medical component weight (35/38/42/45).
// bmi_bp is ONE combined factor (BMI + Blood Pressure from MER form).
const CAT_MEDICAL_MAX = {
  CAT_1: { bmi_bp:10, ecg:4, urine_routine:2, cbc:4, esr:3, hba1c:4, sgpt:3, creatinine:3, total_cholesterol:2 },
  // 10+4+2+4+3+4+3+3+2 = 35 ✓
  CAT_2: { bmi_bp:10, ecg:4, urine_routine:2, cbc:4, esr:3, hba1c:4, sgpt:2, creatinine:2, total_cholesterol:2, triglyceride:2, urine_microalbumin:3 },
  // 10+4+2+4+3+4+2+2+2+2+3 = 38 ✓
  CAT_3: { bmi_bp:9, ecg:4, urine_routine:2, cbc:4, esr:3, hba1c:4, urine_microalbumin:3, lipid_profile:5, lft:4, kft:4 },
  // 9+4+2+4+3+4+3+5+4+4 = 42 ✓
  CAT_4: { bmi_bp:9, ecg:4, urine_routine:2, cbc:3, esr:2, hba1c:4, urine_microalbumin:3, lipid_profile:4, lft:4, kft:4, echo_2d:4, psa_pap:2 }
  // 9+4+2+3+2+4+3+4+4+4+4+2 = 45 ✓
};

// ─── MEDICAL FACTOR BUILDER (per CAT — correct SBI test list) ────────────────
// Each CAT has a DIFFERENT set of medical factors based on which tests SBI mandates.
// CAT 1: 9 tests (standalone SGPT, Creatinine, Total Cholesterol)
// CAT 2: 11 tests (adds Triglyceride + Urine Microalbumin)
// CAT 3: 10 tests (upgrades to full Lipid Profile + LFT + KFT, drops standalone TC+TG+Creatinine+SGPT)
// CAT 4: 13 tests (adds 2D Echo + PSA/PAP Smear)
function buildMedicalFactors(cat) {
  const w = CAT_MEDICAL_MAX[cat] || CAT_MEDICAL_MAX.CAT_1;

  // ── CORE TESTS: present in ALL CAT levels ──────────────────────────────────
  const factors = [
    // MER — BMI + Blood Pressure (7 pts: biggest contributor, 2 linked risk factors)
    mkFactor('bmi_bp', 'MER — BMI + Blood Pressure', w.bmi_bp, [
      {label:'Normal BMI(18.5-24.9) + Normal BP(<130/85)',    value:'both_normal',   points:w.bmi_bp},
      {label:'One borderline (BMI 25-29 or BP 130-139/85-89)',value:'one_borderline',points:Math.round(w.bmi_bp*0.5)},
      {label:'BMI ≥30 or BP ≥140/90',                        value:'both_abnormal', points:Math.round(w.bmi_bp*0.15)}
    ]),
    // ECG — Cardiac rhythm, ST segment, LVH (4 pts: structural/ischaemic disease = high mortality)
    mkFactor('ecg', 'ECG — Rhythm, ST, LVH', w.ecg, [
      {label:'Normal sinus rhythm',           value:'normal',    points:w.ecg},
      {label:'Minor variation / LVH / BBB',   value:'borderline',points:Math.round(w.ecg*0.5)},
      {label:'Ischaemic / Abnormal / LBBB',   value:'abnormal',  points:0.5}
    ]),
    // Urine Routine — Protein, glucose, RBC (2 pts: pointer test, not primary risk driver)
    mkFactor('urine_routine', 'Urine Routine — Protein, Glucose, RBC', w.urine_routine, [
      {label:'All negative / Nil',            value:'nil',       points:w.urine_routine},
      {label:'Trace protein or 1+ glucose',   value:'trace',     points:1},
      {label:'Protein 2+ or Glucose 2+',      value:'abnormal',  points:0.25}
    ]),
    // CBC — Haemoglobin, WBC, Platelets (4 pts: anaemia + leukocytosis both raise mortality)
    mkFactor('cbc', 'CBC — Hb, WBC, Platelets', w.cbc, [
      {label:'All normal (Hb≥13.5M/12F, WBC 4k-11k)', value:'normal',   points:w.cbc},
      {label:'Hb 11-13.4 or WBC borderline',           value:'one_low',  points:Math.round(w.cbc*0.55)},
      {label:'Anaemia Hb<11 or Leukocytosis >15k',     value:'abnormal', points:Math.round(w.cbc*0.2)}
    ]),
    // ESR — Non-specific inflammation (2 pts: adjunct marker, must correlate with other tests)
    mkFactor('esr', 'ESR — Inflammation Marker', w.esr, [
      {label:'Normal M<15 F<20 mm/hr',        value:'normal',    points:w.esr},
      {label:'Mildly elevated 20-40',         value:'borderline',points:1},
      {label:'Significantly elevated >40',    value:'high',      points:0.25}
    ]),
    // HbA1C — Diabetes 3-month control (5 pts: HIGHEST single test weight — diabetes is #1 UW risk)
    mkFactor('hba1c', 'HbA1C — Glycated Haemoglobin', w.hba1c, [
      {label:'Normal <5.7%',                  value:'< 5.7',     points:w.hba1c},
      {label:'Pre-diabetic 5.7-6.4%',         value:'5.7-6.4',   points:Math.round(w.hba1c*0.5)},
      {label:'Diabetic 6.5-7.9%',             value:'6.5-7.9',   points:Math.round(w.hba1c*0.2)},
      {label:'Poorly controlled >=8%',        value:'>= 8',      points:0.25}
    ])
  ];

  // ── CAT 1 & CAT 2 ONLY: Standalone SGPT, Creatinine, Total Cholesterol ─────
  // (These are REPLACED by full LFT/KFT/Lipid Profile in CAT 3+)
  if (cat === 'CAT_1' || cat === 'CAT_2') {
    factors.push(
      // SGPT — Liver cell damage (3 pts: replaced by full LFT in CAT 3+)
      mkFactor('sgpt', 'SGPT — Liver Cell Damage (ALT)', w.sgpt, [
        {label:'Normal <40 U/L',              value:'normal',    points:w.sgpt},
        {label:'Mildly elevated 40-80',       value:'mild',      points:Math.round(w.sgpt*0.5)},
        {label:'Elevated >80 U/L',            value:'high',      points:0.5}
      ]),
      // Serum Creatinine — Kidney filtration (3 pts: replaced by full KFT in CAT 3+)
      mkFactor('serum_creatinine', 'Serum Creatinine — Kidney Filtration', w.creatinine, [
        {label:'Normal M<1.3 F<1.1 mg/dL',   value:'normal',    points:w.creatinine},
        {label:'Mildly elevated 1.3-1.7',    value:'mild',      points:Math.round(w.creatinine*0.5)},
        {label:'Elevated >1.7 mg/dL',         value:'high',      points:0.5}
      ]),
      // Total Cholesterol — Cardiac lipid risk (CAT1=3pts, CAT2=2pts — replaced by Lipid Profile in CAT3+)
      mkFactor('total_cholesterol', 'Total Cholesterol', w.total_cholesterol, [
        {label:'Desirable <200 mg/dL',        value:'< 200',     points:w.total_cholesterol},
        {label:'Borderline 200-239',          value:'200-239',   points:Math.round(w.total_cholesterol*0.5)},
        {label:'High >=240 mg/dL',            value:'>= 240',    points:0.5}
      ])
    );
  }

  // ── CAT 2 ONLY: Serum Triglyceride (NEW vs CAT 1) ─────────────────────────
  // Fat metabolism, MetS marker. Absorbed into Lipid Profile in CAT 3+.
  if (cat === 'CAT_2') {
    factors.push(
      mkFactor('triglyceride', 'Serum Triglyceride — Lipid Metabolism', w.triglyceride, [
        {label:'Normal <150 mg/dL',           value:'< 150',     points:3},
        {label:'Borderline 150-199',          value:'150-199',   points:1.5},
        {label:'High 200-499',                value:'200-499',   points:0.5},
        {label:'Very high >=500 (pancreatitis risk)', value:'>= 500', points:0.1}
      ])
    );
  }

  // ── CAT 2, 3 & 4: Urine Microalbumin (NEW from CAT 2) ─────────────────────
  // Early nephropathy — 30-300 range DOUBLES CV mortality. High weight justified.
  if (cat !== 'CAT_1') {
    factors.push(
      mkFactor('urine_microalbumin', 'Urine Microalbumin — Early Nephropathy', w.urine_microalbumin||4, [
        {label:'Normal <30 mg/g Creatinine',  value:'< 30',      points:w.urine_microalbumin||4},
        {label:'Microalbuminuria 30-300 mg/g',value:'30-300',    points:Math.round((w.urine_microalbumin||4)*0.5)},
        {label:'Macroalbuminuria >300 mg/g',  value:'> 300',     points:0.5}
      ])
    );
  }

  // ── CAT 3 & 4: Upgraded panels replacing standalone tests ─────────────────
  if (cat === 'CAT_3' || cat === 'CAT_4') {
    factors.push(
      // Lipid Profile Full — LDL, HDL, TC/HDL ratio, TG (6 pts: 3 independent CV risk markers)
      mkFactor('lipid_profile', 'Lipid Profile — LDL, HDL, TC/HDL, TG', w.lipid_profile, [
        {label:'Optimal: LDL<100, HDL>60, Ratio<3.5',    value:'optimal',    points:w.lipid_profile},
        {label:'Borderline: LDL 100-159 or Ratio 3.5-5', value:'borderline', points:Math.round(w.lipid_profile*0.5)},
        {label:'High Risk: LDL>=160 or Ratio>5',          value:'high_risk',  points:1}
      ]),
      // LFT Full — SGOT, SGPT, Bilirubin, ALP, GGT, Albumin (5 pts: Albumin reflects synthetic function)
      mkFactor('lft', 'LFT — Full Liver Function Tests', w.lft, [
        {label:'All normal (SGPT<40, Bili<1.2, Alb>=3.5)', value:'normal',   points:w.lft},
        {label:'One parameter mildly elevated',            value:'mild',      points:Math.round(w.lft*0.5)},
        {label:'Two+ elevated or Albumin <3.0',           value:'abnormal',  points:1}
      ]),
      // KFT Full — BUN, Uric Acid, Creatinine, eGFR (5 pts: BUN/Cr ratio shows aetiology)
      mkFactor('kft', 'KFT — Full Kidney Function Tests', w.kft, [
        {label:'All normal (Cr<1.3M, BUN<25, UA<7M)',  value:'normal',    points:w.kft},
        {label:'One parameter mildly elevated',         value:'mild',      points:Math.round(w.kft*0.5)},
        {label:'Creatinine>1.7 or BUN>40 mg/dL',       value:'high',      points:1}
      ])
    );
  }

  // ── CAT 4 EXCLUSIVE: 2D Echo + PSA(M) / PAP Smear(F) ─────────────────────
  if (cat === 'CAT_4') {
    factors.push(
      // 2D Echo — LVEF, wall motion, valves (5 pts: LVEF<35% = absolute decline per UG006)
      mkFactor('echo_2d', '2D Echo — LVEF + Wall Motion', w.echo_2d, [
        {label:'LVEF >=55% + Normal wall motion',      value:'normal',               points:w.echo_2d},
        {label:'LVEF 45-54% or mild hypokinesia',      value:'mildly_reduced',       points:Math.round(w.echo_2d*0.4)},
        {label:'LVEF <45% or akinetic segment',        value:'significantly_reduced',points:0.5}
      ]),
      // PSA / PAP Smear — gender-conditional cancer screening (2 pts: screening not diagnostic)
      mkFactor('psa_pap', 'PSA (Male) / PAP Smear (Female)', w.psa_pap, [
        {label:'PSA <4 ng/mL or PAP NILM (normal)',      value:'normal',    points:2},
        {label:'PSA 4-10 ng/mL or PAP ASCUS/LSIL',      value:'borderline',points:1},
        {label:'PSA >10 ng/mL or PAP HSIL/Malignant',   value:'high_risk', points:0.1}
      ])
    );
  }

  return factors;
}

// ─── SHARED NON-MEDICAL FACTORS (Lifestyle, History, Clinical, Documentation) ─
// Factor maxes are scaled per CAT so they sum exactly to that component's weight.
// CAT1: lifestyle=20, history=15, clinical=15, documentation=15
// CAT2: lifestyle=18, history=15, clinical=15, documentation=14
// CAT3: lifestyle=15, history=15, clinical=16, documentation=12
// CAT4: lifestyle=12, history=15, clinical=16, documentation=12
function sharedComponents(catWeights) {
  const lw = catWeights.lifestyle; // 20/18/15/12
  const hw = catWeights.history;   // 15 all CATs
  const cw = catWeights.clinical;  // 15/15/16/16
  const dw = catWeights.documentation; // 15/14/12/12

  // Lifestyle factors scaled to lw — smoking always gets most (35%), exercise least (10%)
  // Proportions: smoking 35%, alcohol 25%, tobacco 15%, occupation 15%, exercise 10%
  const ls_smoking  = Math.round(lw * 0.35);   // 7/6/5/4
  const ls_alcohol  = Math.round(lw * 0.25);   // 5/5/4/3
  const ls_tobacco  = Math.round(lw * 0.15);   // 3/3/2/2
  const ls_occup    = Math.round(lw * 0.15);   // 3/3/2/2
  const ls_exercise = lw - ls_smoking - ls_alcohol - ls_tobacco - ls_occup; // remainder

  // History factors scaled to hw — PED always dominant (47%)
  const hi_ped      = Math.round(hw * 0.47);   // 7 all CATs
  const hi_family   = Math.round(hw * 0.27);   // 4 all CATs
  const hi_hosp     = Math.round(hw * 0.13);   // 2 all CATs
  const hi_surgical = hw - hi_ped - hi_family - hi_hosp; // remainder = 2

  // Clinical factors scaled to cw — drug-condition match most important (33%)
  const cl_drug  = Math.round(cw * 0.33);      // 5/5/5/5
  const cl_multi = Math.round(cw * 0.33);      // 5/5/5/5
  const cl_cv    = cw - cl_drug - cl_multi;    // remainder = 5/5/6/6

  // Documentation factors scaled to dw
  const doc_complete = Math.round(dw * 0.53);  // 8/7/6/6
  const doc_modules  = Math.round(dw * 0.27);  // 4/4/3/3
  const doc_consist  = dw - doc_complete - doc_modules; // remainder = 3/3/3/3

  return {
    lifestyle: {
      label: 'Lifestyle Risk', weight: lw,
      factors: [
        mkFactor('smoking',   'Smoking Status',    ls_smoking,  [{label:'Never',value:'never',points:ls_smoking},{label:'Former smoker',value:'former',points:Math.round(ls_smoking*0.57)},{label:'Current smoker',value:'current',points:1}]),
        mkFactor('alcohol',   'Alcohol Use',        ls_alcohol,  [{label:'Never',value:'never',points:ls_alcohol},{label:'Occasional',value:'occasional',points:Math.round(ls_alcohol*0.8)},{label:'Regular',value:'regular',points:Math.round(ls_alcohol*0.4)},{label:'Heavy',value:'heavy',points:0.5}]),
        mkFactor('tobacco',   'Tobacco Chewing',    ls_tobacco,  [{label:'Never',value:'never',points:ls_tobacco},{label:'Former',value:'former',points:Math.round(ls_tobacco*0.5)},{label:'Current',value:'current',points:0.5}]),
        mkFactor('occupation','Occupation Hazard',  ls_occup,    [{label:'None',value:'none',points:ls_occup},{label:'Low',value:'low',points:Math.round(ls_occup*0.83)},{label:'Moderate',value:'moderate',points:Math.round(ls_occup*0.5)},{label:'High',value:'high',points:0.5}]),
        mkFactor('exercise',  'Exercise Frequency', ls_exercise, [{label:'Daily',value:'daily',points:ls_exercise},{label:'Regular (3-4/week)',value:'regular',points:Math.max(1,Math.round(ls_exercise*0.75))},{label:'Occasional',value:'occasional',points:Math.max(1,Math.round(ls_exercise*0.5))},{label:'None',value:'none',points:0.5}])
      ]
    },
    medical_history: {
      label: 'Medical History', weight: hw,
      factors: [
        mkFactor('pre_existing',    'Pre-Existing Conditions', hi_ped,      [{label:'None declared',value:'none',points:hi_ped},{label:'1 controlled condition',value:'1_controlled',points:Math.round(hi_ped*0.71)},{label:'2 active conditions',value:'2_active',points:Math.round(hi_ped*0.43)},{label:'3+ active conditions',value:'3+_active',points:Math.round(hi_ped*0.14)}]),
        mkFactor('family_history',  'Family History',          hi_family,   [{label:'None',value:'none',points:hi_family},{label:'1 risk (parent/sibling)',value:'1_risk',points:Math.round(hi_family*0.75)},{label:'2 risks',value:'2_risks',points:Math.round(hi_family*0.5)},{label:'3+ risks',value:'3+_risks',points:Math.round(hi_family*0.25)}]),
        mkFactor('hospitalizations','Hospitalizations',        hi_hosp,     [{label:'None in 5 years',value:'none',points:hi_hosp},{label:'1-2 events',value:'1_2',points:Math.round(hi_hosp*0.5)},{label:'3+ events',value:'3+',points:0.5}]),
        mkFactor('surgical_history','Surgical History',        hi_surgical, [{label:'None',value:'none',points:hi_surgical},{label:'1 surgery',value:'1',points:Math.round(hi_surgical*0.75)},{label:'2+ surgeries',value:'2+',points:Math.round(hi_surgical*0.5)}])
      ]
    },
    clinical_correlation: {
      label: 'Clinical Correlation', weight: cw,
      factors: [
        mkFactor('drug_condition',  'Drug–Condition Match',  cl_drug,  [{label:'All drugs match declared conditions',value:'full_match',points:cl_drug},{label:'Minor gap / probable OTC',value:'minor_gap',points:Math.round(cl_drug*0.4)},{label:'Significant non-disclosure implied',value:'non_disclosure',points:0.5}]),
        mkFactor('multi_system',    'Multi-System Findings', cl_multi, [{label:'No cross-system flags',value:'none',points:cl_multi},{label:'1 cross-system flag',value:'1_flag',points:Math.round(cl_multi*0.6)},{label:'2+ flags (e.g. HTN + DM + CKD)',value:'2+_flags',points:1}]),
        mkFactor('cv_risk',         'Cardiovascular Risk',   cl_cv,    [{label:'Low (<10% 10yr Framingham)',value:'low',points:cl_cv},{label:'Moderate (10-20%)',value:'moderate',points:Math.round(cl_cv*0.6)},{label:'High (>20%)',value:'high',points:1}])
      ]
    },
    documentation_quality: {
      label: 'Documentation Quality', weight: dw,
      factors: [
        mkFactor('completeness',  'Report Completeness',    doc_complete, [{label:'≥90% parameters tested',value:'>= 90',points:doc_complete},{label:'75-89% tested',value:'75-89',points:Math.round(doc_complete*0.75)},{label:'50-74% tested',value:'50-74',points:Math.round(doc_complete*0.5)},{label:'<50% tested',value:'< 50',points:Math.round(doc_complete*0.25)}]),
        mkFactor('module_coverage','Module Coverage',        doc_modules,  [{label:'5+ report modules uploaded',value:'5+',points:doc_modules},{label:'3-4 modules',value:'3-4',points:Math.round(doc_modules*0.75)},{label:'2 modules',value:'2',points:Math.round(doc_modules*0.5)},{label:'1 module only',value:'1',points:Math.round(doc_modules*0.25)}]),
        mkFactor('consistency',   'Consistency & Validity', doc_consist,  [{label:'No contradictions, reports dated within 60 days',value:'clean',points:doc_consist},{label:'Minor inconsistency (e.g. BMI mismatch)',value:'minor',points:Math.round(doc_consist*0.67)},{label:'Major contradiction or expired reports',value:'major',points:0.5}])
      ]
    }
  };
}

// ─── MAIN BUILDER ────────────────────────────────────────────────────────────
// Builds the full per-CAT scoring config. Called at startup and on reset.
// Each CAT gets: correct medical test factors + shared non-medical factors.
function buildDefaultCatScoring() {
  const cfg = {};
  for (const cat of ['CAT_1','CAT_2','CAT_3','CAT_4','tele_mer']) {
    const weights = CAT_WEIGHTS[cat];
    const shared  = sharedComponents(weights);
    cfg[cat] = {
      _version: SCORING_VERSION,
      thresholds: { ...CAT_THRESHOLDS[cat] },
      components: {
        medical: {
          label: 'Medical Parameters',
          weight: weights.medical,
          // Per-CAT correct test list — CAT 1 has 9 tests, CAT 4 has 13 tests
          factors: cat === 'tele_mer' ? [] : buildMedicalFactors(cat)
        },
        lifestyle:     shared.lifestyle,
        history:       shared.history,
        clinical:      shared.clinical,
        documentation: shared.documentation
      }
    };
  }
  return cfg;
}
const DEFAULT_CAT_SCORING = buildDefaultCatScoring();

// Load on startup (called below)
async function loadProductPolicyConfig() {
  // Phase 0 fix: always load (with or without S3). S3 reads are wrapped in try/catch so failures are harmless.
    try { productsConfig = (await s3Client.getConfig('products')) || []; } catch(e) { productsConfig = []; }
    try { policiesConfig = (await s3Client.getConfig('policies')) || []; } catch(e) { policiesConfig = []; }
    try { productPolicyMap = (await s3Client.getConfig('product-policy-map')) || {}; } catch(e) { productPolicyMap = {}; }
    try { catScoringConfig = (await s3Client.getConfig('cat-scoring')) || {}; } catch(e) { catScoringConfig = {}; }
    // Seed/upgrade if empty or old version
    const isCurrentVersion = catScoringConfig?.CAT_1?._version === SCORING_VERSION;
    if (!catScoringConfig || Object.keys(catScoringConfig).length === 0 || !isCurrentVersion) {
      catScoringConfig = buildDefaultCatScoring();
      await s3Client.saveConfig('cat-scoring', catScoringConfig).catch(e => console.error('CAT scoring seed error:', e.message));
      console.log('[Startup] ✅ Dynamic per-CAT scoring config seeded (components + factors)');
    }
  // ── ALWAYS force-reset to SBI Superhealth products on every startup ──────────
  // Version token forces re-seed whenever bumped — change this string to re-seed.
  const SBI_VER = 'sbi-superhealth-v3';
  const SBI_PRODUCTS = [
    { id:'PROD-007', name:'Prime',             code:'SUHE-PRM', type:'health',   _ver:SBI_VER,
      plan_var:'5', product_code:'SUHE001', status:'active', created_at:new Date().toISOString(),
      description:'SBI Super Health Insurance — Prime Plan. SA: 3L/5L/7L/10L and 15L/20L/25L. SUHEPlanVar=5.' },
    { id:'PROD-008', name:'Elite',             code:'SUHE-ELT', type:'health',   _ver:SBI_VER,
      plan_var:'1', product_code:'SUHE001', status:'active', created_at:new Date().toISOString(),
      description:'SBI Super Health Insurance — Elite Plan. SA: 3L/5L/7L/10L and 15L/20L/25L. SUHEPlanVar=1.' },
    { id:'PROD-009', name:'Platinum',          code:'SUHE-PLT', type:'health',   _ver:SBI_VER,
      plan_var:'2', product_code:'SUHE001', status:'active', created_at:new Date().toISOString(),
      description:'SBI Super Health Insurance — Platinum Plan. SA: 10L-25L and 30L-50L. SUHEPlanVar=2.' },
    { id:'PROD-010', name:'Premier',           code:'SUHE-PRE', type:'health',   _ver:SBI_VER,
      plan_var:'4', product_code:'SUHE001', status:'active', created_at:new Date().toISOString(),
      description:'SBI Super Health Insurance — Premier Plan. SA: 3L/5L/7L/10L. SUHEPlanVar=4.' },
    { id:'PROD-011', name:'Platinum Infinite', code:'SUHE-PLI', type:'health',   _ver:SBI_VER,
      plan_var:'3', product_code:'SUHE001', status:'active', created_at:new Date().toISOString(),
      description:'SBI Super Health Insurance — Platinum Infinite. SA: 50L, 75L, 1Cr+. SUHEPlanVar=3.' },
    { id:'PROD-006', name:'Group Health',      code:'GH',       type:'group',    _ver:SBI_VER,
      status:'active', created_at:new Date().toISOString(),
      description:'Employer-sponsored group mediclaim. Simplified UW for groups above 50 lives.' }
  ];
  const isVersioned = productsConfig.some(p => p._ver === SBI_VER);
  if (!isVersioned) {
    // Completely overwrite — remove ALL old products, save only SBI lineup
    productsConfig = SBI_PRODUCTS;
    await s3Client.saveConfig('products', productsConfig).catch(e => console.error('Products seed error:', e.message));
    console.log('[Startup] ✅ SBI products force-seeded: Prime, Elite, Platinum, Premier, Platinum Infinite, Group Health');
  } else {
    // S3 has SBI products — use them as-is, remove any non-SBI products that crept in
    const SBI_IDS = SBI_PRODUCTS.map(p => p.id);
    const hadExtra = productsConfig.some(p => !SBI_IDS.includes(p.id));
    if (hadExtra) {
      productsConfig = productsConfig.filter(p => SBI_IDS.includes(p.id));
      await s3Client.saveConfig('products', productsConfig).catch(e => console.error('Products cleanup error:', e.message));
      console.log('[Startup] ✅ Removed non-SBI products from memory');
    } else {
      console.log('[Startup] ✅ SBI products already current — skipping reset');
    }
  }

  // Seed default policies — always ensure the new policies exist
  const hasNewPolicies = policiesConfig.some(p => p.id === 'POL-001' && p.name?.includes('Arogya Sanjeevani'));
  if (!hasNewPolicies) {
    policiesConfig = [
      {
        id: 'POL-001', name: 'Arogya Sanjeevani UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 75, refer: 60, decline_below: 45 },
          age_limits: { min: 18, max: 65 },
          sa_limits: { min: 100000, max: 500000 },
          loading_overrides: { smoker_current: 50, bmi_obese_1: 25, bmi_obese_2: 75 },
          mandatory_tests: ['blood_work'],
          rule_overrides: {},
          waiting_periods: { diabetes: { years: 4 }, hypertension: { years: 4 }, cardiac: { years: 4 } },
          stp_eligible: true,
          stp_max_age: 45,
          stp_max_sa: 500000
        },
        description: 'Standardized IRDAI plan — STP-enabled up to SA 5L and age 45. Relaxed thresholds for NSTP cases.'
      },
      {
        id: 'POL-002', name: 'Arogya Premier UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 80, refer: 65, decline_below: 50 },
          age_limits: { min: 18, max: 65 },
          sa_limits: { min: 300000, max: 10000000 },
          loading_overrides: { smoker_current: 75, bmi_obese_1: 50, bmi_obese_2: 100, diabetes_declared: 50 },
          mandatory_tests: ['blood_work', 'urine_analysis'],
          rule_overrides: {},
          stp_eligible: true,
          stp_max_age: 45,
          stp_max_sa: 1500000
        },
        description: 'Standard UW thresholds. SA up to 1Cr. STP-enabled up to SA 15L and age 45 for clean profiles.'
      },
      {
        id: 'POL-003', name: 'Critical Illness UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 85, refer: 70, decline_below: 55 },
          age_limits: { min: 18, max: 60 },
          sa_limits: { min: 500000, max: 25000000 },
          loading_overrides: { smoker_current: 100, bmi_obese_1: 75, bmi_obese_2: 150, cardiac_history: 150 },
          mandatory_tests: ['blood_work', 'ecg', 'urine_analysis'],
          rule_overrides: {
            'UG003': { threshold: 250 },
            'UG009': { threshold: 220 }
          },
          waiting_periods: { cancer: { years: 4 }, cardiac: { years: 4 }, stroke: { years: 4 }, organ_failure: { years: 4 } }
        },
        description: 'Strict UW — approve ≥85, lower age cap (60), higher loading for smokers/cardiac/obesity. Stricter glucose/cholesterol thresholds. ECG mandatory.'
      },
      {
        id: 'POL-004', name: 'Super Health Top-Up UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 70, refer: 55, decline_below: 40 },
          age_limits: { min: 18, max: 70 },
          sa_limits: { min: 500000, max: 50000000 },
          loading_overrides: { smoker_current: 50, bmi_obese_1: 30 },
          mandatory_tests: ['blood_work'],
          rule_overrides: {}
        },
        description: 'Relaxed UW — top-up sits above deductible so base risk is partially covered. Higher age limit (70), relaxed loading.'
      },
      {
        id: 'POL-005', name: 'Arogya Supreme UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 82, refer: 68, decline_below: 52 },
          age_limits: { min: 18, max: 65 },
          sa_limits: { min: 1000000, max: 50000000 },
          loading_overrides: { smoker_current: 100, bmi_obese_1: 50, bmi_obese_2: 100, cardiac_history: 100 },
          mandatory_tests: ['blood_work', 'ecg', 'urine_analysis', 'hematology'],
          rule_overrides: {}
        },
        description: 'Premium plan — moderately strict UW. SA up to 5Cr. Full blood panel + ECG + urine + CBC mandatory.'
      },
      {
        id: 'POL-006', name: 'Group Health UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 65, refer: 50, decline_below: 35 },
          age_limits: { min: 18, max: 70 },
          sa_limits: { min: 100000, max: 2000000 },
          loading_overrides: { smoker_current: 25, bmi_obese_1: 15 },
          mandatory_tests: [],
          rule_overrides: {
            'UG023': { disabled: true },
            'UG024': { disabled: true },
            'UG025': { disabled: true }
          },
          stp_eligible: true,
          stp_max_age: 50,
          stp_max_sa: 2000000
        },
        description: 'Relaxed group UW — STP-enabled up to full cap (SA 20L, age 50). Group risk spreading justifies broader STP eligibility.'
      },

      // ─── SBI Super Health Insurance — Prime Plan ─────────────────────────────
      {
        id: 'POL-007', name: 'Prime UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 75, refer: 55, decline_below: 40 },
          age_limits: { min: 0, max: 65 },
          sa_limits: { min: 300000, max: 2500000 },
          loading_overrides: { smoker_current: 75, bmi_obese_1: 50, bmi_obese_2: 100, diabetes_controlled: 50, hypertension_controlled: 25 },
          rule_overrides: {},
          stp_eligible: true,
          stp_max_age: 45,
          stp_max_sa: 1000000,
          waiting_periods: { diabetes: { years: 4 }, hypertension: { years: 4 }, cardiac: { years: 4 } },
          // ── CAT matrix from SBI Excel (age × SA → test type) ──────────────
          // SA Band 1: 3L, 5L, 7L, 10L (300000 – 1000000)
          // SA Band 2: 15L, 20L, 25L   (1500000 – 2500000)
          mandatory_tests: [
            // Band 1 — 3L to 10L
            { test_type: 'STP',      age_min: 0,  age_max: 55, sa_min: 300000,  sa_max: 1000000, description: 'Prime 3L-10L, age 91days-55 → STP' },
            { test_type: 'CAT_1',    age_min: 56,              sa_min: 300000,  sa_max: 1000000, description: 'Prime 3L-10L, age 56+ → CAT 1' },
            // Band 2 — 15L to 25L
            { test_type: 'STP',      age_min: 0,  age_max: 45, sa_min: 1500000, sa_max: 2500000, description: 'Prime 15L-25L, age 0-45 → STP' },
            { test_type: 'tele_mer', age_min: 46, age_max: 55, sa_min: 1500000, sa_max: 2500000, description: 'Prime 15L-25L, age 46-55 → Tele MER' },
            { test_type: 'CAT_1',    age_min: 56, age_max: 60, sa_min: 1500000, sa_max: 2500000, description: 'Prime 15L-25L, age 56-60 → CAT 1' },
            { test_type: 'CAT_2',    age_min: 61,              sa_min: 1500000, sa_max: 2500000, description: 'Prime 15L-25L, age 61+ → CAT 2' }
          ]
        },
        description: 'SBI Super Health Insurance — Prime Plan. STP up to age 45 and SA 10L. TeleMER for 15L-25L age 46-55. CAT 1 for age 56+ on lower bands.'
      },

      // ─── SBI Super Health Insurance — Elite Plan ─────────────────────────────
      {
        id: 'POL-008', name: 'Elite UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 78, refer: 58, decline_below: 42 },
          age_limits: { min: 0, max: 65 },
          sa_limits: { min: 300000, max: 2500000 },
          loading_overrides: { smoker_current: 75, bmi_obese_1: 50, bmi_obese_2: 100, diabetes_controlled: 50, hypertension_controlled: 25 },
          rule_overrides: {},
          stp_eligible: true,
          stp_max_age: 45,
          stp_max_sa: 1000000,
          waiting_periods: { diabetes: { years: 4 }, hypertension: { years: 4 }, cardiac: { years: 4 } },
          mandatory_tests: [
            // Band 1 — 3L to 10L (same as Prime)
            { test_type: 'STP',      age_min: 0,  age_max: 55, sa_min: 300000,  sa_max: 1000000, description: 'Elite 3L-10L, age 0-55 → STP' },
            { test_type: 'CAT_1',    age_min: 56,              sa_min: 300000,  sa_max: 1000000, description: 'Elite 3L-10L, age 56+ → CAT 1' },
            // Band 2 — 15L to 25L
            { test_type: 'STP',      age_min: 0,  age_max: 45, sa_min: 1500000, sa_max: 2500000, description: 'Elite 15L-25L, age 0-45 → STP' },
            { test_type: 'tele_mer', age_min: 46, age_max: 55, sa_min: 1500000, sa_max: 2500000, description: 'Elite 15L-25L, age 46-55 → Tele MER' },
            { test_type: 'CAT_1',    age_min: 56, age_max: 60, sa_min: 1500000, sa_max: 2500000, description: 'Elite 15L-25L, age 56-60 → CAT 1' },
            { test_type: 'CAT_2',    age_min: 61,              sa_min: 1500000, sa_max: 2500000, description: 'Elite 15L-25L, age 61+ → CAT 2' }
          ]
        },
        description: 'SBI Super Health Insurance — Elite Plan. Similar to Prime with slightly stricter score thresholds.'
      },

      // ─── SBI Super Health Insurance — Platinum Plan ──────────────────────────
      {
        id: 'POL-009', name: 'Platinum UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 80, refer: 62, decline_below: 46 },
          age_limits: { min: 0, max: 65 },
          sa_limits: { min: 1000000, max: 5000000 },
          loading_overrides: { smoker_current: 75, bmi_obese_1: 50, bmi_obese_2: 100, diabetes_controlled: 50, cardiac_history: 75 },
          rule_overrides: {},
          stp_eligible: true,
          stp_max_age: 45,
          stp_max_sa: 1000000,
          waiting_periods: { diabetes: { years: 4 }, hypertension: { years: 4 }, cardiac: { years: 4 } },
          mandatory_tests: [
            // Band 1 — 10L to 25L
            { test_type: 'STP',      age_min: 0,  age_max: 45, sa_min: 1000000, sa_max: 2500000, description: 'Platinum 10L-25L, age 0-45 → STP' },
            { test_type: 'tele_mer', age_min: 46, age_max: 50, sa_min: 1000000, sa_max: 2500000, description: 'Platinum 10L-25L, age 46-50 → Tele MER' },
            { test_type: 'CAT_1',    age_min: 51, age_max: 55, sa_min: 1000000, sa_max: 2500000, description: 'Platinum 10L-25L, age 51-55 → CAT 1' },
            { test_type: 'CAT_1',    age_min: 56, age_max: 60, sa_min: 1000000, sa_max: 2500000, description: 'Platinum 10L-25L, age 56-60 → CAT 1' },
            { test_type: 'CAT_2',    age_min: 61,              sa_min: 1000000, sa_max: 2500000, description: 'Platinum 10L-25L, age 61+ → CAT 2' },
            // Band 2 — 30L to 50L
            { test_type: 'STP',      age_min: 0,  age_max: 17, sa_min: 3000000, sa_max: 5000000, description: 'Platinum 30L-50L, age 0-17 → STP' },
            { test_type: 'CAT_1',    age_min: 18, age_max: 45, sa_min: 3000000, sa_max: 5000000, description: 'Platinum 30L-50L, age 18-45 → CAT 1' },
            { test_type: 'CAT_2',    age_min: 46,              sa_min: 3000000, sa_max: 5000000, description: 'Platinum 30L-50L, age 46+ → CAT 2' }
          ]
        },
        description: 'SBI Super Health Insurance — Platinum Plan. Higher SA band (10L-50L). TeleMER entry at age 46. CAT 1 for 51-60. CAT 2 for 61+.'
      },

      // ─── SBI Super Health Insurance — Premier Plan ───────────────────────────
      {
        id: 'POL-010', name: 'Premier UW Policy', version: '1.0',
        overrides: {
          score_thresholds: { approve: 78, refer: 60, decline_below: 44 },
          age_limits: { min: 0, max: 65 },
          sa_limits: { min: 300000, max: 1000000 },
          loading_overrides: { smoker_current: 75, bmi_obese_1: 50, bmi_obese_2: 100 },
          rule_overrides: {},
          stp_eligible: true,
          stp_max_age: 45,
          stp_max_sa: 1000000,
          waiting_periods: { diabetes: { years: 4 }, hypertension: { years: 4 } },
          mandatory_tests: [
            // Premier only has 3L-10L band
            { test_type: 'STP',   age_min: 0,  age_max: 55, sa_min: 300000, sa_max: 1000000, description: 'Premier 3L-10L, age 0-55 → STP' },
            { test_type: 'CAT_1', age_min: 56,              sa_min: 300000, sa_max: 1000000, description: 'Premier 3L-10L, age 56+ → CAT 1' }
          ]
        },
        description: 'SBI Super Health Insurance — Premier Plan. Entry-level plan SA 3L-10L. STP up to age 55. CAT 1 for age 56+.'
      }
    ];
    policiesConfig.forEach(p => { p.created_at = new Date().toISOString(); if (!p.status) p.status = 'active'; });
    s3Client.saveConfig('policies', policiesConfig).catch(e => console.error('Policies seed save error:', e.message));
  }

  // ── Always ensure correct SBI product-policy mapping ────────────────────────
  const SBI_MAP = {
    'PROD-007': 'POL-007',  // Prime            → Prime UW Policy
    'PROD-008': 'POL-008',  // Elite             → Elite UW Policy
    'PROD-009': 'POL-009',  // Platinum          → Platinum UW Policy
    'PROD-010': 'POL-010',  // Premier           → Premier UW Policy
    'PROD-011': 'POL-007',  // Platinum Infinite → Prime-like UW Policy
    'PROD-006': 'POL-006',  // Group Health      → Group Health UW Policy
  };
  const mapCorrect = Object.entries(SBI_MAP).every(([k,v]) => productPolicyMap[k] === v);
  if (!mapCorrect) {
    productPolicyMap = { ...productPolicyMap, ...SBI_MAP };
    await s3Client.saveConfig('product-policy-map', productPolicyMap).catch(e => console.error('Mapping seed error:', e.message));
    console.log('[Startup] ✅ SBI product-policy map updated: Prime→POL-007, Elite→POL-008, Platinum→POL-009, Premier→POL-010');
  }
  console.log(`[Startup] Products: ${productsConfig.length}, Policies: ${policiesConfig.length}, Mappings: ${Object.keys(productPolicyMap).length}`);
}

// Products CRUD
app.get('/api/products', requireAuth, (req, res) => res.json(productsConfig));
app.post('/api/products', requireRole('Super Admin'), async (req, res) => {
  try {
    const { name, code, type, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name required' });
    if (productsConfig.find(p => p.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Product already exists' });
    const product = { id: `PROD-${String(productsConfig.length + 1).padStart(3,'0')}`, name, code: code || name.substring(0,3).toUpperCase(), type: type || 'health', description: description || '', status: 'active', created_at: new Date().toISOString() };
    productsConfig.push(product);
    await s3Client.saveConfig('products', productsConfig);
    res.json({ success: true, product });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/products/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const product = productsConfig.find(p => p.id === req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const { name, code, type, description, status, plan_var, product_code, _ver } = req.body;
    if (name) product.name = name;
    if (code) product.code = code;
    if (type) product.type = type;
    if (description !== undefined) product.description = description;
    if (status) product.status = status;
    if (plan_var) product.plan_var = plan_var;
    if (product_code) product.product_code = product_code;
    if (_ver) product._ver = _ver;
    product.updated_at = new Date().toISOString();
    await s3Client.saveConfig('products', productsConfig);
    res.json({ success: true, product });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const idx = productsConfig.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Product not found' });
    productsConfig.splice(idx, 1);
    // Remove from policy map too
    for (const [k, v] of Object.entries(productPolicyMap)) {
      if (k === req.params.id) delete productPolicyMap[k];
    }
    await s3Client.saveConfig('products', productsConfig);
    await s3Client.saveConfig('product-policy-map', productPolicyMap);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Policies CRUD
app.get('/api/policies', requireAuth, (req, res) => res.json(policiesConfig));
app.post('/api/policies', requireRole('Super Admin'), async (req, res) => {
  try {
    const { name, version, description, overrides } = req.body;
    if (!name) return res.status(400).json({ error: 'Policy name required' });
    const policy = {
      id: `POL-${String(policiesConfig.length + 1).padStart(3,'0')}`,
      name, version: version || '1.0', description: description || '', status: 'active',
      overrides: overrides || {
        score_thresholds: { approve: 80, refer: 65, decline_below: 50 },
        loading_overrides: {},
        rule_overrides: {},
        age_limits: { min: 18, max: 65 },
        sa_limits: { min: 100000, max: 50000000 },
        mandatory_tests: [],
        exclusion_text: ''
      },
      created_at: new Date().toISOString()
    };
    policiesConfig.push(policy);
    await s3Client.saveConfig('policies', policiesConfig);
    res.json({ success: true, policy });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/policies/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const policy = policiesConfig.find(p => p.id === req.params.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    const { name, version, description, status, overrides } = req.body;
    if (name) policy.name = name;
    if (version) policy.version = version;
    if (description !== undefined) policy.description = description;
    if (status) policy.status = status;
    if (overrides) policy.overrides = { ...policy.overrides, ...overrides };
    policy.updated_at = new Date().toISOString();
    await s3Client.saveConfig('policies', policiesConfig);
    res.json({ success: true, policy });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/policies/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    // Remove from mappings first
    for (const [prodId, polId] of Object.entries(productPolicyMap)) {
      if (polId === req.params.id) delete productPolicyMap[prodId];
    }
    policiesConfig = policiesConfig.filter(p => p.id !== req.params.id);
    await s3Client.saveConfig('policies', policiesConfig);
    await s3Client.saveConfig('product-policy-map', productPolicyMap);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Product-Policy Mapping
app.get('/api/product-policy-map', requireAuth, (req, res) => res.json(productPolicyMap));

// ── Module 2: Per-CAT scoring thresholds (editable from Masters Config) ────────
app.get('/api/cat-scoring', requireAuth, (req, res) => {
  const merged = (catScoringConfig && catScoringConfig.CAT_1) ? catScoringConfig : buildDefaultCatScoring();
  res.json(merged);
});

// Save full config — validates dynamic component/factor structure
app.post('/api/cat-scoring', requireRole('Super Admin'), async (req, res) => {
  try {
    const incoming = req.body || {};
    const VALID_CATS = ['CAT_1','CAT_2','CAT_3','CAT_4','tele_mer'];
    for (const [cat, cfg] of Object.entries(incoming)) {
      if (!VALID_CATS.includes(cat)) return res.status(400).json({ error: `Unknown CAT level: ${cat}` });
      // Validate thresholds
      if (cfg.thresholds) {
        const { approve, refer, decline_below } = cfg.thresholds;
        if ([approve, refer, decline_below].some(v => typeof v !== 'number' || v < 0 || v > 100))
          return res.status(400).json({ error: `${cat}: thresholds must be numbers 0–100` });
        if (!(approve > refer && refer > decline_below))
          return res.status(400).json({ error: `${cat}: approve > refer > decline required (got ${approve} > ${refer} > ${decline_below})` });
      }
      // Validate components: weights sum to 100, each factor has valid max + bands
      if (cfg.components) {
        const comps = cfg.components;
        const weightSum = Object.values(comps).reduce((s,c)=> s + (Number(c.weight)||0), 0);
        if (weightSum !== 100) return res.status(400).json({ error: `${cat}: component weights must sum to 100 (got ${weightSum})` });
        for (const [cKey, comp] of Object.entries(comps)) {
          if (!Array.isArray(comp.factors)) return res.status(400).json({ error: `${cat}.${cKey}: factors must be a list` });
          for (const f of comp.factors) {
            if (!f.id || !f.label) return res.status(400).json({ error: `${cat}.${cKey}: each factor needs id and label` });
            if (typeof f.max !== 'number' || f.max <= 0) return res.status(400).json({ error: `${cat}.${cKey}.${f.label}: max must be a positive number` });
            if (!Array.isArray(f.bands) || f.bands.length === 0) return res.status(400).json({ error: `${cat}.${cKey}.${f.label}: needs at least one scoring band` });
            for (const b of f.bands) {
              if (typeof b.points !== 'number' || b.points < 0 || b.points > f.max)
                return res.status(400).json({ error: `${cat}.${cKey}.${f.label}: band "${b.label}" points must be 0–${f.max}` });
            }
          }
          // Factor maxes inside a component must total that component's weight
          const factorMaxSum = comp.factors.reduce((s,f)=> s + (Number(f.max)||0), 0);
          const compWeight = Number(comp.weight)||0;
          if (Math.abs(factorMaxSum - compWeight) >= 0.001)
            return res.status(400).json({ error: `${cat}.${cKey}: factor maxes total ${factorMaxSum} but component weight is ${compWeight} — they must be equal` });
        }
      }
    }
    // Merge per CAT
    for (const [cat, cfg] of Object.entries(incoming)) {
      catScoringConfig[cat] = { ...(catScoringConfig[cat] || {}), ...cfg, _version: SCORING_VERSION };
    }
    await s3Client.saveConfig('cat-scoring', catScoringConfig);
    console.log('[CAT Scoring] Saved by', req.user?.email);
    res.json({ success: true, cat_scoring: catScoringConfig });
  } catch(e) { console.error('CAT scoring save error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/cat-scoring/reset', requireRole('Super Admin'), async (req, res) => {
  try {
    catScoringConfig = buildDefaultCatScoring();
    await s3Client.saveConfig('cat-scoring', catScoringConfig);
    res.json({ success: true, cat_scoring: catScoringConfig });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Diagnostic: test product scoring config lookup
app.get('/api/debug/product-config/:productName', requireAuth, (req, res) => {
  const productName = decodeURIComponent(req.params.productName);
  const product = productsConfig.find(p => p.name === productName && (p.status === 'active' || !p.status));
  if (!product) return res.json({ error: 'Product not found', productName, available_products: productsConfig.map(p => ({ id: p.id, name: p.name, status: p.status })) });
  const policyId = productPolicyMap[product.id];
  if (!policyId) return res.json({ error: 'No policy mapping', product_id: product.id, product_name: product.name, all_mappings: productPolicyMap });
  const policy = policiesConfig.find(p => p.id === policyId && (p.status === 'active' || !p.status));
  if (!policy) return res.json({ error: 'Policy not found', product_id: product.id, policy_id: policyId, available_policies: policiesConfig.map(p => ({ id: p.id, name: p.name, status: p.status })) });
  res.json({ success: true, product: { id: product.id, name: product.name }, policy: { id: policy.id, name: policy.name }, mandatory_tests: policy.overrides?.mandatory_tests || [], score_thresholds: policy.overrides?.score_thresholds || {}, loading_overrides: policy.overrides?.loading_overrides || {} });
});

app.put('/api/product-policy-map', requireRole('Super Admin'), async (req, res) => {
  try {
    const { mappings } = req.body;
    if (!mappings || typeof mappings !== 'object') return res.status(400).json({ error: 'mappings object required' });
    productPolicyMap = mappings;
    await s3Client.saveConfig('product-policy-map', productPolicyMap);
    res.json({ success: true, mappings: productPolicyMap });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Helper: get merged config for a product
function getProductScoringConfig(productName) {
  const product = productsConfig.find(p => p.name === productName && (p.status === 'active' || !p.status));
  if (!product) return null;
  const policyId = productPolicyMap[product.id];
  if (!policyId) return null;
  const policy = policiesConfig.find(p => p.id === policyId && (p.status === 'active' || !p.status));
  if (!policy) return null;
  return { product, policy, overrides: policy.overrides || {} };
}

// ─── resolveCAT ──────────────────────────────────────────────────────────────
// Takes age, sumAssured and policy overrides → returns the correct CAT level
// Rules are stored in policy.overrides.mandatory_tests as an array of objects:
//   { test_type, age_min, age_max, sa_min, sa_max, ped_required }
// Falls back to flat string array for backward compatibility.
function resolveCAT(age, sumAssured, overrides, hasPED = false) {
  const tests = overrides?.mandatory_tests || [];
  if (!tests.length) return { cat: 'STP', reason: 'No mandatory test rules configured' };

  // Backward compat — old flat string array like ['blood_work', 'ecg']
  if (typeof tests[0] === 'string') {
    return { cat: 'CAT_1', reason: 'Legacy flat test list — defaulting to CAT 1', tests };
  }

  // PED is always a hard override — if declared, skip TeleMER, go straight to CAT
  if (hasPED) {
    // Find the lowest CAT rule that matches age+SA (ignore tele_mer for PED cases)
    const pedRules = tests.filter(r => {
      const ageOk = (r.age_min === undefined || age >= r.age_min) &&
                    (r.age_max === undefined || age <= r.age_max);
      const saOk  = (r.sa_min === undefined || sumAssured >= r.sa_min) &&
                    (r.sa_max === undefined || sumAssured <= r.sa_max);
      return ageOk && saOk && r.test_type !== 'STP' && r.test_type !== 'tele_mer';
    });
    if (pedRules.length) {
      const rule = pedRules[0];
      return {
        cat: rule.test_type,
        reason: `PED declared — TeleMER skipped. Age ${age}, SA ₹${(sumAssured/100000).toFixed(0)}L → ${rule.test_type}`,
        rule
      };
    }
    // PED declared but no CAT rule found — default to CAT_1
    return { cat: 'CAT_1', reason: `PED declared — no matching rule, defaulting to CAT 1` };
  }

  // Normal flow — find first matching rule for this age + SA
  for (const rule of tests) {
    const ageOk = (rule.age_min === undefined || age >= rule.age_min) &&
                  (rule.age_max === undefined || age <= rule.age_max);
    const saOk  = (rule.sa_min === undefined || sumAssured >= rule.sa_min) &&
                  (rule.sa_max === undefined || sumAssured <= rule.sa_max);
    if (ageOk && saOk) {
      return {
        cat: rule.test_type,
        reason: `Age ${age} in [${rule.age_min||0}–${rule.age_max||'∞'}], SA ₹${(sumAssured/100000).toFixed(0)}L in [₹${((rule.sa_min||0)/100000).toFixed(0)}L–₹${((rule.sa_max||99999999)/100000).toFixed(0)}L] → ${rule.test_type}`,
        rule
      };
    }
  }

  // No rule matched — default STP
  return { cat: 'STP', reason: `No rule matched age ${age} + SA ₹${(sumAssured/100000).toFixed(0)}L — defaulting to STP` };
}

// ─── Premium Calculation & Policy Issuance ───

let policyCounter = 0; // Persisted to S3
let premiumRates = {};
const premiumRatesPath = path.join(__dirname, 'config', 'premium-rates.json');
try {
  premiumRates = JSON.parse(fs.readFileSync(premiumRatesPath, 'utf8'));
  console.log(`[Premium] Loaded rate tables from ${premiumRatesPath} — ${Object.keys(premiumRates.products || {}).length} products`);
} catch(e) {
  console.error(`[Premium] Rate table load FAILED from ${premiumRatesPath}:`, e.message);
  // Inline fallback for Arogya Sanjeevani so premium calc works even if file is missing
  premiumRates = { gst_rate: 18, products: {
    'Arogya Sanjeevani': { code:'AS', sa_options:[100000,200000,300000,500000], rates: {
      '18-25':{100000:{M:3200,F:3000},200000:{M:4800,F:4500},300000:{M:6200,F:5800},500000:{M:8500,F:8000}},
      '26-35':{100000:{M:3800,F:3600},200000:{M:5600,F:5300},300000:{M:7200,F:6800},500000:{M:9800,F:9200}},
      '36-45':{100000:{M:5200,F:4900},200000:{M:7800,F:7400},300000:{M:10200,F:9600},500000:{M:14000,F:13200}},
      '46-55':{100000:{M:8500,F:8000},200000:{M:12800,F:12000},300000:{M:16500,F:15500},500000:{M:22000,F:20800}},
      '56-65':{100000:{M:14000,F:13200},200000:{M:21000,F:19800},300000:{M:27000,F:25500},500000:{M:36000,F:34000}}
    }},
    'Arogya Premier': { code:'AP', sa_options:[300000,500000,1000000,1500000,2500000,5000000,10000000], rates: {
      '18-25':{300000:{M:5500,F:5200},500000:{M:7800,F:7400},1000000:{M:12000,F:11300},1500000:{M:15000,F:14200},2500000:{M:19500,F:18400},5000000:{M:28000,F:26400},10000000:{M:42000,F:39600}},
      '26-35':{300000:{M:6500,F:6100},500000:{M:9200,F:8700},1000000:{M:14200,F:13400},1500000:{M:17800,F:16800},2500000:{M:23000,F:21700},5000000:{M:33000,F:31200},10000000:{M:49500,F:46800}},
      '36-45':{300000:{M:9000,F:8500},500000:{M:12800,F:12100},1000000:{M:19500,F:18400},1500000:{M:24500,F:23100},2500000:{M:32000,F:30200},5000000:{M:46000,F:43400},10000000:{M:69000,F:65100}},
      '46-55':{300000:{M:14500,F:13700},500000:{M:19200,F:18100},1000000:{M:29500,F:27800},1500000:{M:37000,F:34900},2500000:{M:48000,F:45300},5000000:{M:69000,F:65100},10000000:{M:103500,F:97700}},
      '56-65':{300000:{M:22000,F:20800},500000:{M:29000,F:27400},1000000:{M:44500,F:42000},1500000:{M:55800,F:52700},2500000:{M:72500,F:68400},5000000:{M:104000,F:98200},10000000:{M:156000,F:147200}}
    }},
    'Critical Illness': { code:'CI', sa_options:[500000,1000000,2500000,5000000,10000000,25000000], rates: {
      '18-25':{500000:{M:2800,F:2600},1000000:{M:4500,F:4200},2500000:{M:8500,F:7900},5000000:{M:14000,F:13000},10000000:{M:24000,F:22300},25000000:{M:52000,F:48400}},
      '26-35':{500000:{M:3500,F:3300},1000000:{M:5800,F:5400},2500000:{M:11000,F:10200},5000000:{M:18000,F:16700},10000000:{M:31000,F:28800},25000000:{M:67000,F:62300}},
      '36-45':{500000:{M:5500,F:5100},1000000:{M:9200,F:8600},2500000:{M:17500,F:16300},5000000:{M:29000,F:27000},10000000:{M:50000,F:46500},25000000:{M:108000,F:100400}},
      '46-55':{500000:{M:9500,F:8800},1000000:{M:16000,F:14900},2500000:{M:30500,F:28400},5000000:{M:50000,F:46500},10000000:{M:86000,F:80000},25000000:{M:186000,F:173000}},
      '56-60':{500000:{M:15000,F:14000},1000000:{M:25000,F:23300},2500000:{M:48000,F:44600},5000000:{M:78000,F:72500},10000000:{M:134000,F:124600},25000000:{M:290000,F:269700}}
    }},
    'Super Health Top-Up': { code:'SHTU', sa_options:[500000,1000000,2500000,5000000], rates: {
      '18-25':{500000:{M:1800,F:1700},1000000:{M:2500,F:2400},2500000:{M:4200,F:4000},5000000:{M:6500,F:6100}},
      '26-35':{500000:{M:2200,F:2100},1000000:{M:3200,F:3000},2500000:{M:5200,F:4900},5000000:{M:8000,F:7500}},
      '36-45':{500000:{M:3500,F:3300},1000000:{M:5000,F:4700},2500000:{M:8200,F:7700},5000000:{M:12800,F:12100}},
      '46-55':{500000:{M:5500,F:5200},1000000:{M:8000,F:7500},2500000:{M:13000,F:12300},5000000:{M:20000,F:18900}},
      '56-65':{500000:{M:8500,F:8000},1000000:{M:12500,F:11800},2500000:{M:20000,F:18900},5000000:{M:31000,F:29200}}
    }},
    'Arogya Supreme': { code:'ASU', sa_options:[1000000,2500000,5000000,10000000], rates: {
      '18-25':{1000000:{M:14000,F:13200},2500000:{M:22000,F:20800},5000000:{M:32000,F:30200},10000000:{M:48000,F:45300}},
      '26-35':{1000000:{M:16500,F:15600},2500000:{M:26000,F:24500},5000000:{M:38000,F:35900},10000000:{M:57000,F:53800}},
      '36-45':{1000000:{M:22000,F:20800},2500000:{M:35000,F:33000},5000000:{M:51000,F:48100},10000000:{M:76000,F:71700}},
      '46-55':{1000000:{M:33000,F:31200},2500000:{M:52000,F:49100},5000000:{M:76000,F:71700},10000000:{M:114000,F:107600}},
      '56-65':{1000000:{M:50000,F:47200},2500000:{M:79000,F:74600},5000000:{M:115000,F:108500},10000000:{M:172000,F:162300}}
    }},
    'Group Health': { code:'GH', sa_options:[100000,200000,300000,500000,1000000], rates: {
      '18-25':{100000:{M:1200,F:1100},200000:{M:1800,F:1700},300000:{M:2400,F:2300},500000:{M:3200,F:3000},1000000:{M:5000,F:4700}},
      '26-35':{100000:{M:1500,F:1400},200000:{M:2200,F:2100},300000:{M:2900,F:2700},500000:{M:3900,F:3700},1000000:{M:6100,F:5800}},
      '36-45':{100000:{M:2200,F:2100},200000:{M:3200,F:3000},300000:{M:4200,F:4000},500000:{M:5600,F:5300},1000000:{M:8800,F:8300}},
      '46-55':{100000:{M:3500,F:3300},200000:{M:5200,F:4900},300000:{M:6800,F:6400},500000:{M:9000,F:8500},1000000:{M:14000,F:13200}},
      '56-65':{100000:{M:5500,F:5200},200000:{M:8200,F:7700},300000:{M:10700,F:10100},500000:{M:14200,F:13400},1000000:{M:22000,F:20800}}
    }}
  }};
}

function getAgeBandForPremium(age) {
  if (age <= 25) return '18-25';
  if (age <= 35) return '26-35';
  if (age <= 45) return '36-45';
  if (age <= 55) return '46-55';
  if (age <= 65) return '56-65';
  return '66-70';
}

function findAgeBandInRates(rates, age) {
  const primary = getAgeBandForPremium(age);
  if (rates[primary]) return primary;
  // Try alternative band formats
  const alternatives = ['56-60', '56-65', '61-65', '66-70'];
  if (age > 55 && age <= 60) {
    for (const alt of ['56-60', '56-65']) { if (rates[alt]) return alt; }
  }
  if (age > 60 && age <= 65) {
    for (const alt of ['56-65', '61-65']) { if (rates[alt]) return alt; }
  }
  // Fallback to closest available band
  const allBands = Object.keys(rates);
  return allBands[allBands.length - 1] || primary;
}

function findNearestSA(saOptions, targetSA) {
  // Find the smallest SA option >= targetSA, or the largest if none are bigger
  const sorted = saOptions.map(Number).sort((a, b) => a - b);
  return sorted.find(s => s >= targetSA) || sorted[sorted.length - 1];
}

function calculatePremium(productName, age, gender, sumAssured, loadingPct) {
  const productRates = premiumRates.products?.[productName];
  if (!productRates) return null;

  const ageBand = findAgeBandInRates(productRates.rates || {}, age);
  const genderKey = (gender || '').toLowerCase().startsWith('f') ? 'F' : 'M';
  const nearestSA = findNearestSA(productRates.sa_options || [], sumAssured);
  const bandRates = productRates.rates?.[ageBand];
  if (!bandRates) return null;
  return calcPremiumFromRate(bandRates, nearestSA, genderKey, loadingPct, productName, age, ageBand);
}

function calcPremiumFromRate(bandRates, nearestSA, genderKey, loadingPct, productName, age, ageBand) {
  const saRates = bandRates[String(nearestSA)];
  if (!saRates) return null;
  const basePremium = saRates[genderKey] || saRates['M']; // Fallback to male rate
  if (!basePremium) return null;

  const loading = loadingPct || 0;
  const loadingAmount = Math.round(basePremium * loading / 100);
  const loadedPremium = basePremium + loadingAmount;
  const gstRate = premiumRates.gst_rate || 18;
  const gstAmount = Math.round(loadedPremium * gstRate / 100);
  const totalPremium = loadedPremium + gstAmount;

  return {
    product: productName, age_band: ageBand, gender: genderKey === 'F' ? 'Female' : 'Male',
    sum_assured: nearestSA, base_premium: basePremium,
    loading_pct: loading, loading_amount: loadingAmount,
    loaded_premium: loadedPremium, gst_rate: gstRate, gst_amount: gstAmount,
    total_annual_premium: totalPremium
  };
}

// GET /api/premium/calculate — calculate premium for given parameters
app.get('/api/premium/calculate', requireAuth, (req, res) => {
  const { product, age, gender, sum_assured, loading } = req.query;
  if (!product || !age) return res.status(400).json({ error: 'product and age required' });
  const result = calculatePremium(product, parseInt(age), gender || 'male', parseInt(sum_assured) || 500000, parseInt(loading) || 0);
  if (!result) return res.status(404).json({ error: 'No premium rate found for this combination' });
  res.json(result);
});

// GET /api/premium/rates — return all rate tables
app.get('/api/premium/rates', requireAuth, (req, res) => res.json(premiumRates));

// POST /api/workflow/:id/calculate-premium — calculate and store premium on workflow
app.post('/api/workflow/:id/calculate-premium', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const loading = req.body.loading_pct ?? wf.ai_analysis?.loading_percentage ?? 0;
  console.log(`[Premium] Calculating for: product='${wf.product_name}', age=${wf.age}, gender='${wf.gender}', SA=${wf.sum_assured}, loading=${loading}`);
  const result = calculatePremium(wf.product_name, wf.age || 35, wf.gender || 'male', wf.sum_assured || 500000, loading);
  if (!result) {
    const productRates = premiumRates.products?.[wf.product_name];
    const ageBand = findAgeBandInRates(productRates?.rates || {}, wf.age || 35);
    const nearestSA = productRates ? findNearestSA(productRates.sa_options || [], wf.sum_assured || 500000) : null;
    console.log(`[Premium] FAILED — productFound=${!!productRates}, ageBand=${ageBand}, nearestSA=${nearestSA}`);
    return res.status(400).json({ error: `No premium rate found. Product: ${wf.product_name}, Age: ${wf.age} (band: ${ageBand}), SA: ${wf.sum_assured} (nearest: ${nearestSA}), Gender: ${wf.gender}` });
  }
  if (wf.ai_analysis?.loading_factors?.length) result.loading_breakdown = wf.ai_analysis.loading_factors;
  if (wf.ai_analysis?.exclusions?.length) result.exclusions = wf.ai_analysis.exclusions;
  if (wf.ai_analysis?.waiting_periods) result.waiting_periods = wf.ai_analysis.waiting_periods;
  wf.premium_calculation = result;
  workflowEngine.updateWorkflow(wf.id, wf);
  res.json(result);
});
// GET fallback for calculate-premium
app.get('/api/workflow/:id/calculate-premium', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const loading = parseInt(req.query.loading) || wf.ai_analysis?.loading_percentage || 0;
  const result = calculatePremium(wf.product_name, wf.age || 35, wf.gender || 'male', wf.sum_assured || 500000, loading);
  if (!result) return res.status(400).json({ error: `No premium rate found for ${wf.product_name}` });
  if (wf.ai_analysis?.loading_factors?.length) result.loading_breakdown = wf.ai_analysis.loading_factors;
  wf.premium_calculation = result;
  workflowEngine.updateWorkflow(wf.id, wf);
  res.json(result);
});

// POST /api/workflow/:id/counter-offer-send — send counter-offer terms to customer
app.post('/api/workflow/:id/counter-offer-send', requireAuth, async (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });

    // Calculate premium if not already done
    if (!wf.premium_calculation) {
      const loading = wf.ai_analysis?.loading_percentage || 0;
      const premResult = calculatePremium(wf.product_name, wf.age || 35, wf.gender || 'male', wf.sum_assured || 500000, loading);
      if (premResult) wf.premium_calculation = premResult;
    }

    // Generate counter-offer token
    const token = `CO-${wf.id.substring(0, 8)}-${Date.now().toString(36)}`;
    const deadlineDays = parseInt(req.body.deadline_days) || 15;

    wf.counter_offer = {
      token,
      sent_at: new Date().toISOString(),
      deadline: new Date(Date.now() + deadlineDays * 86400000).toISOString(),
      deadline_days: deadlineDays,
      status: 'pending', // pending, accepted, rejected, expired
      premium: wf.premium_calculation,
      loading_pct: wf.ai_analysis?.loading_percentage || 0,
      loading_factors: wf.ai_analysis?.loading_factors || [],
      exclusions: wf.ai_analysis?.exclusions || [],
      waiting_periods: wf.ai_analysis?.waiting_periods || {},
      sent_by: req.user?.email || 'system'
    };

    wf.state_history.push({ state: 'counter_offer_sent', timestamp: new Date().toISOString(), actor: req.user?.email || 'system', note: `Counter-offer sent. Deadline: ${deadlineDays} days. Token: ${token}` });
    workflowEngine.updateWorkflow(wf.id, wf);

    // Send notification
    commsEngine.sendNotification('counter_offer', {
      proposer_name: wf.proposer_name, proposal_id: wf.proposal_id,
      product_name: wf.product_name, sum_assured: (wf.sum_assured || 0).toLocaleString('en-IN'),
      loading_percentage: wf.counter_offer.loading_pct,
      total_premium: wf.premium_calculation?.total_annual_premium?.toLocaleString('en-IN') || 'N/A',
      acceptance_link: `${req.headers.origin || 'https://insuranceuw.acc.ltd'}/counter-offer?token=${token}`,
      deadline: new Date(wf.counter_offer.deadline).toLocaleDateString('en-IN'),
      email: req.body.email || 'customer@example.com'
    }, ['email', 'sms']);

    res.json({ success: true, token, deadline: wf.counter_offer.deadline, premium: wf.premium_calculation });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/counter-offer-latest — returns the most recent counter-offer (demo shortcut, no auth)
app.get('/api/counter-offer-latest', (req, res) => {
  const allWfs = workflowEngine.listWorkflows({});
  const coWfs = allWfs.filter(w => w.counter_offer?.token).sort((a, b) => new Date(b.counter_offer.sent_at || 0) - new Date(a.counter_offer.sent_at || 0));
  if (coWfs.length === 0) return res.status(404).json({ error: 'No counter-offers found. Send a counter-offer from the Premium & Issuance tab first.' });

  // Check each for expiry
  for (const w of coWfs) {
    if (new Date(w.counter_offer.deadline) < new Date() && w.counter_offer.status === 'pending') {
      w.counter_offer.status = 'expired';
      workflowEngine.updateWorkflow(w.id, w);
    }
  }

  // Priority: pending first, then most recent regardless
  const pending = coWfs.find(w => w.counter_offer.status === 'pending');
  const wf = pending || coWfs[0]; // Fallback to most recent (even if accepted/expired — for demo visibility)

  console.log(`[Counter-Offer Latest] Found ${coWfs.length} offers. Returning: ${wf.proposal_id} (status: ${wf.counter_offer.status}, token: ${wf.counter_offer.token}, sent: ${wf.counter_offer.sent_at})`);
  res.json({
    token: wf.counter_offer.token,
    proposal_id: wf.proposal_id, proposer_name: wf.proposer_name,
    product_name: wf.product_name, sum_assured: wf.sum_assured,
    status: wf.counter_offer.status, deadline: wf.counter_offer.deadline,
    premium: wf.counter_offer.premium,
    loading_pct: wf.counter_offer.loading_pct,
    loading_factors: wf.counter_offer.loading_factors,
    exclusions: wf.counter_offer.exclusions,
    waiting_periods: wf.counter_offer.waiting_periods
  });
});

// GET /api/counter-offer/:token — customer-facing (no auth required)
app.get('/api/counter-offer/:token', (req, res) => {
  const allWfs = workflowEngine.listWorkflows({});
  const wf = allWfs.find(w => w.counter_offer?.token === req.params.token);
  if (!wf) return res.status(404).json({ error: 'Counter-offer not found or expired' });

  // Check expiry
  if (new Date(wf.counter_offer.deadline) < new Date() && wf.counter_offer.status === 'pending') {
    wf.counter_offer.status = 'expired';
    workflowEngine.updateWorkflow(wf.id, wf);
  }

  res.json({
    proposal_id: wf.proposal_id, proposer_name: wf.proposer_name,
    product_name: wf.product_name, sum_assured: wf.sum_assured,
    status: wf.counter_offer.status, deadline: wf.counter_offer.deadline,
    premium: wf.counter_offer.premium,
    loading_pct: wf.counter_offer.loading_pct,
    loading_factors: wf.counter_offer.loading_factors,
    exclusions: wf.counter_offer.exclusions,
    waiting_periods: wf.counter_offer.waiting_periods
  });
});

// POST /api/counter-offer/:token/respond — customer accepts or rejects (no auth)
app.post('/api/counter-offer/:token/respond', (req, res) => {
  const { decision } = req.body; // 'accept' or 'reject'
  if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be accept or reject' });

  const allWfs = workflowEngine.listWorkflows({});
  const wf = allWfs.find(w => w.counter_offer?.token === req.params.token);
  if (!wf) return res.status(404).json({ error: 'Counter-offer not found' });
  if (wf.counter_offer.status !== 'pending') return res.status(400).json({ error: `Counter-offer already ${wf.counter_offer.status}` });
  if (new Date(wf.counter_offer.deadline) < new Date()) return res.status(400).json({ error: 'Counter-offer has expired' });

  wf.counter_offer.status = decision === 'accept' ? 'accepted' : 'rejected';
  wf.counter_offer.responded_at = new Date().toISOString();

  const newState = decision === 'accept' ? 'counter_offer_accepted' : 'counter_offer_rejected';
  wf.state_history.push({ state: newState, timestamp: new Date().toISOString(), actor: 'customer', note: `Customer ${decision}ed the counter-offer` });

  if (decision === 'accept') {
    // Transition workflow — ready for payment and policy issuance
    try { workflowEngine.transitionState(wf.id, 'counter_offer_accepted', 'customer', 'Counter-offer accepted by customer'); } catch(e) { /* State may not be in valid transitions — just record in history */ }
  } else {
    try { workflowEngine.transitionState(wf.id, 'counter_offer_rejected', 'customer', 'Counter-offer rejected by customer'); } catch(e) { }
  }

  workflowEngine.updateWorkflow(wf.id, wf);

  socketManager.emitGlobal('counter_offer_response', { workflow_id: wf.id, proposal_id: wf.proposal_id, proposer_name: wf.proposer_name, decision });

  res.json({ success: true, status: wf.counter_offer.status });
});

// POST /api/workflow/:id/confirm-payment — mark payment as received
app.post('/api/workflow/:id/confirm-payment', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });

  wf.payment = {
    confirmed: true, confirmed_at: new Date().toISOString(), confirmed_by: req.user?.email || 'admin',
    amount: req.body.amount || wf.premium_calculation?.total_annual_premium || 0,
    mode: req.body.mode || 'online', reference: req.body.reference || ''
  };
  wf.state_history.push({ state: 'payment_confirmed', timestamp: new Date().toISOString(), actor: req.user?.email || 'admin', note: `Payment ₹${wf.payment.amount.toLocaleString('en-IN')} confirmed via ${wf.payment.mode}` });
  workflowEngine.updateWorkflow(wf.id, wf);
  res.json({ success: true, payment: wf.payment });
});

// POST /api/workflow/:id/issue-policy — generate policy number and issue
app.post('/api/workflow/:id/issue-policy', requireAuth, async (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });

    // Validate state — must be approved or counter-offer accepted
    const issuableStates = ['auto_approved', 'uw_approved', 'counter_offer_accepted', 'auto_issued'];
    if (!issuableStates.includes(wf.state) && !wf.payment?.confirmed) {
      // Allow if payment is confirmed regardless of state
      if (!wf.payment?.confirmed) return res.status(400).json({ error: `Cannot issue policy in state: ${wf.state}. Must be approved/accepted with payment confirmed.` });
    }

    // Load policy counter from S3
      try {
        const counterData = await s3Client.getConfig('policy-counter');
        if (counterData?.counter) policyCounter = counterData.counter;
      } catch(e) { /* Start from 0 */ }

    // Generate policy number
    policyCounter++;
    const productCode = premiumRates.products?.[wf.product_name]?.code || 'H';
    const year = new Date().getFullYear();
    const seq = String(policyCounter).padStart(6, '0');
    const policyNumber = `SBIG/${productCode}/${year}/${seq}`;

    // Calculate premium if not done
    if (!wf.premium_calculation) {
      wf.premium_calculation = calculatePremium(wf.product_name, wf.age, wf.gender, wf.sum_assured, wf.ai_analysis?.loading_percentage || 0);
    }

    // Set policy details
    const effectiveDate = new Date();
    const expiryDate = new Date(effectiveDate);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    wf.policy = {
      policy_number: policyNumber,
      issued_at: new Date().toISOString(),
      issued_by: req.user?.email || 'system',
      effective_date: effectiveDate.toISOString().split('T')[0],
      expiry_date: expiryDate.toISOString().split('T')[0],
      product: wf.product_name,
      sum_assured: wf.sum_assured,
      premium: wf.premium_calculation,
      loading_pct: wf.ai_analysis?.loading_percentage || 0,
      exclusions: wf.ai_analysis?.exclusions || [],
      waiting_periods: wf.ai_analysis?.waiting_periods || {},
      status: 'active'
    };

    wf.policy_number = policyNumber;

    // Transition state
    wf.state_history.push({ state: 'policy_issued', timestamp: new Date().toISOString(), actor: req.user?.email || 'system', note: `Policy ${policyNumber} issued. Effective: ${wf.policy.effective_date} to ${wf.policy.expiry_date}. Premium: ₹${wf.premium_calculation?.total_annual_premium?.toLocaleString('en-IN')||'N/A'}/year` });
    try { workflowEngine.transitionState(wf.id, 'policy_issued', req.user?.email || 'system', `Policy issued: ${policyNumber}`); } catch(e) { /* Already in terminal state — just update */ }

    workflowEngine.updateWorkflow(wf.id, wf);

    // Save counter to S3
      s3Client.saveConfig('policy-counter', { counter: policyCounter }).catch(e => console.error('Policy counter save error:', e.message));

    // Send notification
    commsEngine.sendNotification('policy_issued', {
      proposer_name: wf.proposer_name, proposal_id: wf.proposal_id,
      policy_number: policyNumber, product_name: wf.product_name,
      sum_assured: (wf.sum_assured || 0).toLocaleString('en-IN'),
      premium: wf.premium_calculation?.total_annual_premium?.toLocaleString('en-IN') || 'N/A',
      effective_date: wf.policy.effective_date,
      expiry_date: wf.policy.expiry_date,
      email: req.body.email || 'customer@example.com'
    }, ['email', 'sms']);

    res.json({ success: true, policy_number: policyNumber, policy: wf.policy });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Diagnostic Triggers & Tele-MER ───
const diagnosticTriggers = require('./lib/diagnostic-triggers');

// GET /api/workflow/:id/diagnostic-triggers — evaluate triggers for a workflow
app.get('/api/workflow/:id/diagnostic-triggers', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  const result = diagnosticTriggers.evaluateTriggers({ age: wf.age, gender: wf.gender, bmi: wf.declared_bmi, sum_assured: wf.sum_assured, smoking: wf.lifestyle?.smoking, medical_history: wf.medical_history, lifestyle: wf.lifestyle });
  res.json(result);
});

// GET /api/workflow/:id/telemer-questionnaire — generate tele-MER questionnaire
app.get('/api/workflow/:id/telemer-questionnaire', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  const triggers = diagnosticTriggers.evaluateTriggers({ age: wf.age, gender: wf.gender, bmi: wf.declared_bmi, sum_assured: wf.sum_assured, smoking: wf.lifestyle?.smoking, medical_history: wf.medical_history, lifestyle: wf.lifestyle });
  const questionnaire = diagnosticTriggers.generateQuestionnaire({ age: wf.age, gender: wf.gender, medical_history: wf.medical_history, lifestyle: wf.lifestyle, conditions: wf.medical_history?.pre_existing_conditions }, triggers.categories);
  res.json({ triggers, questionnaire, proposer: { name: wf.proposer_name, age: wf.age, gender: wf.gender, product: wf.product_name, sa: wf.sum_assured } });
});

// POST /api/workflow/:id/telemer-submit — submit tele-MER interview data
app.post('/api/workflow/:id/telemer-submit', requireAuth, async (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Not found' });
    const { answers, examiner_observations, call_duration_seconds } = req.body;
    if (!answers || !Object.keys(answers).length) return res.status(400).json({ error: 'Interview answers required' });

    // Store tele-MER data on workflow
    wf.telemer_data = {
      answers,
      examiner_observations: examiner_observations || {},
      call_duration_seconds: call_duration_seconds || 0,
      submitted_at: new Date().toISOString(),
      submitted_by: req.user?.email || 'examiner',
      status: 'completed'
    };

    // Parse answers for extracted_data format (so scoring engine can use them)
    if (!wf.extracted_data) wf.extracted_data = {};
    if (!wf.extracted_data.telemer_data) wf.extracted_data.telemer_data = {};
    wf.extracted_data.telemer_data.interview_answers = answers;
    wf.extracted_data.telemer_data.examiner_observations = examiner_observations;

    // Check for medication-condition mismatches
    const medications = [];
    const nonDisclosures = [];
    for (const [qId, answer] of Object.entries(answers)) {
      if (qId === 'GEN_01' && answer.value === 'yes' && answer.followup) {
        // Parse medication mentions
        const medText = answer.followup.toLowerCase();
        const medMap = {
          // Diabetes
          metformin: 'diabetes', glimepiride: 'diabetes', insulin: 'diabetes',
          glipizide: 'diabetes', glyburide: 'diabetes', sitagliptin: 'diabetes',
          vildagliptin: 'diabetes', empagliflozin: 'diabetes', dapagliflozin: 'diabetes',
          // Hypertension
          amlodipine: 'hypertension', telmisartan: 'hypertension', atenolol: 'hypertension',
          losartan: 'hypertension', ramipril: 'hypertension', lisinopril: 'hypertension',
          olmesartan: 'hypertension', valsartan: 'hypertension', bisoprolol: 'hypertension',
          nebivolol: 'hypertension', telma: 'hypertension', inderai: 'hypertension',
          inderal: 'hypertension',
          // Cholesterol / Lipids
          atorvastatin: 'high_cholesterol', rosuvastatin: 'high_cholesterol',
          simvastatin: 'high_cholesterol', pitavastatin: 'high_cholesterol',
          fenofibrate: 'high_cholesterol', ezetimibe: 'high_cholesterol',
          // Thyroid
          thyroxine: 'thyroid', levothyroxine: 'thyroid', eltroxin: 'thyroid',
          thyronorm: 'thyroid', methimazole: 'thyroid', carbimazole: 'thyroid',
          // Cardiac risk (anti-platelets / anti-coagulants)
          aspirin: 'cardiac_risk', clopidogrel: 'cardiac_risk',
          warfarin: 'cardiac_risk', rivaroxaban: 'cardiac_risk',
          dabigatran: 'cardiac_risk', apixaban: 'cardiac_risk',
          ecosprin: 'cardiac_risk',
          // ── NEW categories ────────────────────────────────────────────────
          // Parkinson's disease — critical non-disclosure (like Rajeev Mathur case)
          syndopa: 'parkinsons', levodopa: 'parkinsons', carbidopa: 'parkinsons',
          aciten: 'parkinsons', pramipexole: 'parkinsons', ropinirole: 'parkinsons',
          selegiline: 'parkinsons', rasagiline: 'parkinsons', amantadine: 'parkinsons',
          'tab. syndopa': 'parkinsons', 'tab. aciten': 'parkinsons',
          // Kidney / Proteinuria (renal conditions)
          wysolone: 'kidney_disease', deflazacort: 'kidney_disease',
          tacrolimus: 'kidney_disease', cyclosporine: 'kidney_disease',
          mycophenolate: 'kidney_disease', raflate: 'kidney_disease',
          // Autoimmune / Inflammation
          prednisolone: 'autoimmune', methylprednisolone: 'autoimmune',
          dexamethasone: 'autoimmune', hydroxychloroquine: 'autoimmune',
          methotrexate: 'autoimmune', sulfasalazine: 'autoimmune',
          // Gout / Uric acid
          allopurinol: 'gout', febuxostat: 'gout', probenecid: 'gout',
          // Mental health / Neurological
          risperidone: 'psychiatric', olanzapine: 'psychiatric',
          quetiapine: 'psychiatric', haloperidol: 'psychiatric',
          clonazepam: 'neurological', phenytoin: 'neurological',
          valproate: 'neurological', carbamazepine: 'neurological',
          // Cancer (chemotherapy drugs — immediate escalation)
          tamoxifen: 'cancer', letrozole: 'cancer', anastrozole: 'cancer',
          imatinib: 'cancer', capecitabine: 'cancer',
        };
        for (const [med, condition] of Object.entries(medMap)) {
          if (medText.includes(med)) {
            medications.push({ name: med, treats: condition });
            // Check if condition was declared
            const declared = (wf.medical_history?.pre_existing_conditions || []).some(c => (typeof c === 'string' ? c : c.name || '').toLowerCase().includes(condition.replace('_', '')));
            if (!declared) nonDisclosures.push({ medication: med, implied_condition: condition, disclosed: false });
          }
        }
      }
    }
    wf.telemer_data.medications_detected = medications;
    wf.telemer_data.non_disclosures = nonDisclosures;

    // Determine recommendation
    const evasiveCount = Object.values(answers).filter(a => a.confidence === 'evasive').length;
    const cooperativeness = examiner_observations?.cooperativeness || 'cooperative';
    let telemer_recommendation = 'proceed_to_scoring';
    if (nonDisclosures.length > 0) telemer_recommendation = 'escalate_to_pphc';
    if (evasiveCount >= 3) telemer_recommendation = 'escalate_to_pphc';
    if (cooperativeness === 'hostile' || cooperativeness === 'evasive') telemer_recommendation = 'escalate_to_pphc';

    wf.telemer_data.recommendation = telemer_recommendation;
    wf.telemer_data.escalation_reasons = [];
    if (nonDisclosures.length) wf.telemer_data.escalation_reasons.push(`${nonDisclosures.length} potential non-disclosure(s) detected`);
    if (evasiveCount >= 3) wf.telemer_data.escalation_reasons.push(`${evasiveCount} evasive answers`);
    if (cooperativeness !== 'cooperative') wf.telemer_data.escalation_reasons.push(`Examiner noted: ${cooperativeness}`);

    wf.state_history.push({ state: 'telemer_completed', timestamp: new Date().toISOString(), actor: req.user?.email || 'examiner', note: `Tele-MER interview completed. Duration: ${Math.round((call_duration_seconds||0)/60)}min. Recommendation: ${telemer_recommendation}. ${medications.length} medication(s) detected.` });
    workflowEngine.updateWorkflow(wf.id, wf);

    // If recommendation is to proceed, trigger AI analysis
    if (telemer_recommendation === 'proceed_to_scoring') {
      wf.docs_submitted = true;
      wf.docs_submitted_at = new Date().toISOString();
      workflowEngine.updateWorkflow(wf.id, wf);
    }

    res.json({ success: true, recommendation: telemer_recommendation, medications, non_disclosures: nonDisclosures, escalation_reasons: wf.telemer_data.escalation_reasons });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Biometric Face Verification ───

// POST /api/workflow/:id/proposal-biometric — capture face at proposal creation
app.post('/api/workflow/:id/proposal-biometric', requireAuth, upload.single('face_image'), async (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });

    let faceBase64 = null;
    if (req.file) {
      faceBase64 = req.file.buffer.toString('base64');
    } else if (req.body.face_image) {
      faceBase64 = req.body.face_image.replace(/^data:image\/\w+;base64,/, '');
    }
    if (!faceBase64) return res.status(400).json({ error: 'Face image required' });

    // Store proposal biometrics
    wf.proposal_biometrics = {
      face_image: faceBase64,
      captured_at: new Date().toISOString(),
      captured_by: req.user?.email || 'system',
      liveness_confirmed: req.body.liveness_confirmed === true || req.body.liveness_confirmed === 'true',
      capture_location: req.body.latitude && req.body.longitude ? { lat: parseFloat(req.body.latitude), lng: parseFloat(req.body.longitude) } : null
    };

    // Save face image to S3 uploads/biometrics/ path (uses IAM role — no static keys needed)
    const proposalImgBuffer = Buffer.from(faceBase64, 'base64');
    s3Client.saveBiometric(req.params.id, 'proposal-face.jpg', proposalImgBuffer, 'image/jpeg')
      .then(r => { wf.proposal_biometrics.s3_key = r.key; })
      .catch(e => console.error('S3 proposal face save error:', e.message));

    wf.state_history.push({ state: 'proposal_face_captured', timestamp: new Date().toISOString(), actor: req.user?.email || 'system', note: 'Proposal face photo captured for identity verification' });
    workflowEngine.updateWorkflow(req.params.id, wf);

    res.json({ success: true, biometric_captured: true, captured_at: wf.proposal_biometrics.captured_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/workflow/:id/vendor-biometric — vendor captures face at PPHC
app.post('/api/workflow/:id/vendor-biometric', requireAuth, upload.single('face_image'), async (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });

    // Manual UW override — just update the score without new face image
    if (req.body.manual_override === true || req.body.manual_override === 'true') {
      const manualScore = parseFloat(req.body.browser_face_score);
      if (Number.isFinite(manualScore)) {
        const status = manualScore >= 85 ? 'verified' : manualScore >= 75 ? 'partial' : 'failed';
        wf.biometric_verification = {
          ...wf.biometric_verification,
          face_match_score: manualScore,
          status,
          method: 'manual_uw',
          compared_at: new Date().toISOString(),
          manual_override_by: req.user?.email || 'uw'
        };
        wf.state_history.push({ state: 'biometric_manual_verified', timestamp: new Date().toISOString(), actor: req.user?.email || 'uw', note: `Manual identity verification by UW: ${status} (${manualScore}%)` });
        workflowEngine.updateWorkflow(req.params.id, wf);
        return res.json({ success: true, comparison: { compared: true, score: manualScore, status, method: 'manual_uw' } });
      }
    }

    let faceBase64 = null;
    if (req.file) {
      faceBase64 = req.file.buffer.toString('base64');
    } else if (req.body.face_image) {
      faceBase64 = req.body.face_image.replace(/^data:image\/\w+;base64,/, '');
    }
    if (!faceBase64) return res.status(400).json({ error: 'Face image required' });

    wf.pphc_biometrics = {
      face_image: faceBase64,
      captured_at: new Date().toISOString(),
      captured_by: req.user?.email || 'vendor',
      liveness_confirmed: req.body.liveness_confirmed === true || req.body.liveness_confirmed === 'true',
      capture_location: req.body.latitude && req.body.longitude ? { lat: parseFloat(req.body.latitude), lng: parseFloat(req.body.longitude) } : null
    };

    // Save PPHC face to S3 uploads/biometrics/ path (uses IAM role)
    const pphcImgBuffer = Buffer.from(faceBase64, 'base64');
    s3Client.saveBiometric(req.params.id, 'pphc-face.jpg', pphcImgBuffer, 'image/jpeg')
      .then(r => { wf.pphc_biometrics.s3_key = r.key; })
      .catch(e => console.error('S3 pphc face save error:', e.message));

    wf.state_history.push({ state: 'pphc_face_captured', timestamp: new Date().toISOString(), actor: req.user?.email || 'vendor', note: 'PPHC face photo captured by vendor for identity verification' });

    // Use browser-computed face score if available (from face-api.js)
    let comparisonResult = null;
    const browserScore = parseFloat(req.body.browser_face_score);
    if (Number.isFinite(browserScore)) {
      // Browser already compared using face-api.js — use that score
      const status = browserScore >= 85 ? 'verified' : browserScore >= 75 ? 'partial' : 'failed';
      wf.biometric_verification = {
        face_match_score: browserScore,
        status,
        method: 'face_api_js_browser',
        compared_at: new Date().toISOString(),
        proposal_captured_at: wf.proposal_biometrics?.captured_at,
        pphc_captured_at: wf.pphc_biometrics.captured_at
      };
      wf.state_history.push({
        state: 'biometric_compared', timestamp: new Date().toISOString(), actor: 'face-api.js',
        note: `Face comparison (browser): ${browserScore}% match — ${status}`
      });
      comparisonResult = { compared: true, score: browserScore, status, method: 'face_api_js_browser' };
    } else if (wf.proposal_biometrics?.face_image && wf.pphc_biometrics?.face_image) {
      // No browser score — try server-side Rekognition as fallback
      comparisonResult = await compareFaces(wf);
    }

    workflowEngine.updateWorkflow(req.params.id, wf);
    res.json({ success: true, biometric_captured: true, comparison: comparisonResult });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Face comparison function — uses AWS Rekognition if available, otherwise manual review required
async function compareFaces(wf) {
  const result = { compared: false, score: null, status: 'pending', method: 'manual' };

  try {
    // Try AWS Rekognition
    const { RekognitionClient, CompareFacesCommand } = require('@aws-sdk/client-rekognition');
    const rekognition = new RekognitionClient({
      region: process.env.AWS_REGION || 'ap-south-1',
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
    });

    const command = new CompareFacesCommand({
      SourceImage: { Bytes: Buffer.from(wf.proposal_biometrics.face_image, 'base64') },
      TargetImage: { Bytes: Buffer.from(wf.pphc_biometrics.face_image, 'base64') },
      SimilarityThreshold: 0
    });

    const response = await rekognition.send(command);
    const match = response.FaceMatches?.[0];
    const similarity = match ? Math.round(match.Similarity * 10) / 10 : 0;

    result.compared = true;
    result.score = similarity;
    result.method = 'aws_rekognition';
    result.status = similarity >= 85 ? 'verified' : similarity >= 75 ? 'partial' : 'failed';
    result.compared_at = new Date().toISOString();

    wf.biometric_verification = {
      face_match_score: similarity,
      status: result.status,
      method: 'aws_rekognition',
      compared_at: result.compared_at,
      proposal_captured_at: wf.proposal_biometrics.captured_at,
      pphc_captured_at: wf.pphc_biometrics.captured_at
    };

    wf.state_history.push({
      state: 'biometric_compared', timestamp: new Date().toISOString(), actor: 'Rekognition',
      note: `Face comparison: ${similarity}% match — ${result.status}`
    });

  } catch(e) {
    // Rekognition not available — mark for manual comparison
    console.error('Face comparison error (Rekognition):', e.message);
    result.compared = false;
    result.status = 'manual_review_required';
    result.method = 'manual';
    result.error = e.message.includes('is not authorized') ? 'AWS Rekognition permission not configured' : e.message;

    wf.biometric_verification = {
      face_match_score: null,
      status: 'manual_review_required',
      method: 'manual',
      compared_at: new Date().toISOString(),
      note: 'Automated comparison unavailable — UW must visually verify identity',
      proposal_captured_at: wf.proposal_biometrics?.captured_at,
      pphc_captured_at: wf.pphc_biometrics?.captured_at
    };

    wf.state_history.push({
      state: 'biometric_manual_review', timestamp: new Date().toISOString(), actor: 'System',
      note: 'Automated face comparison unavailable. Manual visual verification required by UW.'
    });
  }

  return result;
}

// GET /api/workflow/:id/biometric-status — get biometric verification status
app.get('/api/workflow/:id/biometric-status', requireAuth, (req, res) => {
  const wf = workflowEngine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  res.json({
    proposal_captured: !!wf.proposal_biometrics?.face_image,
    pphc_captured: !!wf.pphc_biometrics?.face_image,
    verification: wf.biometric_verification || null,
    proposal_captured_at: wf.proposal_biometrics?.captured_at || null,
    pphc_captured_at: wf.pphc_biometrics?.captured_at || null
  });
});

// ─── Historical UW Data Engine ───
const historicalEngine = require('./lib/historical-uw-engine');

// Load historical corpus from S3 on startup (called in loadProductPolicyConfig)
async function loadHistoricalCorpus() {
  if (!process.env.AWS_ACCESS_KEY_ID) return;
  try {
    const data = await s3Client.getConfig('historical-uw-corpus');
    if (data && data.records) {
      historicalEngine.loadCorpus(data);
      console.log(`[Startup] Historical UW corpus: ${historicalEngine.getCorpusSize()} records loaded`);
    }
  } catch(e) { /* No historical data yet */ }
  try {
    const offsets = await s3Client.getConfig('calibration-offsets');
    if (offsets && Object.keys(offsets).length > 0) {
      historicalEngine.loadCalibrationOffsets(offsets);
      console.log(`[Startup] Calibration offsets: ${Object.keys(offsets).length} profile types loaded`);
    }
  } catch(e) { /* No calibration data yet */ }
}

// GET /api/historical-uw/stats — corpus summary
app.get('/api/historical-uw/stats', requireAuth, (req, res) => {
  res.json(historicalEngine.getStats());
});

// POST /api/historical-uw/upload — upload CSV/JSON historical data
app.post('/api/historical-uw/upload', requireRole('Super Admin', 'UW Admin'), upload.single('file'), validateFileContent, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mode = req.body.mode || 'append'; // 'append' or 'replace'

    let records = [];
    const content = req.file.buffer.toString('utf8');

    if (req.file.originalname.endsWith('.json')) {
      records = JSON.parse(content);
      if (!Array.isArray(records)) records = [records];
    } else {
      // Parse CSV
      const lines = content.split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/"/g, ''));
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        if (vals.length < headers.length / 2) continue; // Skip obviously broken rows
        const record = {};
        headers.forEach((h, idx) => { record[h] = vals[idx] || ''; });
        records.push(record);
      }
    }

    if (records.length === 0) return res.status(400).json({ error: 'No valid records found in uploaded file' });

    const result = historicalEngine.ingestHistoricalData(records, mode, req.file.originalname);

    // Persist to S3
      await s3Client.saveConfig('historical-uw-corpus', historicalEngine.getCorpus());

    res.json({
      success: true,
      mode,
      file: req.file.originalname,
      records_in_file: records.length,
      records_ingested: result.ingested,
      records_rejected: result.rejected,
      total_corpus: result.total_corpus,
      stats: result.stats
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/historical-uw/match — find similar historical cases for a proposal
app.post('/api/historical-uw/match', requireAuth, (req, res) => {
  try {
    const result = historicalEngine.findSimilarCases(req.body, req.body.min_similarity || 60);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/historical-uw/match/:workflowId — find similar cases for an existing workflow
app.get('/api/historical-uw/match/:workflowId', requireAuth, (req, res) => {
  try {
    const wf = workflowEngine.getWorkflow(req.params.workflowId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });

    const proposalData = {
      age: wf.age, gender: wf.gender, sum_assured: wf.sum_assured,
      product_type: wf.product_name, smoker: wf.lifestyle?.smoking,
      alcohol: wf.lifestyle?.alcohol, bmi: wf.extracted_data?.physical_exam?.bmi?.value,
      ...(wf.medical_history?.pre_existing_conditions || []).reduce((o, c) => { o[c] = true; return o; }, {})
    };

    const result = historicalEngine.findSimilarCases(proposalData);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/historical-uw/corpus — clear the entire corpus
app.delete('/api/historical-uw/corpus', requireRole('Super Admin'), async (req, res) => {
  try {
    historicalEngine.ingestHistoricalData([], 'replace');
      await s3Client.saveConfig('historical-uw-corpus', historicalEngine.getCorpus());
    res.json({ success: true, message: 'Historical corpus cleared' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/historical-uw/export — export corpus as JSON
app.get('/api/historical-uw/export', requireRole('Super Admin', 'UW Admin'), (req, res) => {
  res.json(historicalEngine.getCorpus());
});

// POST /api/historical-uw/recalibrate — recalculate calibration offsets from all workflows
app.post('/api/historical-uw/recalibrate', requireRole('Super Admin', 'UW Admin'), async (req, res) => {
  try {
    const allWorkflows = workflowEngine.listWorkflows({});
    const result = historicalEngine.calculateCalibrationOffsets(allWorkflows);

    // Persist calibration offsets to S3
      await s3Client.saveConfig('calibration-offsets', historicalEngine.getCalibrationOffsets());

    res.json({ success: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/historical-uw/calibration — get current calibration offsets
app.get('/api/historical-uw/calibration', requireAuth, (req, res) => {
  res.json({ offsets: historicalEngine.getCalibrationOffsets() });
});

// POST /api/historical-uw/pphc-evaluate — evaluate whether PPHC is needed for a proposal
app.post('/api/historical-uw/pphc-evaluate', requireAuth, (req, res) => {
  try {
    const { age, gender, sum_assured, product_name, smoking, alcohol, medical_history } = req.body;
    if (!age) return res.status(400).json({ error: 'Age is required' });

    const proposalData = {
      age, gender, sum_assured: sum_assured || 500000,
      product_type: product_name || 'health',
      smoker: smoking, alcohol,
      ...(medical_history?.pre_existing_conditions || []).reduce((o, c) => { o[c] = true; return o; }, {})
    };

    const historicalMatch = historicalEngine.findSimilarCases(proposalData);

    let routing = 'full_pphc';
    let routingReason = '';

    if (historicalMatch.confidence === 'HIGH' && historicalMatch.pphc_analysis.pphc_recommendation === 'skip_pphc') {
      routing = 'stp_auto_approve';
      routingReason = `Historical confidence HIGH: ${historicalMatch.match_count} similar profiles, ${historicalMatch.decision_distribution.approval_rate}% approved, ${historicalMatch.claim_analysis.claim_rate}% claim rate. PPHC not required.`;
    } else if (historicalMatch.confidence === 'MEDIUM') {
      routing = 'telemer';
      routingReason = `Historical confidence MEDIUM: ${historicalMatch.match_count} similar profiles, ${historicalMatch.decision_distribution.approval_rate}% approved. Tele-MER recommended instead of full PPHC.`;
    } else if (historicalMatch.confidence === 'LOW') {
      routing = 'full_pphc';
      routingReason = `Historical confidence LOW: ${historicalMatch.match_count < 20 ? 'insufficient matching records' : 'approval rate or claim rate outside safe thresholds'}. Full PPHC required.`;
    } else {
      routing = 'full_pphc';
      routingReason = historicalMatch.message || 'Insufficient historical data for PPHC-skip evaluation.';
    }

    res.json({
      routing,
      routing_reason: routingReason,
      pphc_required: routing === 'full_pphc',
      telemer_sufficient: routing === 'telemer',
      auto_approve: routing === 'stp_auto_approve',
      historical_analysis: historicalMatch,
      proposal_profile: proposalData
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Audit Log Export ───
app.get('/api/audit/export', requireRole('Super Admin', 'UW Admin'), (req, res) => {
  const { from_date, to_date, state, product, has_edits } = req.query;
  let workflows = workflowEngine.listWorkflows({});

  // Apply filters
  if (from_date) workflows = workflows.filter(w => new Date(w.created_at) >= new Date(from_date));
  if (to_date) workflows = workflows.filter(w => new Date(w.created_at) <= new Date(to_date));
  if (state) workflows = workflows.filter(w => w.state === state);
  if (product) workflows = workflows.filter(w => w.product_name === product);
  if (has_edits === 'true') workflows = workflows.filter(w => w.audit_trail && w.audit_trail.length > 0);

  const approved = workflows.filter(w => ['auto_approved','uw_approved'].includes(w.state)).length;
  const rejected = workflows.filter(w => ['auto_rejected','uw_rejected'].includes(w.state)).length;
  const referred = workflows.filter(w => w.state === 'referred').length;
  const counterOffered = workflows.filter(w => w.state === 'counter_offered').length;
  const totalEdits = workflows.reduce((sum, w) => sum + (w.audit_trail?.length || 0), 0);
  const avgScore = workflows.filter(w => w.ai_analysis?.risk_score).length > 0 ? Math.round(workflows.filter(w => w.ai_analysis?.risk_score).reduce((s, w) => s + (w.ai_analysis.risk_score.normalized || 0), 0) / workflows.filter(w => w.ai_analysis?.risk_score).length) : 0;

  res.json({
    report_generated: new Date().toISOString(),
    filters: { from_date: from_date || 'all', to_date: to_date || 'all', state: state || 'all', product: product || 'all', has_edits: has_edits || 'all' },
    summary: { total_cases: workflows.length, approved, rejected, referred, counter_offered: counterOffered, total_manual_edits: totalEdits, avg_risk_score: avgScore },
    cases: workflows.map(w => ({
      proposal_id: w.proposal_id, proposer_name: w.proposer_name, age: w.age, gender: w.gender,
      product: w.product_name, sum_assured: w.sum_assured, state: w.state,
      risk_score: w.ai_analysis?.risk_score?.normalized ? Math.round(w.ai_analysis.risk_score.normalized) : null,
      grade: w.ai_analysis?.risk_score?.grade || null,
      decision: w.ai_analysis?.recommendation || null,
      loading_pct: w.ai_analysis?.loading_percentage || 0,
      applied_policy: w.ai_analysis?.applied_policy?.name || 'Default',
      vendor_id: w.vendor_id,
      extraction_method: w.extraction_method,
      documents_count: (w.documents || []).length,
      manual_edits: (w.audit_trail || []).length,
      reassignment_count: w.reassignment_count || 0,
      created_at: w.created_at,
      updated_at: w.updated_at,
      findings_count: (w.ai_analysis?.findings || []).length,
      violations_count: (w.ai_analysis?.guidelines_compliance?.violations || []).length,
      state_transitions: (w.state_history || []).length
    })),
    audit_trail: workflows.filter(w => w.audit_trail?.length).map(w => ({
      proposal_id: w.proposal_id,
      edits: w.audit_trail.map(t => ({ field: t.field_path, old_value: t.old_value, new_value: t.new_value, reason: t.reason, editor: t.editor, timestamp: t.timestamp }))
    }))
  });
});

app.get('/api/audit/export-csv', requireRole('Super Admin', 'UW Admin'), (req, res) => {
  const workflows = workflowEngine.listWorkflows({});
  const headers = ['Proposal ID','Proposer Name','Age','Gender','Product','Sum Assured','State','Risk Score','Grade','Decision','Loading %','Policy','Vendor','Extraction','Docs','Manual Edits','Reassignments','Findings','Violations','Created','Updated'];
  const rows = workflows.map(w => [
    w.proposal_id, `"${(w.proposer_name||'').replace(/"/g,'""')}"`, w.age, w.gender, w.product_name,
    w.sum_assured, w.state,
    w.ai_analysis?.risk_score?.normalized ? Math.round(w.ai_analysis.risk_score.normalized) : '',
    w.ai_analysis?.risk_score?.grade || '',
    w.ai_analysis?.recommendation || '',
    w.ai_analysis?.loading_percentage || 0,
    w.ai_analysis?.applied_policy?.name || 'Default',
    w.vendor_id || '',
    w.extraction_method || '',
    (w.documents||[]).length,
    (w.audit_trail||[]).length,
    w.reassignment_count || 0,
    (w.ai_analysis?.findings||[]).length,
    (w.ai_analysis?.guidelines_compliance?.violations||[]).length,
    w.created_at ? new Date(w.created_at).toLocaleDateString('en-IN') : '',
    w.updated_at ? new Date(w.updated_at).toLocaleDateString('en-IN') : ''
  ].join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=UW-Audit-Report-${new Date().toISOString().split('T')[0]}.csv`);
  res.send(csv);
});

// Analytics
app.get('/api/analytics/dashboard', requireAuth, (req, res) => {
  const wa = workflowEngine.getAnalytics();
  const cs = commsEngine.getCommsStats();
  const vr = vendorApi.listVendorRequests();
  const vs = {};
  vendorApi.listVendors().forEach(v => { const reqs = vr.filter(r => r.vendor_id === v.id); vs[v.id] = { name: v.name, total: reqs.length, completed: reqs.filter(r => r.status === 'report_ready').length, pending: reqs.filter(r => r.status !== 'report_ready').length, sla: v.compliance_rate }; });
  res.json({ workflow: wa, communications: cs, vendors: vs, timestamp: new Date().toISOString() });
});

// Masters & Users
app.get('/api/masters/:type', requireAuth, async (req, res) => {
  const fs = require('fs');
  // For built-in configs, always use local file first (they're the source of truth)
  const builtInConfigs = ['uw-guidelines', 'risk-params', 'medical-scoring'];
  let m = null;
  if (builtInConfigs.includes(req.params.type)) {
    const localPath = path.join(__dirname, 'config', `${req.params.type}.json`);
    try { m = JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch(e) {}
  }
  // Append custom rules if they exist
  if (req.params.type === 'uw-guidelines' && m && customRules.length > 0) {
    m = { ...m, rules: [...(m.rules||[]), ...customRules] };
  }
  if (!m) {
    try { m = await s3Client.getMasters(req.params.type); } catch(e) {}
  }
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(m);
});
app.put('/api/masters/:type', requireRole('Super Admin','Admin'), async (req, res) => { try { await s3Client.saveMasters(req.params.type, req.body); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });

// In-memory custom rules store (persists until server restart)
let customRules = [];

app.get('/api/uw-rules/custom', requireAuth, (req, res) => res.json(customRules));

// Upload UW rules document for AI extraction
app.post('/api/uw-rules/upload', requireAuth, upload.single('document'), validateFileContent, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fs = require('fs');
    const configPath = path.join(__dirname, 'config');
    const existingGuidelines = JSON.parse(fs.readFileSync(`${configPath}/uw-guidelines.json`, 'utf8'));
    const existingRiskParams = JSON.parse(fs.readFileSync(`${configPath}/risk-params.json`, 'utf8'));

    let extractedRules = [];

    if (true) { // Bedrock — no API key needed, uses IAM role
      try {
// using top-level __bedrockClient
        const claude = {
          messages: {
            create: async (params) => {
              const { model, temperature, ...rest } = params;
          if (!rest.anthropic_version) rest.anthropic_version = 'bedrock-2023-05-31';
              const cmd = new InvokeModelCommand({
                modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0',
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(rest)
              });
              const res = await __bedrockClient.send(cmd);
              return JSON.parse(Buffer.from(res.body).toString('utf8'));
            }
          }
        };

        const contentParts = [];
        const isImage = ['image/jpeg','image/png','image/gif','image/webp'].includes(req.file.mimetype);
        const isPdf = req.file.mimetype === 'application/pdf';
        const b64 = req.file.buffer.toString('base64');

        if (isImage) {
          contentParts.push({ type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: b64 } });
        } else if (isPdf) {
          contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
        } else {
          const textContent = req.file.buffer.toString('utf8').substring(0, 10000);
          contentParts.push({ type: 'text', text: textContent });
        }

        contentParts.push({ type: 'text', text: `Extract ALL underwriting rules from this document. For each rule, identify:
- The medical parameter or condition being checked
- The threshold value
- The comparison operator
- What action to take (approve, decline, refer, loading)
- Severity (critical, high, medium, low)
- Any premium loading percentage

Return ONLY valid JSON array:
[
  {
    "id": "CUSTOM-001",
    "name": "Rule name",
    "description": "What this rule checks",
    "path": "data path like physical_exam.bmi.value or blood_chemistry.fasting_glucose.value",
    "operator": "<|>|<=|>=|==|in",
    "threshold": "value or array",
    "action": "decline|refer|loading|flag",
    "severity": "critical|high|medium|low",
    "loading_pct": 0,
    "product_applicability": "all|health|life",
    "source_document": "${req.file.originalname}"
  }
]

Map parameters to these known paths: physical_exam.bmi.value, physical_exam.blood_pressure.systolic.value, blood_chemistry.fasting_glucose.value, blood_chemistry.hba1c.value, blood_chemistry.serum_creatinine.value, blood_chemistry.sgpt_alt.value, blood_chemistry.total_cholesterol.value, blood_chemistry.tc_hdl_ratio.value, blood_chemistry.hiv.value, blood_chemistry.hbsag.value, hematology.hemoglobin.value, cardiac.ecg.overall_interpretation, urine_analysis.protein.value` });

        const response = await claude.messages.create({
          model: 'claude-3-sonnet-20240229', max_tokens: 4000, temperature: 0,
          system: 'You are an insurance underwriting rules extraction AI. Extract structured rules from documents. Return ONLY valid JSON array.',
          messages: [{ role: 'user', content: contentParts }]
        });

        const responseText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          extractedRules = JSON.parse(jsonMatch[0]);
          extractedRules = extractedRules.map((r, i) => ({ ...r, id: r.id || `CUSTOM-${String(i+1).padStart(3,'0')}`, extracted_at: new Date().toISOString(), source: req.file.originalname, ai_extracted: true }));
        }
      } catch(claudeErr) {
        console.error('Claude rules extraction error:', claudeErr.message);
      }
    }

    // Fallback: generate sample rules from document name
    if (extractedRules.length === 0) {
      extractedRules = [
        { id: 'CUSTOM-001', name: 'BMI Check (from '+req.file.originalname+')', description: 'BMI must be under 35 for standard rates', path: 'physical_exam.bmi.value', operator: '<', threshold: 35, action: 'loading', severity: 'medium', loading_pct: 50, product_applicability: 'all', source_document: req.file.originalname, extracted_at: new Date().toISOString(), ai_extracted: false },
        { id: 'CUSTOM-002', name: 'Diabetes Screening', description: 'HbA1c above 7 requires additional loading', path: 'blood_chemistry.hba1c.value', operator: '<', threshold: 7, action: 'loading', severity: 'high', loading_pct: 50, product_applicability: 'health', source_document: req.file.originalname, extracted_at: new Date().toISOString(), ai_extracted: false },
        { id: 'CUSTOM-003', name: 'Hypertension Check', description: 'Systolic BP above 160 requires referral', path: 'physical_exam.blood_pressure.systolic.value', operator: '<', threshold: 160, action: 'refer', severity: 'high', loading_pct: 0, product_applicability: 'all', source_document: req.file.originalname, extracted_at: new Date().toISOString(), ai_extracted: false }
      ];
    }

    // Merge with existing custom rules and persist to S3
    customRules = [...customRules, ...extractedRules];
      s3Client.saveCustomRules(customRules).catch(e => console.error('S3 custom rules save error:', e.message));

    res.json({
      success: true,
      rules_extracted: extractedRules.length,
      rules: extractedRules,
      total_custom_rules: customRules.length,
      source: req.file.originalname,
      ai_extracted: extractedRules.some(r => r.ai_extracted)
    });
  } catch(e) { console.error('Rules upload error:', e); res.status(500).json({ error: e.message }); }
});

// Delete a custom rule
app.delete('/api/uw-rules/custom/:ruleId', requireAuth, (req, res) => {
  customRules = customRules.filter(r => r.id !== req.params.ruleId);
  res.json({ success: true, total: customRules.length });
});
// ─── Phase 3: Information Requests ───
const crypto = require('crypto');

// GET suggested info requests for a workflow (dry run, no side effects)
app.get('/api/workflow/:id/suggested-info-requests', requireAuth, (req, res) => {
  const w = workflowEngine.getWorkflow(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const suggestions = infoRequestSuggester.suggestInfoRequests(w);
  res.json(suggestions);
});

// Create a new info request for a workflow
app.post('/api/workflow/:id/request-info', requireAuth, async (req, res) => {
  try {
    const { items, reason, channels, deadline_days } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const w = workflowEngine.getWorkflow(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });

    const requestId = `IR-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const customerToken = crypto.randomBytes(24).toString('hex');
    const deadlineDays = parseInt(deadline_days, 10) || 14;
    const tokenExpiresAt = new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000).toISOString();

    const request = {
      id: requestId,
      requested_at: new Date().toISOString(),
      requested_by: req.user?.email || 'system',
      request_type: req.body.request_type || 'manual',
      reason,
      items: items.map((item, idx) => ({
        id: `${requestId}-ITEM-${String(idx + 1).padStart(3, '0')}`,
        type: item.type || 'document',
        name: item.name,
        description: item.description || '',
        mandatory: item.mandatory !== false,
        fasting_required: item.fasting_required || false,
        received: false,
        received_at: null,
        received_via: null,
        document_id: null
      })),
      channel: channels?.[0] || 'email',
      customer_token: customerToken,
      token_expires_at: tokenExpiresAt,
      status: 'pending',
      deadline: tokenExpiresAt,
      reminder_sent_count: 0,
      last_reminder_at: null,
      completed_at: null
    };

    workflowEngine.addInformationRequest(w.id, request);

    // Transition state if appropriate (referred or uw_reviewing → awaiting_additional_info)
    if (['referred', 'uw_reviewing'].includes(w.state)) {
      try {
        workflowEngine.transitionState(w.id, 'awaiting_additional_info', req.user?.email || 'system', `Info request ${requestId}: ${reason}`);
      } catch (e) {
        console.error('Info request state transition failed:', e.message);
      }
    }

    // Build portal link (frontend rewrites /info-request -> /info-request.html on Render)
    const portalBase = process.env.FRONTEND_URL || 'http://localhost:3000';
    const portalLink = `${portalBase}/info-request?token=${customerToken}`;

    // Send notification
    try {
      const itemListText = request.items.map((it, i) => `${i + 1}. ${it.name} (${it.type})${it.fasting_required ? ' — FASTING REQUIRED' : ''}`).join('\n');
      const itemListShort = request.items.slice(0, 3).map(it => `• ${it.name}`).join('\n') + (request.items.length > 3 ? `\n• +${request.items.length - 3} more` : '');
      commsEngine.sendNotification('info_requested', {
        proposer_name: w.proposer_name,
        proposal_id: w.proposal_id,
        product_name: w.product_name,
        item_count: request.items.length,
        item_list: itemListText,
        item_list_short: itemListShort,
        reason,
        portal_link: portalLink,
        deadline: new Date(tokenExpiresAt).toLocaleDateString('en-IN'),
        email: req.body.email || 'customer@example.com'
      }, channels || ['email', 'sms']);
    } catch (e) { console.error('Info request notification error:', e.message); }

    socketManager.emitGlobal('info_request_created', { workflow_id: w.id, request_id: requestId, item_count: request.items.length });
    res.json({ success: true, request, portal_link: portalLink, workflow: workflowEngine.getWorkflow(w.id) });
  } catch (e) { console.error('Request-info error:', e); res.status(500).json({ error: e.message }); }
});

// List info requests for a workflow
app.get('/api/workflow/:id/information-requests', requireAuth, (req, res) => {
  const w = workflowEngine.getWorkflow(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json(w.information_requests || []);
});

// Cancel an info request
app.post('/api/workflow/:id/cancel-info-request/:requestId', requireAuth, async (req, res) => {
  try {
    const w = workflowEngine.getWorkflow(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const request = (w.information_requests || []).find(r => r.id === req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Info request not found' });
    if (request.status === 'received' || request.status === 'cancelled') {
      return res.status(409).json({ error: `Request already ${request.status}` });
    }
    workflowEngine.updateInformationRequest(w.id, request.id, {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by: req.user?.email || 'system',
      cancellation_reason: req.body?.reason || 'No reason provided'
    });
    // If this was the only open request and workflow is awaiting → return to uw_reviewing
    const stillOpen = (w.information_requests || []).filter(r => r.id !== request.id && (r.status === 'pending' || r.status === 'partial')).length;
    if (stillOpen === 0 && w.state === 'awaiting_additional_info') {
      try {
        workflowEngine.transitionState(w.id, 'uw_reviewing', req.user?.email || 'system', `All info requests resolved or cancelled — returning to UW review`);
      } catch (e) { console.error('Cancel info request state transition failed:', e.message); }
    }
    res.json({ success: true, request });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual reminder trigger
app.post('/api/workflow/:id/information-request/:requestId/reminder', requireAuth, async (req, res) => {
  try {
    const w = workflowEngine.getWorkflow(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const request = (w.information_requests || []).find(r => r.id === req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Info request not found' });
    if (request.status !== 'pending' && request.status !== 'partial') return res.status(409).json({ error: `Request status is ${request.status}` });

    const portalBase = process.env.FRONTEND_URL || 'http://localhost:3000';
    const portalLink = `${portalBase}/info-request?token=${request.customer_token}`;
    const itemListText = (request.items || []).filter(it => !it.received).map((it, i) => `${i + 1}. ${it.name}`).join('\n');
    const daysRemaining = Math.max(0, Math.ceil((new Date(request.deadline) - new Date()) / (24 * 60 * 60 * 1000)));

    commsEngine.sendNotification('info_reminder', {
      proposer_name: w.proposer_name,
      proposal_id: w.proposal_id,
      item_list: itemListText,
      portal_link: portalLink,
      deadline: new Date(request.deadline).toLocaleDateString('en-IN'),
      days_remaining: daysRemaining,
      email: req.body?.email || 'customer@example.com'
    }, ['email', 'sms']);

    workflowEngine.updateInformationRequest(w.id, request.id, {
      reminder_sent_count: (request.reminder_sent_count || 0) + 1,
      last_reminder_at: new Date().toISOString()
    });

    res.json({ success: true, days_remaining: daysRemaining });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Customer-facing (no auth, token-protected) ───

// Validate token and return request items
app.get('/api/customer/info-request/:token', (req, res) => {
  const found = workflowEngine.findWorkflowByInfoToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'Invalid or expired token' });
  const { workflow, request } = found;
  if (request.status === 'cancelled') return res.status(410).json({ error: 'This request has been cancelled' });
  if (request.status === 'received') return res.status(410).json({ error: 'This request has already been completed' });
  if (new Date(request.token_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This request has expired', expired_at: request.token_expires_at });
  }
  // Sanitized view — no internal scoring or PII beyond what customer already knows
  res.json({
    proposal_id: workflow.proposal_id,
    proposer_name: workflow.proposer_name,
    product_name: workflow.product_name,
    request_id: request.id,
    requested_at: request.requested_at,
    reason: request.reason,
    deadline: request.deadline,
    items: request.items.map(it => ({
      id: it.id, type: it.type, name: it.name, description: it.description,
      mandatory: it.mandatory, fasting_required: it.fasting_required,
      received: it.received, received_at: it.received_at
    })),
    status: request.status
  });
});

// Customer uploads a document for one item
app.post('/api/customer/info-request/:token/upload', upload.single('document'), validateFileContent, async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id required' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const found = workflowEngine.findWorkflowByInfoToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Invalid or expired token' });
    const { workflow, request } = found;
    if (request.status === 'cancelled' || request.status === 'received') return res.status(410).json({ error: `Request is ${request.status}` });
    if (new Date(request.token_expires_at) < new Date()) return res.status(410).json({ error: 'Token expired' });

    const item = request.items.find(it => it.id === item_id);
    if (!item) return res.status(404).json({ error: 'Item not found in request' });
    if (item.received) return res.status(409).json({ error: 'Item already received' });

    // Store file (S3 if configured, in-memory otherwise via no-op fallback)
    const docId = `${item_id}-${Date.now()}`;
    const s3Key = `info-requests/${workflow.id}/${request.id}/${docId}-${req.file.originalname}`;
    // Save info request document to uploads/ path (uses IAM role)
    await s3Client.saveUpload(workflow.id, `info-requests/${request.id}/${docId}-${req.file.originalname}`, req.file.buffer, req.file.mimetype)
      .catch(e => console.error('S3 info request upload error:', e.message));

    // Update item
    item.received = true;
    item.received_at = new Date().toISOString();
    item.received_via = 'customer_portal';
    item.document_id = docId;
    item.s3_key = s3Key;
    item.original_filename = req.file.originalname;
    item.size = req.file.size;
    item.content_type = req.file.mimetype;

    // Also add to workflow.documents so AI re-extraction picks it up
    if (!workflow.documents) workflow.documents = [];
    workflow.documents.push({
      id: docId, name: req.file.originalname, category: item.name.toLowerCase().replace(/\s/g, '_'),
      content_type: req.file.mimetype, size: req.file.size,
      base64_data: req.file.buffer.toString('base64'),
      uploaded_at: new Date().toISOString(),
      source: 'customer_info_request', info_request_id: request.id, info_request_item_id: item_id
    });

    // Compute new request status
    const allReceived = request.items.every(it => it.received || !it.mandatory);
    const allMandatoryReceived = request.items.filter(it => it.mandatory).every(it => it.received);
    if (allReceived && allMandatoryReceived) {
      request.status = 'received';
      request.completed_at = new Date().toISOString();
    } else if (request.items.some(it => it.received)) {
      request.status = 'partial';
    }

    workflowEngine.updateInformationRequest(workflow.id, request.id, request);

    // If all mandatory items received and workflow is awaiting → transition back to uw_reviewing
    if (request.status === 'received' && workflow.state === 'awaiting_additional_info') {
      try {
        workflowEngine.transitionState(workflow.id, 'uw_reviewing', 'customer', `Info request ${request.id} fully received — returning to UW review`);
        commsEngine.sendNotification('info_received', {
          proposer_name: workflow.proposer_name, proposal_id: workflow.proposal_id,
          received_date: new Date().toLocaleDateString('en-IN'),
          email: 'customer@example.com'
        }, ['email', 'sms']);
      } catch (e) { console.error('Info received state transition failed:', e.message); }
    }

    socketManager.emitGlobal('info_item_received', {
      workflow_id: workflow.id, request_id: request.id, item_id, item_name: item.name,
      request_status: request.status
    });

    res.json({ success: true, item, request_status: request.status });
  } catch (e) { console.error('Customer info upload error:', e); res.status(500).json({ error: e.message }); }
});

// Customer provides a clarification text response
app.post('/api/customer/info-request/:token/clarification', async (req, res) => {
  try {
    const { item_id, response } = req.body;
    if (!item_id || !response) return res.status(400).json({ error: 'item_id and response required' });
    const found = workflowEngine.findWorkflowByInfoToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Invalid or expired token' });
    const { workflow, request } = found;
    if (request.status === 'cancelled' || request.status === 'received') return res.status(410).json({ error: `Request is ${request.status}` });
    if (new Date(request.token_expires_at) < new Date()) return res.status(410).json({ error: 'Token expired' });

    const item = request.items.find(it => it.id === item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.type !== 'clarification') return res.status(400).json({ error: 'Item is not a clarification type' });

    item.received = true;
    item.received_at = new Date().toISOString();
    item.received_via = 'customer_portal';
    item.clarification_response = response.substring(0, 5000); // cap

    const allReceived = request.items.every(it => it.received || !it.mandatory);
    const allMandatoryReceived = request.items.filter(it => it.mandatory).every(it => it.received);
    if (allReceived && allMandatoryReceived) {
      request.status = 'received';
      request.completed_at = new Date().toISOString();
    } else if (request.items.some(it => it.received)) {
      request.status = 'partial';
    }

    workflowEngine.updateInformationRequest(workflow.id, request.id, request);

    if (request.status === 'received' && workflow.state === 'awaiting_additional_info') {
      try {
        workflowEngine.transitionState(workflow.id, 'uw_reviewing', 'customer', `Info request ${request.id} fully received`);
      } catch (e) { console.error('Clarification state transition failed:', e.message); }
    }

    res.json({ success: true, item, request_status: request.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: list all open info requests across workflows
app.get('/api/info-requests/open', requireRole('Super Admin', 'UW Admin'), (req, res) => {
  res.json(workflowEngine.listOpenInformationRequests());
});

// ─── Reminder cron ───
// Runs every 6 hours, scans pending info requests, sends reminders on day 3/7/12, expires past deadline.
function runInfoRequestReminderCron() {
  try {
    const open = workflowEngine.listOpenInformationRequests();
    const now = Date.now();
    let remindersSent = 0, expired = 0;
    for (const { workflow_id, request } of open) {
      const ageDays = Math.floor((now - new Date(request.requested_at).getTime()) / (24 * 60 * 60 * 1000));
      const deadlineMs = new Date(request.deadline).getTime();

      // Check expiry first
      if (now > deadlineMs) {
        const w = workflowEngine.getWorkflow(workflow_id);
        if (!w) continue;
        workflowEngine.updateInformationRequest(workflow_id, request.id, {
          status: 'expired', expired_at: new Date().toISOString()
        });
        try {
          commsEngine.sendNotification('info_request_expired', {
            proposer_name: w.proposer_name, proposal_id: w.proposal_id,
            expired_date: new Date().toLocaleDateString('en-IN'),
            email: 'customer@example.com'
          }, ['email', 'sms']);
        } catch (e) { /* ignore */ }
        expired++;
        continue;
      }

      // Reminder schedule: day 3, 7, 12
      const reminderDays = [3, 7, 12];
      const sentCount = request.reminder_sent_count || 0;
      const nextReminderDay = reminderDays[sentCount];
      if (nextReminderDay && ageDays >= nextReminderDay) {
        const w = workflowEngine.getWorkflow(workflow_id);
        if (!w) continue;
        const portalBase = process.env.FRONTEND_URL || 'http://localhost:3000';
        const portalLink = `${portalBase}/info-request?token=${request.customer_token}`;
        const itemListText = (request.items || []).filter(it => !it.received).map((it, i) => `${i + 1}. ${it.name}`).join('\n');
        const daysRemaining = Math.max(0, Math.ceil((deadlineMs - now) / (24 * 60 * 60 * 1000)));
        try {
          commsEngine.sendNotification('info_reminder', {
            proposer_name: w.proposer_name, proposal_id: w.proposal_id,
            item_list: itemListText, portal_link: portalLink,
            deadline: new Date(request.deadline).toLocaleDateString('en-IN'),
            days_remaining: daysRemaining,
            email: 'customer@example.com'
          }, ['email', 'sms']);
          workflowEngine.updateInformationRequest(workflow_id, request.id, {
            reminder_sent_count: sentCount + 1, last_reminder_at: new Date().toISOString()
          });
          remindersSent++;
        } catch (e) { console.error('Reminder send error:', e.message); }
      }
    }
    if (remindersSent > 0 || expired > 0) console.log(`[Info Request Cron] sent ${remindersSent} reminder(s), expired ${expired} request(s)`);
  } catch (e) {
    console.error('[Info Request Cron] error:', e.message);
  }
}
// Don't start the interval in test mode (NODE_ENV=development with no real comms)
if (process.env.NODE_ENV !== 'test') {
  setInterval(runInfoRequestReminderCron, 6 * 60 * 60 * 1000); // every 6 hours
}
// Expose a manual trigger for tests/admin
app.post('/api/info-requests/run-cron', requireRole('Super Admin'), (req, res) => {
  runInfoRequestReminderCron();
  res.json({ success: true, ran_at: new Date().toISOString() });
});
// ─── end Phase 3 ───

// User Management (Phase 2: extended with authority tier, SA/loading caps, specialties)
const VALID_ROLES = ['Super Admin', 'UW Admin', 'Vendor User', 'Viewer', 'Junior UW', 'Senior UW', 'Chief UW', 'Medical Officer', 'UW'];
const VALID_TIERS = ['junior', 'senior', 'chief', 'medical_officer'];
const VALID_SPECIALTIES = ['general', 'metabolic', 'cardiac', 'renal', 'hepatic', 'oncology', 'neurological', 'reinsurance'];

app.get('/api/users', requireRole('Super Admin','UW Admin'), async (req, res) => { try { res.json(await getActiveUsers()); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post('/api/users', requireRole('Super Admin'), async (req, res) => {
  try {
    const { email, name, role, vendor_id, authority_tier, authority_limit_sa, authority_limit_loading_pct, specialties, max_concurrent_cases } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'email and role required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role. Must be one of: ' + VALID_ROLES.join(', ') });
    if (role === 'Vendor User' && !vendor_id) return res.status(400).json({ error: 'vendor_id required for Vendor User role' });
    if (authority_tier && !VALID_TIERS.includes(authority_tier)) return res.status(400).json({ error: 'Invalid authority_tier. Must be one of: ' + VALID_TIERS.join(', ') });
    if (specialties && !Array.isArray(specialties)) return res.status(400).json({ error: 'specialties must be an array' });
    if (specialties) {
      const invalidSpecs = specialties.filter(s => !VALID_SPECIALTIES.includes(s));
      if (invalidSpecs.length) return res.status(400).json({ error: 'Invalid specialties: ' + invalidSpecs.join(', ') + '. Valid: ' + VALID_SPECIALTIES.join(', ') });
    }
    const users = await getActiveUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'User already exists' });
    users.push({
      email: email.toLowerCase(), name: name||'', role, vendor_id: vendor_id||null, status: 'active', created_at: new Date().toISOString(),
      // Phase 2 routing fields
      authority_tier: authority_tier || null,
      authority_limit_sa: authority_limit_sa || null,
      authority_limit_loading_pct: authority_limit_loading_pct || null,
      specialties: specialties || null,
      max_concurrent_cases: max_concurrent_cases || null,
      out_of_office_until: null
    });
    await s3Client.saveUsers(users);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:email', requireRole('Super Admin'), async (req, res) => {
  try {
    const { role, vendor_id, status, name, authority_tier, authority_limit_sa, authority_limit_loading_pct, specialties, max_concurrent_cases, out_of_office_until } = req.body;
    if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (authority_tier && !VALID_TIERS.includes(authority_tier)) return res.status(400).json({ error: 'Invalid authority_tier' });
    if (specialties && !Array.isArray(specialties)) return res.status(400).json({ error: 'specialties must be an array' });
    const users = await getActiveUsers();
    const user = users.find(u => u.email.toLowerCase() === req.params.email.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email.toLowerCase() === (process.env.SUPER_ADMIN_EMAIL||'').toLowerCase()) return res.status(403).json({ error: 'Cannot modify Super Admin account' });
    if (role) user.role = role;
    if (vendor_id !== undefined) user.vendor_id = vendor_id;
    if (status) user.status = status;
    if (name) user.name = name;
    if (authority_tier !== undefined) user.authority_tier = authority_tier;
    if (authority_limit_sa !== undefined) user.authority_limit_sa = authority_limit_sa;
    if (authority_limit_loading_pct !== undefined) user.authority_limit_loading_pct = authority_limit_loading_pct;
    if (specialties !== undefined) user.specialties = specialties;
    if (max_concurrent_cases !== undefined) user.max_concurrent_cases = max_concurrent_cases;
    if (out_of_office_until !== undefined) user.out_of_office_until = out_of_office_until;
    user.updated_at = new Date().toISOString();
    await s3Client.saveUsers(users);
    res.json({ success: true, user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:email', requireRole('Super Admin'), async (req, res) => {
  try {
    if (req.params.email.toLowerCase() === (process.env.SUPER_ADMIN_EMAIL||'').toLowerCase()) return res.status(403).json({ error: 'Cannot delete Super Admin' });
    let users = await getActiveUsers();
    users = users.filter(u => u.email.toLowerCase() !== req.params.email.toLowerCase());
    await s3Client.saveUsers(users);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Phase 2: UW Routing endpoints ───

// Compute current load per UW email from non-terminal workflows
function computeUWLoadMap() {
  const terminalStates = new Set(['policy_issued', 'customer_notified', 'auto_rejected', 'uw_rejected', 'auto_issued']);
  const all = workflowEngine.listWorkflows({});
  const map = {};
  for (const w of all) {
    if (!w.assigned_uw_email) continue;
    if (terminalStates.has(w.state)) continue;
    const key = w.assigned_uw_email.toLowerCase();
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

// GET /api/uw/tiers — expose tier config for admin UI
app.get('/api/uw/tiers', requireAuth, (req, res) => {
  const tiers = uwRouter.loadTiers();
  if (!tiers) return res.status(500).json({ error: 'UW tiers config not available' });
  res.json(tiers);
});

// GET /api/uw/workload — per-UW active load (Super Admin, UW Admin)
app.get('/api/uw/workload', requireRole('Super Admin', 'UW Admin'), async (req, res) => {
  try {
    const users = await getActiveUsers();
    const loadMap = computeUWLoadMap();
    const uwRoles = new Set(['UW Admin', 'Junior UW', 'Senior UW', 'Chief UW', 'Medical Officer', 'UW']);
    const uwUsers = users.filter(u => uwRoles.has(u.role) || u.authority_tier);
    const workload = uwUsers.map(u => ({
      email: u.email,
      name: u.name,
      role: u.role,
      authority_tier: u.authority_tier || null,
      current_load: loadMap[u.email.toLowerCase()] || 0,
      max_concurrent_cases: u.max_concurrent_cases || null,
      specialties: u.specialties || null,
      status: u.status,
      out_of_office_until: u.out_of_office_until || null
    }));
    res.json({ workload, total_uws: uwUsers.length, total_active_assignments: Object.values(loadMap).reduce((a, b) => a + b, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/my-queue — workflows assigned to authenticated user
app.get('/api/my-queue', requireAuth, (req, res) => {
  const email = (req.user?.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'User email not available' });
  const filters = { assigned_uw_email: email };
  if (req.query.state) filters.state = req.query.state;
  const list = workflowEngine.listWorkflows(filters);
  res.json(list);
});

// GET /api/uw/inbox-stats — counts by state for the authenticated user's queue
app.get('/api/uw/inbox-stats', requireAuth, (req, res) => {
  const email = (req.user?.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'User email not available' });
  const mine = workflowEngine.listWorkflows({ assigned_uw_email: email });
  const byState = {};
  const byPriority = { high: 0, medium: 0, standard: 0 };
  for (const w of mine) {
    byState[w.state] = (byState[w.state] || 0) + 1;
    const prio = w.ai_analysis?.referral?.priority || 'standard';
    byPriority[prio] = (byPriority[prio] || 0) + 1;
  }
  const overdue = mine.filter(w => !w.tat_completed_at && new Date() > new Date(w.sla_deadline)).length;
  res.json({
    total: mine.length,
    by_state: byState,
    by_priority: byPriority,
    overdue,
    email
  });
});

// POST /api/workflow/:id/classify — run specialty classifier without assigning (for UI preview)
app.post('/api/workflow/:id/classify', requireAuth, (req, res) => {
  const w = workflowEngine.getWorkflow(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const classification = uwRouter.classifyCaseSpecialty(w);
  res.json(classification);
});

// POST /api/workflow/:id/auto-assign — trigger routing manually (normally fires automatically in transitionState hook)
app.post('/api/workflow/:id/auto-assign', requireRole('Super Admin', 'UW Admin'), async (req, res) => {
  try {
    const w = workflowEngine.getWorkflow(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const users = await getActiveUsers();
    const loadMap = computeUWLoadMap();
    const result = uwRouter.assignToUnderwriter(w, users, null, loadMap);
    if (!result.success) return res.status(422).json({ error: result.reason, classification: result.classification });
    // Write assignment to workflow
    workflowEngine.updateWorkflowFields(w.id, {
      assigned_uw_email: result.assigned_email,
      assigned_uw_tier: result.assigned_tier,
      assigned_uw_at: result.assigned_at,
      uw_classification: result.classification,
      assignment_reason: result.reason
    }, req.user?.email || 'system');
    socketManager.emitGlobal('uw_assigned', { workflow_id: w.id, assigned_uw_email: result.assigned_email, tier: result.assigned_tier });
    res.json({ success: true, assignment: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/workflow/:id/reassign-uw — manual UW reassignment (Super Admin / UW Admin override)
app.post('/api/workflow/:id/reassign-uw', requireRole('Super Admin', 'UW Admin'), async (req, res) => {
  try {
    const { new_uw_email, reason } = req.body;
    if (!new_uw_email || !reason) return res.status(400).json({ error: 'new_uw_email and reason required' });
    const w = workflowEngine.getWorkflow(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const users = await getActiveUsers();
    const target = users.find(u => u.email.toLowerCase() === new_uw_email.toLowerCase() && u.status === 'active');
    if (!target) return res.status(404).json({ error: 'Target UW not found or inactive' });
    const prev = w.assigned_uw_email;
    workflowEngine.updateWorkflowFields(w.id, {
      assigned_uw_email: new_uw_email.toLowerCase(),
      assigned_uw_tier: target.authority_tier || null,
      assigned_uw_at: new Date().toISOString(),
      assignment_reason: `Manually reassigned from ${prev || 'unassigned'} to ${new_uw_email}: ${reason}`,
      uw_reassignment_history: [...(w.uw_reassignment_history || []), { from: prev, to: new_uw_email.toLowerCase(), reason, at: new Date().toISOString(), by: req.user?.email || 'system' }]
    }, req.user?.email || 'system');
    socketManager.emitGlobal('uw_reassigned', { workflow_id: w.id, from: prev, to: new_uw_email });
    res.json({ success: true, workflow: workflowEngine.getWorkflow(w.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/workflow/:id/escalate — UW kicks the case up a tier with reason
app.post('/api/workflow/:id/escalate', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const w = workflowEngine.getWorkflow(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.assigned_uw_email && w.assigned_uw_email.toLowerCase() !== (req.user?.email || '').toLowerCase()) {
      // Allow admins to escalate others' cases
      if (!['Super Admin', 'UW Admin'].includes(req.user?.role)) {
        return res.status(403).json({ error: 'Can only escalate cases assigned to you' });
      }
    }
    // Bump the recommended tier in classification and re-assign
    const users = await getActiveUsers();
    const loadMap = computeUWLoadMap();
    const tiers = uwRouter.loadTiers();
    const tierOrder = ['junior', 'senior', 'chief', 'medical_officer'];
    const currentTier = w.assigned_uw_tier || 'junior';
    const nextIdx = Math.min(tierOrder.indexOf(currentTier) + 1, tierOrder.length - 1);
    const nextTier = tierOrder[nextIdx];

    // Force a classification that insists on the next tier
    const classification = uwRouter.classifyCaseSpecialty(w, tiers);
    classification.recommended_tier = nextTier;
    classification.escalated_from = currentTier;
    classification.escalation_reason = reason;

    // Temp-assign this classification to the workflow object for the router call
    const wForRouting = { ...w, ai_analysis: { ...w.ai_analysis, referral: { ...(w.ai_analysis?.referral || {}), priority: 'high' } } };
    const result = uwRouter.assignToUnderwriter(wForRouting, users, tiers, loadMap);
    if (!result.success) {
      return res.status(422).json({ error: `Escalation failed: ${result.reason}`, classification });
    }
    const prev = w.assigned_uw_email;
    workflowEngine.updateWorkflowFields(w.id, {
      assigned_uw_email: result.assigned_email,
      assigned_uw_tier: result.assigned_tier,
      assigned_uw_at: result.assigned_at,
      uw_classification: classification,
      assignment_reason: `Escalated from ${currentTier} (${prev}) to ${result.assigned_tier} (${result.assigned_email}): ${reason}`,
      uw_reassignment_history: [...(w.uw_reassignment_history || []), { from: prev, to: result.assigned_email, reason: `Escalation: ${reason}`, at: new Date().toISOString(), by: req.user?.email || 'system', type: 'escalation' }]
    }, req.user?.email || 'system');
    socketManager.emitGlobal('uw_escalated', { workflow_id: w.id, from_tier: currentTier, to_tier: result.assigned_tier });
    res.json({ success: true, assignment: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─── end Phase 2 UW routing endpoints ───

// Legacy assessment endpoints removed — all data now in workflow system

// ─── Phase 4: Integration init + Webhook endpoints ───
commsDispatcher.init();
webhookDispatcher.init(s3Client);

// Webhook CRUD (Super Admin only)
app.get('/api/webhooks', requireRole('Super Admin'), (req, res) => res.json(webhookDispatcher.list()));
app.post('/api/webhooks', requireRole('Super Admin'), (req, res) => {
  const { name, url, secret, events } = req.body;
  if (!name || !url || !Array.isArray(events)) return res.status(400).json({ error: 'name, url, events[] required' });
  res.json(webhookDispatcher.add({ name, url, secret, events }));
});
app.put('/api/webhooks/:id', requireRole('Super Admin'), (req, res) => {
  const result = webhookDispatcher.update(req.params.id, req.body);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});
app.delete('/api/webhooks/:id', requireRole('Super Admin'), (req, res) => {
  webhookDispatcher.remove(req.params.id);
  res.json({ success: true });
});
app.post('/api/webhooks/:id/test', requireRole('Super Admin'), async (req, res) => {
  const result = await webhookDispatcher.test(req.params.id);
  res.json(result);
});
app.get('/api/webhooks/retry-queue', requireRole('Super Admin'), (req, res) => res.json(webhookDispatcher.getRetryQueue()));

// Integration health
app.get('/api/health/integrations', requireAuth, (req, res) => {
  res.json({
    email: process.env.SES_REGION ? { provider: 'ses', region: process.env.SES_REGION, from: process.env.SES_FROM_EMAIL || 'noreply@acc.ltd' } : { provider: 'console' },
    sms: process.env.SMS_PROVIDER ? { provider: process.env.SMS_PROVIDER, sender: process.env.SMS_SENDER_ID } : { provider: 'console' },
    whatsapp: process.env.WHATSAPP_PROVIDER ? { provider: process.env.WHATSAPP_PROVIDER } : { provider: 'console' },
    pas: { provider: pasAdapter.getProviderName() },
    webhooks: { count: webhookDispatcher.list().length, retry_queue: webhookDispatcher.getRetryQueue().length },
    s3: { enabled: !!process.env.AWS_ACCESS_KEY_ID, bucket: process.env.S3_BUCKET || 'acc-insurance-uw' }
  });
});

// Phase 4: webhook dispatch hook — fires on decision-relevant state transitions
workflowEngine.registerTransitionHook(async (workflow, newState, oldState) => {
  const webhookEvents = {
    'auto_approved': 'policy_approved',
    'auto_rejected': 'policy_rejected',
    'auto_issued': 'policy_issued',
    'uw_approved': 'policy_approved',
    'uw_rejected': 'policy_rejected',
    'counter_offered': 'counter_offer',
    'referred': 'case_referred',
    'policy_issued': 'policy_issued',
    'awaiting_additional_info': 'info_requested'
  };
  const event = webhookEvents[newState];
  if (event) {
    try { webhookDispatcher.dispatch(workflow, event); } catch (e) { console.error('[Webhook hook]', e.message); }
  }
});
// ─── end Phase 4 ───

if (process.env.REDIS_URL) bullQueue.startWorker();

// Initialize S3 persistence for workflows + custom rules
// S3 persistence — works via IAM role on EC2, no static keys needed
workflowEngine.initPersistence(s3Client);
workflowEngine.loadFromS3().then(count => {
  console.log(`[Startup] ${count} workflows restored from S3`);
}).catch(e => console.error('[Startup] S3 workflow load failed:', e.message));
s3Client.getCustomRules().then(rules => {
  if (rules.length) { customRules.push(...rules); console.log(`[Startup] ${rules.length} custom UW rules loaded from S3`); }
}).catch(e => console.error('[Startup] Custom rules load failed:', e.message));

// Phase 0 fix: product/policy seeding runs unconditionally so dev and test modes have the full catalog
// loadProductPolicyConfig seeds defaults if S3 is empty or unavailable
loadProductPolicyConfig().catch(e => console.error('[Startup] Product-policy load failed:', e.message));
  loadHistoricalCorpus().catch(e => console.error('[Startup] Historical corpus load failed:', e.message));

// Phase 2: register UW auto-routing hook. Fires when a workflow enters `referred` or `awaiting_additional_info`.
// Hook is async but best-effort — failures log but don't block the state transition.
workflowEngine.registerTransitionHook(async (workflow, newState, oldState) => {
  const routingStates = new Set(['referred', 'uw_reviewing', 'awaiting_additional_info']);
  if (!routingStates.has(newState)) return;
  // Don't re-route if already assigned (e.g. awaiting_additional_info → uw_reviewing after customer responds)
  if (workflow.assigned_uw_email) return;

  try {
    const users = await getActiveUsers();
    if (!users || users.length === 0) {
      console.log(`[UW Router] No users in system — skipping auto-assignment for ${workflow.id}`);
      return;
    }
    const loadMap = computeUWLoadMap();
    const result = uwRouter.assignToUnderwriter(workflow, users, null, loadMap);
    if (!result.success) {
      console.log(`[UW Router] Assignment failed for ${workflow.id}: ${result.reason}`);
      workflowEngine.updateWorkflowFields(workflow.id, {
        routing_failed: true,
        routing_failure_reason: result.reason,
        uw_classification: result.classification
      }, 'uw_router');
      socketManager.emitGlobal('routing_failed', { workflow_id: workflow.id, reason: result.reason });
      return;
    }
    workflowEngine.updateWorkflowFields(workflow.id, {
      assigned_uw_email: result.assigned_email,
      assigned_uw_tier: result.assigned_tier,
      assigned_uw_at: result.assigned_at,
      uw_classification: result.classification,
      assignment_reason: result.reason,
      routing_failed: false
    }, 'uw_router');
    socketManager.emitGlobal('uw_assigned', {
      workflow_id: workflow.id,
      assigned_uw_email: result.assigned_email,
      tier: result.assigned_tier,
      specialty: result.classification?.primary_specialty,
      complexity: result.classification?.complexity_score
    });
    console.log(`[UW Router] Workflow ${workflow.id} → ${result.assigned_tier} ${result.assigned_email} (${result.classification?.primary_specialty}, complexity ${result.classification?.complexity_score})`);
  } catch (e) {
    console.error(`[UW Router] Hook error for workflow ${workflow.id}:`, e.message);
  }
});

server.listen(PORT, () => { console.log(`\n=== ACC Health UW Automation v4.0.0 ===\nPort ${PORT} | ${NODE_ENV} | Vendors: ${Object.keys(vendorApi.VENDORS).length} | S3: ${!!process.env.AWS_ACCESS_KEY_ID}\nFeatures: STP fast-lane | Custom rules enforced | UW routing\n`); });
module.exports = app;