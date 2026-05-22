/**
 * Customer Communication Module
 * Automated notifications for UW decisions, PPHC status updates, policy issuance
 * Supports Email, SMS, WhatsApp templates
 */
const { v4: uuidv4 } = require('uuid');

// Communication log store
const commsLog = [];

const TEMPLATES = {
  pphc_scheduled: {
    subject: 'Health Check-up Scheduled — {{proposer_name}}',
    email: `Dear {{proposer_name}},\n\nYour Pre-Policy Health Check-up has been scheduled.\n\nDate: {{scheduled_date}}\nCenter: {{center_name}}\nVendor: {{vendor_name}}\n\nPlease carry a valid photo ID and arrive 15 minutes before your appointment.\nFasting for 12 hours is required for blood tests.\n\nFor any queries, contact our helpline.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Your health check-up is scheduled on {{scheduled_date}} at {{center_name}}. Please fast for 12 hrs. Carry photo ID.',
    whatsapp: '🏥 *Health Check-up Scheduled*\n\nHi {{proposer_name}},\n\n📅 Date: {{scheduled_date}}\n📍 Center: {{center_name}}\n\n⚠️ Please fast for 12 hours before tests.\n\nACC Insurance'
  },
  pphc_completed: {
    subject: 'Health Check-up Complete — Report Under Review',
    email: `Dear {{proposer_name}},\n\nYour health check-up reports have been received and are under review by our underwriting team.\n\nProposal: {{proposal_id}}\nDate of Check-up: {{completed_date}}\n\nYou will be notified of the outcome within 48 hours.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Your health check-up reports received. Decision will be communicated within 48 hours. Proposal: {{proposal_id}}',
    whatsapp: '✅ *Reports Received*\n\nHi {{proposer_name}},\n\nYour health reports are under review.\n📋 Proposal: {{proposal_id}}\n⏰ Expected decision: 48 hours\n\nACC Insurance'
  },
  approved: {
    subject: 'Congratulations! Your Insurance Proposal is Approved',
    email: `Dear {{proposer_name}},\n\nWe are pleased to inform you that your insurance proposal has been approved at standard rates.\n\nProposal: {{proposal_id}}\nProduct: {{product_name}}\nSum Assured: ₹{{sum_assured}}\n\nYour policy document will be issued shortly.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Congratulations! Your proposal {{proposal_id}} is approved. Policy will be issued shortly.',
    whatsapp: '🎉 *Proposal Approved!*\n\nHi {{proposer_name}},\n\nYour insurance proposal has been approved!\n\n📋 Proposal: {{proposal_id}}\n💰 Sum Assured: ₹{{sum_assured}}\n\nPolicy document coming soon!\n\nACC Insurance'
  },
  counter_offer: {
    subject: 'Insurance Proposal — Counter Offer',
    email: `Dear {{proposer_name}},\n\nBased on our medical assessment, we are pleased to offer coverage with modified terms.\n\nProposal: {{proposal_id}}\nProduct: {{product_name}}\nSum Assured: ₹{{sum_assured}}\nPremium Loading: +{{loading_percentage}}%\n{{exclusion_text}}\n\nPlease confirm acceptance or contact us to discuss.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Your proposal {{proposal_id}} is approved with modified terms (+{{loading_percentage}}% loading). Contact us for details.',
    whatsapp: '📋 *Counter Offer*\n\nHi {{proposer_name}},\n\nYour proposal is approved with modified terms:\n\n💰 Loading: +{{loading_percentage}}%\n{{exclusion_text}}\n\nPlease confirm acceptance.\n\nACC Insurance'
  },
  rejected: {
    subject: 'Insurance Proposal — Decision',
    email: `Dear {{proposer_name}},\n\nAfter careful review, we regret to inform you that we are unable to accept your proposal at this time.\n\nProposal: {{proposal_id}}\nReason: {{rejection_reason}}\n\nYou may reapply after addressing the concerns noted. For details, contact our helpline.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: We regret your proposal {{proposal_id}} could not be accepted at this time. Contact us for details.',
    whatsapp: '📋 *Proposal Update*\n\nHi {{proposer_name}},\n\nWe regret to inform you that your proposal could not be accepted at this time.\n\n📋 Proposal: {{proposal_id}}\n\nPlease contact us for details.\n\nACC Insurance'
  },
  referred_uw: {
    subject: 'Proposal Referred for Expert Review',
    email: `Dear {{proposer_name}},\n\nYour proposal has been referred for expert medical review. This is a standard process for certain cases.\n\nProposal: {{proposal_id}}\n\nExpected turnaround: 2-3 business days.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Your proposal {{proposal_id}} is under expert review. Expected update in 2-3 business days.',
    whatsapp: '🔍 *Expert Review*\n\nHi {{proposer_name}},\n\nYour proposal is under expert medical review.\n\n📋 Proposal: {{proposal_id}}\n⏰ Expected: 2-3 business days\n\nACC Insurance'
  },
  policy_issued: {
    subject: 'Policy Issued — {{policy_number}}',
    email: `Dear {{proposer_name}},\n\nYour insurance policy has been issued successfully.\n\nPolicy Number: {{policy_number}}\nProduct: {{product_name}}\nSum Assured: ₹{{sum_assured}}\nEffective Date: {{effective_date}}\n\nPolicy documents will be sent separately.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Policy {{policy_number}} issued for ₹{{sum_assured}}. Documents will be shared shortly.',
    whatsapp: '🎉 *Policy Issued!*\n\nHi {{proposer_name}},\n\n📄 Policy: {{policy_number}}\n💰 Sum Assured: ₹{{sum_assured}}\n📅 Effective: {{effective_date}}\n\nDocuments coming soon!\n\nACC Insurance'
  },
  // ─── Phase 3: Information request templates ───
  info_requested: {
    subject: 'Additional Information Required — Proposal {{proposal_id}}',
    email: `Dear {{proposer_name}},\n\nWe need a few additional items to complete the underwriting review of your insurance proposal.\n\nProposal: {{proposal_id}}\nProduct: {{product_name}}\n\nItems requested:\n{{item_list}}\n\nReason: {{reason}}\n\nPlease upload the requested items at:\n{{portal_link}}\n\nDeadline: {{deadline}}\n\nIf you have any questions, please contact our helpline.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Proposal {{proposal_id}} needs more info. Upload at {{portal_link}} by {{deadline}}. Items: {{item_count}}.',
    whatsapp: '📋 *Additional Information Needed*\n\nHi {{proposer_name}},\n\nProposal: {{proposal_id}}\n\nWe need {{item_count}} item(s) to proceed:\n{{item_list_short}}\n\n📤 Upload here: {{portal_link}}\n⏰ Deadline: {{deadline}}\n\nACC Insurance'
  },
  info_received: {
    subject: 'Information Received — Proposal {{proposal_id}}',
    email: `Dear {{proposer_name}},\n\nWe have received the additional information for your proposal.\n\nProposal: {{proposal_id}}\nReceived: {{received_date}}\n\nYour case is now back under review. We will notify you of the decision shortly.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Information received for proposal {{proposal_id}}. Decision pending.',
    whatsapp: '✅ *Information Received*\n\nHi {{proposer_name}},\n\nProposal {{proposal_id}} is back under review.\n\nACC Insurance'
  },
  info_reminder: {
    subject: 'Reminder — Information Pending for Proposal {{proposal_id}}',
    email: `Dear {{proposer_name}},\n\nThis is a reminder that we are awaiting additional information for your proposal.\n\nProposal: {{proposal_id}}\nDeadline: {{deadline}}\nDays remaining: {{days_remaining}}\n\nPending items:\n{{item_list}}\n\nUpload at: {{portal_link}}\n\nIf the deadline passes without response, your proposal may be auto-declined.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Reminder — proposal {{proposal_id}} info pending. {{days_remaining}} days left. Upload: {{portal_link}}',
    whatsapp: '⏰ *Reminder*\n\nHi {{proposer_name}},\n\nProposal {{proposal_id}} still needs information.\n\n⏳ {{days_remaining}} days remaining\n📤 {{portal_link}}\n\nACC Insurance'
  },
  info_request_expired: {
    subject: 'Information Request Expired — Proposal {{proposal_id}}',
    email: `Dear {{proposer_name}},\n\nThe deadline for submitting additional information for your proposal has passed.\n\nProposal: {{proposal_id}}\nExpired: {{expired_date}}\n\nYour proposal will be processed based on available information. This may result in decline or counter-offer terms. To resubmit with full information, please contact our helpline within 7 days.\n\nRegards,\nACC Insurance Team`,
    sms: 'ACC Insurance: Info request for proposal {{proposal_id}} expired. Contact helpline to resubmit.',
    whatsapp: '⚠️ *Request Expired*\n\nHi {{proposer_name}},\n\nThe info request for proposal {{proposal_id}} has expired.\n\nContact our helpline to resubmit.\n\nACC Insurance'
  }
};

