/**
 * Workflow Engine — NSTP Underwriting Orchestration
 * Updated: persistence now uses PostgreSQL via pg-client (Option B)
 * In-memory Map remains as primary read cache; PG is the durable store.
 */
const { v4: uuidv4 } = require('uuid');
const vendorApi = require('./vendor-api');

// In-memory workflow store (primary cache) + DB persistence (durable)
const workflows = new Map();
let dbClient = null;

function initPersistence(db) {
  dbClient = db;
  console.log('[Workflow Engine] PostgreSQL persistence enabled');
}

function persist(workflow) {
  if (!dbClient || !workflow?.id) return;
  dbClient.saveWorkflow(workflow.id, workflow).catch(e => console.error('[Persist] Error:', e.message));
}

async function loadFromS3() {
  // Renamed to loadFromDB internally — kept as loadFromS3 export for compatibility
  if (!dbClient) { console.log('[Workflow Engine] No DB — in-memory only'); return 0; }
  try {
    const items = await dbClient.listWorkflowsFromS3();
    let count = 0;
    for (const wf of items) {
      if (wf.id && !workflows.has(wf.id)) {
        workflows.set(wf.id, wf);
        count++;
      }
    }
    console.log(`[Workflow Engine] Loaded ${count} workflow(s) from PostgreSQL`);
    return count;
  } catch(e) {
    console.error('[Workflow Engine] DB load error:', e.message);
    return 0;
  }
}

const WORKFLOW_STATES = {
  CREATED: 'created',
  STP_EVALUATING: 'stp_evaluating',
  AUTO_ISSUED: 'auto_issued',
  NSTP_FLAGGED: 'nstp_flagged',
  VENDOR_ASSIGNED: 'vendor_assigned',
  PPHC_SCHEDULED: 'pphc_scheduled',
  PPHC_COMPLETED: 'pphc_completed',
  EXTRACTION_IN_PROGRESS: 'extraction_in_progress',
  EXTRACTION_DONE: 'extraction_done',
  RULE_ENGINE_PROCESSING: 'rule_engine_processing',
  AUTO_APPROVED: 'auto_approved',
  AUTO_REJECTED: 'auto_rejected',
  COUNTER_OFFERED: 'counter_offered',
  REFERRED: 'referred',
  UW_REVIEWING: 'uw_reviewing',
  UW_APPROVED: 'uw_approved',
  UW_REJECTED: 'uw_rejected',
  POLICY_ISSUED: 'policy_issued',
  CUSTOMER_NOTIFIED: 'customer_notified',
  AWAITING_ADDITIONAL_INFO: 'awaiting_additional_info',
  COUNTER_OFFER_ACCEPTED: 'counter_offer_accepted',
  COUNTER_OFFER_REJECTED: 'counter_offer_rejected',
  COUNTER_OFFER_EXPIRED: 'counter_offer_expired',
  PAYMENT_CONFIRMED: 'payment_confirmed'
};

