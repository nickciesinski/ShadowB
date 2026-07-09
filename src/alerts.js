'use strict';
/**
 * src/alerts.js — minimal one-off alert emails
 *
 * Deliberately separate from src/emails.js (which is large and imports
 * half the pipeline) so low-level modules like game-optimizer and the
 * weekly tuner scripts can send an alert without circular-import risk.
 *
 * NEVER throws — an alert failing to send must not take down the job
 * it's alerting about. Falls back to console when Gmail isn't configured.
 */

const nodemailer = require('nodemailer');
const { GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_RECIPIENTS } = require('./config');

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  return _transporter;
}

/**
 * Send a plain alert email. Returns true if sent, false otherwise.
 * @param {Object} opts
 * @param {string} opts.subject
 * @param {string} [opts.html]  HTML body (preferred)
 * @param {string} [opts.text]  Plaintext fallback body
 */
async function sendAlertEmail({ subject, html, text } = {}) {
  const body = html || `<pre style="font-family:monospace;">${text || ''}</pre>`;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !EMAIL_RECIPIENTS || EMAIL_RECIPIENTS.length === 0) {
    console.warn(`[alerts] Email not configured — ALERT logged only: ${subject}\n${text || html || ''}`);
    return false;
  }
  try {
    await getTransporter().sendMail({
      from: GMAIL_USER,
      to: EMAIL_RECIPIENTS.join(', '),
      subject: `🚨 ${subject}`,
      html: `<div style="font-family:'Segoe UI',Roboto,sans-serif;max-width:600px;margin:auto;padding:16px;">${body}
<hr style="margin-top:16px;border:none;border-top:1px solid #eee;">
<p style="font-size:11px;color:#999;">Shadow Bets automated alert — src/alerts.js</p></div>`,
    });
    console.log(`[alerts] Sent: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[alerts] Failed to send "${subject}":`, err.message);
    return false;
  }
}

module.exports = { sendAlertEmail };
