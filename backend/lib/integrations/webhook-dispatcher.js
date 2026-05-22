/**
 * Webhook Dispatcher — Phase 4
 *
 * Fires outbound HTTP POSTs on workflow state transitions.
 * Subscriptions stored in S3/memStore via s3Client.
 * Payloads are customer-safe (no internal scoring exposed).
 *
 * Config: managed via /api/webhooks endpoints.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

let s3Client = null;
let subscriptions = []; // { id, name, url, secret, events: ['policy_issued', ...], active: true }

function init(s3) {
  s3Client = s3;
  loadSubscriptions().catch(e => console.error('[Webhooks] Load failed:', e.message));
}

async function loadSubscriptions() {
  if (!s3Client) return;
  try {
    const data = await s3Client.getConfig('webhook-subscriptions');
    if (Array.isArray(data)) {
      subscriptions = data;
      console.log(`[Webhooks] Loaded ${subscriptions.length} subscription(s)`);
    }
  } catch (e) { /* empty is fine */ }
}

async function saveSubscriptions() {
  if (!s3Client) return;
  await s3Client.saveConfig('webhook-subscriptions', subscriptions);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

function sanitizePayload(workflow, event) {
  return {
    event,
    timestamp: new Date().toISOString(),
    workflow_id: workflow.id,
    proposal_id: workflow.proposal_id,
    proposer_name: workflow.proposer_name,
    product_name: workflow.product_name,
    sum_assured: workflow.sum_assured,
    state: workflow.state,
    route_type: workflow.route_type || null,
    policy_number: workflow.policy_number || null,
    decision: workflow.decision?.recommendation || null,
    loading_percentage: workflow.decision?.loading_percentage || null
    // Explicitly no: risk_score, ai_analysis, findings, extracted_data, audit_trail
  };
}

async function fireWebhook(sub, payload) {
  const signature = sub.secret ? sign(payload, sub.secret) : null;
  const data = JSON.stringify(payload);
  const parsedUrl = new URL(sub.url);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = client.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Webhook-Signature': signature || '',
        'X-Webhook-Event': payload.event,
        'User-Agent': 'ACC-Insurance-UW/4.0'
      },
      timeout: 10000
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ success: res.statusCode < 300, status: res.statusCode, response: buf.substring(0, 200) }));
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

// Retry queue (in-memory for simplicity; Phase 7 can use Redis)
const retryQueue = [];
const MAX_RETRIES = 3;

async function dispatch(workflow, event) {
  const matching = subscriptions.filter(s => s.active && s.events.includes(event));
  if (matching.length === 0) return;

  const payload = sanitizePayload(workflow, event);

  for (const sub of matching) {
    const result = await fireWebhook(sub, payload);
    if (!result.success) {
      console.error(`[Webhooks] Failed: ${sub.name} (${sub.url}): ${result.error || result.status}`);
      retryQueue.push({ sub, payload, attempts: 1, next_retry: Date.now() + 30000 });
    }
  }
}

// Retry timer — runs every 30 seconds
setInterval(() => {
  const now = Date.now();
  const pending = retryQueue.filter(r => r.next_retry <= now);
  for (const item of pending) {
    const idx = retryQueue.indexOf(item);
    if (idx >= 0) retryQueue.splice(idx, 1);
    fireWebhook(item.sub, item.payload).then(result => {
      if (!result.success && item.attempts < MAX_RETRIES) {
        retryQueue.push({ ...item, attempts: item.attempts + 1, next_retry: Date.now() + item.attempts * 60000 });
      } else if (!result.success) {
        console.error(`[Webhooks] DROPPED after ${MAX_RETRIES} retries: ${item.sub.name} event=${item.payload.event}`);
      }
    });
  }
}, 30000);

// ─── CRUD for subscriptions ───

function list() { return subscriptions; }

function add(sub) {
  const id = `WH-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const entry = { id, name: sub.name, url: sub.url, secret: sub.secret || '', events: sub.events || [], active: true, created_at: new Date().toISOString() };
  subscriptions.push(entry);
  saveSubscriptions().catch(() => {});
  return entry;
}

function update(id, updates) {
  const sub = subscriptions.find(s => s.id === id);
  if (!sub) return null;
  Object.assign(sub, updates, { updated_at: new Date().toISOString() });
  saveSubscriptions().catch(() => {});
  return sub;
}

function remove(id) {
  subscriptions = subscriptions.filter(s => s.id !== id);
  saveSubscriptions().catch(() => {});
  return true;
}

async function test(id) {
  const sub = subscriptions.find(s => s.id === id);
  if (!sub) return { error: 'Subscription not found' };
  const payload = sanitizePayload({
    id: 'test-workflow', proposal_id: 'TEST-PROP', proposer_name: 'Test User',
    product_name: 'Test Product', sum_assured: 500000, state: 'auto_approved',
    decision: { recommendation: 'accept_standard', loading_percentage: 0 }
  }, 'test_ping');
  return fireWebhook(sub, payload);
}

function getRetryQueue() { return retryQueue.map(r => ({ sub_name: r.sub.name, event: r.payload.event, attempts: r.attempts, next_retry: new Date(r.next_retry).toISOString() })); }

module.exports = { init, dispatch, list, add, update, remove, test, getRetryQueue };
