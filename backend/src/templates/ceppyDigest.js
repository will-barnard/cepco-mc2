'use strict';

/**
 * Builds the weekly Ceppys digest email — services/ceppys.js's
 * sendCeppyDigest(), fired either by the schedule (services/
 * ceppyScheduler.js) or an admin's manual "Send now" (routes/ceppys.js).
 * One nomination list, same for every recipient (no per-recipient
 * personalization) — same visual language as templates/quoteEmail.js and
 * templates/purchaseReceipt.js (inline CID logo, same fonts/colors) so it
 * reads as the same shop, not a separate tool bolted on.
 *
 * C1 (boss-list scope): nominations are grouped by award category
 * (category_label_snapshot, or the free-typed category_other, in that
 * order — see migration 027) so the email reads like an actual awards
 * list rather than a flat pile. Nominations with neither (pre-C1 rows
 * still sitting unsent when this deploys) fall into a final "General"
 * bucket rather than being dropped or crashing the render.
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

function nominationRow(n) {
  return `<div style="padding:16px 0;border-bottom:1px solid #ececec;">
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#d97706;">
      ${escapeHtml(n.title)}
    </p>
    <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#16181d;">
      ${escapeHtml(n.nominee_name)}
    </p>
    <p style="margin:0 0 6px;font-size:12px;color:#9aa1ad;">
      Nominated by ${escapeHtml(n.nominator_name)}
    </p>
    <p style="margin:0;font-size:14px;color:#16181d;line-height:1.5;">
      ${escapeHtml(n.reason)}
    </p>
  </div>`;
}

/** Group label for a nomination — snapshot key label wins, then the
 * free-typed "other" category, then a catch-all for rows with neither. */
function categoryLabel(n) {
  return n.category_label_snapshot || n.category_other || 'General';
}

/** Groups nominations by category, preserving each group's first-appearance
 * order (nominations already arrive ordered by created_at) rather than
 * re-sorting groups alphabetically — the first category to get a nomination
 * this round leads the email. */
function groupByCategory(nominations) {
  const order = [];
  const groups = new Map();
  for (const n of nominations) {
    const label = categoryLabel(n);
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label).push(n);
  }
  return order.map((label) => ({ label, items: groups.get(label) }));
}

function categorySection({ label, items }) {
  return `<div style="margin:0 0 20px;">
    <h2 style="margin:0 0 4px;font-size:13px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#16181d;border-bottom:2px solid #16181d;padding-bottom:6px;">
      ${escapeHtml(label)}
    </h2>
    ${items.map(nominationRow).join('')}
  </div>`;
}

/** `nominations` is an array of ceppy_nominations rows joined to nominee_name/nominator_name. */
function buildCeppyDigestEmail({ nominations }) {
  const body = nominations.length
    ? groupByCategory(nominations).map(categorySection).join('')
    : `<p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">
         No Ceppy nominations came in this round — nominate a teammate any time from the
         Ceppys tab.
       </p>`;

  const html = `
<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="background:#16181d;padding:22px 28px;">
      ${logoUrl
        ? `<img src="${logoUrl}" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />`
        : '<img src="cid:cepco-logo" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />'}
    </div>
    <div style="padding:28px;">
      <h1 style="font-size:20px;margin:0 0 4px;color:#16181d;">This week's Ceppy nominations</h1>
      <p style="font-size:14px;color:#6b7280;line-height:1.5;margin:0 0 20px;">
        ${nominations.length
          ? `${nominations.length} nomination${nominations.length === 1 ? '' : 's'} came in since the last digest.`
          : 'A quick roundup of who got nominated this round.'}
      </p>
      ${body}
      <p style="margin:20px 0 0;font-size:12px;color:#9aa1ad;text-align:center;">
        Nominate a teammate any time from the Ceppys tab in Mission Control.
      </p>
    </div>
    <div style="background:#f4f4f5;padding:16px 28px;font-size:12px;color:#9aa1ad;">
      Chicago Electric Piano Company
    </div>
  </div>
</div>`.trim();

  return {
    subject: "This week's Ceppy nominations — Chicago Electric Piano Company",
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

module.exports = { buildCeppyDigestEmail };
