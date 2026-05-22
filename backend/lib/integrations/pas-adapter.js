/**
 * Policy Admin System (PAS) Adapter — Phase 4
 *
 * Adapter pattern: common interface, multiple implementations.
 * Set PAS_PROVIDER env var to select (mock|hdfc_ergo|tata_aig).
 * Default: mock (generates placeholder policy numbers).
 *
 * Config env vars: PAS_PROVIDER, PAS_API_BASE, PAS_API_KEY
 */

const https = require('https');

function httpRequest(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
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

// ─── Mock adapter (always available) ───
const mockAdapter = {
  name: 'mock',
  async issuePolicy(workflow) {
    const policyNumber = `${workflow.product_name?.substring(0, 3)?.toUpperCase() || 'HLT'}-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 1000000)).padStart(7, '0')}`;
    return {
      success: true,
      policy_number: policyNumber,
      effective_date: new Date().toISOString().split('T')[0],
      expiry_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      premium_amount: Math.round((workflow.sum_assured || 500000) * 0.015),
      payment_link: null,
      document_url: null,
      provider: 'mock'
    };
  },
  async getPolicy(policyNumber) {
    return { policy_number: policyNumber, status: 'active', provider: 'mock' };
  }
};

// ─── Real PAS adapter template (customize per BFSI client) ───
function createRealAdapter(provider) {
  const base = process.env.PAS_API_BASE;
  const apiKey = process.env.PAS_API_KEY;
  if (!base || !apiKey) {
    console.error(`[PAS] ${provider} adapter requires PAS_API_BASE and PAS_API_KEY`);
    return mockAdapter;
  }
  return {
    name: provider,
    async issuePolicy(workflow) {
      const payload = {
        proposal_id: workflow.proposal_id,
        proposer_name: workflow.proposer_name,
        age: workflow.age,
        gender: workflow.gender,
        sum_assured: workflow.sum_assured,
        product_name: workflow.product_name,
        premium_loading_pct: workflow.decision?.loading_percentage || 0,
        exclusions: workflow.decision?.exclusions || [],
        effective_date: new Date().toISOString().split('T')[0],
        uw_decision: workflow.decision?.recommendation,
        risk_score: workflow.risk_score?.normalized
      };
      try {
        const result = await httpRequest('POST', `${base}/api/v1/policies/issue`, payload, {
          'Authorization': `Bearer ${apiKey}`,
          'X-Request-ID': workflow.id
        });
        if (result.status >= 200 && result.status < 300) {
          return {
            success: true,
            policy_number: result.body.policy_number,
            effective_date: result.body.effective_date,
            expiry_date: result.body.expiry_date,
            premium_amount: result.body.premium_amount,
            payment_link: result.body.payment_link || null,
            document_url: result.body.document_url || null,
            provider
          };
        }
        return { success: false, error: result.body?.error || `PAS returned ${result.status}`, provider };
      } catch (e) {
        console.error(`[PAS] ${provider} issuePolicy error:`, e.message);
        return { success: false, error: e.message, provider };
      }
    },
    async getPolicy(policyNumber) {
      try {
        const result = await httpRequest('GET', `${base}/api/v1/policies/${policyNumber}`, null, {
          'Authorization': `Bearer ${apiKey}`
        });
        return { ...result.body, provider };
      } catch (e) {
        return { error: e.message, provider };
      }
    }
  };
}

// ─── Factory ───
function getAdapter() {
  const provider = (process.env.PAS_PROVIDER || 'mock').toLowerCase();
  switch (provider) {
    case 'hdfc_ergo':
    case 'tata_aig':
    case 'star_health':
    case 'sbi_general':
      return createRealAdapter(provider);
    case 'mock':
    default:
      return mockAdapter;
  }
}

const adapter = getAdapter();
console.log(`[PAS] Provider: ${adapter.name}`);

module.exports = {
  issuePolicy: (wf) => adapter.issuePolicy(wf),
  getPolicy: (pn) => adapter.getPolicy(pn),
  getProviderName: () => adapter.name
};
