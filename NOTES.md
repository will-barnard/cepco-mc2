# Build notes — Mission Control v2, Phase 1

What got built, what I'd flag before this goes into daily use, and how to finish
wiring up file storage. Written against `PLAN.md` as of this build.

---

## 1. What Phase 1 covers

Everything in PLAN §15 Phase 1 is implemented and tested:

| Plan item | Where |
|---|---|
| Auth, internal roles | `backend/src/routes/auth.js`, `middleware/auth.js` |
| Ticket CRUD, 5 categories | `routes/tickets.js` |
| Estimates | `routes/estimates.js` |
| Hours logging | `routes/hours.js` |
| Photo attachments | `routes/attachments.js`, `storage/` |
| QC sign-off | `routes/qc.js` |
| Admin settings | `services/settings.js`, `routes/settings.js` |
| `status_change_log` audit trail | written on every status change in `routes/tickets.js` |
| CSV migration | `scripts/importCsv.js` |
| Beachhead deploy | `beachhead.json`, `docker-compose.yml`, `frontend/nginx.conf` |

Extra beyond Phase 1, because they were nearly free once the schema existed:
parts orders tracking, shipments, invoice records with the QC gate, the fleet
view, and the estimate-vs-actual accuracy report.

**Verification.** 47 API smoke assertions, 19 attachment assertions and 11
image-pipeline unit tests, all passing against real PostgreSQL 18 with the real
CSVs imported:

```bash
cd backend  && npm test   # needs the stack up; see README
cd frontend && npm test   # pure unit tests, no stack needed
```

---

## 2. Things I'd flag

Ordered roughly by how likely they are to bite.

### 2.1 The historical `Estimated Hrs` data does not exist

PLAN §5 says estimate templates should be "seeded from the historical
`Estimated Hrs` values already present in the CSVs." They are almost entirely
blank — across all five sheets, **one row** has a number in that column
(Elliot Korte, 6 hrs). The import produced exactly 1 estimate from 118 tickets.

So confidence scoring has no seed data. `GET /api/estimates/reference` is built
and works, but it will return nothing until the shop has logged real hours
against real estimates for a while. That's fine — it just means Phase 2's
"estimate confidence fed by historical hours" starts from zero rather than from
the sheets. Worth knowing before anyone expects it to be useful on day one.

### 2.2 iPhone photos — RESOLVED, converted in the browser

Previously flagged as a problem; now handled. `frontend/src/imagePipeline.js`
normalises every file before it leaves the browser:

- **HEIC → JPEG** via `heic2any`, lazily imported so only a tech who actually
  uploads a HEIC downloads the 1.3 MB decoder. Desktop users never fetch it.
- **EXIF orientation baked into the pixels**, so phone photos stop arriving
  sideways.
- **Longest edge capped at 2560px, re-encoded at JPEG q0.85.** A 5 MB phone
  photo becomes roughly 400 KB — a real difference when uploading a dozen of
  them over shop wifi.
- **Passthrough for anything already small and web-safe**, and if re-encoding
  would somehow produce a *bigger* file, the original is kept.

Detection matters more than it looks: iOS frequently hands over a HEIC with an
empty `type`, so the check tests the filename as well as the MIME type. That
case is covered by a unit test.

The server still accepts HEIC as a fallback, so an upload can't hard-fail if
conversion misbehaves on some future browser — but in practice nothing HEIC
should ever reach it.

One thing genuinely untestable here: the HEIC decode itself needs a real
WASM-capable browser, so it's stubbed in the unit tests. **Worth confirming
with one real photo off your phone on first use.** Everything routing into it
is tested.

### 2.3 Free-form statuses mean nonsense transitions are possible

This is the plan's explicit choice (§8) and I've built it as specified — any
status can follow any status, with `status_change_log` as the audit trail
instead of a rules engine. Consequence worth naming out loud: nothing stops
"Invoice Paid" → "Not Started", or a ticket skipping QC entirely by being set
straight to Done.

