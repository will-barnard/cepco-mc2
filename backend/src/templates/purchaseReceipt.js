'use strict';

const fs = require('fs');
const path = require('path');

// Same repo-root resolution pattern as scripts/migrate.js's MIGRATIONS_DIR —
// works regardless of the process's cwd.
const LOGO_PATH = path.resolve(__dirname, '../../../assets/CEPCO-LOGO-FINAL.png');

// Read once, lazily, and cache — most boots never send this email, so don't
// pay the disk read (or risk a startup crash if the asset ever moves) until
// the first send actually happens.
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

/** purchase_date is a plain 'YYYY-MM-DD' string (see NOTES.md §2.13) — parse
 * it from its parts, never `new Date(thatString)`, so it can't land on the
 * wrong day for whoever's reading the email. */
function formatDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

const formatMoney = (n) => Number(n).toLocaleString('en-US', {
  style: 'currency', currency: 'USD',
});

/**
 * Builds the "we bought your instrument" receipt email. `purchase` is a row
 * from instrument_purchases joined with its instrument (see
 * routes/purchases.js's send-receipt handler) — every user-supplied field
 * is HTML-escaped before it goes anywhere near the template.
 */
function buildPurchaseReceiptEmail(purchase) {
  const instrumentLabel = escapeHtml(
    [purchase.instrument_family, purchase.instrument_model].filter(Boolean).join(' '),
  );
  const sellerName = escapeHtml(purchase.seller_name);
  const price = formatMoney(purchase.price);
  const date = formatDate(purchase.purchase_date);

  const detailRow = (label, value) => (value
    ? `<tr>
         <td style="padding:7px 0;color:#6b7280;font-size:14px;">${label}</td>
         <td style="padding:7px 0;text-align:right;font-weight:600;font-size:14px;color:#16181d;">${value}</td>
       </tr>`
    : '');

  const html = `
<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="background:#16181d;padding:22px 28px;">
      <img src="cid:cepco-logo" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />
    </div>
    <div style="padding:28px;">
      <h1 style="font-size:20px;margin:0 0 4px;color:#16181d;">Purchase receipt</h1>
      <p style="color:#6b7280;font-size:13px;margin:0 0 22px;">${date}</p>
      <p style="font-size:14px;color:#16181d;line-height:1.5;margin:0 0 22px;">
        Thank you, ${sellerName} — this confirms Chicago Electric Piano Company's
        purchase of the instrument below.
      </p>
      <table style="width:100%;border-collapse:collapse;">
        ${detailRow('Instrument', instrumentLabel || '—')}
        ${detailRow('Year', escapeHtml(purchase.instrument_year))}
        ${detailRow('Serial number', escapeHtml(purchase.instrument_serial_no))}
      </table>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;border-top:1px solid #e5e5e5;">
        <tr>
          <td style="padding:14px 0 0;color:#6b7280;font-size:14px;">Amount paid</td>
          <td style="padding:14px 0 0;text-align:right;font-weight:700;font-size:20px;color:#16181d;">${price}</td>
        </tr>
      </table>
      ${purchase.notes ? `<p style="margin:22px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">${escapeHtml(purchase.notes)}</p>` : ''}
    </div>
    <div style="background:#f4f4f5;padding:16px 28px;font-size:12px;color:#9aa1ad;">
      Chicago Electric Piano Company
    </div>
  </div>
</div>`.trim();

  return {
    subject: `Your purchase receipt from Chicago Electric Piano Company${instrumentLabel ? ` — ${instrumentLabel}` : ''}`,
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

module.exports = { buildPurchaseReceiptEmail };
