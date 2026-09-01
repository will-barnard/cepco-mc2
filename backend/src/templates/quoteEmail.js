'use strict';

/**
 * Builds the customer-facing quote email — routes/quotes.js's POST
 * /:id/send. Same visual language as templates/purchaseReceipt.js (inline
 * CID logo, same fonts/colors), just an itemized table instead of a single
 * line, and a single CTA button that goes to the public confirm/decline
 * page (`/quote/:token` in the frontend) rather than performing any action
 * itself — a GET link that changes state is a bad idea in email (some mail
 * clients/security scanners prefetch every link in a message), so the
 * button only ever *shows* the quote; confirming or declining happens from
 * a real click once the customer is looking at it. See NOTES.md.
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

const formatMoney = (n) => Number(n).toLocaleString('en-US', {
  style: 'currency', currency: 'USD',
});

function itemRow(item) {
  const instrumentLabel = escapeHtml(
    [item.instrument_family, item.instrument_model].filter(Boolean).join(' ') || 'General',
  );
  // parts_cost (migration 043) is a real dollar amount included in the
  // total, additive to an hours-based item's labor — shown here so the
  // line item's own price is legible, not folded silently into the
  // total. outlier_hours (same migration) never appears here — see
  // routes/quotes.js's outlierBufferFor for why.
  let price;
  if (item.pricing_type === 'flat') {
    price = formatMoney(item.flat_cost);
  } else {
    price = `${item.min_hours}–${item.max_hours} hrs`;
    if (item.parts_cost) price += ` + ${formatMoney(item.parts_cost)} parts`;
  }
  return `<tr>
    <td style="padding:9px 0;border-bottom:1px solid #ececec;font-size:14px;color:#16181d;">
      ${escapeHtml(item.procedure_name)}<br/>
      <span style="font-size:12px;color:#9aa1ad;">${instrumentLabel}</span>
    </td>
    <td style="padding:9px 0;border-bottom:1px solid #ececec;text-align:right;font-size:14px;
               color:#16181d;white-space:nowrap;">${price}</td>
  </tr>`;
}

/**
 * `estimate` is an `estimates` row (kind='customer_quote'), `customer` a
 * `customers` row, `items` its `estimate_items` rows, `totals` from
 * routes/quotes.js's totalsFor(), `confirmUrl` the public page link.
 */
function buildQuoteEmail({
  estimate, customer, items, totals, confirmUrl,
}) {
  const customerName = escapeHtml(customer.name);
  const title = escapeHtml(estimate.title || 'Your estimate');

  const rangeLabel = totals.min_cost === totals.max_cost
    ? formatMoney(totals.min_cost)
    : `${formatMoney(totals.min_cost)} – ${formatMoney(totals.max_cost)}`;

  const html = `
<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="background:#16181d;padding:22px 28px;">
      <img src="cid:cepco-logo" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />
    </div>
    <div style="padding:28px;">
      <h1 style="font-size:20px;margin:0 0 4px;color:#16181d;">${title}</h1>
      <p style="font-size:14px;color:#16181d;line-height:1.5;margin:0 0 22px;">
        Hi ${customerName} — here's an estimate for the work discussed. Take a look and let us
        know how you'd like to proceed.
      </p>
      <table style="width:100%;border-collapse:collapse;">
        ${items.map(itemRow).join('')}
      </table>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        <tr>
          <td style="padding:14px 0 0;color:#6b7280;font-size:14px;">Estimated total</td>
          <td style="padding:14px 0 0;text-align:right;font-weight:700;font-size:20px;color:#16181d;">
            ${rangeLabel}
          </td>
        </tr>
      </table>
      ${estimate.notes ? `<p style="margin:22px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">${escapeHtml(estimate.notes)}</p>` : ''}
      <div style="text-align:center;margin-top:28px;">
        <a href="${confirmUrl}"
           style="display:inline-block;background:#16181d;color:#ffffff;text-decoration:none;
                  font-size:14px;font-weight:600;padding:13px 28px;border-radius:8px;">
          Review &amp; respond to this estimate
        </a>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#9aa1ad;text-align:center;">
        You'll be able to confirm and get the work scheduled, or let us know it's a no —
        right from that page.
      </p>
    </div>
    <div style="background:#f4f4f5;padding:16px 28px;font-size:12px;color:#9aa1ad;">
      Chicago Electric Piano Company
    </div>
  </div>
</div>`.trim();

  return {
    subject: `Estimate from Chicago Electric Piano Company${estimate.title ? ` — ${estimate.title}` : ''}`,
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

module.exports = { buildQuoteEmail };
