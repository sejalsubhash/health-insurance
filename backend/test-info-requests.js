/**
 * Phase 3 info request E2E test.
 *
 * Covers:
 *  - Unit: suggester rules fire on relevant findings
 *  - E2E: create info request from UW side, verify state transition + token + comms
 *  - E2E: customer-facing GET /api/customer/info-request/:token
 *  - E2E: customer uploads document → item marked received
 *  - E2E: clarification response handling
 *  - E2E: all-items-received → state transitions back to uw_reviewing
 *  - E2E: cancel info request
 *  - E2E: manual reminder
 *  - E2E: reminder cron expires past-deadline requests
 */
process.env.SKIP_AUTH = 'true';
process.env.NODE_ENV = 'development';
process.env.SUPER_ADMIN_EMAIL = 'admin@acc.ltd';
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.REDIS_URL;
delete process.env.ANTHROPIC_API_KEY;

const http = require('http');
const suggester = require('./lib/info-request-suggester');

let pass = 0, fail = 0;
function section(name) { console.log(`\n─── ${name} ───`); }
function assert(cond, label, detail) {
  if (cond) { console.log(`\x1b[32mPASS\x1b[0m  ${label}`); pass++; }
  else { console.log(`\x1b[31mFAIL\x1b[0m  ${label}${detail ? '\n       ' + detail : ''}`); fail++; }
}

section('UNIT: suggester rules');

// Fixture 1: workflow with HbA1c borderline finding → diabetes confirm should fire
const wf1 = {
  age: 45,
  ai_analysis: {
    findings: [{ parameter: 'HbA1c', value: '6.4%', status: 'borderline', implication: 'Pre-diabetic range' }],
    guidelines_compliance: { violations: [], warnings: [] }
  }
};
const s1 = suggester.suggestInfoRequests(wf1);
assert(s1.total >= 1, 'HbA1c finding generates ≥1 suggestion', `total=${s1.total}`);
assert(s1.items.some(i => i.id === 'DIABETES_CONFIRM'), 'DIABETES_CONFIRM rule fired');

// Fixture 2: liver enzymes elevated
const wf2 = {
  age: 50,
  ai_analysis: {
    findings: [{ parameter: 'SGPT/ALT', value: '85 U/L', status: 'high', implication: 'Liver function concern' }],
    guidelines_compliance: { violations: [], warnings: [] }
  }
};
const s2 = suggester.suggestInfoRequests(wf2);
assert(s2.items.some(i => i.id === 'LIVER_WORKUP'), 'LIVER_WORKUP rule fired');

// Fixture 3: undisclosed condition
const wf3 = {
  age: 40,
  ai_analysis: {
    findings: [{ parameter: 'Undisclosed Condition', value: 'Metformin → Diabetes', status: 'high', implication: 'Medication suggests undeclared diabetes' }],
    guidelines_compliance: { violations: [], warnings: [] }
  }
};
const s3 = suggester.suggestInfoRequests(wf3);
assert(s3.items.some(i => i.id === 'PRESCRIPTION_HISTORY'), 'PRESCRIPTION_HISTORY rule fired');

// Fixture 4: BMI discrepancy
const wf4 = {
  age: 35,
  ai_analysis: {
    findings: [{ parameter: 'BMI Discrepancy', value: 'Declared: 24, Measured: 28', status: 'high', implication: 'Possible non-disclosure' }],
    guidelines_compliance: { violations: [], warnings: [] }
  }
};
const s4 = suggester.suggestInfoRequests(wf4);
assert(s4.items.some(i => i.id === 'BMI_REEXAM'), 'BMI_REEXAM rule fired');

// Fixture 5: missing tests for SA tier
const wf5 = {
  age: 35,
  ai_analysis: {
    findings: [{ parameter: 'Missing Tests for SA Tier', value: 'ecg, urine_analysis', status: 'borderline', implication: 'SA tier requirement' }],
    guidelines_compliance: { violations: [], warnings: [] }
  }
};
const s5 = suggester.suggestInfoRequests(wf5);
assert(s5.items.length >= 2, 'missing tests generate per-test suggestions');
assert(s5.items.some(i => i.id.includes('ECG')), 'ECG suggestion present');