The one hard gate I did enforce is the one §6 calls for: **QC must pass before
an invoice record can be created**, and that's tested. Everything else is
convention. If a specific transition turns out to need a guardrail, it can be
added without a schema change — the log already has the data to show which
transitions actually happen.

### 2.4 QC sign-off doesn't stop a tech signing off their own work

`require_distinct_reviewers` (on for the Perfectionist tier) enforces that two
*different* reviewers signed the passing rounds. It does not check that neither
of them is the assigned tech. For a shop this size that may be exactly right —
sometimes there are only two people in the building — but it's not what
"two-person sign-off" implies to everyone, so: it's a deliberate gap, not an
oversight. Easy to tighten in `routes/qc.js` if you want it.

### 2.5 Shop contacts imported as free text, not employee records

The sheets record contacts as initials and nicknames — `MB`, `KB`, `KM`, `MN`,
`KEEGZ`, `Max`, `Mike`. I did not guess at who those map to, so they're stored
verbatim in `tickets.shop_contact_raw` and displayed as-is. Once real staff
accounts exist, mapping them onto `shop_contact_id` is a short UPDATE per
initial. Leaving it unmapped is safer than a wrong guess.

### 2.6 Instrument family classification is heuristic

RHODES and WURLITZER sheets map cleanly. `HOHNER + STRINGS` and `KOMBO` each
hold several families, so `classifyFamily()` in `importCsv.js` guesses from the
instrument text — Clavinet/Pianet/Cembalet → hohner, CP-70/Helpinstill →
strings, Vox/Farfisa/Acetone → organ, everything else in KOMBO → rarity.

It'll get some wrong. An Ondioline is filed as a rarity; a "Selmer Clavioline &
Elka String Machine" row goes to hohner on the `clavioline` match when strings
is arguably better. Worth a pass through `/fleet` and the ticket list to correct
outliers, since family drives which QC template gets offered.

### 2.7 Estimates and tickets have a circular creation story

§5 says confirming an estimate should auto-generate the associated ticket(s).
§12 defines `estimates.ticket_id` as required — an estimate belongs to a ticket.
Both can't be true at once for the first estimate on a job.

I built it the §12 way: ticket first, estimate attached to it, approval recorded
on the estimate. If the intent was really "quote first, ticket on acceptance,"
that needs either a nullable `ticket_id` or a separate `quotes` table before the
Phase 2 quote-email work starts. Worth settling before then.

### 2.8 Labor rate — RESOLVED, now $185 and admin-editable

The rate moved, which is exactly the case this was flagged for, so it became
configuration rather than a constant. It now lives in a `shop_config` settings
row (migration `002`) and is editable under **Settings → Shop configuration**.

The important property is preserved: each estimate copies the rate onto its own
row at write time, so **changing the shop rate never restates a quote that has
already gone out**. That's covered by a test — the rate is changed mid-suite and
the existing estimate is asserted to still read $185 while a new one picks up
the new value.

