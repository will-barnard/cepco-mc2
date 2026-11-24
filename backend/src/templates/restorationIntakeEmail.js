'use strict';

/**
 * Restoration sale emails (services/restorationIntake.js): to the
 * reviewers when a restoration pre-order comes in from Shopify, and when
 * the order for one they already set up is cancelled. Same shell as the
 * other Mission Control emails (templates/fridayLunchEmail.js).
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOGO_PATH = path.resolve(__dirname, '../../../assets/CEPCO-LOGO-LIGHT.png');
let cachedLogoBase64 = null;
function logoBase64() {
  if (cachedLogoBase64 === null) cachedLogoBase64 = fs.readFileSync(LOGO_PATH).toString('base64');
  return cachedLogoBase64;
}
const logoUrl = config.appBaseUrl ? `${config.appBaseUrl}/api/public/assets/logo.png` : null;
const homeUrl = config.appBaseUrl ? `${config.appBaseUrl}/` : null;

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function button(label) {
  if (!homeUrl) {
    return '<p style="margin:20px 0 0;font-size:13px;color:#6b7280;">Open Mission Control — it\'s on the homepage.</p>';
  }
  return `<p style="margin:22px 0 0;">
    <a href="${homeUrl}" style="display:inline-block;background:#16181d;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:6px;">
      ${escapeHtml(label)}
    </a>
  </p>`;
}

function itemLine(it) {
  const who = it.customer ? it.customer.name : 'no customer on the order';
  const paid = it.item.deposit_label ? ` — ${it.item.deposit_label} deposit` : '';
  return `<li><strong>${escapeHtml(it.item.title)}</strong>${escapeHtml(paid)}<br />
    <span style="color:#6b7280;">Order ${escapeHtml(it.order.name || it.order.shopify_order_id)} · ${escapeHtml(who)}</span></li>`;
}

function buildRestorationIntakeEmail({ kind, items }) {
  const many = items.length > 1;
  const cancelled = kind === 'cancelled';
  const subject = cancelled
    ? `Restoration order cancelled: ${items[0].order.name || ''}`.trim()
    : `New restoration sale${many ? 's' : ''} to set up${items[0].order.name ? `: ${items[0].order.name}` : ''}`;
  const heading = cancelled ? 'A restoration order was cancelled' : `Restoration sale${many ? 's' : ''} to set up`;
  const intro = cancelled
    ? 'The sale is still recorded and the instrument still shows as the customer\'s. Decide on the homepage whether to undo the sale or keep it.'
    : 'Confirm which instrument was sold and pick the queue. Mission Control records the sale and opens the restoration ticket.';
  const html = `
<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="background:#16181d;padding:22px 28px;">
      ${logoUrl
        ? `<img src="${logoUrl}" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />`
        : '<img src="cid:cepco-logo" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />'}
    </div>
    <div style="padding:28px;">
      <h1 style="font-size:20px;margin:0 0 14px;color:#16181d;">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 12px;font-size:14px;color:#16181d;line-height:1.5;">${escapeHtml(intro)}</p>
      <ul style="margin:0;padding-left:20px;font-size:14px;color:#16181d;line-height:1.6;">
        ${items.map(itemLine).join('')}
      </ul>
      ${button(cancelled ? 'Review it' : 'Set it up')}
    </div>
    <div style="background:#f4f4f5;padding:16px 28px;font-size:12px;color:#9aa1ad;">
      Chicago Electric Piano Company
    </div>
  </div>
</div>`.trim();

  return {
    subject,
    html,
    attachments: logoUrl ? [] : [{
      filename: 'cepco-logo.png', content: logoBase64(), content_type: 'image/png', content_id: 'cepco-logo',
    }],
  };
}

module.exports = { buildRestorationIntakeEmail };