const VALID_TRANSITIONS = {
  [WORKFLOW_STATES.CREATED]: [WORKFLOW_STATES.STP_EVALUATING, WORKFLOW_STATES.NSTP_FLAGGED],
  [WORKFLOW_STATES.STP_EVALUATING]: [WORKFLOW_STATES.AUTO_ISSUED, WORKFLOW_STATES.NSTP_FLAGGED],
  [WORKFLOW_STATES.AUTO_ISSUED]: [WORKFLOW_STATES.POLICY_ISSUED, WORKFLOW_STATES.CUSTOMER_NOTIFIED],
  [WORKFLOW_STATES.NSTP_FLAGGED]: [WORKFLOW_STATES.VENDOR_ASSIGNED],
  [WORKFLOW_STATES.VENDOR_ASSIGNED]: [WORKFLOW_STATES.PPHC_SCHEDULED],
  [WORKFLOW_STATES.PPHC_SCHEDULED]: [WORKFLOW_STATES.PPHC_COMPLETED],
  [WORKFLOW_STATES.PPHC_COMPLETED]: [WORKFLOW_STATES.EXTRACTION_IN_PROGRESS],
  [WORKFLOW_STATES.EXTRACTION_IN_PROGRESS]: [WORKFLOW_STATES.EXTRACTION_DONE],
  [WORKFLOW_STATES.EXTRACTION_DONE]: [WORKFLOW_STATES.RULE_ENGINE_PROCESSING],
  [WORKFLOW_STATES.RULE_ENGINE_PROCESSING]: [WORKFLOW_STATES.AUTO_APPROVED, WORKFLOW_STATES.AUTO_REJECTED, WORKFLOW_STATES.COUNTER_OFFERED, WORKFLOW_STATES.REFERRED],
  [WORKFLOW_STATES.REFERRED]: [WORKFLOW_STATES.UW_REVIEWING, WORKFLOW_STATES.VENDOR_ASSIGNED, WORKFLOW_STATES.AWAITING_ADDITIONAL_INFO],
  [WORKFLOW_STATES.UW_REVIEWING]: [WORKFLOW_STATES.UW_APPROVED, WORKFLOW_STATES.UW_REJECTED, WORKFLOW_STATES.COUNTER_OFFERED, WORKFLOW_STATES.AWAITING_ADDITIONAL_INFO],
  [WORKFLOW_STATES.AWAITING_ADDITIONAL_INFO]: [WORKFLOW_STATES.UW_REVIEWING, WORKFLOW_STATES.AUTO_REJECTED],
  [WORKFLOW_STATES.AUTO_APPROVED]: [WORKFLOW_STATES.POLICY_ISSUED, WORKFLOW_STATES.PAYMENT_CONFIRMED, WORKFLOW_STATES.VENDOR_ASSIGNED],
  [WORKFLOW_STATES.UW_APPROVED]: [WORKFLOW_STATES.POLICY_ISSUED, WORKFLOW_STATES.PAYMENT_CONFIRMED, WORKFLOW_STATES.VENDOR_ASSIGNED],
  [WORKFLOW_STATES.COUNTER_OFFERED]: [WORKFLOW_STATES.COUNTER_OFFER_ACCEPTED, WORKFLOW_STATES.COUNTER_OFFER_REJECTED, WORKFLOW_STATES.COUNTER_OFFER_EXPIRED, WORKFLOW_STATES.POLICY_ISSUED, WORKFLOW_STATES.UW_REJECTED, WORKFLOW_STATES.VENDOR_ASSIGNED],
  [WORKFLOW_STATES.COUNTER_OFFER_ACCEPTED]: [WORKFLOW_STATES.PAYMENT_CONFIRMED, WORKFLOW_STATES.POLICY_ISSUED],
  [WORKFLOW_STATES.COUNTER_OFFER_REJECTED]: [WORKFLOW_STATES.CUSTOMER_NOTIFIED],
  [WORKFLOW_STATES.COUNTER_OFFER_EXPIRED]: [WORKFLOW_STATES.CUSTOMER_NOTIFIED],
  [WORKFLOW_STATES.PAYMENT_CONFIRMED]: [WORKFLOW_STATES.POLICY_ISSUED],
  [WORKFLOW_STATES.POLICY_ISSUED]: [WORKFLOW_STATES.CUSTOMER_NOTIFIED],
  [WORKFLOW_STATES.AUTO_REJECTED]: [WORKFLOW_STATES.CUSTOMER_NOTIFIED, WORKFLOW_STATES.VENDOR_ASSIGNED],
  [WORKFLOW_STATES.UW_REJECTED]: [WORKFLOW_STATES.CUSTOMER_NOTIFIED, WORKFLOW_STATES.VENDOR_ASSIGNED]
};

function createWorkflow(proposalData) {
  const id = uuidv4();
  const workflow = {
    id,
    proposal_id: proposalData.proposal_id || `PROP-${Date.now()}`,
    quotation_no: proposalData.quotation_no || null,
    proposer_name: proposalData.proposer_name,
    age: proposalData.age,
    gender: proposalData.gender,
    sum_assured: proposalData.sum_assured,
    product_name: proposalData.product_name || 'Health Shield',
    policy_type: proposalData.policy_type || 'health',
    nstp_reason: proposalData.nstp_reason || 'sum_assured_threshold',
    observations: proposalData.observations || '',
    required_tests: proposalData.required_tests || [],
    assigned_vendor_id: proposalData.assigned_vendor_id || 'VEND-001',
    lifestyle: proposalData.lifestyle || {},
    medical_history: proposalData.medical_history || {},
    height_cm: proposalData.height_cm || null,
    weight_kg: proposalData.weight_kg || null,
    declared_bmi: proposalData.declared_bmi || null,
    cat_level: proposalData.cat_level || null,
    cat_reason: proposalData.cat_reason || null,
    pphc_category: proposalData.cat_level || null,
    route_type: proposalData.route_type || 'nstp_full_pphc',
    stp_evaluation: proposalData.stp_evaluation || null,
    stp_shadow_mode: proposalData.stp_shadow_mode || false,
    policy_number: null,
    state: WORKFLOW_STATES.CREATED,
    vendor_id: null,
    vendor_request_id: null,
    documents: [],
    docs_submitted: false,
    extracted_data: null,
    risk_score: null,
    decision: null,
    uw_comments: null,
    counter_offer: null,
    communication_log: [],
    information_requests: [],
    state_history: [{
      state: WORKFLOW_STATES.CREATED,
      timestamp: new Date().toISOString(),
      actor: 'system',
      note: `Workflow created — route: ${proposalData.route_type || 'nstp_full_pphc'}`
    }],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tat_started_at: new Date().toISOString(),
    tat_completed_at: null,
    sla_deadline: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
  };

  workflows.set(id, workflow);
  persist(workflow);
  return workflow;
}