Historical imports are deliberately pinned to **$175**, the rate the sheets were
quoted at (JOB QUEUE.csv's labour-rate rows). They were not backfilled.

An estimate can still override the rate per job if a particular quote needs it.

### 2.9 No rate limiting on login

Login compares with bcrypt (cost 12), which is slow enough to make brute force
impractical at any volume, and the app is behind Beachhead's proxy. But there's
no lockout or throttle. For an internal tool on a private domain that's a
reasonable place to be; noting it so it's a decision rather than an accident.

### 2.10 The nginx config was reviewed, not executed

No Docker or nginx binary in the build environment, so `frontend/nginx.conf`
could not be started and probed here. It follows the Beachhead resolver pattern
exactly (`resolver 127.0.0.11 valid=30s ipv6=off;` + variable `proxy_pass`, no
URI part after the variable), and the compose file passes every item on the
Beachhead checklist. But the first real deploy is the first time nginx actually
parses it. Everything else in this build ran for real.

---

## 3. Hooking up Google Cloud Storage

Photos currently use the `local` driver — a named Docker volume
(`cepco-mc2-uploads`) that survives redeploys but has no backup and lives on the
same box as everything else. Fine for now, not where job photos should live
permanently. Switching to GCS is env-var-only; no code change.

### 3.1 Create the bucket

```bash
# Use the same GCP project and region as the Beachhead VM (PLAN §16 —
# still needs confirming which project that is).
gcloud config set project YOUR_PROJECT_ID

gcloud storage buckets create gs://cepco-mc2-photos \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --public-access-prevention

# Cheap insurance against an accidental overwrite or delete (PLAN §11).
gcloud storage buckets update gs://cepco-mc2-photos --versioning
```

No lifecycle deletion rule — photos are job records and should be kept.

### 3.2 Give the backend access

Two paths, depending on the answer to §16's open question.

**If the Beachhead host is a GCE VM** — preferred, no key material anywhere:

```bash
gcloud storage buckets add-iam-policy-binding gs://cepco-mc2-photos \
  --member="serviceAccount:VM_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

Leave `GCS_SERVICE_ACCOUNT_KEY` unset. The SDK picks up Application Default
Credentials automatically.

> One catch: generating V4 signed URLs from ADC needs the service account to be
> able to sign. Grant it `roles/iam.serviceAccountTokenCreator` **on itself**:
> ```bash
> gcloud iam service-accounts add-iam-policy-binding \
>   VM_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com \
>   --member="serviceAccount:VM_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com" \
>   --role="roles/iam.serviceAccountTokenCreator"
> ```
> Without it, uploads fail at the signing step with a permissions error that
> doesn't mention signing.

**If it isn't a GCE VM** — dedicated service account with a key:

```bash
gcloud iam service-accounts create cepco-mc2-storage \
  --display-name="Mission Control photo storage"

# Scoped to this one bucket, not project-wide (PLAN §11).
gcloud storage buckets add-iam-policy-binding gs://cepco-mc2-photos \
  --member="serviceAccount:cepco-mc2-storage@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

gcloud iam service-accounts keys create /tmp/cepco-mc2-key.json \
  --iam-account=cepco-mc2-storage@YOUR_PROJECT.iam.gserviceaccount.com
```

### 3.3 CORS — required, and easy to forget

The browser uploads straight to the bucket, so the bucket must accept
cross-origin PUTs from the app's domain. Without this, uploads fail in the
browser with an opaque CORS error while working fine from curl.

```bash
cat > /tmp/cors.json <<'EOF'
[{
  "origin": ["https://missioncontrol.chicagoelectricpiano.com"],
  "method": ["GET", "PUT"],
  "responseHeader": ["Content-Type", "Content-Length"],
  "maxAgeSeconds": 3600
}]
EOF

gcloud storage buckets update gs://cepco-mc2-photos --cors-file=/tmp/cors.json
```

Replace the origin with the app's real domain once it's set.

### 3.4 Set the Beachhead env vars

In the Beachhead dashboard, as **global** vars (no Target Service — they're
referenced with `${VAR}` in `docker-compose.yml`, and a targeted var resolves to
empty there):

```
STORAGE_DRIVER=gcs
GCS_BUCKET_NAME=cepco-mc2-photos
GCS_PROJECT_ID=YOUR_PROJECT_ID
GCS_SERVICE_ACCOUNT_KEY=<entire JSON key on one line — omit if using the VM's service account>
```

Redeploy. The backend logs `[storage] driver=gcs directUpload=true` on boot, and
`GET /api/attachments/capabilities` will report the same. The frontend switches
to the signed-URL path on its own — no frontend change.

### 3.5 Migrating the photos already in the local volume

Only relevant if photos get uploaded before the switch. There's no automated
migration; the rows carry a `driver` column recording which backend wrote them,
so a mixed state is at least detectable:

```sql
SELECT driver, count(*) FROM ticket_attachments GROUP BY driver;
```

If the count under `local` is small, re-uploading through the UI is the least
fiddly fix. If it's large, copy the volume contents to the bucket preserving
paths and `UPDATE ticket_attachments SET driver = 'gcs' WHERE driver = 'local'`.

---

### 2.11 Photo uploads are capped at 2560px

The pipeline caps the longest edge at 2560px before upload. That's ample for
before/after documentation and for zooming in on a reed or a hammer tip, and it
keeps uploads fast on shop wifi.

If some job ever needs true full-resolution evidence — a cosmetic restoration
where fine grain matters, say — that cap is one constant in
`frontend/src/imagePipeline.js` (`MAX_EDGE`). Flagging it because it's a
deliberate quality/speed trade, not an accident, and it's lossy: the original
file is never uploaded.

---

### 2.12 Shared-computer quick switching — the security shape of it

Kiosk mode (`localStorage`-only per browser, toggled from Account by an
admin) shows a "who's using this" picker after 5 minutes idle, or on demand
via "Switch user" next to Sign out. Switching *into* a junior/senior account
takes one tap, no credential. Switching into an admin account requires that
admin's 4-digit PIN (`employees.pin_hash`, bcrypt, set by the admin
themselves from Account).

Two things worth being deliberate about, not stumbling into:

- `POST /auth/switch` is gated by `requireAuth` only — any already-signed-in
  session can call it, not just a browser that's had kiosk mode switched on.
  The server has no reliable way to tell "the shared shop computer" from
  "someone's laptop that's still logged in"; a client-side flag can't be
  trusted for that. So in practice any staff member could hit the API
  directly and switch into a *non-admin* coworker's identity from anywhere,
  same as this endpoint's front door. Admins are still protected by the PIN
  either way. Accepted for this build — an internal tool, low stakes, same
  posture as §2.9.
- The PIN has no attempt throttle, same reasoning as §2.9's login note: only
  10,000 combinations, but bcrypt-slow per guess and there's no exposed way
  to script rapid-fire attempts without also being an authenticated
  employee already. Revisit both together if that stops being true.

---

### 2.13 Dates need a real timezone, not the container's default

Building the rental calendar (fleet instruments going out/coming back,
`instrument_rentals`) surfaced a latent bug worth fixing everywhere at once
rather than just in the new feature:

- node-pg's default parser for a `DATE` column builds a JS `Date` at local
  midnight and JSON-serializes it through `.toISOString()` (a UTC
  conversion). A `DATE` has no time component to begin with, so that
  round-trip could silently shift `drop_off_date`, `due_date`, or a rental's
  `start_date`/`end_date` onto the wrong calendar day depending on the
  container's timezone. Fixed globally in `backend/src/db.js` — `DATE`
  columns now come back as the plain `'YYYY-MM-DD'` string Postgres sent,
  never through a `Date` object. Nothing in the frontend displayed those two
  ticket date fields yet, so this changes no visible behavior for tickets —
  it only matters going forward, and immediately for rentals.
- Neither the backend container nor the Postgres container has a timezone
  configured, so both default to UTC. "Today" for the shop is Chicago's
  today, not UTC's — they diverge for several hours every evening. Rather
  than set container-wide `TZ` (bigger blast radius, affects every
  timestamp display), the rental endpoints compute shop-local "today"
  explicitly: `(now() AT TIME ZONE 'America/Chicago')::date` in
  `routes/rentals.js` (`config.shopTimezone`, override with `SHOP_TZ`), and
  `Intl.DateTimeFormat(..., { timeZone: 'America/Chicago' })` on the
  frontend (`DashboardView.vue`, `RentalCalendarView.vue`). Any future
  "what day is it for the shop" logic should use the same pattern rather
  than `CURRENT_DATE` or `new Date()` directly.

---

### 2.14 Instrument-purchase receipts brought Resend forward from Phase 2

The "Add instrument purchase" flow (Inventory Restorations tab) needed a way
to actually email a seller their receipt, which meant standing up real
email sending earlier than planned:

- `backend/src/mailer.js` calls Resend's HTTP API directly (`fetch`, no SDK
  dependency added). `RESEND_API_KEY` / `RESEND_FROM_EMAIL` were already in
  `.env.example` as "Phase 2, unused" — they're read now. Leave them blank
  and the app still boots and the button still appears; clicking it just
  fails with a clear "email isn't configured yet" error instead of pretending
  to send. Every attempt — sent or failed — is logged to the existing
  `emails` table, so there's an audit trail either way.
- The receipt's branding is the shop logo (`assets/CEPCO-LOGO-FINAL.png`)
  sent as an inline CID attachment, not a linked image — most mail clients
  block remote images by default, so an inline attachment is the only way
  that logo reliably shows up. `backend/src/templates/purchaseReceipt.js` is
  where the HTML lives if the design ever needs to change.
- `instrument_purchases` is its own table (migration 005), not new columns
  on `instruments` or a reuse of `customers` for the seller — same reasoning
  as `instrument_rentals` in §2.13's neighbor entry: `customers` means
  "someone we service" and a fleet/inventory instrument is deliberately
  `customer_id = NULL` (001_init.sql), so folding sellers into that table
  would either break that convention or overload it with a second meaning.
- Creating the instrument + the `inventory_restoration` ticket + the
  purchase row all happen in one transaction (`routes/purchases.js`). That
  required pulling the ticket-insert logic in `routes/tickets.js` out into
  `resolveNewTicketFields`/`insertTicketRow` so it could run on purchases.js's
  own transaction client instead of duplicating (and risking drifting from)
  that logic. `POST /tickets` itself is unchanged — same validation, same
  response shape, just calling the extracted functions now.

### 2.15 Shopify order intake — webhook receiver, not a poller

An order placed in Shopify now becomes a ticket in MC2 automatically,
without anyone touching Shopify's admin:

- `backend/src/routes/shopifyWebhooks.js` is a webhook *receiver*
  (`orders/create`, `orders/cancelled`), not a polling job — Shopify pushes
  to us the moment an order is placed, which is both simpler and far lower
  latency than scanning the Orders API on a timer. It has no `requireAuth`;
  instead `backend/src/shopify.js#verifyWebhookHmac` checks the
  `X-Shopify-Hmac-Sha256` header against an HMAC-SHA256 of the *raw* request
  body using `SHOPIFY_WEBHOOK_SECRET`. That's why `index.js` now captures
  `req.rawBody` in the global `express.json({ verify })` call instead of
  parsing Shopify's route separately — Express's JSON parser normally
  discards the exact bytes, and a signature computed over the re-serialized
  body wouldn't reliably match Shopify's.
- Idempotency against webhook redelivery (Shopify retries on anything but a
  fast 200) is a unique partial index, `tickets_shopify_order_id_idx`
  (migration 006), not just an in-code check. The route does check-then-insert
  for the common case (skip the transaction entirely if a ticket already
  exists for that order id), but the index is what actually prevents a
  duplicate ticket if two deliveries race each other — the insert's `23505`
  is caught and treated as "already handled," not an error.
- New-ticket creation goes through the same `resolveNewTicketFields` /
  `insertTicketRow` pair introduced for inventory purchases (§2.14) — the
  webhook route doesn't call `POST /tickets` over HTTP, it calls those
  functions directly on its own transaction, same pattern as
  `routes/purchases.js`. `created_by` is `null` (no staff member created it).
- Two admin-editable settings drive where an order-ticket lands, both stored
  on existing rows so no new schema was needed: which category it's filed
  under is a `shop_config` row (`shopify_default_category`, alongside
  `labor_rate`) whose `meta.value` is a `ticket_category` key, editable from
  Settings -> Shop configuration; who it's assigned to is
  `meta.default_assignee_id` on that *category's own* settings row, editable
  from the "Default assignee" column on the Ticket categories table. That
  second one isn't Shopify-specific — `resolveNewTicketFields` reads it for
  every ticket creation path (manual, inventory purchase, Shopify order)
  whenever nobody named an assignee explicitly, so setting a shipping
  manager as Shipping's default assignee auto-assigns tickets from all three
  sources, not just orders. If the configured category is ever missing or
  retired, the route falls back to `orders_shipping` rather than failing the
  webhook.
- The customer on an order-ticket is matched by email against `customers`
  first, falling back to creating one with `source = 'shopify'` — the same
  `source` enum already used to distinguish direct/email/shopify customers,
  now actually populated by something.
- `orders/updated` is deliberately *not* wired to do anything yet, even
  though `registerShopifyWebhooks.js` subscribes to it (so re-registering
  later, once it is acted on, doesn't require touching Shopify's admin
  again). Syncing line-item/fulfillment changes back onto an in-progress
  ticket is a real design question (what happens if a tech already started
  the work?) that wasn't part of what was asked for — the route acknowledges
  the webhook with 200 and stops there.
- Registering the webhook subscriptions with Shopify is a separate one-off
  step from the receiver going live: `npm run shopify:register-webhooks`
  (`backend/src/scripts/registerShopifyWebhooks.js`) hits the Admin REST API
  with `SHOPIFY_ADMIN_API_TOKEN` and points the subscriptions at
  `${PUBLIC_BASE_URL}/api/shopify/webhooks`. It's safe to re-run — it skips
  any topic already registered to that exact address. `SHOPIFY_SHOP_DOMAIN`
  is a new env var (the receiving endpoint itself doesn't need it — only
  this registration script and any future outbound Admin API call do).

### 2.16 The login cookie needed SameSite=None for Shopify's iframe

Opening MC2 embedded inside Shopify admin (a link that loads it in an
iframe) 401'd on every request, including login itself. Cause: `cepco_token`
was `SameSite=Lax`, and browsers refuse to send (and, in Chrome's case,
refuse to even store) a Lax cookie in a third-party/cross-site iframe
context. That's a browser-level restriction, not a bug in our CORS config —
`cors({ origin: true, credentials: true })` was already correct and had
nothing to do with it.

- `backend/src/routes/auth.js` now sets the cookie through one
  `setAuthCookie()` helper shared by `/login` and `/switch` (kiosk identity
  switching), with `sameSite: 'none'` whenever `secure` is true (production).
  `SameSite=None` requires `Secure`, and Chrome rejects the cookie outright
  if that pairing isn't right — so local dev (plain HTTP) still gets `Lax`,
  which is all a same-origin dev server ever needed.
- This doesn't touch kiosk mode's behavior: `None` is strictly *more*
  permissive than `Lax` (send everywhere vs. send almost everywhere), so
  nothing that worked on the shop-floor kiosk browser stops working — the
  switch endpoint uses the exact same helper and cookie.
- What this does **not** fully solve: Safari's ITP, and Chrome's own
  ongoing move to block third-party cookies by default, can still refuse a
  `SameSite=None` cookie purely because it's a *third-party* cookie, no
  matter how it's attributed. `SameSite=None` fixes today's Chrome-default
  behavior; it isn't a permanent guarantee against browsers tightening
  further. The actually robust fix for a real embedded-in-Shopify surface is
  Shopify's own pattern — App Bridge session tokens sent as an
  `Authorization` header instead of a cookie — which is a real scope
  increase (new frontend auth wiring, a second verification path in the
  backend) and wasn't undertaken here since the ask was to stop the 401s,
  not to make MC2 a permanent embedded Shopify surface. If MC2 ever needs to
  live inside Shopify's admin as a first-class embedded app, revisit this.
- Recommended alongside this: don't actually embed MC2 in an iframe at all —
  point the Shopify-side link at MC2's URL opening in a new tab. That sidesteps
  third-party-cookie restrictions entirely (MC2 becomes a normal same-site
  page from the browser's perspective) and needs no code change, only how
  the link is configured on Shopify's side.

---

## 4. Suggested first moves after deploy

1. Set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, deploy, log in, change the
   password immediately (`POST /api/auth/change-password`).
2. Create the real staff accounts under Settings → Staff accounts.
3. Run the import: `docker compose exec backend node backend/src/scripts/importCsv.js`
   (add `--dry-run` first to see the report without writing).
4. Walk `/fleet` and fix any instrument families the classifier got wrong (§2.6).
5. Map the `shop_contact_raw` initials onto real employees (§2.5).
6. Get the GCS bucket up (§3) before the shop starts relying on photos.
