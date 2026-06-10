#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# SBI UW — Extraction Failure Diagnostic Script
# Run: bash diagnose_extraction.sh
# Output saved to: ~/extraction_diagnosis_TIMESTAMP.txt
# ─────────────────────────────────────────────────────────────────────────────

OUTFILE="$HOME/extraction_diagnosis_$(date +%Y%m%d_%H%M%S).txt"
SEP="================================================================"

log() { echo "$1" | tee -a "$OUTFILE"; }

log "$SEP"
log " SBI UW — Extraction Failure Diagnosis"
log " $(date)"
log " Output: $OUTFILE"
log "$SEP"

# ── 1. Container Status ───────────────────────────────────────────────────────
log ""
log "--- 1. CONTAINER STATUS ---"
sudo docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>&1 | tee -a "$OUTFILE"

# ── 2. Environment Variables ──────────────────────────────────────────────────
log ""
log "--- 2. ENVIRONMENT VARIABLES (masked) ---"
sudo docker exec sbi-backend node -e "
const vars = {
  AWS_ACCESS_KEY_ID:           process.env.AWS_ACCESS_KEY_ID       ? 'SET (' + process.env.AWS_ACCESS_KEY_ID.substring(0,4) + '...)' : 'NOT SET — lazy-load will FAIL',
  AWS_SECRET_ACCESS_KEY:       process.env.AWS_SECRET_ACCESS_KEY   ? 'SET' : 'NOT SET',
  AWS_REGION:                  process.env.AWS_REGION              || 'NOT SET',
  BEDROCK_REGION:              process.env.BEDROCK_REGION          || 'NOT SET',
  BEDROCK_MODEL_ID:            process.env.BEDROCK_MODEL_ID        || 'NOT SET',
  BEDROCK_INFERENCE_PROFILE:   process.env.BEDROCK_INFERENCE_PROFILE || 'NOT SET',
  BEDROCK_CROSS_ACCOUNT_ROLE:  process.env.BEDROCK_CROSS_ACCOUNT_ROLE_ARN ? 'SET (' + process.env.BEDROCK_CROSS_ACCOUNT_ROLE_ARN + ')' : 'NOT SET',
  S3_BUCKET:                   process.env.S3_BUCKET               || 'NOT SET',
  DATABASE_URL:                process.env.DATABASE_URL            ? 'SET' : 'NOT SET',
  SKIP_AUTH:                   process.env.SKIP_AUTH               || 'NOT SET',
  NODE_TLS_REJECT_UNAUTHORIZED:process.env.NODE_TLS_REJECT_UNAUTHORIZED || 'NOT SET',
};
Object.entries(vars).forEach(([k,v]) => console.log(k + ': ' + v));
" 2>&1 | tee -a "$OUTFILE"

# ── 3. STS AssumeRole Test ────────────────────────────────────────────────────
log ""
log "--- 3. STS ASSUMEROLE TEST ---"
sudo docker exec sbi-backend node -e "
require('dotenv').config();
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const roleArn = process.env.BEDROCK_CROSS_ACCOUNT_ROLE_ARN;
if (!roleArn) {
  console.log('SKIP — BEDROCK_CROSS_ACCOUNT_ROLE_ARN not set, using instance credentials directly');
  process.exit(0);
}
const sts = new STSClient({ region: process.env.BEDROCK_REGION || 'ap-south-1' });
sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'diag-test', DurationSeconds: 900 }))
  .then(r => {
    console.log('STS AssumeRole: SUCCESS');
    console.log('  AccessKeyId (prefix):', r.Credentials.AccessKeyId.substring(0,8) + '...');
    console.log('  Expiration:', r.Credentials.Expiration);
  })
  .catch(e => {
    console.log('STS AssumeRole: FAILED');
    console.log('  Error name:', e.name);
    console.log('  Error message:', e.message);
    console.log('  Fix: Check trust policy on role', roleArn, '— must trust EC2 instance role or the calling principal');
  });
" 2>&1 | tee -a "$OUTFILE"