function transitionState(workflowId, newState, actor, note, extraData = {}) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

  const oldState = workflow.state;
  const allowed = VALID_TRANSITIONS[workflow.state];
  if (!allowed || !allowed.includes(newState)) {
    throw new Error(`Invalid transition: ${workflow.state} → ${newState}`);
  }

  workflow.state = newState;
  workflow.updated_at = new Date().toISOString();
  workflow.state_history.push({ state: newState, timestamp: new Date().toISOString(), actor, note });
  Object.assign(workflow, extraData);

  if (['auto_approved','auto_rejected','uw_approved','uw_rejected','counter_offered','auto_issued','policy_issued','counter_offer_accepted','counter_offer_rejected','counter_offer_expired'].includes(newState)) {
    if (!workflow.tat_completed_at) workflow.tat_completed_at = new Date().toISOString();
  }

  workflows.set(workflowId, workflow);
  persist(workflow);
  runTransitionHooks(workflow, newState, oldState);
  return workflow;
}

function flagAsNSTP(workflowId, reason) {
  return transitionState(workflowId, WORKFLOW_STATES.NSTP_FLAGGED, 'system', `Flagged as NSTP: ${reason}`, { nstp_reason: reason });
}

function assignVendor(workflowId, vendorId, actor) {
  const vendor = vendorApi.getVendor(vendorId);
  if (!vendor) throw new Error(`Vendor ${vendorId} not found`);
  const workflow = workflows.get(workflowId);
  const vendorRequest = vendorApi.submitPPHCRequest(vendorId, {
    proposal_id: workflow.proposal_id, proposer_name: workflow.proposer_name,
    age: workflow.age, gender: workflow.gender, sum_assured: workflow.sum_assured
  });
  return transitionState(workflowId, WORKFLOW_STATES.VENDOR_ASSIGNED, actor, `Assigned to ${vendor.name}`, {
    vendor_id: vendorId, vendor_request_id: vendorRequest.request_id
  });
}

function recordDecision(workflowId, decision, riskScore, actor) {
  const stateMap = {
    accept_standard: WORKFLOW_STATES.AUTO_APPROVED,
    accept_with_loading: WORKFLOW_STATES.COUNTER_OFFERED,
    refer: WORKFLOW_STATES.REFERRED,
    decline: WORKFLOW_STATES.AUTO_REJECTED
  };
  return transitionState(workflowId, stateMap[decision.recommendation] || WORKFLOW_STATES.REFERRED, actor,
    `Decision: ${decision.recommendation}`, { decision, risk_score: riskScore,
    counter_offer: decision.recommendation === 'accept_with_loading' ? { loading_percentage: decision.loading_percentage, exclusions: decision.exclusions || [] } : null });
}

function uwReview(workflowId, uwDecision, comments, actor) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  if (workflow.state === WORKFLOW_STATES.REFERRED) {
    transitionState(workflowId, WORKFLOW_STATES.UW_REVIEWING, actor, 'Manual review started');
  }
  const stateMap = { approve: WORKFLOW_STATES.UW_APPROVED, reject: WORKFLOW_STATES.UW_REJECTED, counter_offer: WORKFLOW_STATES.COUNTER_OFFERED };
  return transitionState(workflowId, stateMap[uwDecision], actor, comments, { uw_comments: comments });
}

function addCommunication(workflowId, type, recipient, message, channel) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  workflow.communication_log.push({ id: uuidv4(), type, recipient, message, channel, sent_at: new Date().toISOString(), status: 'sent' });
  workflow.updated_at = new Date().toISOString();
  workflows.set(workflowId, workflow);
  persist(workflow);
  return workflow;
}

