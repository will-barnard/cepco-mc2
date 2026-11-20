'use strict';

/**
 * Friday Lunch emails (services/fridayLunchEmail.js): suggestions open,
 * voting open, winner. Same shell as templates/ceppyDigest.js -- dark header
 * with the logo, white card -- so it reads as Mission Control, not a
 * bolt-on. Never names who suggested or voted for anything.
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
const pageUrl = config.appBaseUrl ? `${config.appBaseUrl}/lunch` : null;

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// lunch_date is a bare 'YYYY-MM-DD' (db.js keeps DATEs as strings); noon
// UTC means no timezone can push it onto a neighbouring day.
const friendlyDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
});

function button(label) {
  if (!pageUrl) {
    return '<p style="margin:20px 0 0;font-size:13px;color:#6b7280;">Open Mission Control → More → Friday Lunch.</p>';
  }
  return `<p style="margin:22px 0 0;">
    <a href="${pageUrl}" style="display:inline-block;background:#16181d;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:6px;">
      ${escapeHtml(label)}
    </a>
  </p>`;
}

function requestsBlock(requests) {
  if (!requests || !requests.length) return '';
  return `<p style="margin:18px 0 6px;font-size:12px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#6b7280;">
      Requests
    </p>
    <ul style="margin:0;padding-left:20px;font-size:14px;color:#16181d;line-height:1.6;">
      ${requests.map((r) => `<li>${escapeHtml(r.request_text)}</li>`).join('')}
    </ul>`;
}

function body({
  kind, round, places, requests,
}) {
  const date = friendlyDate(round.lunch_date);
  if (kind === 'suggesting') {
    return {
      subject: `Friday Lunch: where should we go ${date}?`,
      heading: 'Friday Lunch suggestions are open',
      content: `<p style="margin:0;font-size:14px;color:#16181d;line-height:1.5;">
          Any requests for ${escapeHtml(date)} ("no Mexican this week")? Add yours, then suggest
          up to two places. It's all anonymous.
        </p>${button('Add requests and suggestions')}`,
    };
  }
  if (kind === 'voting') {
    return {
      subject: `Friday Lunch: voting is open for ${date}`,
      heading: 'Time to vote on Friday Lunch',
      content: `<p style="margin:0 0 12px;font-size:14px;color:#16181d;line-height:1.5;">
          Rank up to three of these: 1st gets 3 points, 2nd gets 2, 3rd gets 1. Votes are anonymous, and you can change yours until voting closes.
        </p>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#16181d;line-height:1.7;">
          ${places.map((p) => `<li>${escapeHtml(p.name)}</li>`).join('')}
        </ul>${requestsBlock(requests)}${button('Cast your vote')}`,
    };
  }
  if (kind === 'orders') {
    const winner = round.winner_name || 'lunch';
    return {
      subject: `Friday Lunch: add your ${winner} order`,
      heading: `Add your order for ${escapeHtml(winner)}`,
      content: `<p style="margin:0;font-size:14px;color:#16181d;line-height:1.5;">
          We're collecting orders for ${escapeHtml(date)}. Type yours on the Friday Lunch page.
          Orders show your name so whoever places it knows whose is whose.
        </p>${button('Add my order')}`,
    };
  }

  if (kind === 'runoff') {
    return {
      subject: `Friday Lunch runoff: ${places.map((p) => p.name).join(' vs ')}`,
      heading: 'Friday Lunch runoff',
      content: `<p style="margin:0 0 12px;font-size:14px;color:#16181d;line-height:1.5;">
          It's down to these for ${escapeHtml(date)}. Pick one; most votes wins.
          Votes are anonymous, and you can change yours until voting closes.
        </p>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#16181d;line-height:1.7;">
          ${places.map((p) => `<li>${escapeHtml(p.name)}</li>`).join('')}
        </ul>${requestsBlock(requests)}${button('Vote in the runoff')}`,
    };
  }

  // closed (or a recount that changed the winner -- see services/fridayLunch.js)
  const winner = round.winner_name;
  if (round.parent_round_id) {
    const drawn = round.result?.tie_break?.method === 'random';
    return {
      subject: winner ? `Friday Lunch runoff: it's ${winner}` : 'Friday Lunch runoff closed',
      heading: winner ? `Friday Lunch is ${escapeHtml(winner)}` : 'Friday Lunch runoff closed',
      content: `<p style="margin:0;font-size:14px;color:#16181d;line-height:1.5;">
          ${drawn
            ? `The runoff for ${escapeHtml(date)} ended in a tie, so the winner was picked at random.`
            : `The runoff for ${escapeHtml(date)} is in.`}
        </p>${button('See the results')}`,
    };
  }
  if (round.result?.recounted_at) {
    return {
      subject: winner ? `Friday Lunch recount: it's ${winner}` : 'Friday Lunch recount',
      heading: winner ? `Recount: Friday Lunch is ${escapeHtml(winner)}` : 'Friday Lunch recount',
      content: `<p style="margin:0;font-size:14px;color:#16181d;line-height:1.5;">
          We recounted the votes for ${escapeHtml(date)} with points (1st = 3, 2nd = 2, 3rd = 1),
          so 2nd and 3rd choices count. That changed the result.
        </p>${button('See the results')}`,
    };
  }
  return {
    subject: winner ? `Friday Lunch: it's ${winner}` : 'Friday Lunch: voting closed',
    heading: winner ? `Friday Lunch is ${escapeHtml(winner)}` : 'Friday Lunch voting closed',
    content: `<p style="margin:0;font-size:14px;color:#16181d;line-height:1.5;">
        ${winner
          ? `The vote is in for ${escapeHtml(date)}.`
          : `No votes were cast for ${escapeHtml(date)}, so there's no winner.`}
      </p>${button('See the results')}`,
  };
}

function buildFridayLunchEmail({
  kind, round, places, requests = [],
}) {
  const { subject, heading, content } = body({
    kind, round, places, requests,
  });
  const html = `
<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="background:#16181d;padding:22px 28px;">
      ${logoUrl
        ? `<img src="${logoUrl}" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />`
        : '<img src="cid:cepco-logo" alt="Chicago Electric Piano Company" height="30" style="display:block;border:0;" />'}
    </div>
    <div style="padding:28px;">
      <h1 style="font-size:20px;margin:0 0 14px;color:#16181d;">${heading}</h1>
      ${content}
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

module.exports = { buildFridayLunchEmail };