# ── 4. Bedrock Endpoint Reachability ─────────────────────────────────────────
log ""
log "--- 4. BEDROCK ENDPOINT REACHABILITY ---"
sudo docker exec sbi-backend node -e "
const https = require('https');
const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-south-1';
const hostname = 'bedrock-runtime.' + region + '.amazonaws.com';
console.log('Testing:', hostname + ':443');
const req = https.request({ hostname, port: 443, path: '/', method: 'GET', timeout: 8000,
  rejectUnauthorized: false
}, r => console.log('Reachable: HTTP', r.statusCode, '— network OK'));
req.on('error',   e => console.log('UNREACHABLE — Error:', e.message, '| Check VPC Security Group / NACLs / VPC Endpoint'));
req.on('timeout', () => { console.log('TIMEOUT — Port 443 blocked. Check SG outbound rules or add Bedrock VPC Endpoint'); req.destroy(); });
req.end();
" 2>&1 | tee -a "$OUTFILE"

# ── 5. STS Endpoint Reachability ─────────────────────────────────────────────
log ""
log "--- 5. STS ENDPOINT REACHABILITY ---"
sudo docker exec sbi-backend node -e "
const https = require('https');
const region = process.env.BEDROCK_REGION || 'ap-south-1';
const hostname = 'sts.' + region + '.amazonaws.com';
console.log('Testing:', hostname + ':443');
const req = https.request({ hostname, port: 443, path: '/', method: 'GET', timeout: 8000,
  rejectUnauthorized: false
}, r => console.log('Reachable: HTTP', r.statusCode, '— network OK'));
req.on('error',   e => console.log('UNREACHABLE — Error:', e.message));
req.on('timeout', () => { console.log('TIMEOUT — STS endpoint blocked'); req.destroy(); });
req.end();
" 2>&1 | tee -a "$OUTFILE"

# ── 6. S3 Bucket Access Test ─────────────────────────────────────────────────
log ""
log "--- 6. S3 BUCKET ACCESS TEST ---"
sudo docker exec sbi-backend node -e "
require('dotenv').config();
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const bucket = process.env.S3_BUCKET;
if (!bucket) { console.log('SKIP — S3_BUCKET not set'); process.exit(0); }
const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
const testKey = 'diag-test-' + Date.now() + '.txt';
async function run() {
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: testKey, Body: 'diag-test', ContentType: 'text/plain' }));
    console.log('S3 PutObject: SUCCESS');
    await s3.send(new GetObjectCommand({ Bucket: bucket, Key: testKey }));
    console.log('S3 GetObject: SUCCESS');
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: testKey }));
    console.log('S3 DeleteObject: SUCCESS');
    console.log('S3 bucket', bucket, ': FULLY ACCESSIBLE');
  } catch(e) {
    console.log('S3 FAILED:', e.name, '|', e.message);
    console.log('Bucket:', bucket);
  }
}
run();
" 2>&1 | tee -a "$OUTFILE"

# ── 7. Full Bedrock Inference Test ───────────────────────────────────────────
log ""
log "--- 7. BEDROCK FULL INFERENCE TEST ---"
sudo docker exec sbi-backend node -e "
require('dotenv').config();
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');

async function test() {
  const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-south-1';
  const roleArn = process.env.BEDROCK_CROSS_ACCOUNT_ROLE_ARN;
  const modelId = process.env.BEDROCK_INFERENCE_PROFILE || process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';
  console.log('Model/Profile ID:', modelId);
  console.log('Region:', region);

  let client;
  if (roleArn) {
    console.log('Using cross-account role:', roleArn);
    try {
      const sts = new STSClient({ region });
      const r = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'diag', DurationSeconds: 900 }));
      client = new BedrockRuntimeClient({ region, credentials: {
        accessKeyId: r.Credentials.AccessKeyId,
        secretAccessKey: r.Credentials.SecretAccessKey,
        sessionToken: r.Credentials.SessionToken
      }});
      console.log('Credentials assumed successfully');
    } catch(e) {
      console.log('AssumeRole failed:', e.name, e.message);
      console.log('Falling back to instance credentials');
      client = new BedrockRuntimeClient({ region });
    }
  } else {
    console.log('No cross-account role — using instance credentials');
    client = new BedrockRuntimeClient({ region });
  }

  try {
    const start = Date.now();
    const res = await client.send(new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Reply with exactly: BEDROCK_OK' }]
      })
    }));
    const out = JSON.parse(Buffer.from(res.body).toString());
    const text = out.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
    console.log('Bedrock InvokeModel: SUCCESS (' + (Date.now()-start) + 'ms)');
    console.log('Response:', text.trim());
  } catch(e) {
    console.log('Bedrock InvokeModel: FAILED');
    console.log('  Error name:', e.name);
    console.log('  Error message:', e.message);
    if (e.name === 'AccessDeniedException')    console.log('  Fix: Role lacks bedrock:InvokeModel on model/profile ARN');
    if (e.name === 'ResourceNotFoundException') console.log('  Fix: Model/inference profile ARN not found in this region');
    if (e.name === 'ValidationException')       console.log('  Fix: Model ID format wrong or model not available in region');
    if (e.message?.includes('Could not load'))  console.log('  Fix: Instance has no IAM role attached or role has no Bedrock permissions');
  }
}
test();
" 2>&1 | tee -a "$OUTFILE"

