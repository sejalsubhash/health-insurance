/**
 * End-to-end test for the STP evaluate endpoint.
 * Starts the server in dev mode (SKIP_AUTH=true, no S3, no Redis), fires requests, asserts responses.
 */
process.env.SKIP_AUTH = 'true';
process.env.NODE_ENV = 'development';
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.REDIS_URL;
delete process.env.ANTHROPIC_API_KEY;

const http = require('http');

// Start server
require('./server');

// Wait for listen
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: process.env.PORT || 10000,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${process.env.PORT || 10000}${path}`, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on('error', reject);
  });
}

(async () => {
  await sleep(1500); // server boot

  let pass = 0, fail = 0;
  function assert(cond, label, detail) {
    if (cond) { console.log(`\x1b[32mPASS\x1b[0m  ${label}`); pass++; }
    else { console.log(`\x1b[31mFAIL\x1b[0m  ${label}\n   ${detail || ''}`); fail++; }
  }

  // 1. Health check — new fields
  const h = await get('/health');
  assert(h.status === 200, 'health endpoint 200', h.status);
  assert(h.body.version === '4.0.0', 'version is 4.0.0', h.body.version);
  assert(Array.isArray(h.body.features) && h.body.features.includes('stp_fast_lane'), 'stp_fast_lane feature flag present');

  // 2. STP rules endpoint
  const sr = await get('/api/stp-rules');
  assert(sr.status === 200, 'GET /api/stp-rules 200');
  assert(sr.body?.hard_knockouts?.max_age === 45, 'max_age is 45', JSON.stringify(sr.body?.hard_knockouts));

  // 3. Preview — clean case, STP-enabled product
  const cleanProposal = {
    proposer_name: 'Test Clean', age: 30, gender: 'male', sum_assured: 300000,
    product_name: 'Arogya Sanjeevani',
    height_cm: 172, weight_kg: 68,
    lifestyle: { smoking: 'never', alcohol: 'never', tobacco_chewing: 'never', occupation_hazard: 'none', exercise: 'regular' },
    medical_history: { pre_existing_conditions: [], family_history: 'none', hospitalizations: 0, surgery_types: [] }
  };
  const preview = await post('/api/stp-evaluate-preview', cleanProposal);
  assert(preview.status === 200, 'STP preview 200', preview.body);
  assert(preview.body?.evaluation?.eligible === true, 'clean case eligible', JSON.stringify(preview.body?.evaluation));
  assert(preview.body?.evaluation?.route === 'stp_auto_issue', 'clean case route=stp_auto_issue');
  assert(preview.body?.lightweight_analysis?.risk_score?.normalized >= 85, 'clean case light score ≥85', preview.body?.lightweight_analysis?.risk_score?.normalized);

  // 4. Full STP evaluate — clean case → should auto-issue
  const full = await post('/api/workflow/stp-evaluate', cleanProposal);
  assert(full.status === 200, 'STP evaluate 200', full.body);
  assert(full.body?.route === 'stp_auto_issued', 'route=stp_auto_issued', full.body?.route);
  assert(!!full.body?.policy_number, 'policy number generated', full.body?.policy_number);
  assert(full.body?.workflow?.state === 'auto_issued', 'workflow state=auto_issued', full.body?.workflow?.state);
  assert(full.body?.workflow?.route_type === 'stp_auto_issue', 'workflow route_type=stp_auto_issue');
  assert(!!full.body?.workflow?.stp_evaluation, 'stp_evaluation recorded on workflow');
  assert(full.body?.workflow?.state_history?.some(h => h.state === 'stp_evaluating'), 'stp_evaluating state in history');
  assert(full.body?.workflow?.state_history?.some(h => h.state === 'auto_issued'), 'auto_issued state in history');

  const stpWorkflowId = full.body?.workflow?.id;

  // 5. Blocked case — smoker → should go to NSTP full PPHC
  const smoker = {
    proposer_name: 'Test Smoker', age: 30, gender: 'male', sum_assured: 300000,
    product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68,
    lifestyle: { smoking: 'current' },
    medical_history: { pre_existing_conditions: [] }
  };
  const smokerResp = await post('/api/workflow/stp-evaluate', smoker);
  assert(smokerResp.status === 200, 'smoker evaluate 200');
  assert(smokerResp.body?.route === 'nstp_full_pphc', 'smoker routed to nstp_full_pphc', smokerResp.body?.route);
  assert(smokerResp.body?.workflow?.state === 'vendor_assigned', 'smoker workflow state=vendor_assigned');
  assert(smokerResp.body?.workflow?.stp_evaluation?.eligible === false, 'smoker stp_evaluation marked ineligible');
  assert(smokerResp.body?.workflow?.stp_evaluation?.blocking_factors?.some(b => b.code === 'current_smoker'), 'current_smoker in blocking factors');

  // 6. Blocked by product policy — Critical Illness not STP-enabled
  const ciProposal = { ...cleanProposal, product_name: 'Critical Illness' };
  const ciResp = await post('/api/workflow/stp-evaluate', ciProposal);
  assert(ciResp.status === 200, 'CI evaluate 200');
  assert(ciResp.body?.route === 'nstp_full_pphc', 'CI routed to nstp_full_pphc even when clean');
  assert(ciResp.body?.workflow?.stp_evaluation?.blocking_factors?.some(b => b.code === 'policy_not_stp_enabled'), 'policy_not_stp_enabled in CI blocking factors');

  // 7. Soft-flag case — age 47 on a policy with stp_max_age=50 → telemer
  // First need to dynamically create/edit a policy or find one. We'll just check that Group Health at age 47 routes to telemer (GH has stp_max_age=50)
  const softAge = {
    proposer_name: 'Test Soft Age', age: 47, gender: 'male', sum_assured: 1500000,
    product_name: 'Group Health', height_cm: 172, weight_kg: 68,
    lifestyle: { smoking: 'never', alcohol: 'never', tobacco_chewing: 'never', occupation_hazard: 'none', exercise: 'regular' },
    medical_history: { pre_existing_conditions: [], family_history: 'none', hospitalizations: 0, surgery_types: [] }
  };
  const softResp = await post('/api/workflow/stp-evaluate', softAge);
  assert(softResp.status === 200, 'soft age evaluate 200');
  assert(softResp.body?.route === 'nstp_telemer', 'soft age routed to nstp_telemer', softResp.body?.route + ' — ' + JSON.stringify(softResp.body?.evaluation?.blocking_factors?.map(b=>b.code)));

  // 8. Shadow mode — clean case with shadow_mode=true should force NSTP but log STP eligibility
  const shadowResp = await post('/api/workflow/stp-evaluate', { ...cleanProposal, shadow_mode: true });
  assert(shadowResp.status === 200, 'shadow evaluate 200');
  assert(shadowResp.body?.route === 'stp_shadow_logged', 'shadow mode route=stp_shadow_logged', shadowResp.body?.route);
  assert(shadowResp.body?.workflow?.stp_shadow_mode === true, 'shadow mode flag set on workflow');
  assert(shadowResp.body?.workflow?.stp_evaluation?.eligible === true, 'shadow workflow still records STP eligibility');
  assert(shadowResp.body?.workflow?.state === 'vendor_assigned', 'shadow workflow in NSTP state');

  // 9. Analytics dashboard includes STP block
  const analytics = await get('/api/analytics/dashboard');
  assert(analytics.status === 200, 'analytics 200');
  assert(analytics.body?.workflow?.stp, 'analytics has stp block');
  assert(typeof analytics.body?.workflow?.stp?.total_evaluated === 'number', 'stp.total_evaluated numeric');
  assert(analytics.body?.workflow?.stp?.auto_issued >= 1, 'at least 1 auto_issued recorded', analytics.body?.workflow?.stp?.auto_issued);
  assert(analytics.body?.workflow?.stp?.route_distribution?.stp_auto_issue >= 1, 'route_distribution.stp_auto_issue >=1');

  // 10. Workflow filter by route_type
  const listResp = await get('/api/workflows?route_type=stp_auto_issue');
  assert(listResp.status === 200, 'workflows list 200');
  assert(Array.isArray(listResp.body), 'workflows list is array');
  assert(listResp.body.every(w => w.route_type === 'stp_auto_issue'), 'all filtered workflows have route_type=stp_auto_issue');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Test error:', e); process.exit(1); });
