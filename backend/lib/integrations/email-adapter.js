/**
 * Email Adapter — Phase 4
 * AWS SES when configured, console log fallback for dev.
 *
 * Config env vars: SES_REGION, SES_FROM_EMAIL, SES_REPLY_TO
 */

let sesClient = null;

function init() {
  if (process.env.SES_REGION && process.env.AWS_ACCESS_KEY_ID) {
    try {
      const { SESClient } = require('@aws-sdk/client-ses');
      sesClient = new SESClient({
        region: process.env.SES_REGION || 'ap-south-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });
      console.log('[Email] SES client initialized');
    } catch (e) {
      console.error('[Email] SES init failed:', e.message);
    }
  } else {
    console.log('[Email] SES not configured — emails will be logged to console');
  }
}

async function send({ to, subject, body, replyTo }) {
  const from = process.env.SES_FROM_EMAIL || 'noreply@acc.ltd';
  const timestamp = new Date().toISOString();

  if (sesClient) {
    try {
      const { SendEmailCommand } = require('@aws-sdk/client-ses');
      const result = await sesClient.send(new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: body, Charset: 'UTF-8' },
            Html: { Data: body.replace(/\n/g, '<br>'), Charset: 'UTF-8' }
          }
        },
        ReplyToAddresses: replyTo ? [replyTo] : [process.env.SES_REPLY_TO || from]
      }));
      return { success: true, provider: 'ses', message_id: result.MessageId, timestamp };
    } catch (e) {
      console.error('[Email] SES send error:', e.message);
      return { success: false, provider: 'ses', error: e.message, timestamp };
    }
  }

  // Dev fallback: log to console
  console.log(`[Email] TO: ${to} | SUBJECT: ${subject} | BODY: ${body.substring(0, 200)}...`);
  return { success: true, provider: 'console', message_id: `dev-${Date.now()}`, timestamp };
}

module.exports = { init, send };