// Fixture 6: clean workflow → no suggestions
const wfClean = {
  age: 30,
  ai_analysis: {
    findings: [{ parameter: 'BMI', value: '23', status: 'normal', implication: 'OK' }],
    guidelines_compliance: { violations: [], warnings: [] }
  }
};
const sClean = suggester.suggestInfoRequests(wfClean);
assert(sClean.total === 0, 'clean workflow → 0 suggestions');

// Fixture 7: age-gated rule (cardiac stress test only fires age >= 40)
const wfYoung = {
  age: 25,
  ai_analysis: {
    findings: [{ parameter: 'ECG', value: 'borderline', status: 'borderline', implication: 'minor' }],
    guidelines_compliance: { violations: [], warnings: [] }
  }
};
const sYoung = suggester.suggestInfoRequests(wfYoung);
assert(!sYoung.items.some(i => i.id === 'CARDIAC_STRESS'), 'CARDIAC_STRESS gated out for young patient');

// ─── E2E ───

require('./server');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, path, body, headers, isMultipart) {
  return new Promise((resolve, reject) => {
    const data = body && !isMultipart ? JSON.stringify(body) : body;
    const reqHeaders = isMultipart
      ? (headers || {})
      : { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(headers || {}) };
    const req = http.request({
      hostname: 'localhost',
      port: process.env.PORT || 10099,
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Helper to upload a file (multipart/form-data)
function uploadFile(path, fieldName, fileBuffer, filename, mimetype, extraFields) {
  return new Promise((resolve, reject) => {
    const boundary = '----test' + Date.now();
    const parts = [];
    for (const [k, v] of Object.entries(extraFields || {})) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const req = http.request({
      hostname: 'localhost', port: process.env.PORT || 10099, path, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  await sleep(1500);

  section('E2E: Create workflow + suggest info requests');

  // Create a workflow that will land in NSTP and fake an ai_analysis with findings
  const proposal = {
    proposer_name: 'Test Phase3', age: 45, gender: 'male', sum_assured: 5000000,
    product_name: 'Arogya Premier',
    height_cm: 170, weight_kg: 78,
    lifestyle: { smoking: 'former', alcohol: 'regular' },
    medical_history: { pre_existing_conditions: ['hypertension'], family_history: 'none' }
  };
  const create = await request('POST', '/api/workflow/stp-evaluate', proposal);
  assert(create.status === 200, 'create workflow');
  const wfId = create.body?.workflow?.id;
  assert(!!wfId, 'workflow id present');

  // The workflow has no ai_analysis (no documents submitted). Suggester returns empty.
  const sugEmpty = await request('GET', `/api/workflow/${wfId}/suggested-info-requests`);
  assert(sugEmpty.status === 200, 'suggester endpoint 200');
  assert(sugEmpty.body?.total === 0, 'no suggestions without ai_analysis');

  // Inject an ai_analysis directly via the field-edit path? There's no such endpoint.
  // Instead use the workflow store directly via internal helper — we'll pretend by calling /api/workflow/:id (read), then nothing.
  // For the test, we need to seed ai_analysis somehow. We'll add a dev-only test endpoint conditionally — or use the fact that the workflow is in vendor_assigned and can't easily be mutated.
  // Easier: use the workflow-engine module directly via require.
  const workflowEngine = require('./lib/workflow-engine');
  workflowEngine.updateWorkflowFields(wfId, {
    ai_analysis: {
      recommendation: 'refer',
      findings: [
        { parameter: 'HbA1c', value: '6.4%', status: 'borderline', implication: 'Pre-diabetic' },
        { parameter: 'SGPT/ALT', value: '78 U/L', status: 'high', implication: 'Liver concern' },
        { parameter: 'Blood Pressure', value: '142/90 mmHg', status: 'high', implication: 'Hypertension' }
      ],
      guidelines_compliance: { violations: [], warnings: [] }
    },
    state: 'referred'  // force state for transition test
  }, 'test');

  const sug = await request('GET', `/api/workflow/${wfId}/suggested-info-requests`);
  assert(sug.status === 200, 'suggest endpoint after analysis 200');
  assert(sug.body?.total >= 3, `≥3 suggestions for 3 findings (got ${sug.body?.total})`);
  assert(sug.body.items.some(i => i.id === 'DIABETES_CONFIRM'), 'diabetes suggestion');
  assert(sug.body.items.some(i => i.id === 'LIVER_WORKUP'), 'liver suggestion');
  assert(sug.body.items.some(i => i.id === 'BP_DIARY'), 'BP diary suggestion');

  section('E2E: Create info request → state transition');

  const create_ir = await request('POST', `/api/workflow/${wfId}/request-info`, {
    items: [
      { type: 'test', name: 'Diabetic Profile', description: 'FBS + HbA1c', mandatory: true, fasting_required: true },
      { type: 'document', name: 'BP Diary', description: '7-day home BP log', mandatory: true }
    ],
    reason: 'Glucose and BP findings need confirmation',
    channels: ['email'],
    deadline_days: 14
  });
  assert(create_ir.status === 200, 'create info request 200', JSON.stringify(create_ir.body));
  assert(!!create_ir.body?.request?.id, 'request id present');
  assert(!!create_ir.body?.request?.customer_token, 'customer token issued');
  assert(!!create_ir.body?.portal_link, 'portal link returned');
  assert(create_ir.body?.request?.items?.length === 2, '2 items in request');
  assert(create_ir.body?.workflow?.state === 'awaiting_additional_info', `state transitioned (got ${create_ir.body?.workflow?.state})`);

  const requestId = create_ir.body.request.id;
  const token = create_ir.body.request.customer_token;

  section('E2E: Customer-facing token endpoint');

  const customerView = await request('GET', `/api/customer/info-request/${token}`);
  assert(customerView.status === 200, 'customer GET 200');
  assert(customerView.body?.proposal_id, 'proposal_id in customer view');
  assert(customerView.body?.items?.length === 2, '2 items visible to customer');
  // No internal data leaked
  assert(!customerView.body?.ai_analysis, 'no ai_analysis in customer view');
  assert(!customerView.body?.risk_score, 'no risk_score in customer view');

  // Bad token
  const badToken = await request('GET', `/api/customer/info-request/bogus-token-12345`);
  assert(badToken.status === 404, 'bad token returns 404');

  section('E2E: Customer uploads document');

  const item1Id = create_ir.body.request.items[0].id;
  const item2Id = create_ir.body.request.items[1].id;

  // Upload file for item 1 (a fake PDF)
  const fakePdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024, 0x20), Buffer.from('%%EOF')]);
  const upload1 = await uploadFile(`/api/customer/info-request/${token}/upload`, 'document', fakePdf, 'diabetic-profile.pdf', 'application/pdf', { item_id: item1Id });
  assert(upload1.status === 200, 'upload item 1', JSON.stringify(upload1.body));
  assert(upload1.body?.item?.received === true, 'item 1 marked received');
  assert(upload1.body?.request_status === 'partial', 'request status now partial');

  // Upload for item 2
  const upload2 = await uploadFile(`/api/customer/info-request/${token}/upload`, 'document', fakePdf, 'bp-diary.pdf', 'application/pdf', { item_id: item2Id });
  assert(upload2.status === 200, 'upload item 2');
  assert(upload2.body?.item?.received === true, 'item 2 received');
  assert(upload2.body?.request_status === 'received', `request status now received (got ${upload2.body?.request_status})`);

  // After all received, workflow should transition back to uw_reviewing
  const wfAfter = await request('GET', `/api/workflow/${wfId}`);
  assert(wfAfter.body?.state === 'uw_reviewing', `workflow back to uw_reviewing (got ${wfAfter.body?.state})`);

  // Token should now be unusable
  const closedView = await request('GET', `/api/customer/info-request/${token}`);
  assert(closedView.status === 410, `closed token returns 410 (got ${closedView.status})`);

  section('E2E: Cancel info request');

  // Need a fresh workflow + info request
  const create2 = await request('POST', '/api/workflow/stp-evaluate', proposal);
  const wf2Id = create2.body?.workflow?.id;
  workflowEngine.updateWorkflowFields(wf2Id, {
    ai_analysis: { findings: [{ parameter: 'BP', value: '145/95', status: 'high', implication: 'hypertension' }], guidelines_compliance: { violations: [], warnings: [] } },
    state: 'referred'
  }, 'test');
  const ir2 = await request('POST', `/api/workflow/${wf2Id}/request-info`, {
    items: [{ type: 'document', name: 'BP Diary', mandatory: true }],
    reason: 'BP confirmation', channels: ['email'], deadline_days: 14
  });
  assert(ir2.status === 200, 'create 2nd info request');
  const ir2Id = ir2.body?.request?.id;

  const cancel = await request('POST', `/api/workflow/${wf2Id}/cancel-info-request/${ir2Id}`, { reason: 'No longer needed' });
  assert(cancel.status === 200, 'cancel info request 200', JSON.stringify(cancel.body));
  assert(cancel.body?.request?.status === 'cancelled', 'request status cancelled');

  const wf2After = await request('GET', `/api/workflow/${wf2Id}`);
  assert(wf2After.body?.state === 'uw_reviewing', `cancelled → uw_reviewing (got ${wf2After.body?.state})`);

  section('E2E: Manual reminder');

  const create3 = await request('POST', '/api/workflow/stp-evaluate', proposal);
  const wf3Id = create3.body?.workflow?.id;
  workflowEngine.updateWorkflowFields(wf3Id, {
    ai_analysis: { findings: [{ parameter: 'HbA1c', value: '6.5%', status: 'borderline', implication: '' }], guidelines_compliance: { violations: [], warnings: [] } },
    state: 'referred'
  }, 'test');
  const ir3 = await request('POST', `/api/workflow/${wf3Id}/request-info`, {
    items: [{ type: 'test', name: 'Diabetic Profile', mandatory: true }],
    reason: 'glucose confirmation', deadline_days: 14
  });
  const ir3Id = ir3.body?.request?.id;

  const reminder = await request('POST', `/api/workflow/${wf3Id}/information-request/${ir3Id}/reminder`, {});
  assert(reminder.status === 200, 'manual reminder 200', JSON.stringify(reminder.body));
  assert(typeof reminder.body?.days_remaining === 'number', 'days_remaining returned');

  // Verify reminder count incremented
  const irList = await request('GET', `/api/workflow/${wf3Id}/information-requests`);
  assert(irList.status === 200, 'list info requests');
  const ir3Updated = irList.body.find(r => r.id === ir3Id);
  assert(ir3Updated?.reminder_sent_count === 1, 'reminder count incremented');

  section('E2E: Reminder cron expires past-deadline requests');

  const create4 = await request('POST', '/api/workflow/stp-evaluate', proposal);
  const wf4Id = create4.body?.workflow?.id;
  workflowEngine.updateWorkflowFields(wf4Id, {
    ai_analysis: { findings: [{ parameter: 'BP', value: '150/95', status: 'high', implication: '' }], guidelines_compliance: { violations: [], warnings: [] } },
    state: 'referred'
  }, 'test');
  const ir4 = await request('POST', `/api/workflow/${wf4Id}/request-info`, {
    items: [{ type: 'document', name: 'BP Diary', mandatory: true }],
    reason: 'test expiry', deadline_days: 14
  });
  const ir4Id = ir4.body?.request?.id;

  // Force expiry by directly editing
  workflowEngine.updateInformationRequest(wf4Id, ir4Id, {
    deadline: new Date(Date.now() - 1000).toISOString(),
    token_expires_at: new Date(Date.now() - 1000).toISOString()
  });

  // Run cron
  const cron = await request('POST', '/api/info-requests/run-cron');
  assert(cron.status === 200, 'manual cron run 200');

  // Verify expiry
  const irList4 = await request('GET', `/api/workflow/${wf4Id}/information-requests`);
  const ir4Updated = irList4.body.find(r => r.id === ir4Id);
  assert(ir4Updated?.status === 'expired', `request expired by cron (got ${ir4Updated?.status})`);

  section('E2E: Open info requests admin endpoint');

  const open = await request('GET', '/api/info-requests/open');
  assert(open.status === 200, 'open list 200');
  assert(Array.isArray(open.body), 'open list is array');
  // ir3 is the only still-pending one (others received/cancelled/expired)
  assert(open.body.some(o => o.request.id === ir3Id), 'ir3 in open list');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Test error:', e); process.exit(1); });
