/**
 * SMS Adapter — Phase 4
 * Supports MSG91, Gupshup, or console fallback.
 *
 * Config env vars: SMS_PROVIDER (msg91|gupshup), SMS_API_KEY, SMS_SENDER_ID, SMS_DLT_ENTITY_ID
 */

const https = require('https');

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
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

async function sendViaMSG91({ to, body, templateId }) {
  const apiKey = process.env.SMS_API_KEY;
  if (!apiKey) throw new Error('SMS_API_KEY not configured');
  const payload = {
    sender: process.env.SMS_SENDER_ID || 'ACCINW',
    route: '4',
    country: '91',
    DLT_TE_ID: templateId || process.env.SMS_DLT_TEMPLATE_ID || '',
    sms: [{ message: body, to: [to.replace(/^\+91/, '')] }]
  };
  const result = await httpPost('https://control.msg91.com/api/v5/flow/', payload, { authkey: apiKey });
  return { success: result.status < 300, provider: 'msg91', response: result.body };
}

async function sendViaGupshup({ to, body }) {
  const apiKey = process.env.SMS_API_KEY;
  if (!apiKey) throw new Error('SMS_API_KEY not configured');
  const params = new URLSearchParams({
    userid: process.env.SMS_USERID || '',
    password: apiKey,
    send_to: to.replace(/^\+/, ''),
    msg: body,
    msg_type: 'TEXT',
    method: 'sendMessage',
    format: 'json',
    v: '1.1',
    auth_scheme: 'plain'
  });
  const result = await httpPost(`https://enterprise.smsgupshup.com/GatewayAPI/rest?${params}`, '');
  return { success: result.status < 300, provider: 'gupshup', response: result.body };
}

async function send({ to, body, templateId }) {
  const provider = (process.env.SMS_PROVIDER || 'console').toLowerCase();
  const timestamp = new Date().toISOString();

  if (provider === 'msg91') {
    try {
      const result = await sendViaMSG91({ to, body, templateId });
      return { ...result, timestamp };
    } catch (e) {
      console.error('[SMS] MSG91 error:', e.message);
      return { success: false, provider: 'msg91', error: e.message, timestamp };
    }
  }

  if (provider === 'gupshup') {
    try {
      const result = await sendViaGupshup({ to, body });
      return { ...result, timestamp };
    } catch (e) {
      console.error('[SMS] Gupshup error:', e.message);
      return { success: false, provider: 'gupshup', error: e.message, timestamp };
    }
  }

  // Dev fallback
  console.log(`[SMS] TO: ${to} | BODY: ${body.substring(0, 160)}`);
  return { success: true, provider: 'console', message_id: `dev-sms-${Date.now()}`, timestamp };
}

module.exports = { send };
