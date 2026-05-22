/**
 * WhatsApp Adapter — Phase 4
 * Meta WhatsApp Business Cloud API when configured, console fallback for dev.
 *
 * Config env vars: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_PROVIDER (meta|gupshup)
 */

const https = require('https');

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
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

async function sendViaMeta({ to, body, templateName }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID required');

  // If templateName is provided, use template message; else send plain text
  const payload = templateName ? {
    messaging_product: 'whatsapp',
    to: to.replace(/^\+/, ''),
    type: 'template',
    template: { name: templateName, language: { code: 'en' } }
  } : {
    messaging_product: 'whatsapp',
    to: to.replace(/^\+/, ''),
    type: 'text',
    text: { body: body.replace(/[*_~]/g, '') }  // strip markdown for plain text
  };

  const result = await httpPost(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    payload,
    { Authorization: `Bearer ${token}` }
  );

  return {
    success: result.status < 300,
    provider: 'meta_whatsapp',
    message_id: result.body?.messages?.[0]?.id,
    response: result.body
  };
}

async function send({ to, body, templateName }) {
  const provider = (process.env.WHATSAPP_PROVIDER || 'console').toLowerCase();
  const timestamp = new Date().toISOString();

  if (provider === 'meta') {
    try {
      const result = await sendViaMeta({ to, body, templateName });
      return { ...result, timestamp };
    } catch (e) {
      console.error('[WhatsApp] Meta API error:', e.message);
      return { success: false, provider: 'meta_whatsapp', error: e.message, timestamp };
    }
  }

  // Dev fallback
  console.log(`[WhatsApp] TO: ${to} | BODY: ${body.substring(0, 200)}...`);
  return { success: true, provider: 'console', message_id: `dev-wa-${Date.now()}`, timestamp };
}

module.exports = { send };
