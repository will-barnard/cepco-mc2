/**
 * Attachment path test: capabilities, multipart upload, gallery listing,
 * authenticated file serving, MIME rejection, and delete.
 */

const BASE = process.env.API_BASE || 'http://127.0.0.1:3311';
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

let cookie = '';
let passed = 0;
let failed = 0;

const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
};

async function call(method, path, body) {
  const headers = { cookie };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, raw: text };
}

// Smallest valid PNG (1x1, transparent).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  console.log(`\nAttachment test against ${BASE}\n`);
  await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });

  const caps = await call('GET', '/api/attachments/capabilities');
  check('capabilities reports the active driver',
    caps.status === 200 && caps.body.driver === 'local' && caps.body.direct_upload === false,
    JSON.stringify(caps.body));

  const ticket = await call('POST', '/api/tickets', {
    title: 'Photo test ticket', category_key: 'servicing', priority_key: 'expedited',
  });
  const tid = ticket.body.id;

  const noDirect = await call('POST', '/api/attachments/upload-url', {
    ticket_id: tid, file_name: 'a.jpg', content_type: 'image/jpeg',
  });
  check('signed-URL path refused on the local driver', noDirect.status === 400);

  // --- multipart upload ----------------------------------------------------
  const form = new FormData();
  form.append('ticket_id', String(tid));
  form.append('caption', 'hammer tips before');
  form.append('files', new Blob([PNG], { type: 'image/png' }), 'before.png');
  form.append('files', new Blob([PNG], { type: 'image/png' }), 'after.png');
  const upload = await call('POST', '/api/attachments', form);
  check('two photos upload in one request',
    upload.status === 201 && upload.body.length === 2, JSON.stringify(upload.body).slice(0, 200));
  check('caption and uploader are recorded',
    upload.body?.[0]?.caption === 'hammer tips before' && !!upload.body?.[0]?.uploader_id);
  check('storage driver is stamped on the row', upload.body?.[0]?.driver === 'local');

  // --- rejection -----------------------------------------------------------
  const badForm = new FormData();
  badForm.append('ticket_id', String(tid));
  badForm.append('files', new Blob(['#!/bin/sh'], { type: 'application/x-sh' }), 'evil.sh');
  const rejected = await call('POST', '/api/attachments', badForm);
  check('non-image upload is rejected', rejected.status === 400, JSON.stringify(rejected.body));

  // --- listing + serving ---------------------------------------------------
  const list = await call('GET', `/api/attachments/ticket/${tid}`);
  check('gallery lists both photos', list.body.length === 2, `got ${list.body.length}`);
  check('uploader name is joined for display', !!list.body[0].uploader_name);

  const urlRes = await call('GET', `/api/attachments/${list.body[0].id}/url`);
  check('a viewable URL is issued', urlRes.status === 200 && !!urlRes.body.url);

  const file = await fetch(BASE + urlRes.body.url, { headers: { cookie } });
  const bytes = Buffer.from(await file.arrayBuffer());
  check('file serves back byte-identical',
    file.status === 200 && bytes.equals(PNG), `${file.status}, ${bytes.length} bytes`);
  check('served with the stored content type',
    file.headers.get('content-type')?.includes('image/png'));

  const anon = await fetch(BASE + urlRes.body.url);
  check('file is not served without a session', anon.status === 401);

  // --- appears on the ticket ----------------------------------------------
  const detail = await call('GET', `/api/tickets/${tid}`);
  check('attachments appear on the ticket detail', detail.body.attachments.length === 2);

  const listing = await call('GET', '/api/tickets');
  const row = listing.body.find((t) => t.id === tid);
  check('attachment count shows in the ticket list', row.attachment_count === 2, `${row.attachment_count}`);

  // --- caption editing after upload ---------------------------------------
  const captioned = await call('PATCH', `/api/attachments/${list.body[1].id}`, {
    caption: 'hammer tips after',
  });
  check('caption can be set after upload',
    captioned.status === 200 && captioned.body.caption === 'hammer tips after',
    JSON.stringify(captioned.body));

  const cleared = await call('PATCH', `/api/attachments/${list.body[1].id}`, { caption: '' });
  check('clearing a caption stores null', cleared.body.caption === null);

  const missingCaption = await call('PATCH', `/api/attachments/${list.body[1].id}`, {});
  check('caption patch requires a caption field', missingCaption.status === 400);

  // --- delete --------------------------------------------------------------
  const del = await call('DELETE', `/api/attachments/${list.body[0].id}`);
  check('photo deletes', del.status === 200);
  const after = await call('GET', `/api/attachments/ticket/${tid}`);
  check('gallery reflects the deletion', after.body.length === 1);

  // --- QC photos: attached to a round, separate from the ticket gallery ----
  const round = await call('POST', '/api/qc/checks', { ticket_id: tid });
  const qcForm = new FormData();
  qcForm.append('caption', 'tine before');
  qcForm.append('files', new Blob([PNG], { type: 'image/png' }), 'qc-before.png');
  const qcUp = await call('POST', `/api/qc/checks/${round.body.id}/attachments`, qcForm);
  check('a QC photo uploads to a round', qcUp.status === 201 && qcUp.body.length === 1, JSON.stringify(qcUp.body));
  check('QC photo is keyed under the ticket\'s qc/ folder',
    qcUp.body?.[0]?.storage_key.startsWith(`tickets/${tid}/qc/`));
  const qcBad = new FormData();
  qcBad.append('files', new Blob(['#!/bin/sh'], { type: 'application/x-sh' }), 'evil.sh');
  check('non-image QC upload is rejected',
    (await call('POST', `/api/qc/checks/${round.body.id}/attachments`, qcBad)).status === 400);

  const qcList = await call('GET', `/api/qc/checks/${round.body.id}/attachments`);
  check('QC gallery lists the photo with its uploader',
    qcList.body.length === 1 && !!qcList.body[0].uploader_name);
  const generalAfterQc = await call('GET', `/api/attachments/ticket/${tid}`);
  check('QC photos do not appear in the ticket\'s general gallery', generalAfterQc.body.length === 1);

  const qcUrl = await call('GET', `/api/qc/attachments/${qcList.body[0].id}/url`);
  const qcFile = await fetch(BASE + qcUrl.body.url, { headers: { cookie } });
  check('QC photo serves back byte-identical through the file proxy',
    qcFile.status === 200 && Buffer.from(await qcFile.arrayBuffer()).equals(PNG), `${qcFile.status}`);
  check('QC photo is not served without a session', (await fetch(BASE + qcUrl.body.url)).status === 401);

  const qcCaption = await call('PATCH', `/api/qc/attachments/${qcList.body[0].id}`, { caption: 'tine after' });
  check('QC photo caption can be edited', qcCaption.body.caption === 'tine after');

  // A signed-off round is closed to new photos and deletions.
  await call('POST', `/api/qc/checks/${round.body.id}/sign-off`, { passed: true });
  const lateForm = new FormData();
  lateForm.append('files', new Blob([PNG], { type: 'image/png' }), 'late.png');
  check('a signed-off round rejects new photos',
    (await call('POST', `/api/qc/checks/${round.body.id}/attachments`, lateForm)).status === 400);
  check('a signed-off round rejects photo deletion',
    (await call('DELETE', `/api/qc/attachments/${qcList.body[0].id}`)).status === 400);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
