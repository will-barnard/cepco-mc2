'use strict';

/**
 * Builds the customer-facing progress update email —
 * routes/progressUpdates.js's POST /:id/send. Same visual language as
 * templates/quoteEmail.js and templates/purchaseReceipt.js (inline CID
 * logo, same fonts/colors), and the same reasoning for a single CTA that
 * only ever *shows* the update: a GET link that changes state is unsafe
 * in email (mail security scanners and some clients prefetch every link
 * in a message body), so anything the customer can actually do — here,
 * just "mark as seen" — happens from a real click once they're looking at
 * the page itself. See routes/publicProgressUpdates.js and NOTES.md.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOGO_PATH = path.resolve(__dirname, '../../../assets/CEPCO-LOGO-LIGHT.png');

let cachedLogoBase64 = null;
function logoBase64() {
  if (cachedLogoBase64 === null) {
    cachedLogoBase64 = fs.readFileSync(LOGO_PATH).toString('base64');
  }
  return cachedLogoBase64;
}

// A hosted URL (needs APP_BASE_URL configured) renders as a normal inline
// image with no attachment icon in the recipient's mail client — see
// routes/publicAssets.js. Falls back to the CID-attachment approach when
// APP_BASE_URL isn't set, so sending still works, just less elegantly.
const logoUrl = config.appBaseUrl ? `${config.appBaseUrl}/api/public/assets/logo.png` : null;

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// First non-blank line of a snapshotted notes field, for the short preview
// in the email body — the full text is on the update page itself, not
// repeated here.
const firstLine = (text) => {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean);
  return line || '';
};

/**
 * `update` is a progress_updates row, `ticket` its ticket (title +
 * instrument_family/instrument_model), `customer` a customers row,
 * `attachmentCount` how many photos are on the update, `confirmUrl` the
 * public page link.
 */
function buildProgressUpdateEmail({
  update, ticket, customer, attachmentCount, confirmUrl,
}) {
  const customerName = escapeHtml(customer.name);
  const instrumentLabel = [ticket.instrument_family, ticket.instrument_model]
    .filter(Boolean).join(' ');
  const title = escapeHtml(ticket.title || 'Your instrument');

  const doneLine = firstLine(update.service_done_notes);
  const neededLine = firstLine(update.service_needed_notes);

  const previewRows = [
    doneLine && { label: 'Done so far', value: doneLine },
    neededLine && { label: 'Still ahead', value: neededLine },
    attachmentCount > 0 && {
      label: 'Photos',
      value: `${attachmentCount} photo${attachmentCount === 1 ? '' : 's'} attached`,
    },
  ].filter(Boolean);

  const html = `
<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="background:#16181d;padding:22px 28px;">
      ${logoUrl
        ? `<img src="${logoUrl}" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />`
        : '<img src="cid:cepco-logo" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />'}
    </div>
    <div style="padding:28px;">
      <h1 style="font-size:20px;margin:0 0 4px;color:#16181d;">Progress update — ${title}</h1>
      <p style="font-size:14px;color:#16181d;line-height:1.5;margin:0 0 22px;">
        Hi ${customerName} — here's where things stand${instrumentLabel ? ` with your ${escapeHtml(instrumentLabel)}` : ''}.
      </p>
      ${update.summary ? `<p style="font-size:14px;color:#16181d;line-height:1.6;margin:0 0 20px;white-space:pre-line;">${escapeHtml(update.summary)}</p>` : ''}
      ${previewRows.length ? `<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        ${previewRows.map((r) => `<tr>
          <td style="padding:9px 0;border-bottom:1px solid #ececec;font-size:12px;color:#9aa1ad;white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>
          <td style="padding:9px 0 9px 14px;border-bottom:1px solid #ececec;font-size:14px;color:#16181d;">${escapeHtml(r.value)}</td>
        </tr>`).join('')}
      </table>` : ''}
      <div style="text-align:center;margin-top:28px;">
        <a href="${confirmUrl}"
           style="display:inline-block;background:#16181d;color:#ffffff;text-decoration:none;
                  font-size:14px;font-weight:600;padding:13px 28px;border-radius:8px;">
          View full progress update
        </a>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#9aa1ad;text-align:center;">
        Photos, full notes, and anything else we've added are on that page.
      </p>
    </div>
    <div style="background:#f4f4f5;padding:16px 28px;font-size:12px;color:#9aa1ad;">
      Chicago Electric Piano Company
    </div>
  </div>
</div>`.trim();

  return {
    subject: `Progress update from Chicago Electric Piano Company — ${ticket.title || 'your instrument'}`,
    html,
    attachments: logoUrl ? [] : [
      {
        filename: 'cepco-logo.png',
        content: logoBase64(),
        content_type: 'image/png',
        content_id: 'cepco-logo',
      },
    ],
  };
}

module.exports = { buildProgressUpdateEmail };
