'use strict';

/**
 * Internal notification emailed to every admin-level employee when a
 * customer accepts an estimate — services/quotes.js's
 * notifyAdminsEstimateAccepted(), fired from publicQuotes.js's POST
 * /:token/confirm (the only place an estimate's status becomes
 * 'confirmed'). Same visual language as templates/quoteEmail.js and
 * templates/ceppyDigest.js (inline CID logo, same fonts/colors), just
 * internal-facing and much shorter — there's nothing here an admin needs
 * to review before acting, unlike the customer's own copy of the
 * estimate.
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

const formatMoney = (n) => Number(n).toLocaleString('en-US', {
  style: 'currency', currency: 'USD',
});

/**
 * `estimate` is an `estimates` row, `customerName` a plain string (the
 * caller may only have a joined name, not a full customers row, in
 * hand), `totals` from routes/quotes.js's totalsFor(). `estimateUrl` is
 * null when APP_BASE_URL isn't configured — the CTA button is left out
 * entirely rather than linking to "null", since (unlike the customer-
 * facing quote email) a missing link here is a cosmetic gap, not a
 * reason to hold up sending the notice at all.
 */
function buildEstimateAcceptedNotice({
  estimate, customerName, totals, estimateUrl,
}) {
  const name = escapeHtml(customerName || 'A customer');
  const title = escapeHtml(estimate.title || 'an estimate');
  const rangeLabel = totals.min_cost === totals.max_cost
    ? formatMoney(totals.min_cost)
    : `${formatMoney(totals.min_cost)} – ${formatMoney(totals.max_cost)}`;

  const html = `
<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="background:#16181d;padding:22px 28px;">
      ${logoUrl
        ? `<img src="${logoUrl}" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />`
        : '<img src="cid:cepco-logo" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />'}
    </div>
    <div style="padding:28px;">
      <h1 style="font-size:20px;margin:0 0 12px;color:#16181d;">Estimate accepted</h1>
      <p style="font-size:14px;color:#16181d;line-height:1.5;margin:0;">
        ${name} accepted <strong>${title}</strong> (${rangeLabel}).
      </p>
      ${estimateUrl ? `<div style="text-align:center;margin-top:24px;">
        <a href="${estimateUrl}"
           style="display:inline-block;background:#16181d;color:#ffffff;text-decoration:none;
                  font-size:14px;font-weight:600;padding:13px 28px;border-radius:8px;">
          View estimate
        </a>
      </div>` : ''}
    </div>
    <div style="background:#f4f4f5;padding:16px 28px;font-size:12px;color:#9aa1ad;">
      Chicago Electric Piano Company
    </div>
  </div>
</div>`.trim();

  return {
    subject: `Estimate accepted — ${name}${estimate.title ? `: ${estimate.title}` : ''}`,
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

module.exports = { buildEstimateAcceptedNotice };