function getWorkflow(workflowId) { return workflows.get(workflowId) || null; }

function addDocument(workflowId, doc) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  if (workflow.docs_submitted) throw new Error('Documents already final-submitted.');
  workflow.documents.push({ ...doc, uploaded_at: new Date().toISOString() });
  workflow.updated_at = new Date().toISOString();
  workflows.set(workflowId, workflow);
  persist(workflow);
  // Also save document metadata to PG documents table
  if (dbClient?.saveDocumentMeta) {
    dbClient.saveDocumentMeta(workflowId, doc).catch(e => console.error('[Doc meta] Error:', e.message));
  }
  return workflow;
}

function removeDocument(workflowId, docId) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  if (workflow.docs_submitted) throw new Error('Documents already final-submitted.');
  workflow.documents = workflow.documents.filter(d => d.id !== docId);
  workflow.updated_at = new Date().toISOString();
  workflows.set(workflowId, workflow);
  persist(workflow);
  return workflow;
}

function finalizeDocuments(workflowId, actor) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  if (workflow.documents.length === 0) throw new Error('No documents to submit.');
  workflow.docs_submitted = true;
  workflow.docs_submitted_at = new Date().toISOString();
  workflow.docs_submitted_by = actor;
  workflow.updated_at = new Date().toISOString();
  workflow.state_history.push({ state: 'docs_submitted', timestamp: new Date().toISOString(), actor, note: `${workflow.documents.length} document(s) final-submitted` });
  workflows.set(workflowId, workflow);
  persist(workflow);
  return workflow;
}

function getDocuments(workflowId) {
  return workflows.get(workflowId)?.documents || [];
}

function listWorkflowsByVendor(vendorId) {
  return Array.from(workflows.values()).filter(w => w.vendor_id === vendorId).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

function listWorkflows(filters = {}) {
  let list = Array.from(workflows.values());
  if (filters.state) list = list.filter(w => w.state === filters.state);
  if (filters.vendor_id) list = list.filter(w => w.vendor_id === filters.vendor_id);
  if (filters.route_type) list = list.filter(w => w.route_type === filters.route_type);
  if (filters.assigned_uw_email) list = list.filter(w => (w.assigned_uw_email||'').toLowerCase() === filters.assigned_uw_email.toLowerCase());
  return list.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

function getAnalytics() {
  const all = Array.from(workflows.values());
  const completed = all.filter(w => w.tat_completed_at);
  const avgTat = completed.length > 0 ? completed.reduce((sum, w) => sum + (new Date(w.tat_completed_at) - new Date(w.tat_started_at)), 0) / completed.length : 0;
  const stateCounts = {};
  all.forEach(w => { stateCounts[w.state] = (stateCounts[w.state] || 0) + 1; });
  const decisions = all.filter(w => w.decision);
  const decisionCounts = {};
  decisions.forEach(w => { const d = w.decision.recommendation || 'unknown'; decisionCounts[d] = (decisionCounts[d] || 0) + 1; });
  const slaBreaches = all.filter(w => !w.tat_completed_at && new Date() > new Date(w.sla_deadline)).length;
  const stpEvaluated = all.filter(w => w.stp_evaluation);
  const stpAutoIssued = all.filter(w => w.state === 'auto_issued' || w.route_type === 'stp_auto_issue');
  const routeDistribution = { stp_auto_issue: 0, nstp_telemer: 0, nstp_full_pphc: 0 };
  all.forEach(w => { if (w.route_type && routeDistribution[w.route_type] !== undefined) routeDistribution[w.route_type]++; });
  return {
    total_workflows: all.length, state_distribution: stateCounts, decision_distribution: decisionCounts,
    avg_tat_ms: Math.round(avgTat), avg_tat_hours: Math.round(avgTat / (60*60*1000) * 10) / 10,
    sla_breaches: slaBreaches, sla_compliance_pct: all.length > 0 ? Math.round((1 - slaBreaches / all.length) * 100 * 10) / 10 : 100,
    auto_decision_rate: decisions.length > 0 ? Math.round(decisions.filter(w => ['auto_approved','auto_rejected','counter_offered'].includes(w.state)).length / decisions.length * 100) : 0,
    completed_today: completed.filter(w => new Date(w.tat_completed_at).toDateString() === new Date().toDateString()).length,
    stp: { total_evaluated: stpEvaluated.length, auto_issued: stpAutoIssued.length, route_distribution: routeDistribution }
  };
}

function reassignToVendor(workflowId, reason, actor) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  if (!workflow.docs_submitted) throw new Error('Cannot reassign — documents have not been submitted yet.');
  if (!reason?.trim()) throw new Error('Reason for reassignment is required.');
  const previousAnalysis = { risk_score: workflow.risk_score, decision: workflow.decision };
  workflow.docs_submitted = false; workflow.docs_submitted_at = null; workflow.docs_submitted_by = null;
  workflow.ai_analysis = null; workflow.risk_score = null; workflow.decision = null;
  workflow.ai_summary_text = null; workflow.extracted_data = null; workflow.extraction_method = null; workflow.api_log = [];
  if (!workflow.reassignment_history) workflow.reassignment_history = [];
  workflow.reassignment_history.push({ reassigned_at: new Date().toISOString(), reassigned_by: actor, reason, previous_state: workflow.state, previous_analysis });
  workflow.state = 'vendor_assigned'; workflow.updated_at = new Date().toISOString();
  workflow.state_history.push({ state: 'reassigned_to_vendor', timestamp: new Date().toISOString(), actor, note: `Reassigned: ${reason}` });
  workflow.state_history.push({ state: 'vendor_assigned', timestamp: new Date().toISOString(), actor: 'system', note: `Returned to vendor. Reason: ${reason}` });
  workflow.reassignment_reason = reason; workflow.reassignment_count = (workflow.reassignment_count || 0) + 1;
  workflows.set(workflowId, workflow); persist(workflow);
  return workflow;
}

function updateWorkflowFields(workflowId, fields, actor) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  const changed = [];
  for (const [k, v] of Object.entries(fields || {})) { if (v !== undefined) { workflow[k] = v; changed.push(k); } }
  workflow.updated_at = new Date().toISOString();
  workflow.state_history.push({ state: workflow.state, timestamp: new Date().toISOString(), actor: actor || 'system', note: `Fields updated: ${changed.join(', ')}`, type: 'field_update' });
  workflows.set(workflowId, workflow); persist(workflow);
  return workflow;
}