function fillTemplate(template, data) {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }
  return result;
}

function sendNotification(templateKey, recipientData, channels = ['email']) {
  const template = TEMPLATES[templateKey];
  if (!template) throw new Error(`Template '${templateKey}' not found`);

  const notifications = [];
  for (const channel of channels) {
    const content = template[channel];
    if (!content) continue;

    const notification = {
      id: uuidv4(),
      template: templateKey,
      channel,
      recipient: recipientData.email || recipientData.phone || 'unknown',
      recipient_name: recipientData.proposer_name,
      subject: template.subject ? fillTemplate(template.subject, recipientData) : null,
      body: fillTemplate(content, recipientData),
      proposal_id: recipientData.proposal_id,
      status: 'sent',  // In production: queued → sent → delivered → read
      sent_at: new Date().toISOString(),
      delivered_at: new Date(Date.now() + 2000).toISOString()
    };

    notifications.push(notification);
    commsLog.push(notification);
  }

  return notifications;
}

function getCommsLog(filters = {}) {
  let log = [...commsLog];
  if (filters.proposal_id) log = log.filter(n => n.proposal_id === filters.proposal_id);
  if (filters.channel) log = log.filter(n => n.channel === filters.channel);
  if (filters.template) log = log.filter(n => n.template === filters.template);
  return log.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
}

function getCommsStats() {
  const total = commsLog.length;
  const byChannel = {};
  const byTemplate = {};
  commsLog.forEach(n => {
    byChannel[n.channel] = (byChannel[n.channel] || 0) + 1;
    byTemplate[n.template] = (byTemplate[n.template] || 0) + 1;
  });

  return {
    total_sent: total,
    by_channel: byChannel,
    by_template: byTemplate,
    last_24h: commsLog.filter(n => Date.now() - new Date(n.sent_at).getTime() < 24 * 60 * 60 * 1000).length
  };
}

module.exports = {
  TEMPLATES,
  sendNotification,
  getCommsLog,
  getCommsStats,
  fillTemplate
};
