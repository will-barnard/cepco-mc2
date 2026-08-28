'use strict';

/**
 * Builds the weekly Ceppys digest email — services/ceppys.js's
 * sendCeppyDigest(), fired either by the schedule (services/
 * ceppyScheduler.js) or an admin's manual "Send now" (routes/ceppys.js).
 * One nomination list, same for every recipient (no per-recipient
 * personalization) — same visual language as templates/quoteEmail.js and
 * templates/purchaseReceipt.js (inline CID logo, same fonts/colors) so it
 * reads as the same shop, not a separate tool bolted on.
 */

const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.resolve(__dirname, '../../../assets/CEPCO-LOGO-FINAL.png');

let cachedLogoBase64 = null;
function logoBase64() {
  if (cachedLogoBase64 === null) {
    cachedLogoBase64 = fs.readFileSync(LOGO_PATH).toString('base64');
  }
  return cachedLogoBase64;
}

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

/** `nominations` is an array of ceppy_nominations rows joined to nominee_name/nominator_name. */
function buildCeppyDigestEmail({ nominations }) {
  const body = nominations.length
    ? nominations.map(nominationRow).join('')
    : `<p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">
         No Ceppy nominations came in this round — nominate a teammate any time from the
         Ceppys tab.
       </p>`;

  const html = `
<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="background:#16181d;padding:22px 28px;">
      <img src="cid:cepco-logo" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />
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
    attachments: [
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