function updateWorkflow(workflowId, wfData) {
  wfData.updated_at = new Date().toISOString();
  workflows.set(workflowId, wfData); persist(wfData);
  return wfData;
}

const transitionHooks = [];
function registerTransitionHook(fn) { transitionHooks.push(fn); }
function runTransitionHooks(workflow, newState, oldState) {
  for (const hook of transitionHooks) {
    try { hook(workflow, newState, oldState); } catch(e) { console.error('[transition hook] error:', e.message); }
  }
}

function addInformationRequest(workflowId, request) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  if (!workflow.information_requests) workflow.information_requests = [];
  workflow.information_requests.push(request);
  workflow.updated_at = new Date().toISOString();
  workflow.state_history.push({ state: workflow.state, timestamp: new Date().toISOString(), actor: request.requested_by || 'system', note: `Info request created (${request.id}): ${request.items?.length || 0} item(s)`, type: 'info_request_created' });
  workflows.set(workflowId, workflow); persist(workflow);
  return workflow;
}

function updateInformationRequest(workflowId, requestId, updates) {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  const request = (workflow.information_requests || []).find(r => r.id === requestId);
  if (!request) throw new Error(`Info request ${requestId} not found`);
  Object.assign(request, updates);
  workflow.updated_at = new Date().toISOString();
  workflows.set(workflowId, workflow); persist(workflow);
  return request;
}

function findWorkflowByInfoToken(token) {
  for (const wf of workflows.values()) {
    const req = (wf.information_requests || []).find(r => r.customer_token === token);
    if (req) return { workflow: wf, request: req };
  }
  return null;
}

function listOpenInformationRequests() {
  const open = [];
  for (const wf of workflows.values()) {
    for (const req of wf.information_requests || []) {
      if (req.status === 'pending' || req.status === 'partial') {
        open.push({ workflow_id: wf.id, proposal_id: wf.proposal_id, request: req });
      }
    }
  }
  return open;
}

module.exports = {
  WORKFLOW_STATES, createWorkflow, transitionState, flagAsNSTP, assignVendor,
  recordDecision, uwReview, addCommunication, addDocument, removeDocument,
  finalizeDocuments, getDocuments, getWorkflow, listWorkflows, listWorkflowsByVendor,
  reassignToVendor, getAnalytics, updateWorkflowFields, updateWorkflow,
  registerTransitionHook, runTransitionHooks, addInformationRequest,
  updateInformationRequest, findWorkflowByInfoToken, listOpenInformationRequests,
  initPersistence, loadFromS3
};