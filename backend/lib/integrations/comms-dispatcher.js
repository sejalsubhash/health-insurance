/**
 * Comms Dispatcher — Phase 4
 *
 * Wraps the existing comms-engine.js template system with real delivery via adapters.
 * The existing commsEngine.sendNotification still generates the content;
 * this dispatcher handles the actual send.
 *
 * Usage:
 *   const commsDispatcher = require('./integrations/comms-dispatcher');
 *   commsDispatcher.init();
 *   // Then when you want to send:
 *   await commsDispatcher.send('email', { to: 'x@y.com', subject, body });
 */

const emailAdapter = require('./email-adapter');
const smsAdapter = require('./sms-adapter');
const whatsappAdapter = require('./whatsapp-adapter');

let initialized = false;

function init() {
  if (initialized) return;
  emailAdapter.init();
  initialized = true;
  console.log('[Comms Dispatcher] Initialized — email: ' + (process.env.SES_REGION ? 'SES' : 'console') +
    ', sms: ' + (process.env.SMS_PROVIDER || 'console') +
    ', whatsapp: ' + (process.env.WHATSAPP_PROVIDER || 'console'));
}

/**
 * Send a notification through the appropriate channel.
 * Returns delivery result with provider name and message_id.
 */
async function send(channel, { to, subject, body, templateName, templateId }) {
  if (!initialized) init();

  switch (channel) {
    case 'email':
      return emailAdapter.send({ to, subject, body });
    case 'sms':
      return smsAdapter.send({ to, body, templateId });
    case 'whatsapp':
      return whatsappAdapter.send({ to, body, templateName });
    default:
      console.log(`[Comms] Unknown channel '${channel}' — logging: ${body?.substring(0, 100)}`);
      return { success: true, provider: 'console', channel };
  }
}

/**
 * Send via all requested channels. Returns array of results.
 */
async function sendMulti(channels, data) {
  const results = [];
  for (const ch of channels) {
    const result = await send(ch, data);
    results.push({ channel: ch, ...result });
  }
  return results;
}

module.exports = { init, send, sendMulti };