# ── 8. Document In-Memory State Check ────────────────────────────────────────
log ""
log "--- 8. DOCUMENT CONTENT IN MEMORY CHECK ---"
sudo docker exec sbi-backend node -e "
// Check if any workflows exist and if their docs have base64_data
const path = require('path');
try {
  const wfEngine = require('/app/lib/workflow-engine');
  const all = wfEngine.getAllWorkflows ? wfEngine.getAllWorkflows() : [];
  if (!all || all.length === 0) {
    console.log('No workflows in memory');
  } else {
    const recent = all.slice(-3);
    recent.forEach(wf => {
      const docs = wf.documents || [];
      const withData    = docs.filter(d => d.base64_data).length;
      const withContent = docs.filter(d => d.has_content).length;
      console.log('WF:', wf.proposal_id || wf.id, '| state:', wf.state, '| docs:', docs.length, '| with base64:', withData, '| has_content flag:', withContent);
      if (withContent > 0 && withData === 0) {
        console.log('  !! PROBLEM: has_content=true but base64_data missing — lazy-load will be needed');
        console.log('  !! AWS_ACCESS_KEY_ID set?', process.env.AWS_ACCESS_KEY_ID ? 'YES' : 'NO — lazy-load will be SKIPPED');
      }
    });
  }
} catch(e) { console.log('Could not inspect workflows:', e.message); }
" 2>&1 | tee -a "$OUTFILE"

# ── 9. Recent Backend Logs ────────────────────────────────────────────────────
log ""
log "--- 9. RECENT BACKEND LOGS (extraction related) ---"
sudo docker logs sbi-backend --tail 100 2>&1 | grep -E "extract|Extract|Claude|Bedrock|STS|AssumeRole|Error|error|FAIL|failed|timeout|base64|document|s3|S3" | tail -40 | tee -a "$OUTFILE"

# ── 10. Raw Last 50 Backend Log Lines ────────────────────────────────────────
log ""
log "--- 10. LAST 50 BACKEND LOG LINES (raw) ---"
sudo docker logs sbi-backend --tail 50 2>&1 | tee -a "$OUTFILE"

# ── 11. Memory & Resource Usage ──────────────────────────────────────────────
log ""
log "--- 11. MEMORY & RESOURCE USAGE ---"
sudo docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.MemPerc}}" 2>&1 | tee -a "$OUTFILE"

# ── 12. Nginx Config (upload size) ───────────────────────────────────────────
log ""
log "--- 12. NGINX UPLOAD LIMITS ---"
sudo docker exec sbi-frontend nginx -T 2>/dev/null | grep -E "client_max_body|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout" | tee -a "$OUTFILE"

# ── 13. Multer Upload Limit in server.js ─────────────────────────────────────
log ""
log "--- 13. MULTER FILE SIZE LIMIT ---"
sudo docker exec sbi-backend grep -E "fileSize|fileSizeMB|base64SizeMB|too large|FILE TOO LARGE|50 \* 1024|100 \* 1024" /app/server.js 2>&1 | head -5 | tee -a "$OUTFILE"

# ─────────────────────────────────────────────────────────────────────────────
log ""
log "$SEP"
log " DIAGNOSIS COMPLETE"
log " Full output saved to: $OUTFILE"
log "$SEP"
echo ""
echo "Share the file at: $OUTFILE"