/**
 * End-to-end smoke test. Exercises the Phase 1 loop against a live API:
 * login -> settings -> create ticket -> estimate -> hours -> QC gate ->
 * invoice gate -> status audit trail -> admin settings guardrails.
 *
 * Run with the backend already listening on API_BASE (default :3311).
 */

const BASE = process.env.API_BASE || 'http://127.0.0.1:3311';
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

let cookie = '';
let passed = 0;
let failed = 0;

const ok = (name) => { passed += 1; console.log(`  PASS  ${name}`); };
const bad = (name, detail) => {
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
};

function check(name, condition, detail) {
  if (condition) ok(name); else bad(name, detail);
}

async function call(method, path, body) {
  const headers = { cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`);

  // --- health --------------------------------------------------------------
  const health = await call('GET', '/healthz');
  check('health check reports db up', health.status === 200 && health.body.db === 'up',
    JSON.stringify(health.body));

  // --- auth ----------------------------------------------------------------
  const badLogin = await call('POST', '/api/auth/login', { email: EMAIL, password: 'wrong' });
  check('wrong password is rejected', badLogin.status === 401);

  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  check('admin can log in', login.status === 200 && login.body.user.role === 'admin',
    JSON.stringify(login.body));

  const me = await call('GET', '/api/auth/me');
  check('session cookie authenticates /me', me.status === 200 && me.body.user.email === EMAIL.toLowerCase());

  // --- settings ------------------------------------------------------------
  const settings = await call('GET', '/api/settings');
  const statuses = settings.body.ticket_status || [];
  // qc_tier used to be a fifth category here — retired in migration 021
  // (routes/qc.js's standardized round progression replaced it), so a
  // fresh seed never creates one at all.
  check('all four settings categories are seeded',
    ['ticket_category', 'ticket_status', 'priority_tier', 'tech_level']
      .every((c) => (settings.body[c] || []).length > 0),
    Object.keys(settings.body).join(','));
  check('historical statuses seeded (8)', statuses.length === 8, `got ${statuses.length}`);

  // --- imported data -------------------------------------------------------
  const imported = await call('GET', '/api/tickets', undefined);
  check('CSV import produced tickets', Array.isArray(imported.body) && imported.body.length > 20,
    `got ${imported.body?.length}`);

  const fleet = await call('GET', '/api/instruments?fleet=true');
  check('showroom fleet imported', fleet.body.length > 30, `got ${fleet.body.length}`);
  check('fleet instruments have no customer',
    fleet.body.every((i) => i.customer_id === null));

  const parts = await call('GET', '/api/parts?status=needed');
  check('parts orders imported', parts.body.length > 5, `got ${parts.body.length}`);

  const vendors = await call('GET', '/api/parts/vendors');
  check('all 8 vendors present', vendors.body.length >= 8, `got ${vendors.body.length}`);

  // --- ticket lifecycle ----------------------------------------------------
  const customer = await call('POST', '/api/customers', { name: 'Smoke Test Customer' });
  const instrument = await call('POST', '/api/instruments', {
    family: 'wurlitzer', model: '200A', customer_id: customer.body.id,
  });

  const ticket = await call('POST', '/api/tickets', {
    title: 'Smoke test — Wurlitzer 200A',
    category_key: 'servicing',
    priority_key: 'standard_setup',
    customer_id: customer.body.id,
    instrument_id: instrument.body.id,
  });
  check('ticket created', ticket.status === 201, JSON.stringify(ticket.body));
  const tid = ticket.body.id;

  check('label snapshot written at creation',
    ticket.body.status_label_snapshot === 'Reservation',
    ticket.body.status_label_snapshot);

  const badEnum = await call('POST', '/api/tickets', {
    title: 'bad', category_key: 'nope', priority_key: 'standard_setup',
  });
  check('unknown category key is rejected', badEnum.status === 400);

  // --- estimate + labor rate ----------------------------------------------
  const rate = await call('GET', '/api/estimates/labor-rate');
  check('shop labor rate is $185', Number(rate.body.labor_rate) === 185,
    JSON.stringify(rate.body));

  const estimate = await call('POST', '/api/estimates', {
    ticket_id: tid, estimated_hours: 10, parts_cost: 250, confidence: 'high',
  });
  check('estimate created', estimate.status === 201);
  check('estimate picks up the $185 shop rate by default',
    Number(estimate.body.labor_rate) === 185, estimate.body.labor_rate);

  // Changing the rate must not restate quotes that already went out.
  const rateSetting = (settings.body.shop_config || []).find((s) => s.key === 'labor_rate');
  check('labor rate is exposed as an admin setting', !!rateSetting);
  await call('PATCH', `/api/settings/${rateSetting.id}`, {
    meta: { ...rateSetting.meta, value: 195 },
  });
  const afterRateChange = await call('GET', `/api/tickets/${tid}`);
  check('existing estimate keeps its quoted rate after a rate change',
    Number(afterRateChange.body.estimates[0].labor_rate) === 185,
    afterRateChange.body.estimates[0].labor_rate);

  const ticket3 = await call('POST', '/api/tickets', {
    title: 'Rate change check', category_key: 'servicing', priority_key: 'expedited',
  });
  const newRateEstimate = await call('POST', '/api/estimates', {
    ticket_id: ticket3.body.id, estimated_hours: 2,
  });
  check('a new estimate picks up the changed rate',
    Number(newRateEstimate.body.labor_rate) === 195, newRateEstimate.body.labor_rate);

  const explicitRate = await call('POST', '/api/estimates', {
    ticket_id: ticket3.body.id, estimated_hours: 2, labor_rate: 150,
  });
  check('an explicit rate overrides the shop default',
    Number(explicitRate.body.labor_rate) === 150, explicitRate.body.labor_rate);

  await call('PATCH', `/api/settings/${rateSetting.id}`, {
    meta: { ...rateSetting.meta, value: 185 },
  });

  const approve = await call('POST', `/api/estimates/${estimate.body.id}/approve`);
  check('estimate approved', approve.status === 200 && !!approve.body.approved_at);

  const reApprove = await call('POST', `/api/estimates/${estimate.body.id}/approve`);
  check('double approval is refused', reApprove.status === 404);

  // --- hours ---------------------------------------------------------------
  await call('POST', '/api/hours', { ticket_id: tid, hours: 4.5, task_description: 'Action work' });
  await call('POST', '/api/hours', { ticket_id: tid, hours: 7, task_description: 'Electronics' });
  const overLimit = await call('POST', '/api/hours', { ticket_id: tid, hours: 99 });
  check('absurd hours entry is rejected', overLimit.status === 400);

  const withHours = await call('GET', `/api/tickets/${tid}`);
  check('actual hours roll up on the ticket',
    Number(withHours.body.actual_hours) === 11.5, withHours.body.actual_hours);
  check('estimate variance is visible (11.5 actual vs 10 est)',
    Number(withHours.body.estimated_hours) === 10);

  // --- QC: standardized round progression, 2-reviewer sign-off (§021) -----
  const earlyInvoice = await call('POST', '/api/invoices', { ticket_id: tid });
  check('invoicing is blocked before QC passes', earlyInvoice.status === 400,
    JSON.stringify(earlyInvoice.body));

  const templates = await call('GET', '/api/qc/templates?family=wurlitzer&kind=qc');
  check('wurlitzer QC templates seeded from the sheets', templates.body.length >= 2,
    `got ${templates.body.length}`);

  // No tier, no template picker — the backend always resolves the next
  // round number and its standardized template for this ticket's
  // instrument family (routes/qc.js). This is round 1, so it's Wurlitzer's
  // "QC Round 1" template.
  const roundOne = await call('POST', '/api/qc/checks', { ticket_id: tid });
  check('QC round 1 auto-resolves the standardized Wurlitzer template',
    roundOne.status === 201 && roundOne.body.round_number === 1 && roundOne.body.results.length === 17,
    `round ${roundOne.body.round_number}, ${roundOne.body.results?.length} items`);

  await call('PATCH', `/api/qc/checks/${roundOne.body.id}`, { notes: 'Round 1 looks good.' });
  const signOffRound1 = await call('POST', `/api/qc/checks/${roundOne.body.id}/sign-off`, { passed: true });
  check('round 1 signs off', signOffRound1.status === 200 && signOffRound1.body.check.passed);
  check('one passing round is not enough on its own anymore (2 are required)',
    signOffRound1.body.ticket_qc_passed === false && signOffRound1.body.rounds_passed === 1,
    JSON.stringify(signOffRound1.body));

  const stillBlocked = await call('POST', '/api/invoices', { ticket_id: tid });
  check('invoicing still blocked after one round', stillBlocked.status === 400);

  // Round 2 always follows round 1 (there's no way to ask for it first),
  // and clearing QC needs a *different* reviewer to sign it off — sign
  // this one off from a second employee's session.
  const roundTwo = await call('POST', '/api/qc/checks', { ticket_id: tid });
  check('round 2 auto-resolves the standardized "QC Final" template',
    roundTwo.status === 201 && roundTwo.body.round_number === 2 && roundTwo.body.results.length === 19,
    `round ${roundTwo.body.round_number}, ${roundTwo.body.results?.length} items`);

  const qcAdminCookie = cookie;
  await call('POST', '/api/employees', {
    name: 'QC Reviewer Two', email: 'qc.reviewer.two@example.com',
    password: 'reviewer-password-1', role: 'senior',
  });
  await call('POST', '/api/auth/login', {
    email: 'qc.reviewer.two@example.com', password: 'reviewer-password-1',
  });
  const signOffRound2 = await call('POST', `/api/qc/checks/${roundTwo.body.id}/sign-off`, { passed: true });
  cookie = qcAdminCookie; // back to the admin session for everything after this

  check('a second, distinct reviewer\'s pass clears QC',
    signOffRound2.body.ticket_qc_passed === true
      && signOffRound2.body.rounds_passed === 2
      && signOffRound2.body.distinct_reviewers === 2,
    JSON.stringify(signOffRound2.body));

  const invoice = await call('POST', '/api/invoices', { ticket_id: tid, amount: 2000 });
  check('invoicing allowed after QC passes', invoice.status === 201, JSON.stringify(invoice.body));

  // --- status audit trail --------------------------------------------------
  await call('PATCH', `/api/tickets/${tid}`, { status_key: 'in_progress', status_note: 'Started work' });
  await call('PATCH', `/api/tickets/${tid}`, { status_key: 'done' });
  const audited = await call('GET', `/api/tickets/${tid}`);
  check('every status change is logged', audited.body.status_history.length === 3,
    `${audited.body.status_history.length} entries`);
  check('status change note is captured',
    audited.body.status_history.some((h) => h.note === 'Started work'));
  check('free-form transitions allowed (in_progress -> done)',
    audited.body.status_key === 'done');

  // --- settings guardrails (§8) -------------------------------------------
  const inUse = statuses.find((s) => s.key === 'done');
  const del = await call('DELETE', `/api/settings/${inUse.id}`);
  check('deleting an in-use status is refused', del.status === 409, JSON.stringify(del.body));

  const renamed = await call('PATCH', `/api/settings/${inUse.id}`, { label: 'Completed' });
  check('renaming a status succeeds', renamed.status === 200 && renamed.body.label === 'Completed');

  const afterRename = await call('GET', `/api/tickets/${tid}`);
  check('rename propagates to existing tickets',
    afterRename.body.status_label === 'Completed', afterRename.body.status_label);
  check('but the historical snapshot is preserved',
    afterRename.body.status_label_snapshot === 'Done', afterRename.body.status_label_snapshot);
  await call('PATCH', `/api/settings/${inUse.id}`, { label: 'Done' });

  const unusedCreate = await call('POST', '/api/settings', {
    category: 'ticket_status', label: 'Temp Status',
  });
  const unusedDelete = await call('DELETE', `/api/settings/${unusedCreate.body.id}`);
  check('deleting an unused status succeeds', unusedDelete.status === 200);

  // --- RBAC ----------------------------------------------------------------
  await call('POST', '/api/employees', {
    name: 'Junior Smoke', email: 'junior.smoke@example.com',
    password: 'junior-password-1', role: 'junior',
  });
  const adminCookie = cookie;
  await call('POST', '/api/auth/login', {
    email: 'junior.smoke@example.com', password: 'junior-password-1',
  });
  const juniorSettings = await call('POST', '/api/settings', {
    category: 'ticket_status', label: 'Should Fail',
  });
  check('junior tech cannot edit settings', juniorSettings.status === 403);

  const juniorEstimate = await call('POST', '/api/estimates', { ticket_id: tid, estimated_hours: 1 });
  check('junior tech cannot write estimates', juniorEstimate.status === 403);

  const juniorHours = await call('POST', '/api/hours', { ticket_id: tid, hours: 1 });
  check('junior tech can log their own hours', juniorHours.status === 201);

  const juniorReads = await call('GET', '/api/tickets');
  check('junior tech can read tickets', juniorReads.status === 200);

  // --- self-service password change -----------------------------------
  const wrongCurrent = await call('POST', '/api/auth/change-password', {
    current_password: 'not-the-real-password', new_password: 'junior-password-2',
  });
  check('change-password rejects wrong current password', wrongCurrent.status === 401);

  const tooShort = await call('POST', '/api/auth/change-password', {
    current_password: 'junior-password-1', new_password: 'short',
  });
  check('change-password rejects a too-short new password', tooShort.status === 400);

  const changed = await call('POST', '/api/auth/change-password', {
    current_password: 'junior-password-1', new_password: 'junior-password-2',
  });
  check('junior tech can change their own password', changed.status === 200);

  cookie = '';
  const oldPasswordLogin = await call('POST', '/api/auth/login', {
    email: 'junior.smoke@example.com', password: 'junior-password-1',
  });
  check('old password no longer works after change', oldPasswordLogin.status === 401);

  const newPasswordLogin = await call('POST', '/api/auth/login', {
    email: 'junior.smoke@example.com', password: 'junior-password-2',
  });
  check('new password logs in', newPasswordLogin.status === 200);

  cookie = adminCookie;

  const noAuth = await fetch(`${BASE}/api/tickets`);
  check('unauthenticated request is rejected', noAuth.status === 401);

  // --- summary -------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
