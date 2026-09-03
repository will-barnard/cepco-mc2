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

### 2.17 Job queues are now explicit and admin-reorderable

Before this, "queue order" was implicit: the ticket list sorted by priority
tier, then `updated_at DESC` as a tiebreaker — which meant touching a ticket
at all (a note, a field edit) bumped it back toward the top of its priority
band. That's not a queue anyone can deliberately manage, just a sort that
happens to look queue-like most of the time.

- Migration 007 adds two independent, persisted position columns on
  `tickets`: `category_queue_position` (this job's spot among other active
  jobs in the same category) and `tech_queue_position` (its spot among
  other active jobs assigned to the same tech). Two columns, not one,
  because they can legitimately disagree — an admin might want a job done
  first in a specific tech's day even though other jobs are technically
  "ahead" of it in that category shop-wide.
- Every ticket-creation path (manual, inventory purchase, Shopify order —
  all three already funnel through `insertTicketRow`, per §2.14/§2.15) drops
  a new ticket at the bottom of both queues it participates in: bottom of
  its category's queue always, and bottom of its assigned tech's queue too
  if it has one at creation (explicit `assigned_tech_id` or a category's
  default assignee). Changing a ticket's category or assignee later
  (`PATCH /tickets/:id`) moves it to the bottom of whichever queue it just
  joined, rather than keeping a position number that only meant something in
  the queue it left.
- `POST /tickets/:id/reorder-category` and `.../reorder-tech` (admin-only —
  junior/senior techs can see the order, only admins can change it) move a
  ticket by **swapping position values with whichever ticket is currently
  adjacent** in that queue, not by nudging the position by a fixed delta
  (contrast with Settings' `sort_order ± 15` — fine for a short admin list,
  not precise enough for a queue people reorder constantly). A swap is
  always exactly correct after one click no matter how uneven the gaps
  between positions have become.
- `GET /tickets` orders by `category_queue_position` when filtered to
  exactly one category, or `tech_queue_position` when filtered to exactly
  one tech (and neither, both at once has no single queue to show), falling
  back to the old priority/recency sort for a mixed/unfiltered browse. The
  Inventory Restorations page lost its client-side re-sort-by-`created_at`
  as a result — it's just `GET /tickets?category=inventory_restoration` now,
  same as any other single-category queue, with the same reorder arrows.
- Known gap: reordering always operates against the *full* queue, not just
  what's currently visible under other filters (search text, status,
  priority). If a filter is hiding a ticket's actual neighbor, "move down"
  still does the right thing server-side but won't visibly change the two
  rows on screen until the filter clears. Not solved here — flagged in case
  it's confusing in practice.

### 2.18 "Ship this instrument" completes a half-built feature

The ask was a button on a ticket that spins up a linked ticket to ship its
instrument. While building it, it turned out the data model this needs was
already there: `shipments` (method, contact info, international flag,
scheduled date, tracking number, a packing checklist) and a full
`routes/shipments.js` CRUD API, plus a seeded shipping-kind `qc_templates`
row to auto-fill the checklist — all backend-only, with no frontend ever
built to use it. PLAN §7 describes exactly this: "deeper packing jobs...
own ticket type, reuses the existing... Shipping Checklist pattern." So
this feature is really two things: the requested button, and finishing the
shipments UI that was apparently always the intended destination for it.

- Migration 008 adds `tickets.source_ticket_id` (self-referencing, `ON
  DELETE SET NULL`) — a generic "created from another ticket" provenance
  link, alongside the existing `shopify_order_id`/`legacy_ref` provenance
  columns. First (only, so far) use is this feature, but it's written
  generically in case something else wants to spin up a linked ticket later.
- `routes/shipments.js`'s checklist-seeding insert logic is now
  `createShipment(client, {...})`, exported off the router the same way
  `routes/tickets.js` exports `resolveNewTicketFields`/`insertTicketRow` —
  so `POST /tickets/:id/create-shipping-ticket` can create the new ticket
  and its shipment in one transaction (`insertTicketRow` then
  `createShipment` on the same client), rather than a second HTTP round
  trip that could succeed on the ticket and fail on the shipment.
- The button (`TicketDetailView.vue`) is disabled — actually replaced with a
  link to the existing one — once a shipping ticket already exists
  (`ticket.child_tickets.length`, from a new `source_ticket_id`-keyed query
  added to `GET /tickets/:id`), same guard pattern as "Create invoice
  record" hiding once `ticket.invoices.length`. Anyone signed in can click
  it, not just admins/seniors — same permission level as creating any other
  ticket.
- New `TicketShipment.vue` renders the shipment: method/contact/
  international/scheduled-date/tracking fields that PATCH individually on
  change (mirroring `TicketDetailView`'s own Details card — no buffered
  form, so there's nothing to go stale when `ticket` gets replaced wholesale
  after a reload), the packing checklist (same toggle pattern as
  `TicketQc.vue`'s round checklist, just without QC's sign-off step), and a
  "Mark shipped" button that locks the fields afterward.
- Priority defaults to `daily_todo`, same reasoning as the Shopify order
  intake and inventory-purchase defaults (§2.14/§2.15) — shipping jobs are
  usually quick; a deep-pack/international one can be re-triaged from the
  queue like anything else. Category is hardcoded to `shipping` — this
  button only ever means one thing.

### 2.19 Statuses are now category-aware, not just one shared list

Shipping tickets only need Not Started / In Progress / Done — Reservation,
QC, Invoice Sent, Invoice Paid, and On Hold don't mean anything on a job
that's just packing and sending an already-serviced instrument. Rather than
forking a second status enum for Shipping (which would mean a parallel set
of settings rows, and every piece of code that reads `ticket_status` having
to know which enum applies where), each `ticket_status` row's `meta` gets an
`applicable_categories` list:

- Empty or absent -> the status applies to every category. This is the
  default every pre-existing status keeps (Not Started, In Progress, Done
  included), so this is opt-in *restriction*, not opt-in availability —
  nothing that worked before this change stops working.
- Non-empty -> only the listed `ticket_category` keys. Migration 009
  backfills this onto the five statuses Shipping shouldn't offer, listing
  every *other* current category explicitly (rather than "all except
  shipping" as a special case anywhere) — so adding a sixth category later
  is a Settings edit, not a code change.
- `services/settings.js` adds `statusAppliesToCategory` (the plain
  predicate), `resolveStatusForCategory` (like `resolveActive` but also
  checks the category), and `defaultStatusForCategory` (first non-retired,
  applicable status by sort order — replaces the old category-blind "first
  non-retired status" query used when a new ticket doesn't specify one).
  `routes/tickets.js` uses these in both ticket creation and `PATCH
  /tickets/:id`.
- Changing a ticket's category can strand its current status (e.g. a
  Servicing ticket sitting at "QC" gets moved to Shipping, which doesn't
  have a QC status). `PATCH /tickets/:id` checks for this whenever category
  changes without an explicit new status, and re-homes it to the new
  category's default — logged to `status_change_log` with an explanatory
  note so it doesn't look like an unexplained status jump later.
- Settings UI: the Ticket statuses table gets an "Applies to" column — one
  checkbox per active ticket category. Unchecking one writes an explicit
  list; checking every box collapses back to an empty list rather than an
  explicit full one, so a category added later automatically inherits every
  status that was never deliberately restricted.
- The ticket detail page's status dropdown uses a new
  `settings.statusesForCategory(categoryKey)` store getter instead of
  `settings.active('ticket_status')`, filtering client-side against the
  already-loaded settings data — no new endpoint needed.

### 2.20 Shipping tickets drop the sections that don't apply to them

Beyond status, a Shipping ticket's page now shows only Details, the
Shipment card, Photos, and Status history — no Quality control, Estimate,
Hours logging, or Invoicing cards. Those are real work-tracking tools for
billable repair/restoration jobs; a shipping ticket is packing and sending
something that was (usually) already billed on its original ticket, so
showing an empty QC/estimate/invoice section on every one would just be
noise. Gated by a single `isShipping` computed (`ticket.category_key ===
'shipping'`) in `TicketDetailView.vue` — deliberately not a generalized
"which sections does this category show" settings mechanism, since this is
the one category that needs it and a real generalization would want to
know which *other* categories want which subset before it's worth building.

### 2.21 "Sort by status" rides the same sort_order as everything else

The Tickets page's new "Sort by" control adds a `status` option
(`?sort=status`) alongside the default priority/queue order. It orders by
`st.sort_order` — the ticket_status settings row's own position, i.e.
whatever order they're arranged in on Settings -> Ticket statuses (which is
already how the shop expresses "this comes before that" for every other
enum in the app) — not alphabetical, not by key. Reservation (10) before Not
Started (20) before In Progress (30) before QC (40)... is the out-of-the-box
progression; reordering statuses in Settings changes this sort too, same as
it already changes the status dropdown's option order.

An explicit `?sort=` always wins over the category/tech queue-order logic
from §2.17, even when a category or tech filter is also active — it's a
deliberate "show me this order" choice, not a fallback. The reorder ↑/↓
arrows hide themselves in this mode (`TicketsView.vue`'s `queueType`
returns null whenever `sort` is set): they act on `category_queue_position`/
`tech_queue_position`, and swapping those wouldn't visibly do anything to a
list that's actually sorted by status.

### 2.22 Sub-tickets — assigning a custom shop task to someone else

The ask: custom shop tasks (e.g. metal fabrication for a specific
instrument) need to be spun off as their own assignable, trackable ticket
without losing the connection to the job they came from. Rather than a new
parent/child concept, this reuses the `source_ticket_id` link migration 008
added for "Ship this instrument" (§2.18) — a sub-ticket *is* a normal
ticket row with `source_ticket_id` pointing at the one it came from, so
shipping tickets turn out to be one specific case of sub-tickets rather
than a separate mechanism sub-tickets now sit alongside.

Three product decisions, asked and answered up front rather than guessed:

- **No enforcement blocking the parent.** A shop lead can move the parent
  ticket to Done/Invoicing while a sub-ticket is still open — the child's
  status is visible on the parent (`TicketSubTickets.vue`'s list), not
  gated. Revisit only if it turns out people are shipping instruments with
  fabrication work still outstanding by mistake.
- **New sub-ticket defaults to its parent's category**, since the common
  case (a fabrication task off a Servicing job) is itself servicing-ish
  work — but the category select stays editable in the form, since that
  default is wrong often enough (a Shipping ticket spinning off a
  Servicing sub-ticket) to not hardcode.
- **Any ticket can spawn sub-tickets**, including sub-tickets themselves —
  no category allowlist. `TicketSubTickets.vue` is rendered unconditionally
  in `TicketDetailView.vue`, so nesting happens naturally rather than
  needing to be special-cased away later.

Implementation:

- `GET /tickets/:id`'s child-tickets query (previously scoped implicitly to
  shipping tickets by the fact that nothing else set `source_ticket_id`)
  now selects category/status/assignee for every child, ordered by
  creation — `routes/tickets.js`. No migration needed; the column and its
  index already existed.
- `resolveNewTicketFields` validates `source_ticket_id` up front (parent
  must exist) so a bad id fails as a 400 instead of surfacing the
  `tickets_source_ticket_id_fkey` constraint as a raw 500.
- New `TicketSubTickets.vue` replaces the old header-level "Ship this
  instrument" button/link in `TicketDetailView.vue`: it lists existing
  children (title, category, status, assignee), has a "+ Add sub-ticket"
  form (title/category/priority/assignee/notes, posting a normal `POST
  /tickets` with `source_ticket_id` set plus the parent's
  `instrument_id`/`customer_id` carried over), and folds "Ship this
  instrument" in as a quick-action button that pre-fills the same
  create-shipping-ticket call — it's just a sub-ticket creation shortcut,
  not a different feature. The button now hides based on whether a
  *shipping-category* child exists (`hasShippingChild`), not "any child
  exists" — the old guard would have hidden it forever after the first
  unrelated sub-ticket.
- No depth cap and no cycle check on `source_ticket_id` — a ticket could in
  principle chain sub-tickets arbitrarily deep. Not worth guarding against
  until someone actually does it; the UI only ever renders one level (a
  ticket's direct children), so a deep chain would just mean clicking
  through several tickets to see the whole thread, not a crash.

### 2.23 QC checklist templates finally have a screen

`qc_templates` (migration 001) already had everything this needed — `family`
(nullable — a specific instrument type, or NULL for "every type"), `kind`
(`qc`/`shipping`/`evaluation`), a `tier_key`, and the `items` JSONB array of
`{label, note}` rows that become a ticket's actual checklist — plus a full
admin CRUD API in `routes/qc.js`. None of it had a frontend. The only way to
add or change a checklist was editing `seed.js`'s `QC_TEMPLATES` array and
redeploying, which is what prompted this: a "different checklist per
instrument type" ask that the data model already supported end-to-end
(`TicketQc.vue`'s template dropdown already requests `?family=<the ticket's
instrument family>`, and the route already returns that family's templates
plus the family-NULL ones together) but that nobody could actually act on
without touching code.

- New `QcTemplatesView.vue` at `/settings/qc-templates`, linked from the top
  of `SettingsView.vue` (`meta: { admin: true }` on the route, same guard as
  `/settings` itself — it doesn't sit in the top nav, only reachable through
  Settings). Filter by instrument type and kind, inline-editable name/type/
  kind/tier per template (autosaves on change, same pattern as the rest of
  Settings), and an "Edit checklist" panel per template for the `items`
  array — add/remove/reorder rows, buffered locally until "Save checklist"
  rather than a PATCH per keystroke, since it's a whole array rewrite.
- `GET /qc/templates` gained `?include_inactive=true`, additive only — every
  existing caller (just `TicketQc.vue`'s round-start dropdown) keeps getting
  active-only results by omitting it. The admin screen always fetches with
  it set and filters "Show retired" client-side, so toggling it doesn't
  need a re-fetch.
- No hard delete — "Retire"/"Restore" toggles `qc_templates.active`, same
  as every other Settings table, and the same reasoning: `qc_checks` rows
  already snapshot the items they were started with (`results`, `template_id
  ON DELETE SET NULL`), so a retired or even hard-deleted template can't
  corrupt history either way, but retiring keeps the option to bring an old
  checklist back without retyping it.

### 2.24 Standard procedures + customer estimates — resolving §2.7

The ask: a price/hours catalog per instrument type ("standard procedures"),
an Estimates page for building a customer quote from it across one or more
instruments, emailing it with a confirm/decline link, and having a
confirmation create the ticket(s) if the shop hasn't already made them by
hand. This is PLAN §5 in full — and it's also, almost word for word, the
exact gap §2.7 flagged: "PLAN §5 says confirming an estimate should
auto-generate the associated ticket(s). §12 defines `estimates.ticket_id`
as required — an estimate belongs to a ticket. Both can't be true at once
... worth settling before [Phase 2's quote-email work] starts." This is
that settling.

**One table, two kinds of row, not two tables.** `estimates` already meant
something — a tech's post-intake hours/parts estimate, logged against a
ticket that already exists, feeding the actual-vs-estimate reporting in
`routes/estimates.js`'s `/reference`. That's real and stays exactly as it
was: `routes/estimates.js` is untouched, byte for byte. A customer quote is
a genuinely different shape (a customer, no ticket yet, a list of
instrument+procedure line items, an email/confirm lifecycle) but it's still
legitimately "an estimate" in the shop's own vocabulary, so migration 011
adds a `kind` column (`'ticket_estimate'` — the untouched default every
existing row keeps — or `'customer_quote'`) plus the columns the new kind
needs, rather than standing up a same-meaning `quotes` table next to it.
`ticket_id` becomes nullable: a `ticket_estimate` row always has one
(enforced in application code, same as most cross-field rules in this app,
not a DB constraint); a `customer_quote` row never does, even after
conversion — see below. `routes/quotes.js` is a new, separate route file
even though it shares the table: the two payload shapes have nothing in
common, so one file branching on `kind` everywhere would be worse than two
small files that each only ever touch their own kind.

**Why a quote can produce more than one ticket.** Confirming/converting a
multi-instrument quote makes one ticket per distinct instrument — not one
combined ticket — because that's what the existing ticket model actually
supports: `tickets.instrument_id` is singular, and `multi_instrument` is
just an acknowledgement flag on a single-instrument ticket, not a real list
(see §2.18's neighbor comment and TicketNewView.vue). Building real
multi-instrument tickets would be a bigger structural change than this ask
called for, and one ticket per instrument keeps every existing per-ticket
mechanism (status, assignee, QC, invoicing) working unmodified for
estimate-born tickets exactly as it does for any other. Consequence: a
single `estimates.ticket_id` column couldn't represent "the ticket(s) this
quote produced" even if it were being reused, so a `customer_quote` row
never populates its own `ticket_id` — the link runs the other way, via a
new `tickets.source_estimate_id` (same shape as `source_ticket_id`,
migration 008, §2.22's sub-tickets). `estimate_items.ticket_id` tracks
which specific ticket each line item ended up on (several items can share
one, when they're for the same instrument).

**Everything is snapshotted at add-time.** `estimate_items` copies the
procedure's name/pricing and the instrument's family/model onto the row
the moment it's added — same reasoning as `qc_checks` snapshotting
`qc_templates.items` (§2.23) and tickets snapshotting settings labels: a
later rename or re-price of a standard procedure, or a change to an
instrument's record, must never rewrite a quote that's already gone out to
a customer. The estimate itself freezes the shop's labor rate at creation
(`estimates.labor_rate`, the same column `routes/estimates.js` already used
for this exact purpose) so a rate change afterward doesn't restate a quote
either.

**One shared conversion path, called from three places.**
`routes/quotes.js` exports `createTicketsForEstimate()`; it's called by
staff clicking "Create ticket manually" on the estimate (`POST
/quotes/:id/create-tickets`), by the customer clicking confirm on the
public page (`POST /public/quotes/:token/confirm`), and by nothing else.
It runs under `SELECT ... FOR UPDATE`, so whichever of "staff converts it
first" and "customer confirms first" happens first wins outright — the
loser sees `status = 'ticket_created'` already set and returns the
tickets that exist instead of erroring or double-creating. This is what
lets the button and the email both say "this creates the ticket" without
either one needing to know whether the other already ran.

**The public link is a page, not an action.** The confirm/decline buttons
in `templates/quoteEmail.js`'s email both point at the same URL — a public,
token-looked-up frontend route (`/quote/:token`, `router.js`'s new
`alwaysPublic` flag so a signed-in employee previewing their own link
doesn't get bounced to the dashboard the way every other `meta.public`
route would). Confirming or declining only ever happens from a real button
click on that page (`POST /public/quotes/:token/confirm` or `.../decline`),
never from the page's own GET load — a GET link that changes state is
unsafe in email, since mail security scanners and some clients prefetch
every link in a message body, which would silently "confirm" or "decline"
an estimate nobody actually looked at. `backend/src/routes/publicQuotes.js`
has no `requireAuth` and looks estimates up only by the random
`confirm_token` (24 random bytes, migration 011), never by the numeric id,
so a link can't be guessed the way a sequential id could.

**Decline exists but does nothing beyond recording itself** (no
notification, no ticket-side effect) — that's deliberately as far as this
first version goes. A declined quote can still be confirmed later (the
public page offers "Actually, let's proceed" instead of the normal
confirm/decline pair) — confirm always wins over an earlier decline. The
one thing decline can't undo is a quote that's already `ticket_created`;
work has started by then.

**New settings screen, same shape as §2.23's.** `ProceduresView.vue`
(Settings -> Standard procedures) manages `standard_procedures` — name,
instrument type (nullable = "every type," same convention as
`qc_templates.family`), and pricing as either an hours range (billed at the
shop's labor rate) or a flat cost, never both (enforced by a DB CHECK,
migration 010, and by the form only ever showing the fields for whichever
type is selected). Same admin screen conventions as QC templates: inline
autosave, `include_inactive=true` for the admin view only, Retire/Restore
instead of delete.

**Not built, worth knowing:** no quote expiration; no line-item quantities
(each procedure is a flat one-off per instrument, matching what was asked
for); no notification back to staff when a customer confirms or declines
(the Estimates list is the way to notice — a future version could email
the shop, too); `APP_BASE_URL` must be set (`.env.example`) for "Email
estimate" to work at all — same "fails clearly instead of sending
something broken" posture as the missing-Resend-keys case it already had.

### 2.25 Queues are now status-first, and the category picker is narrowable

Every queue axis (§2.17's category/tech, §2.15's family) is now sorted by
status first and its own position column second — `GET /tickets` prefixes
`st.sort_order` onto all three `ORDER BY`s, so the shop's configured status
progression (Settings -> Ticket statuses, same `sort_order` §2.21 already
rides) is the primary grouping everywhere a queue is shown, not just an
explicit `?sort=status`. The dashboard's "Unassigned" list gets the same
treatment as a new case (`technician_id=unassigned` with no category/family
filter), tiebroken by priority since there's no position column for an
unassigned ticket to speak of.

`POST /tickets/reorder-queue` now requires `status_key` and scopes its
"what's currently in this queue" check to `(queue, status_key)` rather than
just `queue` — so it only ever renumbers positions within one status
section, and a stale/cross-status request fails the existing mismatch check
rather than silently reordering across a boundary. `QueueView.vue` matches
this on the client: tickets render as status sections (a header per
section, using the same status order the query returns), dragging is
blocked from crossing a section boundary (`onDragOver`'s guard), and
row numbering restarts per section since positions are now scoped that way.

Two more pieces landed alongside this:

- **Category-queue visibility.** `ticket_category.meta.hide_from_category_queue`
  (Settings -> Ticket categories' new "Queue picker" column,
  `stores.js`'s `categoriesForQueuePicker`) lets an admin drop a category out
  of the Queue page's "By category" picker — meant for categories that
  usually carry an instrument (Servicing, Inventory Restorations) and are
  better browsed "By instrument family" instead, leaving the picker to the
  catch-all categories that usually don't (Shipping, Daily To-Do's, Orders &
  Shipping). Absent/false meta means "shown," so nothing changed for any
  existing category until an admin opts one out.
- **Dashboard pagination.** "Assigned to me"/"Unassigned" used to hard-cap
  at 15/10 tickets with no way to see past that. `GET /tickets` now accepts
  `offset` and reports the *un*-limited match count via an `X-Total-Count`
  header rather than changing its response shape (still a plain array —
  every other caller is unaffected); `api.js` attaches that count as a
  non-enumerable `.totalCount` on the returned array, and `DashboardView.vue`
  uses it to drive independent Prev/Next paging per list, re-fetching a page
  at a time rather than holding the full list in memory.

`TicketTable.vue` picked up an opt-in `groupByStatus` prop (used by both
dashboard lists) that renders the same kind of status section headers —
`TicketsView.vue`'s plain flat table doesn't pass it, so that page is
unaffected.

### 2.26 Queue page drops the technician axis, dropdown becomes buttons

Follow-up to §2.25: the Queue page (`QueueView.vue`) no longer offers "By
technician" as a pickable queue — just "By instrument type" and "By
category," each its own row of buttons instead of one `<select>` with
optgroups, so the two axes read as visually distinct groups rather than
three flattened dropdown sections. Instrument type is listed first and
defaults to being pre-selected on load (falling back to the first pickable
category only if a shop somehow has no instrument families), matching
§2.25's framing that instrument type is the primary axis and category is
just the catch-all for tickets that don't have one.

This only removes the *picker* — `GET /tickets?technician_id=...` and
`ticket_technicians.queue_position` (migration 013) are untouched, since
the dashboard's "Assigned to me" list still orders by them (§2.25's
status-first change applies there too). The practical effect: a tech's
personal queue order is no longer directly draggable anywhere — a new
ticket still joins the back of the tech's queue the same as always
(§2.17), it just can't be manually reshuffled from this page anymore.
`POST /tickets/reorder-queue`'s `scope=tech` branch is also left in place
server-side (unused now, but harmless) rather than removed, in case that
capability is wanted back later.

### 2.27 Tickets and Queue merge into one page, defaulting to "All instruments"

The separate Tickets page (`TicketsView.vue`, filtering/searching) and Queue
page (`QueueView.vue`, drag-reorder) are now one page at `/queue` —
`TicketsView.vue` is gone, `/tickets` redirects to `/queue` (keeping its
query string, so e.g. DashboardView's status-count links still land on a
filtered list), and the topbar's separate "Tickets" link is gone too
(`App.vue`); "New ticket" moved into the merged page's header. `router.js`'s
`ticket-new`/`ticket`/quote/status-report routes are untouched.

The merged page defaults to "All instruments" (a new button, alongside the
existing instrument-type/category ones) rather than the first instrument
family the Queue page used to pre-select — same reasoning as always leading
with the primary axis (§2.26), just inverted now that browsing everything
is the more common first landing than any one queue.

The old Tickets page's entire filter bar (search, status, category,
priority, instrument, tech, sort, hide-statuses, archived, "Clear filters")
now lives below the instrument/category buttons, wired to the exact same
`filters.category`/`filters.instrument_family` the buttons set — picking
either one clears the other, so there's still only ever one queue picked at
a time. Filters stay mirrored into the URL, same as the old Tickets page.

Drag-to-reorder only ever worked against one *complete* queue — `POST
/tickets/reorder-queue` checks the dragged status section's full membership
against what the server has — so now that the filter bar can narrow a queue
down (or "All instruments" can remove the notion of a queue entirely),
`QueueView.vue`'s new `canReorder` gates dragging off whenever that
completeness isn't guaranteed: search text, a priority filter, or "Show
archived" can each hide a ticket that legitimately belongs in the section
being dragged, and picking both an instrument and a category (or an
explicit "Sort by" override) isn't a real single-axis queue to begin with.
The single-status filter and "Hide statuses" are fine, since both only ever
drop *whole* status sections rather than part of one. Whenever dragging is
off, the list falls back to `TicketTable.vue` (the old Tickets page's
table), status-grouped when the backend is still returning one queue's
order (`isQueueOrdered`) and flat otherwise — matching the old Tickets
page's plain view for the true "browse everything, unfiltered" case.

### 2.28 Tasks — per-tech work items underneath a ticket

The ask (from the shop, not an engineering-driven idea): each ticket should
break down into a handful of short-lived tasks assigned to individual
techs, ranked *above* tickets on a tech's dashboard, and only relevant once
a ticket is actually being worked. Scoped and built as migration 022 plus
`routes/tasks.js`, `TicketTasks.vue`, and a "My tasks" section on
`DashboardView.vue`.

**Not a sub-ticket, not a QC check — a new, deliberately lighter table.**
Sub-tickets (§2.22) were the closest existing "assign a piece of work to
someone" mechanism, but a sub-ticket is a full ticket: its own status
workflow, queue position, hours log, QC/invoicing exposure. Ten of those
per job would flood the Queue page (§2.27), ticket counts, and every report
that counts tickets. QC checks (§2.23) are reference-only and
reviewer-signed-off — the wrong shape for a plain per-tech to-do list.
`ticket_tasks` (migration 022) is its own table instead: a title, an
optional `technician_id` (independent of `ticket_technicians`, migration
013 — one ticket's ten tasks can be split across several people), a
`done`/`done_at`/`done_by` triple, and a back-of-the-line `position` (same
`MAX(...)+10` convention as `category_queue_position`/
`family_queue_position`). No status workflow, no queue-position conflicts
to reconcile, no hours logging of its own — hours stay exactly where they
already were (`hours_log`), and a task's only state is whether it's done.

**Sourced from Standard Procedures, or free-form.** A task can snapshot a
`standard_procedures` row (`standard_procedure_id` + a `title` copied from
its name at attach-time, same snapshot-don't-reference convention as
`estimate_items.procedure_name`) or be typed directly with no procedure
behind it, for work that isn't on the catalog (a callback, a one-off fix).
Both are the same table, same endpoints — `POST /tasks` just requires
either `standard_procedure_id` or a `title`.

**Quote-born tickets get their tasks automatically; everything else gets a
"+ Add procedure" panel.** Most tickets never go through a customer quote
(manual creation, Shopify orders, inventory purchases), so tasks can't
*only* come from quote conversion the way the ask first sounded — the
common case would end up with zero tasks. `routes/quotes.js`'s
`createTicketsForEstimate` now inserts one task per `estimate_item` right
after that item's ticket is created (`estimate_item_id` traces the
lineage), unassigned since a quote doesn't know who'll do the work.
`TicketTasks.vue` (rendered on every ticket, right after `TicketSubTickets`)
is the same mechanism for everything else: a family-filtered procedure
picker (same NULL-means-every-instrument-type filtering `EstimateNewView`
already uses) plus a free-form "add custom task" input, so a ticket that
never had a quote still ends up with a task list.

**"In progress" is a Settings flag, not a hardcoded status key.** Every
other status-driven behavior in this app (sort order, category
applicability, color) already goes through admin-editable `meta` rather
than a string comparison against a specific key — statuses themselves are
fully shop-configurable (§2.19), so hardcoding `status_key === 'in_progress'`
into task visibility would silently break the day someone renames,
reorders, or retires that status. Settings → Ticket statuses gets a new
"Unlocks tasks" checkbox (`meta.unlocks_tasks`, same on/off-flag pattern as
`hide_ship_button`/`show_status_notes`); migration 022 backfills it onto
the shop's actual "In Progress" row and `seed.js` matches for fresh
installs, but an admin can move it, add it to more than one status, or
turn it off entirely. `GET /tasks?unlocked_only=true` is the only thing
that checks the flag — a ticket's own detail page always shows its full
task list regardless of status, so staff can plan a job's tasks during
intake even before it's active. Nothing here blocks checking a task off
early, either; the flag only gates dashboard *visibility*.

**Dashboard ranking rides the existing priority tiers.** A tech's tasks can
come from several different tickets at once, so "My tasks" orders them by
each task's parent ticket's `priority_tier.sort_order` (the same Daily
To-Do → Custom Shop scale tickets already use), tiebroken by the task's own
position — reusing an existing concept rather than standing up a second,
cross-ticket drag-reorderable queue for tasks on top of everything Queue
already does (§2.17, §2.25–§2.27).

**Deliberately left out of this first version:** no hours logging per task
(finishing one doesn't touch `actual_hours` — that stays a ticket-level
concern); no pagination on "My tasks" (tasks are meant to be few and
short-lived at any given moment, unlike the ticket lists below it); no
reordering UI for tasks within a ticket beyond creation order; and no
automatic ticket-status effect when every task on a ticket is done (marking
tasks complete doesn't move the ticket itself — a shop lead still changes
status by hand). Any of these can follow if it turns out to matter in
practice.

### 2.29 N4a — sweeping the hardcoded category/priority keys before Settings can break them

The boss handed over a big list of changes (see the "MC2 Change Scope"
write-up). Two of its packets are foundational and block everything else:
this one, and §2.30 below. Both shipped together, ahead of any of the
category/priority reshuffle the rest of the list calls for.

**The problem:** `ticket_category` and `priority_tier` are admin-editable
(§8) and about to be edited heavily — the boss list retires `shipping`,
`servicing` and `inventory_restoration` as categories in favor of a merged
Repairs & Restoration plus new Housekeeping/SideQuests categories, and
replaces all five priority tiers with three new ones. But half a dozen code
paths assumed one of the old keys would always exist: `TicketNewView.vue`
and `EstimateNewView.vue` defaulted their forms to `'servicing'`/
`'standard_setup'`; `FleetView.vue` created restoration tickets as
`'inventory_restoration'`/`'standard_setup'`; `routes/tickets.js`'s
create-shipping-ticket spun off a `'shipping'` ticket at
`DEFAULT_SHIPPING_PRIORITY_KEY`; `routes/purchases.js` and
`routes/quotes.js` had their own equivalent constants. `settings.resolveActive()`
rejects a retired key outright, so the day an admin actually did the
reshuffle, every one of these would start throwing 400s on ticket creation
— not a hypothetical, since the reshuffle is packet N2b, a few chats away.

**The fix, `settings.defaultKeyPreferring(category, ...preferredKeys)`:**
tries each preferred key in order, returns the first that's still active,
and falls back to whatever sorts first in the category (`firstActive()`) if
none of them are. A hardcoded "usual" default becomes a *preference*
instead of an assumption. Every backend call site above now goes through
it for its fallback constant; a value the caller explicitly supplied (e.g.
`purchases.js`'s optional `b.priority_key`) still goes straight to
`resolveActive()` and fails loudly if it's actually invalid — only the
"nobody said, pick something sensible" path got more forgiving. The
frontend forms (`TicketNewView.vue`, `EstimateNewView.vue`, `FleetView.vue`)
follow the same idea client-side: they start with a blank `category_key`/
`priority_key` and fill in a real one on mount from `settings.active(...)`,
preferring the historical key if it's still there.

**`ticket_status.meta.applicable_categories` was backwards, so it became
`excluded_categories`.** Five statuses (Reservation, QC, Invoice Sent,
Invoice Paid, On Hold) carried an *allowlist* meaning "every category
except Shipping" — spelled out as the literal four other keys. That reads
exactly backwards once new categories exist: Housekeeping and SideQuests
would silently have been missing from all five statuses the moment N2b
created them, since they'd never appear in an allowlist written before they
existed. Flipped to a denylist (`excluded_categories: ['shipping']`) so a
category added later automatically keeps every status that hasn't
specifically excluded it. Migration 023 converts existing rows
data-drivenly (computing the actual complement rather than hardcoding
`'shipping'`, in case an admin had already customized one). Not in the
boss's list, but the same bug in spirit, and would have bitten on the same
timeline as everything else here.

`routes/purchases.js`, `routes/quotes.js`'s `createTicketsForEstimate` and
`routes/shopifyWebhooks.js`'s category resolution got the same treatment.
`importCsv.js` was deliberately left alone — it writes tickets with the
*historical* keys via a raw `INSERT`, which is correct even after those
keys are retired (retiring never touches existing rows, only blocks new
assignment), since the whole point of that script is reproducing the
sheets' own historical categorization.

### 2.30 N2a — the sub-category mechanism

Three separate asks on the boss list ("make Custom Shop a sub-category",
the SideQuests tree of Hunt/R&D/Outreach/Other, and the instrument model
tree) all needed some notion of a settings value having a parent, which the
flat `settings` table had no room for. Built once here rather than three
times.

**`settings.meta.parent_key`** — no schema change, `meta` is already JSONB
and this is the same per-row-flag mechanism as `hide_ship_button` or
`default_assignee_id`. A row names another row in the *same category* as
its parent. `services/settings.js`'s `validateParentKey()` enforces exactly
one level of nesting (a parent can't itself have a parent; a row with
children of its own can't become someone else's child) and that the named
parent actually exists — checked on both `create()` and `update()`.
`remove()` now also refuses to hard-delete a value that's still someone's
parent (`countChildren()`), the same "retire instead" rule `countUsage()`
already enforces for tickets.

**`tickets.subcategory_key` / `subcategory_label_snapshot`** (migration
024) follow the exact key-plus-snapshot convention every other
configurable field on a ticket already uses. `routes/tickets.js`'s new
`resolveSubcategory()` is called from both ticket creation and PATCH: it
requires the chosen subcategory's `meta.parent_key` to actually match the
ticket's own `category_key`, so a stale or mismatched pairing (a Custom
Shop child on a Housekeeping ticket) fails loudly at write time instead of
silently mislabeling the ticket. Changing a ticket's category clears its
subcategory automatically if the old one doesn't belong to the new
category — same "re-home or clear, don't leave stale" rule §2.19's status
handling already follows.

**The free-text "Other" leaf** (`tickets.subcategory_other_text`) mirrors
the Parts/Supplies "Other" vendor ask (`parts_orders.vendor_other`): a
sub-category row can be flagged `meta.allow_free_text`, and only then will
`resolveSubcategory()` accept accompanying typed text instead of rejecting
it.

**Settings screen:** `ticket_category` rows get a "Parent" column — a
picker offering every top-level (non-child, non-retired) category, or plain
text on a row that already has children of its own (nesting it further
isn't offered rather than offered-and-rejected). The "add new value" row
gets the same picker so a child can be created directly under a parent.

**Deliberately left out of this packet:** no UI in `TicketNewView.vue`
itself for actually picking a two-level category/sub-category (that's
N2c/N3's job — this just built the mechanism and the two new
`stores.js` getters, `topLevel()`/`childrenOf()`, for them to consume); no
attempt to reconcile this with N7's instrument model tree, which the boss
list's own framing lumped in with "things that need a parent" but whose
own packet describes a separate `instrument_models` table instead (ragged
4-level depth doesn't fit a flat parent/child pair) — left for N7 to settle
when it's picked up.

### 2.31 Wave 2 (boss-list scope) — Parts/Supplies, Queue sort, Ceppy categories

Five packets, two of which had an explicit "ask the boss" decision point in
the scope doc; both were put to the actual person running this project
before writing any code, and the answers below are recorded here so nobody
re-litigates them by reading old code and guessing.

**P1 — Parts renamed to "Parts / Supplies."** Purely cosmetic: the nav
label and page heading change, nothing about the data model or API. Kept
as its own item rather than folded silently into P2/P3 so it shows up in
this changelog as the deliberate, separate rename it is.

**P2 — "Received" renamed to "Delivered," and delivered orders archive.**
The boss-list flagged a decision: should "Ordered" and "Delivered" both be
able to show on one line item, or stay sequential (an order is Needed, or
Ordered, or Delivered — never two states at once)? **Answer: sequential** —
the existing `status` enum model stays exactly as it was, just with the
one value renamed (`received` → `delivered`, migration 026, plus the
`ordered_at`/`received_at` timestamp columns which keep their names since
renaming a column is a bigger footprint than renaming a status string for
no behavioral gain). The archiving half is new: marking an order delivered
now also sets `parts_orders.archived = TRUE` in the same PATCH, and the
default parts list filters `archived = FALSE` unless `?archived=true` is
passed — same "hidden by default, nothing thrown away, one query param to
see it" convention `tickets`'s own archived filter already uses. There's
no explicit "unarchive" affordance; if a delivered order's status is later
changed back, it stays archived until someone flips it manually via the
API — not worth a UI for a case the shop hasn't asked for.

**P3 — Parts orders can name a vendor that isn't in the vendor list.**
`parts_orders.vendor_other` (migration 025) is the free-text escape hatch,
mutually exclusive with `vendor_id` exactly the way `tickets.subcategory_
other_text` is mutually exclusive with a real subcategory (§2.30) —
enforced in both `POST /parts` and `PATCH /parts/:id`. The parts list's
`vendor_name` now reads `COALESCE(v.name, p.vendor_other)` so the UI never
has to know which case it's looking at.

**Q3 — Queue cards and "sort by" now have a date option.** Another
boss-list decision: which date should drive it — drop-off, due, or
created? **Answer: drop-off date** — when the instrument actually landed
in the shop, which is what a front-counter person glancing at the queue
actually wants ("what's been sitting here longest"), not `due_date` (a
promise date, not an arrival date) or `created_at` (when the ticket record
was typed in, which can lag the physical drop-off). `sort=date` orders by
`t.drop_off_date NULLS LAST, t.updated_at DESC`, and the drag-reorder queue
view disables manual drag-reordering under this sort the same way it
already does under `sort=status` — a computed sort order isn't something
you drag around.

**C1 — Ceppy nominations get an award category.** `ceppy_category` is a
new settings category (`Technical Ceppy`, `Primetime Ceppy` seeded, plus
the usual free-text "Other…" escape hatch on the nomination form —
`ceppy_nominations.category_key` / `category_label_snapshot` /
`category_other`, migration 027) rather than a hardcoded pair, because the
shop will invent a third award eventually and this way that's a Settings
edit, not an engineering ticket. `services/settings.js`'s old
`USAGE_COLUMN` (ticket-only) became `USAGE_SOURCE` — `{table, column,
noun}` per category — so delete-protection (`remove()`/`countUsage()`)
extends to a non-ticket table without special-casing `ceppy_category`
inline; the four existing ticket-backed categories behave identically to
before. The weekly digest email (`templates/ceppyDigest.js`) now groups
nominations under a heading per category — label snapshot, then the typed
"Other" text, then a `General` catch-all for any nomination that predates
this packet and is still unsent when it deploys — so the email reads like
an actual awards list instead of one flat pile, which was the doc's
explicit ask.

One factual correction to the scope doc itself, noted here so it isn't
rediscovered the hard way later: the doc claims the nominations table
"kept its original spelling through the Ceppie → Ceppy rename." It didn't —
migration 019 renamed the table to `ceppy_nominations`. Migration 027
targets the real, current name; see its own header comment.

### 2.32 Wave 3 (boss-list scope) — category reshuffle, priority tiers, sub-category buttons, SideQuests

N2b, N4b, N2c and N3, the second half of the promised category/priority
overhaul (N2a/N4a in §2.29/§2.30 were the foundations). Three separate
things came up mid-implementation that the scope doc either flagged as an
open decision or didn't anticipate at all — all three went back to the
actual person running this before any code changed, rather than guessed.

**Decision 1 — Custom Shop.** It existed only as a *priority* tier
(`priority_tier.custom_shop`) before this packet, which never made sense —
a job's type and its urgency are different axes, and that conflation is
exactly what N4b's tier cleanup (below) undoes elsewhere. **Answer:
retire the tier entirely** — Custom Shop is now purely a ticket
sub-category, a child of the new "Repairs & Restoration" (migration 029).

**Decision 2 — the ~118 tickets on Servicing/Inventory Restorations.**
**Answer: re-point them.** In practice this split into two different
outcomes once the third decision (below) came up: Servicing's tickets are
re-pointed onto the new `repairs_restoration` key (migration 029's
`UPDATE tickets ... WHERE category_key = 'servicing'`); Inventory
Restorations' tickets need no re-pointing at all, because that category's
own *key* never changes — see decision 3.

**Decision 3 — Inventory Restorations, found mid-build.** The doc's
target list says "retire Servicing and Inventory Restorations into the
merged one," as if they were symmetric. They aren't:
`frontend/src/views/InventoryRestorationsView.vue` is a dedicated page
that queues *only* instruments the shop bought to flip, filtered strictly
on `category_key = 'inventory_restoration'`. Flattening it into the merge
like Servicing would have made that page start showing every Repairs &
Restoration ticket, customer jobs included, with no way left to tell them
apart. **Answer: keep it as a sub-category** instead of retiring it —
`inventory_restoration` becomes a *child* of the new `repairs_restoration`
parent (`meta.parent_key`, same N2a mechanism as Custom Shop), keeping its
own key untouched. The page didn't need a single code change: its filter
already asks for exactly that key, which is still active, just nested now.

**Decision 4 — the "retire Shipping" landmine, also found mid-build.**
The doc lists "retire Shipping" as a plain settings-screen bullet, but the
standalone `shipping` ticket_category (distinct from "Orders & Shipping,"
which stays) is not a leftover duplicate — it's the specific category the
"Ship this instrument" button auto-assigns to spun-off pack-and-send
sub-tickets, and three places keyed real behavior directly off
`category_key === 'shipping'`: `TicketDetailView.vue` hid the
Estimate/Hours/QC/Invoicing cards on those tickets, `TicketSubTickets.vue`
used it to stop a second "Ship this instrument" sub-ticket being spun up,
and five ticket-status rows excluded it via `meta.excluded_categories` so
a shipping ticket couldn't be set to a status that assumes billable work.
Retiring the category as written would have silently broken all three.
**Answer: retire it, and build the replacement** — migration 028 adds
`tickets.is_shipping` (backfilled `TRUE` for every ticket already on the
old category), and every one of those three call sites now checks that
flag instead of the category. The status-exclusion mechanism grew a
parallel `meta.excluded_for_shipping` boolean alongside the existing
`meta.excluded_categories` array (`statusAppliesToCategory()` in
`services/settings.js` checks both), since a status's "not valid for a
shipping job" rule is now about the flag, not a category name. New
shipping sub-tickets land in "Orders & Shipping" going forward
(`PREFERRED_SHIPPING_CATEGORY_KEY`); their priority default moved from the
retired `daily_todo` tier to `low_priority`, its closest successor among
the three new ones. One more thing this uncovered: `POST /tickets` used to
hand the raw request body straight to `resolveNewTicketFields`/
`insertTicketRow`, which meant a client could set `is_shipping: true` on
an ordinary ticket directly — nothing else does this (every other caller
builds its own object rather than forwarding a request body), so that one
route now explicitly pins `is_shipping: false` regardless of what's in the
body, leaving `create-shipping-ticket` as the only path that can set it.

**N4b — the three new priority tiers.** Expedited / SOS, Standard
Priority, Low Priority replace all five of the old sheet-inherited ones
(`daily_todo`, `expedited`, `standard_setup`, `deep_dive`, plus
`custom_shop` retiring here from decision 1). Per the boss's call, they
carry no `min_hours`/`max_hours` metadata — those bands described job
*size*, and these tiers are about urgency, a different question entirely.
Expedited sorts first (`sort_order`), since that drives the dashboard's
task ranking. Every hardcoded `'standard_setup'`/`'daily_todo'`-as-priority
default across the app (`TicketNewView.vue`, `EstimateNewView.vue`,
`FleetView.vue`, `routes/purchases.js`, `routes/quotes.js`,
`routes/shopifyWebhooks.js`) was swept to point at the new equivalent —
same `defaultKeyPreferring()` resilience N4a built, just re-aimed.
Existing tickets keep their original (now-retired) priority key and label
snapshot; nothing re-points them; there's no single obvious new tier each
old one maps onto, unlike the category merge above.

**N2c — category buttons instead of a dropdown.** `TicketNewView.vue`'s
Category field is now a row of toggle buttons over
`settings.topLevel('ticket_category')`, matching the pattern
`QueueView.vue` already used for its instrument-type/category pickers. A
second, conditional row appears underneath once the chosen category
actually has children (`settings.childrenOf`) — Repairs & Restoration's
Custom Shop/Inventory Restorations, SideQuests' four. Sub-category is
optional (the parent is a perfectly good bucket on its own), and picking a
new top-level category clears any previously-chosen child, mirroring the
backend's own "re-home or clear" rule for an existing ticket's category
change (§2.30). A child flagged `meta.allow_free_text` (SideQuests'
"Other") swaps in a text input for `subcategory_other_text`. Losing the
native `<select required>` meant category and the free-text requirement
both needed an explicit check in `submit()` instead.

**N3 — SideQuests.** Four children seeded under a new top-level
`sidequests` category: Hunt, R&D, Outreach, and Other (`meta.
allow_free_text: true`, the same mechanism P3's vendor-other and N2b's
Custom Shop/Inventory-Restorations nesting all share). No ticket-creation
changes were needed beyond N2c's picker — the new-ticket form's
customer/instrument fields were already optional ("— none (internal /
fleet) —"), so a SideQuest ticket with neither works today. Worth flagging
forward, per the doc's own note: N1's title generator (not yet built) will
need testing against a ticket with no customer and no instrument once it
exists — out of scope here, just recorded so it isn't forgotten.
---

### 2.33 Wave 4 (boss-list scope) — auto-generated titles, tech level moves to tasks, QC "report an issue"

N1, N8 and Q5 from the boss list, plus N5 and N6 — both settled as
no-code-this-wave and documented here rather than silently dropped.

**N1 — ticket titles auto-generate when none is typed.** `POST /tickets`
used to flatly require a title; a walk-in ticket that already names a
customer and/or instrument doesn't need one typed by hand too. Format is
`[Client Name] ["Nickname"] [Instrument Model]` (`composeTicketTitle` in
`routes/tickets.js`), using whichever pieces are actually present — a new
`instruments.nickname` column (migration 030) supplies the middle one, set
today only via the New Ticket page's "Add a new instrument instead" form.
A title is still required when there's nothing to build one from (an
internal SideQuest ticket with no customer or instrument, say) — this is
deliberately scoped to just the one generic `POST /tickets` route:
`resolveNewTicketFields`/`insertTicketRow` themselves are untouched, so the
five other callers (fleet restorations, inventory purchases, Shopify
orders, `create-shipping-ticket`, quote conversion) keep supplying their
own explicit titles completely unaffected. `TicketNewView.vue` mirrors the
exact same rule client-side (`autoTitlePreview`) so its own Title field
only becomes required, and only shows the asterisk, once that preview
would actually be empty — and previews what it'll be titled otherwise,
so nobody's surprised by what shows up on the ticket.

**N8 — tech level moves from the ticket to the task.** A ticket's ~10
tasks are often a mix of skill levels (a bass reed swap and a full action
rebuild landing on the same Wurlitzer job) — one `tech_level_key` per
*ticket* could only ever describe one of them. Migration 031 adds
`tech_level_key`/`tech_level_label_snapshot` to `ticket_tasks` instead,
same key+snapshot convention as everywhere else; `routes/tasks.js`'s
POST/PATCH resolve and validate it (PATCH supports an explicit clear to
null, same idiom as `tickets.js`'s own settings-backed columns), and
`TicketTasks.vue` grew a per-task tech-level picker alongside the existing
technician-assignment select. `tickets.tech_level_key` itself is left
completely alone — column, index, `routes/tickets.js` logic, all
untouched, per the boss's own framing that "the column costs nothing" and
ripping it out would mean backfilling historical tickets' tech level onto
tasks that may not even exist for them. The two ticket-level pickers
(`TicketNewView.vue`, `TicketDetailView.vue`) are simply gone; new tickets
quietly stop populating a field nothing reads anymore.

Also built, as the packet's own suggested nice-to-have: `standard_procedures`
gained `default_tech_level_key`/`default_tech_level_label_snapshot`
(same migration), editable from the Standard Procedures admin screen. A
task created from a procedure that has one arrives pre-tagged with it —
still just a starting point, overridable per-task the same as every other
pre-fill in this app (`TicketNewView.vue`'s default-technicians-by-family,
for one) — while a task with no procedure behind it, or from a procedure
with no default set, starts at "any level" exactly as before.

**Q5 — QC rounds: "report an issue" replaces "fail this round."**
`qc_checks.passed = false` is still something the schema and
`POST /qc/checks/:id/sign-off` support — nothing stops a future caller from
using it — but there's no UI path to it from `TicketQc.vue` anymore. Per
the packet's own suggested cleanest approach, a round that turns up a
problem doesn't get stamped failed; it generates a task instead (a new
"Found something? Add it as a task" field, open to anyone working the
ticket, not gated to senior/admin the way sign-off is) and the round
itself is left exactly alone — still open, still unsigned, sitting there
until the work gets done and someone comes back and signs it off. "Sign
off as passed" is renamed "Approve for next round" per the doc's own
suggested naming; there is no longer a "sign off as failed" of any kind
from this screen.

One wrinkle this surfaced: `TicketTasks.vue` doesn't emit `changed` (its
own docstring explains why — tasks aren't part of `GET /tickets/:id`'s
payload for a parent reload to expose), so `TicketQc.vue` creating a task
directly had no way to make the Tasks panel show it without a manual page
reload. Rather than growing a wider cross-panel notification mechanism for
what's still just this one case, `TicketTasks.vue` now exposes its own
`load()` (`defineExpose`), and `TicketDetailView.vue` holds a template ref
to it and calls straight into it on `TicketQc`'s new `task-created` emit —
the one panel that actually needs to know refreshes, nothing else changes.

**N5 — no code this wave.** The packet framed this as either "typeahead
with create" on the customer field or Xero sync, and asked which one
actually matters. Answer: Xero sync is the real goal — a typeahead search
component is comparatively small standalone UI work, while Xero
integration is its own multi-step epic (OAuth, an accounting-side contact
model to reconcile against, sync direction and conflict handling) that
deserves its own dedicated pass rather than being shoehorned into this
wave alongside N1/N8/Q5. Recorded here so it isn't lost, not built.

**N6 — no code this wave, checkboxes stay as they are.** Originally
answered as "remove the customer checkbox only," but that answer was
explicitly conditioned on N5's typeahead shipping this same wave (so a
customer could always be found or created from one combined control).
Once N5 came back as "Xero sync, not typeahead, this wave" the two
answers contradicted each other — flagged back rather than silently
picking one, and the boss's call was to keep both of the New Ticket page's
inline "add instead" checkboxes (customer and instrument) exactly as they
are. Removing the customer one without the typeahead in place would have
broken walk-in customer creation outright.

### 2.34 Wave 5, A1/A2 — recurring-ticket engine + daily sweeps + weekly chore rotation

First two of Wave 5 (the doc's own "heavy ones" wave). Both share one
engine rather than two, since A2 explicitly "extends A1" and the two
differ only in whether a rotation applies.

**A1 — recurring-ticket engine.** Nothing generated tickets on a schedule
before this; the shape is copied straight from `services/ceppyScheduler.js`
(already in the codebase): a plain in-process `setInterval` (60s tick),
shop-local day-of-week/time computed via `EXTRACT(DOW FROM now() AT TIME
ZONE $1)`/`to_char(... , 'HH24:MI')` against `config.shopTimezone` (never
the container's own clock — see §2.13), a `last_generated_at` timestamp
compared by shop-local *date* rather than exact time so a missed tick
still recovers on the next check instead of silently skipping a day, and
"log the one bad row and move on to the rest" error handling so a retired
category key on one template can't take the whole process down. New
`recurring_ticket_templates` table (migration 032) holds the config —
title/category/priority/cadence/day-of-week/time/notes/active/sort_order —
seeded with the four daily tickets the packet named: AM/PM Inbox Clearing
and AM/PM Online Orders, all `low_priority`/`housekeeping` or
`orders_shipping`, firing at 08:30/16:00 shop-local. Each fire creates a
ticket the same way the Shopify order webhook does — `createdById: null`,
routed through the existing `resolveNewTicketFields`/`insertTicketRow`
pair from `routes/tickets.js` so it gets exactly the same validation and
defaulting as a human-created ticket, nothing bespoke.

**A2 — weekly chore rotation.** Extends A1 on the same table/engine:
`recurring_ticket_templates.rotate_among_active_techs` is the only thing
that differs about a chore template's firing. Migration 033 seeds the
four weekly chores (bathroom/floor/showroom/kitchen, Mon-Thu 08:00). Per
the boss's decision (flag on the staff record, not a hardcoded exclusion
list — the doc's own explicit warning was "don't hardcode 'minus Jakob'"),
a new `employees.excluded_from_chore_rotation` boolean (also migration
033) is checked with a "Skip chores" column on Settings → Staff accounts,
wired through the table's existing generic `updateEmployeeField` helper —
no new function needed. The rotation itself is deliberately *not* a
stored numeric index: `nextRotationEmployee` stores who went last
(`rotation_last_employee_id`) and walks the *current* eligible list
(active, not excluded) by id each time to find whoever's next, wrapping
around — a stored index would silently drift the moment someone's hired,
excluded, or deactivated, while this self-heals automatically, including
when last week's assignee is no longer eligible at all (falls through to
the first eligible person). If literally everyone's excluded or inactive,
the chore ticket still gets created, just unassigned — a visibly-unassigned
chore beats one that silently never appears.

Both live behind a new Settings → Recurring tickets admin screen
(`RecurringTicketsView.vue`, `routes/recurringTicketTemplates.js`) — same
"config in a table, not in code" shape as QC/Standard Procedures screens:
inline-editable rows that autosave, a "+ New template" form, Pause/Resume
rather than delete-by-default (though hard delete is also offered here,
since unlike QC templates these rows aren't referenced by any other
table — nothing keeps a firing history that would be lost).

### 2.35 Wave 5, A3 — fleet QC on a real per-instrument cycle

`instruments.fleet_last_qc` (the SHOWROOM QC sheet's "Last QC" column) is
shop shorthand free text — "Pre 2025", "Upcoming", "Never" — with no
computable date behind any of it, so nothing could ever be automated off
it. Migration 034 adds two real columns next to it rather than replacing
it: `last_qc_at` (date) and `qc_interval_months` (3/6/12, DB-checked).
`fleet_last_qc` itself is untouched — still shown exactly as before on
FleetView.vue — because backfilling ~70 existing fleet instruments with a
real cycle is explicitly a shop data-entry pass, not an engineering task;
there's no way to derive a date from "Pre 2025" or "Never" by script.
Until that pass sets both columns for a given instrument, it's simply
invisible to the automation below — same "no eligible row, nothing
happens" posture Wave 5's other schedulers take on an empty pool.

FleetView.vue gained an editable "QC cycle" column (a date input plus a
3/6/12/none select, both autosaving via a new `updateInstrument` PATCH)
sitting next to the old free-text column rather than replacing it, so the
backfill can happen instrument-by-instrument over time without disturbing
the shorthand still being read today. A "due <date>" pill previews the
next cycle date client-side; `routes/instruments.js`'s PATCH now accepts
and validates both fields (the same `qc_interval_months IN (3,6,12)`
check the DB itself enforces, surfaced as a clean 400 instead of a raw
constraint error).

The actual sweep is a new `fleetQcSweep()` in `services/recurringTickets.js`
— same file as A1/A2's engine, called once at the end of every 60s `tick()`
rather than as a second interval. It's gated to run once a day (07:00
shop-local, not admin-configurable — this is a background sweep, not
something the doc asked a settings screen for) via a `shop_config` /
`fleet_qc_sweep` row (migration 034) whose `meta.last_run_at` is compared
by shop-local *date*, the identical idiom `ceppyScheduler.js`'s
`ceppys_schedule` row already uses — a missed tick still recovers on the
next check instead of silently skipping a day. Each pass selects every
fleet instrument whose `last_qc_at + qc_interval_months` has passed,
skips any that already has an open ticket titled `Fleet QC — …` for that
instrument (the title prefix doubles as the "don't refire" marker, same
lightweight match-on-what's-visible approach `FleetView.vue`'s own
`qcPill()` already takes with `fleet_last_qc`), and creates one via the
same `resolveNewTicketFields`/`insertTicketRow` pair every other
automated ticket in this app goes through — `createdById: null`, category/
priority resolved through `settings.defaultKeyPreferring('inventory_
restoration'/'standard_priority')` (the same "prefer this key, fall back
if Settings ever retires it" helper `shopifyWebhooks.js`/`quotes.js`
already use, rather than a raw literal that would break silently the day
someone retires that key). Title pairs N1's nickname field with the
model/family for something a tech can actually read on the queue: `Fleet
QC — {nickname} {model}`.

One incidental fix while in `tick()`: a failure loading the recurring-
ticket templates used to `return` immediately, which — now that
`fleetQcSweep()` also lives at the end of the same function — would have
silently skipped the fleet sweep too on a transient templates-table
hiccup. Changed to fall through with an empty template list instead, so
the two sweeps are independent: one failing never blocks the other.

### 2.36 Wave 5, Q6 — per-round QC signoffs (Setup QC / Final Assembly QC)

Migration 021's round progression only ever let a round hold one
`reviewer_id`/`signed_off_at` — the ticket-wide "2 rounds, signed off by 2
different reviewers" rule (`REQUIRED_ROUNDS`/`REQUIRE_DISTINCT_REVIEWERS`
in `routes/qc.js`) was a workaround for that: it counted two different
signers *somewhere across the ticket's rounds*, which isn't what the boss
actually wants — two techs literally checking the same closing pass.
Migration 035 adds a real `qc_check_signoffs` table (one row per person
per round, unique on `(qc_check_id, reviewer_id)` so re-signing upserts
rather than piling up) and `qc_templates.required_signoffs` (default 1,
set to 2 for every existing round 2 — Setup QC stays a single reviewer,
Final Assembly QC needs two distinct techs). `qc_checks.reviewer_id`/
`passed`/`signed_off_at` are left in place rather than dropped; they now
mean "this round is fully closed, and by whom most recently" instead of
"the one person who reviewed it" — existing signed-off rounds were
backfilled into the new table as their round's sole recorded signoff, so
nothing already closed changes behavior.

`POST /qc/checks/:id/sign-off` (routes/qc.js) now upserts into
`qc_check_signoffs` instead of writing straight onto `qc_checks`, then
only closes the round (`passed`/`signed_off_at` on `qc_checks` itself)
once the round's distinct passing signoffs reach its template's
`required_signoffs` — a failing signoff still closes the round outright
regardless of that count, same "one 'no' is enough" behavior the old
model had (there's no UI path to a failing signoff since Q5 replaced it
with "add a task instead" — kept only for whatever might still post
`passed: false` directly). `REQUIRE_DISTINCT_REVIEWERS` is gone entirely:
the ticket-level rule is back down to "2 rounds each individually
passed," since each round's own `required_signoffs` is now what enforces
"signed off by enough different people," scoped to the round that
actually needs it rather than smeared across the whole ticket.

`GET /tickets/:id`'s QC query (routes/tickets.js) now also returns each
round's `required_signoffs` (from its template, defaulting to 1 for a
round with none) and a `signoffs` array — every person who's signed that
round so far, with name and pass/fail. `TicketQc.vue` uses both: an open
round with `required_signoffs > 1` shows "N of M signed" and a running
list of who's signed already; the sign-off button reads "Add my
signature" instead of "Approve for next round" once more than one is
needed, and hides for whoever's already signed (re-signing is harmless —
the backend upserts — just confusing to have the button still sitting
there). Settings → QC templates gained a "Signatures" field next to
Round, both on the create form and inline per template, so the boss can
set it per round themselves — including the eventual rename to "Setup
QC"/"Final Assembly QC" and the round-2 content rewrite, which stay a
shop/content job rather than something this migration does; the two
existing family-agnostic round-2 templates ("Wurlitzer — QC Final",
"General Final QC") keep their current names for now, just with
`required_signoffs = 2` already wired up underneath.

### 2.37 Wave 5, Q4 — QC checklist grouped by service category

Supersedes an earlier decision (§2.23/Q5): checklist items were made
deliberately reference-only — a client-only highlight that reset on
reload, with a free-text notes field standing in for whatever tracking
was needed. The boss's actual ask turned out to be the opposite: group
every round's checklist into four fixed buckets — Tuning, Action,
Electronics, Cosmetics (the coarser of two groupings offered, chosen over
per-family/per-task-type splits) — and make checking an item off
something that actually sticks, not just a highlight for the current
viewing session.

No new tables or columns: `qc_templates.items` and `qc_checks.results`
were already JSONB, so both simply grew two more keys per entry —
`category` (one of `routes/qc.js`'s new `QC_ITEM_CATEGORIES` constant, a
small fixed list rather than a Settings-editable category the way
`ticket_category` is — four buckets the boss picked once, not something
that needs admin CRUD) and `checked` (boolean, defaulting false when a
round starts). `POST /qc/checks` now snapshots both from the template
onto each result row; `PATCH /qc/checks/:id` needed no changes at all —
it already accepted a full replacement `results` array for the notes
field's sake, so a checked-item toggle is just another full-array PATCH
through the same endpoint. A new `GET /qc/item-categories` gives the
frontend the canonical list rather than hardcoding it in two places.

`TicketQc.vue`'s flat checklist is now rendered as one section per
category (fixed order: Tuning, Action, Electronics, Cosmetics, then a
trailing "General" for any item with no category assigned — every
pre-Q4 item, until someone tags it) — `groupedResults()` buckets a
round's `results` client-side for display without touching their storage
order. Each item button now toggles a persisted `checked` flag
(`toggleItem` PATCHes the whole array with just that one entry flipped)
instead of a local Set, and is disabled once its round is signed off —
matching the backend's own "can't edit a closed round" rule rather than
letting a click there silently fail. Toggling stays open to anyone
working the round, same as the notes field and Q5's "add a task" — it's
recording what was checked, not signing off on it.

Settings → QC templates' item editor gained a category dropdown per row
(fetched from `GET /qc/item-categories`, so this screen can't drift from
the backend's list), defaulting new items to "General." Assigning
categories to the ~40 existing checklist items across every seeded
template is content work for the shop to do at its own pace from that
screen — same "boss/content job, not this change's job" framing as Q6's
template renames; nothing here does it for them, and an unassigned item
degrades gracefully into "General" rather than disappearing.

### 2.38 Wave 5, N9 — multi-instrument jobs as sibling tickets

`tickets.multi_instrument` (already in the schema) did nothing until now
— nothing ever set it besides a checkbox with no consequence. Boss's call:
one full ticket per instrument, linked as a family, over a join-table
design. No new schema at all — this reuses `source_ticket_id` (migration
008's generic "created from another ticket" provenance link), the exact
mechanism `TicketSubTickets.vue`'s sub-tickets already run on, rather than
inventing a second way to say "these tickets belong together."

`TicketNewView.vue` gained an "Additional instruments" section, shown
once "Multi-instrument job" is checked — one row per extra instrument,
each either picked from the customer's existing instruments or added
inline (a trimmed version of the primary instrument's own add-new form:
family/model/nickname, skipping year/serial as unnecessary for a quick
add). On submit, the primary ticket is created first as always; then one
sibling `POST /tickets` per non-blank row, each with `source_ticket_id`
set to the primary's id and the same category/subcategory/priority/
status/customer/technicians/notes/dates/`qc_required` as the primary —
title is left blank on every sibling so N1's `composeTicketTitle`
generates a per-instrument one instead of every sibling sharing the
primary's title. There's no server-side transaction spanning the whole
batch (each instrument/ticket is its own independent request, same as
`TicketSubTickets.vue`'s one-at-a-time creation) — a failure partway
through a multi-sibling submit leaves the primary and whatever siblings
already succeeded as real tickets rather than rolling anything back;
`submit()` surfaces exactly which ones failed and links straight to the
primary (`createdTicketId`) instead of either silently losing track of a
partial failure or stranding the user on a form that looks like nothing
happened.

`GET /tickets/:id` gained a `sibling_tickets` query: when a ticket has its
own `source_ticket_id` set, it also fetches every other ticket sharing
that same `source_ticket_id` — the rest of the family, from any one
sibling's own detail page, not just the single backlink up to the primary
that `source_ticket_id`/`source_ticket_title` already gave every child.
`TicketDetailView.vue` surfaces this as a one-line "part of a
multi-instrument job with #12, #13" next to the existing "created from
#X" line. `child_tickets` (the primary's own downward view, already
powering `TicketSubTickets.vue`) is untouched — a sibling's siblings query
and the primary's children query are two different directions through the
same `source_ticket_id` column, not two representations of the same data.

### 2.39 Wave 5, N7 — instrument model tree (scaffold)

Explicit scope for this one: build the structure now, the boss's real model
list arrives later as a CSV. Everything here is placeholder except the
plumbing.

The 7 existing `instruments.family` keys (rhodes/wurlitzer/hohner/strings/
organ/amp/rarity) are completely untouched — they're a join key in five
places (instruments, qc_templates, standard_procedures,
instrument_default_technicians, Queue's per-family ordering) that nothing
here needed to touch. Migration 036 adds `instrument_models`, a ragged
self-referencing tree (`parent_id`, no fixed depth column) that sits
*beneath* a family key rather than replacing it — `instruments.model` stays
a plain TEXT column, never a foreign key, so the tree is purely a UX aid
for filling that field. The migration seeds two families (Rhodes,
Wurlitzer) with obviously-fake placeholder data on purpose, deliberately
mixing depths (a leaf sitting right at the family root next to a deeper
era → series → model chain) to prove the ragged shape works before real
data arrives. `backend/src/routes/instrumentModels.js` is straightforward
admin CRUD (GET open to any authenticated user — it's read live while
someone's filling out a form — POST/PATCH/DELETE admin-only), with the one
integrity rule that actually matters for a tree: a node's parent must be
in the same family. Deleting a branch node cascades to everything under
it — a branch with children is "a whole model line," not a row to keep as
an orphan.

`InstrumentModelPicker.vue` is the piece every form actually touches. It's
a v-model over a plain string, so it drops into any existing
`<input v-model="instrument.model">` without changing what gets submitted
or how the backend validates it. Ragged depth is a first-class UX choice,
not just a schema one: every level change emits the joined ancestor path,
not just a true leaf, so stopping at "1970s" (no series chosen yet) is
already a valid, saved value — nobody's blocked from finishing a form
because this family's tree happens to be deeper or shallower than another
one's. A manual free-text fallback is always available, not just where a
node's `allow_manual` flag is set, since the tree is placeholder-only
right now and forcing a pick from fake data would actively get in the
way; the flag stays meaningful once real content lands (a family like
rarity that's inherently open-ended will want it permanently). Wired into
the three forms that had a bare model `<input>`: `TicketNewView.vue` (both
the primary "add a new instrument" block and N9's sibling-instrument rows),
`InventoryPurchaseNewView.vue`, and `EstimateNewView.vue`.

Family display labels are additive, not a replacement. `GET
/instruments/families` keeps its plain-string-array shape — with ~11
frontend files already doing `v-for="f in refData.families"` /
`:value="f"`, changing that shape would've meant touching every one of
them for no reason. Instead `routes/instruments.js` gained a sibling
`FAMILY_LABELS` map and `GET /instruments/family-labels`, and
`useRefData` gained a `familyLabel(key)` getter (falls back to the raw key
if the map hasn't loaded yet) that fetches it alongside the existing
`families` call in `load()`. Applied to the highest-visibility spots —
FleetView's family filter and table column, QcTemplatesView's family
filter buttons, TicketNewView's two family selects — but deliberately
**not** an exhaustive sweep of all ~11 files that reference `.family` or
`refData.families` (CustomersView, HoursView, InstrumentDefaultsView,
ProceduresView, QueueView, RentalCalendarView still show raw keys). That's
scope creep for a change explicitly called a scaffold; flagging it here
as a known, intentional gap rather than leaving it silently inconsistent.

New admin screen: `InstrumentModelsView.vue` (Settings → Instrument
models), one family tab at a time, same "inline rows, autosave on change"
shape as RecurringTicketsView.vue/ProceduresView.vue — add a node (with a
parent picker rendered from the same flattened, depth-indented list the
picker's own dropdown logic produces), rename inline, toggle
`allow_manual`/active, delete (with the cascade warning up front in the
page's own description rather than a confirm dialog). No bulk import
yet — that's the CSV step, deferred along with the real data.

### 2.40 Consolidate the amp/rarity families into "other"

Boss's call, after Wave 5 shipped: the `amp` and `rarity` instrument
families weren't pulling their weight as separate buckets, so they're now
one `other` family. `routes/instruments.js`'s `FAMILIES` drops from 7 keys
to 6 (`rhodes, wurlitzer, hohner, strings, organ, other`), and
`FAMILY_LABELS` follows suit — no more separate "Amplifier"/"Other"
labels, just one `other: 'Other'`.

Migration 037 reassigns every existing `family = 'amp'` or `'rarity'` row
to `'other'`, across every table that stores this key: `instruments`,
`qc_templates`, `standard_procedures`, `instrument_default_technicians`,
and N7's new `instrument_models` (no seed rows there yet for either
family, but future-proofed anyway). `instrument_default_technicians` has
a real `(family, employee_id)` PRIMARY KEY (migration 014), so the
migration deletes the redundant side first if the same employee was
already a default tech for both families — otherwise the merge would hit
a PK violation. `qc_templates` and `standard_procedures` have no such
constraint, so if the shop had ever set up its own custom template or
procedure specifically for `amp` and a different one for `rarity`, both
now sit side by side under `other` rather than being silently merged or
one being deleted — this migration can't guess which one's content should
win, and `qc.js`'s "resolve this round's template" query just takes
whichever sorts first, so the other becomes an invisible duplicate.
Flagging this in "Suggested first moves after deploy" below: worth a scan
of Settings → QC templates and Settings → Standard procedures for any
leftover pair that needs reconciling.

`importCsv.js` (the one-time Google Sheets importer, still runnable with
`--reset`) had its `classifyFamily()` amp-vs-rarity regex split removed —
both branches just return `'other'` now, since the distinction no longer
maps to anything. Nothing in the frontend hardcoded `'amp'`/`'rarity'`
anywhere — every family dropdown/filter across the app (Fleet, QC
templates, Queue, Ticket forms, Estimate/Purchase forms, the N7 model
picker) already reads its list from `refData.families` /
`FAMILIES.includes(...)`, so removing two keys from that one array is
everywhere it needed to be removed. Also applied N7's `familyLabel()`
helper to QueueView's two family filters (buttons and the mobile
`<select>`) while in this code — those were still showing raw family
keys and hadn't made the "highest-visibility spots" cut in §2.39, but
Queue is arguably the single most-used family filter in the app.

### 2.41 Fix: new tickets were defaulting to "Done"

Settings → Ticket statuses and `defaultStatusForCategory` (the function
`routes/tickets.js` calls to pick a new ticket's starting status) both
walk `ticket_status` rows in the same order — lowest `sort_order` first —
so the row sitting at the top of that Settings list *is* what every new
ticket starts on, by construction, not two things that can drift apart.
Somewhere along the way `done` picked up a lower `sort_order` than the
in-progress statuses that should precede it, so both symptoms (Done
showing first in Settings, new tickets landing on Done) were the same
underlying data issue.

Migration 038 re-pins all 8 seeded `ticket_status` rows to seed.js's
canonical order (`reservation, not_started, in_progress, qc,
invoice_sent, invoice_paid, done, on_hold` — 10 through 80) by key, rather
than nudging today's values relatively, so it corrects things regardless
of how they drifted and is a no-op if a given key was already right. Any
extra ticket_status an admin has since added is left untouched.

### 2.42 Standalone shipping tickets, direct from New Ticket

Three related complaints, one underlying gap: the only way to get a
ticket onto the simplified, non-billable `is_shipping` track (migration
028 — hides Estimate/Hours/QC/Invoicing, narrows the status list to Not
Started/In Progress/Done) was `POST /tickets/:id/create-shipping-ticket`,
which requires an existing ticket with a known instrument to spin off
from. That has no answer for an *inbound* shipment — an instrument being
shipped *to* the shop, with no prior ticket, sometimes not even fully on
file yet — so anyone in that situation had to create a plain ticket
instead, and a plain ticket defaults to a full-service billable job:
`is_shipping` was previously always forced `false` on `POST /tickets`,
and the New Ticket form's status dropdown was rendering the entire
`ticket_status` list unfiltered rather than `statusesForCategory()` (the
helper `TicketDetailView.vue`'s own edit dropdown already used), so QC
and every other non-shipping status were pickable there too — and would
have 400'd at submit if actually chosen, since `resolveStatusForCategory`
does enforce the real rule.

`POST /tickets` now accepts `is_shipping: true` from the client, but only
honors it when the ticket's resolved category is `orders_shipping` — the
same category real "Ship this instrument" tickets already land in
(`PREFERRED_SHIPPING_CATEGORY_KEY`). Every other category still gets a
hard `false` regardless of what's in the request body, preserving the
original point of locking this down (a client can't silently get QC/
Invoicing waived on an ordinary repair ticket) while finally giving
Orders & Shipping — which also carries real billable Shopify orders, so
this had to stay opt-in, not automatic — a way to make a ticket that's
*genuinely* just packing/logistics from scratch. `TicketNewView.vue`
shows a "This is a shipping/logistics ticket" checkbox once that category
is picked; checking it hides the QC-required checkbox (forced `false`,
since the whole QC story is inert once `is_shipping` hides those cards
anyway) and reveals a "Shipping to / contact info" field.

When `is_shipping` is set this way, `POST /tickets` also creates the
ticket's `shipments` row in the same transaction — mirroring
`create-shipping-ticket` exactly (checklist auto-seeded from a
shipping-kind QC template for the instrument's family) — so
`TicketShipment.vue`'s card actually has something to render instead of
a ticket stuck in the simplified UI with nowhere to record a destination
or tracking number. The contact-info field's value is what seeds that
row's `contact_info`.

That contact-info field doubles as the answer to "multiple instruments
going to the same place": N9's existing multi-instrument sibling-tickets
mechanism (checkbox + "Additional instruments" rows) was already
category-agnostic, so it works here without changes — what was missing
was `is_shipping`/`shipping_contact_info` in the sibling `POST /tickets`
payload the primary ticket's `submit()` sends per instrument. Both are
now copied onto every sibling exactly like `qc_required`/`notes` already
were, so checking "shipping ticket," filling in one destination, and
adding three more instruments produces four linked tickets (one per
instrument, `source_ticket_id` back to the primary, same as any other
multi-instrument job) each with its own shipment record pre-filled with
the same destination — editable independently after that, since tracking
numbers and ship dates will differ per package even when the address
doesn't.

The New Ticket form's status `<select>` now uses `statusesForCategory()`
generally (not just for the new shipping checkbox), with a watcher that
re-homes an already-picked status to that combination's default if
switching category (or toggling the shipping checkbox) makes the current
pick invalid — the same "don't leave a stale, now-invalid choice sitting
in the form" pattern N2c's category buttons already apply to
sub-category. This was a real, independent bug beyond the shipping
scenario: any category could previously show QC/Invoice Sent/Invoice
Paid/On Hold as pickable status options regardless of whether they
actually applied.

Not touched: `TicketSubTickets.vue`'s "Ship this instrument" button still
only ships a single already-known instrument off a single existing
ticket — bundling several *existing* tickets' instruments into one
outbound shipment together is a different, bigger feature nobody's asked
for yet, separate from today's inbound-shipment gap this closes.

### 2.43 Queue pages read status order high-to-low, not low-to-high

Fallout from migration 038 (§2.41): fixing `ticket_status.sort_order` so
Settings and new-ticket defaulting walk it lowest-first (Reservation ...
Done, On Hold last) also flipped the Queue page, because `GET /tickets`
was already using that same column as every queue's primary grouping —
`st.sort_order NULLS LAST`, ascending, same direction as Settings. Before
038, `done`'s too-low `sort_order` incidentally put Done-status sections
near the top of the Queue; correcting the data made the Queue render in
true low-to-high workflow order instead, which is what the ascending query
was always going to do once the numbers were right — just not the order
the shop actually wants to see there.

The two screens want opposite walks of the same column: Settings / the
new-ticket default should stay lowest-first (that's the fix from §2.41,
untouched here — `services/settings.js`'s `listAll`/`listCategory`/
`defaultStatusForCategory` are unchanged), but the Queue page's status
sections — and the dashboard's "Unassigned" list, and the "Sort by ->
Status progression" option, all of which share the one `st.sort_order`
grouping per the comment above `orderBy` in `routes/tickets.js` — should
read highest-first instead. Changed all five `orderBy` branches that
reference `st.sort_order` (category queue, tech queue, family queue,
`sort=status`, and the unassigned-dashboard branch) from
`st.sort_order NULLS LAST` to `st.sort_order DESC NULLS LAST`. `NULLS
LAST` stays on both ends of the flip — a ticket whose status doesn't
carry a sort_order still sorts to the very end, not the top, regardless
of direction.

Nothing else needed touching: `TicketTable.vue`'s status-section grouping
(§2.27) just breaks on consecutive `status_key` runs in whatever order the
server returns rows, so reversing the SQL directly reverses what's
rendered, section for section. `POST /reorder-queue` renumbers positions
*within* one status's section only, never across statuses, so it's
unaffected by which end of `sort_order` the section itself sorts from.

### 2.44 Pin a recurring ticket to one specific person

Extends A1/A2's recurring-ticket engine (§2.40's neighbors, migrations
032/033) with a per-template override: any recurring ticket — daily or
weekly, rotating or not — can now be pinned to one specific employee from
Settings → Recurring tickets, instead of either rotating or falling back to
the category's default assignee.

Migration 039 adds `recurring_ticket_templates.fixed_assignee_employee_id`
(nullable, `ON DELETE SET NULL` so retiring a staff account doesn't block
on a stale pin — it just silently falls back, same posture
`nextRotationEmployee()` already takes when nobody's left in the rotation
pool). `services/recurringTickets.js`'s `fireTemplate()` checks it first,
ahead of `rotate_among_active_techs`: a pin always wins when both are set.
Deliberately, setting a pin does *not* touch `rotation_last_employee_id` —
clearing the pin later resumes a weekly rotation exactly where it left
off rather than restarting from the first eligible employee.

`routes/recurringTicketTemplates.js` validates the id against a live
employee lookup (`resolveFixedAssignee()`) rather than letting a bad id
surface as a raw FK-violation 500, and `GET /` now also joins in
`fixed_assignee_name` alongside the existing `rotation_last_employee_name`
so the frontend never has to cross-reference the employee list itself.
PATCH treats "field not sent" (leave alone) and "field sent as null/''"
(explicitly clear the pin) as different things, same touched-flag pattern
`notes` already used on this endpoint.

`RecurringTicketsView.vue` gets a "Fixed assignee" dropdown on the create
form and inline on every daily and weekly row (active employees only,
same filter every other assignee picker in the app uses), autosaving on
change like every other field on this screen. A weekly row's "next up: …"
label now shows "fixed: …" instead whenever a pin is set, since the
rotation name would otherwise be misleading (it's not who's actually
getting the next ticket while a pin is active).

### 2.45 Group an already-existing ticket's instrument onto a shipment

The gap §2.42 flagged and left alone — "bundling several *existing*
tickets' instruments into one outbound shipment together" — turned out to
be exactly what was needed next: someone had already clicked "Ship this
instrument" on one ticket and wanted to add a second, already-existing
ticket's instrument to that same shipment, not spin up a second
disconnected shipping ticket for it (which is all "Ship this instrument"
has ever been able to do — one instrument, one new ticket, one new
shipment, every time).

Migration 040 adds `shipment_items`: `shipment_id`, `instrument_id`,
`source_ticket_id` (the repair ticket the instrument came from), and
`own_tracking_number`. The shipping ticket's own instrument
(`tickets.instrument_id` via `shipments.ticket_id`) stays the "primary"
one and is never duplicated into this table — `shipment_items` is only
the *additional* instruments pulled in from other tickets.

`own_tracking_number`'s NULL-ness (not truthiness) is the whole "one box
or separate boxes" answer: NULL means this instrument rides in the
shipment's own box, sharing its `tracking_number` and packing checklist;
a non-NULL value (including `''`, deliberately distinct from NULL so "own
box, tracking not filled in yet" doesn't collapse back into "shares the
box") means it's packed separately with its own tracking number. No
second shipment row, no second ticket status to track — it's all still
the one shipping ticket.

`routes/shipments.js` gains three endpoints: `GET /:id/candidate-tickets`
(open, non-archived tickets with an instrument, excluding this shipment's
own ticket and anything already claimed by another shipment — as either a
shipment's own ticket or someone else's item — with an optional `q`
against title/customer/instrument, same ILIKE shape `GET /tickets`
already uses), `POST /:id/items` (re-checks that same not-already-claimed
condition server-side, since the candidate list can go stale between load
and click), and `PATCH` / `DELETE /:id/items/:itemId` for the box toggle
and removing an instrument from the shipment (never touches the source
ticket itself — it just stops being part of this shipment). Adding new
items is blocked once `shipments.shipped_at` is set, same as everywhere
else a shipment is "locked" — but the box toggle and tracking-number edits
on existing items stay open after shipping, matching `tracking_number`'s
own always-editable behavior on the shipment itself.

`routes/tickets.js`'s single-ticket `GET` now joins each shipment's items
(instrument label, source ticket id/title, own tracking number) into the
`shipments` array it already returns, so `TicketShipment.vue` doesn't need
a second round-trip.

`TicketShipment.vue` gets a new "Instruments in this shipment" list: the
ticket's own instrument (non-removable, labeled "this ticket"), then each
`shipment_items` row with a link back to its source ticket, a "Separate
box" checkbox (the `own_tracking_number` toggle), a tracking-number input
that only appears once that's checked, and a remove button. "+ Add
instrument from another ticket" opens a small search box hitting the new
candidate-tickets endpoint and adds whichever result gets clicked.

Not touched: `TicketSubTickets.vue`'s "Ship this instrument" button still
only ever creates a brand-new shipping ticket for a single instrument —
this is the *other* path, for when a shipping ticket already exists and
needs to absorb one more instrument rather than being the thing that
creates it. The two are complementary, not a replacement of each other.

### 2.46 Ticket detail page cleanup: technicians widget, status report gating, shipping column order

Three small UI requests against `TicketDetailView.vue`, grouped together
since they all came in as one pass.

**Assigned technicians collapses once populated.** It used to always
render `TechnicianPicker` inline — a lot of vertical space on a ticket
that already has people on it. Now it starts expanded only when nobody's
assigned yet (nothing to collapse, and it's the field you'd want to fill
in first); once someone is, it collapses behind a one-line summary (names,
comma-separated) and a "Show"/"Hide" toggle. The expand/collapse state is
only (re-)initialized once per ticket — `lastInitializedTicketId` in
`load()` — rather than on every reload, specifically so that assigning
the *first* technician doesn't yank the picker away mid-edit the moment
`patch()`'s own `load()` call re-fetches the ticket: the id hasn't
changed, so the guard leaves `showTechnicians` alone and the picker stays
open for adding more people. Revisiting the ticket later re-evaluates from
scratch, same as a fresh page load.

**Customer status report hidden for non-repair categories.** Added
`hide_status_report` to the same per-category `meta` mechanism as
`hide_ship_button`/`show_status_notes` (`stores.js`'s new
`statusReportAllowed` getter, default-permissive like `hide_ship_button`)
rather than hardcoding category keys in the template, so any category can
be opted out later from Settings → Ticket categories' new "Status report"
column with no deploy. Migration 041 opts Housekeeping out by default —
inbox sweeps and weekly chores have no customer to report to. Shipping
tickets are gated separately, through the existing `is_shipping` check
(`showStatusReport` combines both) rather than through this same
category flag, since Orders & Shipping also carries real billable Shopify
orders that should keep their report — the category itself can't be the
signal here, same reasoning migration 028's header already gives for why
`is_shipping` exists at all.

**Shipping tickets: Shipment card moved above Photos.** `TicketShipment`
used to sit in the left column, between Purchase and Estimate/Hours.
Moved it to the right column, directly above `TicketPhotos` — for a
shipping ticket specifically, that puts the packing checklist as the
first thing in that column (QC is already hidden there via `!isShipping`),
ahead of photos, matching how that ticket type actually gets worked. Its
render condition (`ticket.shipments?.length`) is unchanged, so a non-
shipping ticket that somehow carries a shipment (never happens today —
every path that creates one also sets `is_shipping`) still shows it, just
in the new spot.

### 2.47 Orders/shipping always shipping, Housekeeping auto-task, priority "highlight in tasks" flag

Three independent requests that came in together.

**"This is a shipping/logistics ticket" checkbox removed — Orders & Shipping
tickets are always shipping now.** The checkbox on the New Ticket form was
the only way `is_shipping` ever got set to `false` on a manually-created
Orders & Shipping ticket, and in practice nobody wanted that — the category
exists specifically for shipping work, plus the handful of real billable
Shopify orders that flow in through the webhook. `POST /tickets`'s
`isShipping` derivation is now just `category.key === 'orders_shipping'`,
with the checkbox, its form field, and the standalone `qc_required`-forcing
watch removed from `TicketNewView.vue` (QC still gets force-cleared when you
pick the category, same as before, just via the category-change handler
instead of a separate watcher). This only touches the manual `POST /tickets`
path — `shopifyWebhooks.js` creates its tickets through `insertTicketRow`
directly and never sets `is_shipping` at all, so real Shopify orders are
unaffected.

**Housekeeping tickets get an automatic task at creation.** Added a check
inside `insertTicketRow` (the one helper shared by every ticket-creation
path — manual, sub-tickets, recurring-ticket firings, fleet QC, quote
conversion, purchases) that, when `category.key === 'housekeeping'`, inserts
a `ticket_tasks` row titled after the ticket itself, assigned to the same
technician if one was set at creation. Housekeeping tickets are almost
always fired by the recurring-ticket scheduler with nobody watching the
tickets list, so previously the only way to notice one existed was to go
looking; now it shows up on the assignee's dashboard "My tasks" the moment
it's created, same as any other unlocked task.

**New Settings flag: highlight a priority tier's tasks on the dashboard.**
Added `highlight_in_tasks` to `priority_tier` rows' `meta` (Settings →
Priority tiers gets a new checkbox column, same generic per-row-flag
mechanism as `hide_ship_button`/`unlocks_tasks`) and a `stores.js` getter
`highlightTasksForPriority(priorityKey)` to read it. `DashboardView.vue`'s
"My tasks" card now splits `myTasks` into `regularTasks` and
`priorityTasks` by that flag; flagged tasks move into a new "Priority
tasks" card directly below the main one, styled with a red border so it's
visually impossible to miss. Migration 042 turns the flag on for
Expedited/SOS by default — Standard and Low Priority stay off, same
opt-in convention as `show_status_notes`. Turning it off for a tier just
folds its tasks back into the regular list, no code change needed.

### 2.48 Seed Rhodes/Wurlitzer standard procedures; parts-by-variant and outlier buffer

Seeded `standard_procedures` (migration 044) from the shop's own pricing
spreadsheet — 81 rows, 40 Rhodes + 41 Wurlitzer (200/140/145/110/120
models, all `family = 'wurlitzer'`, no sub-family distinction). Clavinet,
Pianet, and Combo Organ sections in the same spreadsheet were deliberately
left out of this pass. A few curation calls made transcribing it: typos
fixed ("Hamer" → "Hammer", "Replacment/Repacement" → "Replacement");
"Rhodes "/"Wurlitzer " prefixes added to every name (the sheet only
implied the instrument via section headers, and procedure names need to
stand alone in the estimate builder); two malformed cells parsed by hand
("Tuning & Voicing 110-120 Models" had "3-5" run into the Average High
column; the 200A-style pickup shield row had no Low value, just a bare
.25 High); pure placeholder rows with no numbers skipped entirely; and the
whole "Rhodes Replacement Parts" section — where all four key-count price
columns were always identical — collapsed to a single `flat_cost` instead
of populating four redundant variant columns.

That last point ties into the bigger schema change this needed (migration
043). The spreadsheet has two things `standard_procedures` couldn't
express before: some parts prices vary by the instrument's key count
(Rhodes Piano Bass/54-Key/73-Key/88-Key), and an "outlier" column that's
explicitly *not* a normal range — it's what the shop thinks a rare
problem job runs, separate from the everyday min/max hours.

**Parts pricing is now its own axis, independent of labor.** Before, a
procedure was hours-billed *or* flat-priced, and that was its whole price.
Now labor (hours or nothing) and parts (nothing, a flat amount, or one of
four `parts_cost_piano_bass`/`_54_key`/`_73_key`/`_88_key` columns) are
decoupled: an hours procedure can carry an additive parts cost on top of
labor (a grommet job bills hours *and* needs a grommet), and a flat
procedure's price comes from whichever of flat_cost/variant is set, since
it has no labor to price instead. `flat_cost` and the four variant
columns stay mutually exclusive (new CHECK), and a flat-priced procedure
must have one of them set (relaxed CHECK, replacing migration 010's
strict hours-xor-flat version). `routes/procedures.js`'s POST/PATCH
validate the combination — `resolveHours`/`resolveParts`/`resolveOutlier`
— rather than letting a bad combination surface as a raw CHECK-violation
500.

When a procedure prices by key count, `routes/quotes.js`'s
`resolveProcedureItem()` requires the estimate builder to say which
variant (`parts_variant` on the submitted item — `piano_bass`/`54_key`/
`73_key`/`88_key`) and snapshots both the resolved dollar amount and a
human label (`parts_variant_label_snapshot`) onto the `estimate_items` row
at build time, same snapshot convention every other estimate field
already uses. A procedure with no variant columns set ignores
`parts_variant` entirely — the common case is unaffected.
`EstimateNewView.vue` shows a "— select variant —" dropdown next to any
checked procedure that has variant columns, and refuses to submit until
every one of them has a pick.

**The "outlier" column became an internal-only estimate-builder buffer,
not a customer-facing field.** The ask: assume there's likely one outlier
somewhere on any given quote, and budget for it as the *mean*, across
every hours-based line item that has an `outlier_hours` value, of
`(outlier_hours - max_hours)` — how far past its own normal high end that
item's outlier would run. `routes/quotes.js`'s `outlierBufferFor()`
computes this and returns `outlier_buffer_hours`/`outlier_buffer_cost`
alongside the normal totals on every staff-facing quote response (GET
list, GET one, POST, PATCH) — zero when nothing on the quote has an
`outlier_hours` value to go on. It's deliberately never computed inside
`POST /:id/send` (the totals passed to `buildQuoteEmail()` are the plain
`totalsFor()` result, nothing more) and never returned by
`publicQuotes.js`, so there's no path for it to reach a customer, in the
email or on the public confirm page. `EstimateDetailView.vue` (staff-only)
shows it as a small note under the total: "Internal only — budget ~X
extra hrs ($Y) assuming one line item on this estimate runs long."
`outlier_hours` on `standard_procedures` only applies to hours-priced
procedures (silently dropped if a procedure is flat-priced) and must be
at or above that procedure's own `max_hours` — a value inside the normal
range wouldn't be an outlier.

`Settings → Standard procedures` (`ProceduresView.vue`) got a matching
rework: an "Outlier hours" field next to min/max (hours procedures only),
and the old single flat-cost input replaced with a "Parts" mode picker —
No parts cost / Single amount / By key count — that swaps in either a
`$` input or four key-count inputs. Switching a procedure to flat pricing
auto-advances an invalid "No parts cost" pick to "Single amount" (a flat
procedure can't have zero price sources), and switching *from* flat back
to hours preserves whatever parts pricing it already had rather than
clearing it.

`QuoteConfirmView.vue` (the one customer-facing page that doesn't go
through the backend's `totalsFor()` — it recomputes its own total and
per-item cost client-side from what `publicQuotes.js` returns) got its
`itemCost()`/`total()` updated to add `parts_cost` into the hours branch
at both ends of the range, so a parts-carrying procedure doesn't quietly
undercount on the one page a customer actually sees. `publicQuotes.js`
includes `parts_cost` and `parts_variant_label_snapshot` in that
customer-safe item shape (they're real, priced-in numbers) but excludes
`outlier_hours` outright, same as the email template.

### 2.49 N10 — Estimate wizard screens + standardized ticket titles

The boss sketched a redesign of the estimate builder as a series of
full-screen button pickers instead of one long scrolling form — meant to
be run on an iPad standing at the bench, one decision at a time: customer
info up top, then per instrument a family picker (Rhodes/Wurlitzer/
Hohner/Combo/Electric Strings/Other) -> a cascading model picker (walking
`instrument_models`' ragged tree — N7's scaffold — one level per screen
instead of a stack of `<select>`s) -> Year/Nickname -> four procedure
screens split by category (Standard Setup & Actions / Electronics /
Cosmetics / Parts) -> a Review/Breakdown screen that can jump back into
any instrument -> a Final/Approval screen (cost summary, then the
customer's email & contact info) before saving. `EstimateNewView.vue` was
rebuilt end to end around this — same underlying POST /quotes payload
shape as before, just walked to a lot more deliberately.

**`standard_procedures.category` (migration 045)** is the new piece that
makes screens 3-6 possible: nullable, one of `standard_setup` /
`electronics` / `cosmetics` / `parts`, backfilled for all 81 of migration
044's seeded rows by id range (safe — those ids are stable, assigned in
that migration's own insertion order into what was an empty table; nothing
since then has touched ids 1-81). A row with no category still shows up
in the wizard, bucketed under Standard Setup & Actions rather than going
missing — same "an incomplete admin list never blocks the shop floor"
posture as `allow_manual`. `Settings -> Standard procedures`
(`ProceduresView.vue`) got an "Estimate wizard screen" picker to fix up
the backfill's guesses or categorize anything added since.

**"Electronics (Suitcase only)"** — the boss's own annotation — is
`instrument_models.is_suitcase` (same migration), a per-node boolean
(admin-set in `Settings -> Instrument models`, same convention as
`allow_manual`) marking a Rhodes Suitcase 73/88-style node, or a
Wurlitzer 140/145/110/120-style self-contained-tube-amp node, as opposed
to a Stage-style instrument with no built-in amp electronics. The
Electronics screen only shows when the *new* instrument being quoted was
picked from a path carrying that flag (and only if the family actually
has any `electronics`-category procedures at all). An *existing*
instrument picked from the customer's own instrument list has no such
flag stored on it (that lives on the tree node, not the `instruments`
row) — for that path the screen shows whenever the family has electronics
procedures, full stop, rather than hiding real available work for lack of
one bit of provenance.

**Standardized ticket titles.** `routes/tickets.js`'s `composeTicketTitle`
(N1) moved from "[Client Name] [\"Nickname\"] [Instrument Model]"
(space-joined, `Model` being whatever the picker/free-text left in
`instruments.model`) to "[Client Name] - [\"Nickname\"] [Year] [Family]
[Model leaf]" — e.g. `Dolly Jones - "Old Betsy" 1973 Rhodes Stage 73`.
`Model leaf` is the last " / "-segment of the model chain (`modelLeaf()`)
— the specific model someone actually picked, not the whole era/mark path
to it — and `Family` is the human label from `routes/instruments.js`'s
`FAMILY_LABELS` (now also exported), not the raw key. Whichever pieces
are actually present still just get space-joined / dash-joined; nothing
required that wasn't already optional. `composeTicketTitle` is now
exported and reused by `routes/quotes.js`'s `createTicketsForEstimate` —
an estimate-originated ticket used to get its own, different
"[Family] [Model] — [Procedure]" title built inline there, so the exact
same customer's instrument rendered two different ways depending on
whether the ticket came from a walk-in intake or a confirmed estimate.
The one case `composeTicketTitle` alone can't describe — a quote line
item with no instrument at all (the "General" bucket) — still appends the
procedure name(s), same as the old inline title did, so that distinction
isn't lost. `TicketNewView.vue`'s `autoTitlePreview` mirrors the new
format client-side exactly, same as before (N1).

Two things the boss's sketch implied but didn't spell out, both handled
as reasonable defaults rather than blocking on a re-ask: Year/Nickname
have no screen of their own in the sketch, so they land as a single small
"Instrument details" step right after the model is picked and before the
four procedure screens. And a returning customer's *existing* instruments
get a quick-pick screen ahead of the family picker (skipping the whole
tree walk for an instrument already on file) — the sketch only draws the
new-instrument path, but dropping that shortcut from the old form would
have been a real regression.

### 2.50 Rename "Status Reports" to "Progress Updates"

Codebase-wide rename, all the way through — same depth-of-rename posture
as migration 019's ceppie->ceppy rename: schema, code, and display text,
not just the label. Migration 046 renames `status_reports` ->
`progress_updates`, `status_report_attachments` ->
`progress_update_attachments` (+ its `status_report_id` column), their
indexes, and the `status_reports_touch` trigger; on the backend,
`routes/statusReports.js` / `routes/publicStatusReports.js` /
`templates/statusReportEmail.js` became `progressUpdates.js` /
`publicProgressUpdates.js` / `progressUpdateEmail.js` (`git mv`, mount
paths in `index.js` now `/api/progress-updates` and
`/api/public/progress-updates`); on the frontend, the three
`StatusReport*View.vue` files became `ProgressUpdate*View.vue`, the
`status-reports`/`status-report` route names became `progress-updates`/
`progress-update`, `stores.js`'s `statusReportAllowed` getter became
`progressUpdateAllowed` (reading the settings meta key
`hide_progress_update`, migration 046 rewrites migration 041's stored
`hide_status_report` flag on the Housekeeping row so that opt-out isn't
silently dropped), and `SettingsView.vue`'s toggle/column followed suit.

Two things deliberately NOT rewritten, both the same "a snapshot records
what happened, not what it's called today" posture used everywhere else
in this schema (`estimate_items`, `emails.template` generally, etc.):
existing `emails.template = 'status_report'` audit rows from before this
rename keep that value — only new sends write `'progress_update'` — and
old NOTES.md entries describing this feature under its old name (§2.46,
§2.47, migration 041's own header) are left as the historical record of
what was true when they were written.

One customer-facing wrinkle: `/status-report/:token` links already sent
in progress-update emails before this change live in real inboxes
indefinitely, so `router.js` keeps that exact path alive as a permanent
alias (`status-report-view-legacy`) pointing at the same, renamed
`ProgressUpdatePublicView.vue` component — the new canonical path is
`/progress-update/:token`. The backend API path underneath has no such
alias; only this app's own frontend JS calls it, and frontend + backend
always deploy together.

### 2.51 Customer picker: search-and-select instead of one giant dropdown

`EstimateNewView.vue`'s and `TicketNewView.vue`'s customer field was a
plain `<select>` populated by fetching every customer on mount — fine
early on, real friction once the shop has enough customers that finding
one means scrolling a native dropdown blind. New shared component
`components/CustomerSearchSelect.vue` replaces both: type to search
(debounced 250ms, same pattern as `CustomersView.vue`'s own search box),
tap a result, or tap the field with nothing typed yet to browse the
existing `GET /customers` (`?q=` already supported server-side, no
backend change needed) sorted-by-name list. Same open/close convention
as `QueueView.vue`'s hide-statuses menu — click-outside + Escape — styled
the same way (`.customer-search-*` mirrors `.hide-status-*` in
`styles.css`).

`v-model` is still just the customer id, so both callers bind it exactly
like the old `<select>` did; a `change` event additionally hands back the
full customer row (or `null` once cleared) since both views also want the
name/email/phone off the selected row — `EstimateNewView.vue` for the
"Email & Contact" step's prefill, `TicketNewView.vue` for
`autoTitlePreview` (N1) — without a second fetch. Neither view holds onto
a full customer array anymore; the picked row is kept in a plain
`selectedCustomer` ref, set from that `change` event.

### 2.52 Two-way Xero customer sync

New integration: customers <-> Xero Contacts, both directions, via a Xero
**Custom Connection** (single-organisation, OAuth2 client_credentials —
no per-user consent screen, since this only ever talks to the shop's own
Xero org). `XERO_CLIENT_ID`/`XERO_CLIENT_SECRET` were already scaffolded
as unused env vars in docker-compose.yml under a "Phase 2 integrations"
placeholder; this is what finally reads them (`config.js`'s new `xero`
block).

**Pieces:** `backend/src/xero.js` is the thin API client — token
fetch/cache (30 min, native `fetch`, no SDK, same posture as
`shopify.js`'s `adminApiRequest`), tenant id discovery via
`GET /connections` (a Custom Connection authorizes exactly one org),
and `listContacts`/`createContact`/`updateContact` against the Accounting
API. `services/xeroSync.js` is the actual two-way reconcile — the one
place both the admin-only manual trigger (`routes/xero.js`'s
`POST /xero/sync`, mirroring Ceppys' `send-now`) and the nightly schedule
(`services/xeroScheduler.js`, mirroring `ceppyScheduler.js` but daily
instead of weekly) actually run from.

**Migration 047** adds `customers.xero_contact_id` (partial-unique, most
rows stay unlinked) and `customers.xero_synced_at`, and widens the
`source` CHECK to add `'xero'` (a contact that only ever existed in Xero
needs a real source value once it's pulled in as a new row here — see
that migration's comment for why it doesn't get force-fit into
`'direct'`). The schedule itself is an ordinary `shop_config` settings
row (`xero_sync`, seeded disabled) edited through the same generic
`PATCH /settings/:id` every other shop_config value uses — same shape as
`ceppys_schedule`, just a daily time instead of a day+time.

**The reconcile algorithm** (full detail in `xeroSync.js`'s header
comment): fetch every Xero contact and every customer in full each run —
small dataset for one shop, so a full diff beats tracking an incremental
cursor. Match by `xero_contact_id` first (already linked), then by email,
then by exact name, but only when that key is unique on the MC2 side —
an ambiguous match is left alone rather than guessed at, since a stray
duplicate is obvious and easy to fix by hand later while a wrong merge
silently corrupts a customer's data. Whatever matches nothing on either
side gets created on the other. For a matched pair, whichever side (Xero's
`UpdatedDateUTC`, MC2's `updated_at`) changed since `xero_synced_at` wins;
if *both* changed, last-write-wins by comparing the two timestamps
directly, and it's recorded in the sync's returned `conflicts` list (shown
in the Customers page's panel) rather than resolved silently.

**Deliberate limitation:** Xero's `Addresses`/`Phones` are structured
(line/city/region/postal, typed numbers); `customers.address`/`.phone`
are single free-text fields. Pulled data gets flattened into one string;
pushed data goes to Xero as `AddressLine1`/a single `PhoneNumber` — good
enough to have the data present and usable on both sides, not a
substitute for editing a properly structured address directly in Xero
when that structure actually matters there (e.g. what prints on an
invoice).

**Frontend:** an admin-only "Xero sync" panel on `CustomersView.vue`
(mirrors `CeppysView.vue`'s Configure panel almost exactly) — enable
toggle, time-of-day, Sync now button, last-synced timestamp, and the
conflict list from the most recent run. A linked customer's detail pane
shows a small "Linked to Xero" pill.

**Not yet exercised against a live Xero connection** — built against
Xero's documented Custom Connection / Accounting API contract, but this
session had no real credentials to test end to end. The first "Sync now"
click against Will's actual org is the real test; `xero.js`'s error
handling surfaces Xero's own error detail (not just a status code) if
something about the token/scope/payload shape needs adjusting.

### 2.53 Xero backfill review tool

Follow-up to §2.52 — Will's ask: before turning the regular two-way sync
loose on an org that already has its own separate customer history on
both sides, find likely "these are the same person" pairs that don't
already match exactly (the regular sync's own matcher already handles
exact email/name for free) and let a human confirm or reject each one,
so a typo or a missing email doesn't turn into a duplicate customer
instead of a link.

**`services/xeroBackfill.js`** scores every still-unlinked MC2 customer
against every still-unlinked Xero contact — no fuzzy-matching package
(same no-SDK posture as `xero.js`'s plain-`fetch` client): exact email
scores highest, otherwise a hand-rolled bigram (Dice coefficient) name
similarity, with a matching phone number (compared by its last 7 digits,
so formatting differences don't break a real match) nudging the score
up. Every candidate carries *which* signals fired, not just a bare
percentage, so a human can judge "Bob Smith"/"Robert Smith" (name-only)
differently from a real email match. Pairs are assigned greedily —
highest score first, claim if neither side is already claimed — into
`confident` (>=0.82) and `possible` (>=0.45) buckets; a rejected pair is
remembered in the new `xero_dismissed_matches` table (migration 048) so
neither this tool nor the regular sync's own auto-matcher suggests or
silently links it again (a shared household email between two different
people is exactly the case that table exists for).

**`XeroBackfillView.vue`** (`/customers/xero-backfill`, admin-only, linked
from the Customers page's Xero sync panel) is the review screen: bulk-link
the confident list, link/dismiss the possible list one at a time, and for
an MC2 customer with no algorithmic candidate at all, a manual search box
over every still-unlinked Xero contact (already fetched with the rest of
the screen's data, no extra round trip) — for the typo or maiden name the
scorer wasn't going to catch. Nothing on this screen creates or overwrites
a record on either side; `POST /xero/backfill/link` only sets
`customers.xero_contact_id` and deliberately leaves `xero_synced_at`
unset, so the *next* regular sync run reconciles the newly-linked pair's
actual field values (whichever side is newer) the same way it handles
every other first-time link — this tool's whole job is establishing which
records are the same, not moving data.

### 2.54 Fix: backfill screen counted already-linked Xero contacts as unmatched

Will's first real run of the backfill review screen (§2.53) showed every
section empty except "Xero-only contacts" — which, with real customer
data on both sides and no prior manual sync, made no sense. Root cause:
`computeBackfillCandidates()` built its "unlinked Xero contacts" list by
filtering only on `IsCustomer`/`ContactStatus`, never checking whether
that contact was already someone's `customers.xero_contact_id` — so once
*any* sync had actually run (most likely the nightly scheduler's own
startup catch-up tick, services/xeroScheduler.js, firing the moment the
"Sync automatically" toggle got saved on with a time already past for the
day — an easy thing to trigger just by exploring the panel, not something
that requires ever clicking "Sync now") and linked or created a customer
for every real Xero contact, this screen kept showing the *entire* Xero
contact list as "Xero-only" forever, since nothing ever excluded an
already-linked one. Fixed by fetching the full customers table (not just
`WHERE xero_contact_id IS NULL`) so the unlinked-Xero-contact filter can
check against every `xero_contact_id` actually in use, not just the
unlinked-customer subset — those are two different questions and
conflating them was the bug.

Practical fallout: if a full sync really did run before backfill got a
chance to, the sync's own conservative exact-email/exact-name matching
already made whatever calls it could — meaning some real duplicates may
already exist for anything that didn't match exactly (a typo, a missing
email) and would have shown up in backfill's "possible matches" for a
human to catch, had the tool run first. Worth a manual look at the
Customers page for anything that looks duplicated before relying on the
backfill screen's now-correct "everything's already reconciled" result.

### 2.55 Fix: Xero sync never pulled in address or phone

Will: after a sync ran, linked and newly-created customers alike had no
address and no phone, even for Xero contacts that have both on file.
`xeroSync.js`'s `addressFromXero`/`phoneFromXero` were reading `xc.Addresses`/
`xc.Phones` correctly — the actual bug was one call earlier: `xero.js`'s
`listContacts()` calls Xero's `GET /Contacts`, and that endpoint defaults to
an abbreviated response (`summaryOnly=true`) that omits `Addresses`,
`Phones`, and a few other detail fields from the payload entirely, not as
empty arrays — it's optimised for orgs with large contact lists that don't
want that detail on every page. A small piano shop's contact list doesn't
need that optimization and was silently paying for it. Fixed by requesting
`GET /Contacts?page=N&summaryOnly=false` — no change needed anywhere else,
since `xeroSync.js`/`xeroBackfill.js` were already reading the right fields,
they just never received them.

Next sync run (manual "Sync now" or the nightly schedule) will pull address
and phone into every already-linked customer along with everything else,
same as any other Xero-side change — no separate backfill needed for this
part.

### 2.56 Xero duplicate-customer merge tool

Direct fallout of §2.54: Will ran a full sync before backfill (§2.53) got a
chance to run, so pre-existing customers that didn't match a Xero contact by
exact email or exact name (a nickname, a typo, an email on file in one
system only) each got a brand-new `source = 'xero'` customer created for
them instead of being linked — the shop ended up with two rows for some of
the same real people, and the new row is the one actually linked to Xero
going forward.

`services/xeroDuplicates.js` finds these: it pairs every customer never
linked to Xero (a likely-original record) against every `source = 'xero'`
customer (a likely duplicate the sync just created), using the exact same
scoring `xeroBackfill.js` already has — email-exact, bigram name similarity,
last-7-digits phone match — reused via that file's exports rather than
redefined. `frontend/src/views/XeroDuplicatesView.vue` is the review screen
(linked from the Customers page's Xero panel, next to the backfill link):
confident and possible pairs, "Not a duplicate" to dismiss (persisted in
migration 049's `xero_dismissed_duplicate_pairs`, same idea as §2.53's
`xero_dismissed_matches` but for two MC2 rows rather than an MC2/Xero pair),
and "Merge" to confirm one.

A merge (`mergeDuplicate`, `db.js`'s `withTransaction`) reassigns every
child record with a `customer_id` FK — `instruments`, `tickets`, `emails`,
`estimates`, `progress_updates` — from the duplicate onto the survivor,
moves the duplicate's `xero_contact_id` onto the survivor, and deletes the
duplicate row. `xero_synced_at` is deliberately left null on the survivor
afterwards, same reasoning as backfill's `linkCustomerToXero`: the next
regular sync run reconciles name/email/phone/address itself by comparing
which side actually changed more recently, rather than the merge having to
guess which of the two versions is "right". No bulk "merge all" button on
purpose, unlike backfill's confident-matches list — a merge deletes a
customer row and reassigns its history, and that's not something to do to a
few dozen records unattended even at high confidence.

### 2.57 Fix: address/phone still missing after §2.55's fix, even after a real sync

Will deployed §2.55's `listContacts()` fix and ran "Sync now" — still no
addresses. The API fix itself was right, but it wasn't enough on its own
for any customer that had *already* been linked and synced before it
shipped: `runXeroSync()` decides whether to pull a contact's fields by
comparing `xero_synced_at` (this row's last-reconciled time) against
Xero's own `UpdatedDateUTC` — and a contact's address hadn't actually
*changed* in Xero since that last sync, only our read of it had been
broken. So every already-linked customer looked "unchanged" and the pull
branch never ran, no matter how many times the sync fired.

Rather than weaken that change-detection (which is doing exactly what
it's for — see §2.52), added a narrow one-time catch-up:
`fillMissingFieldsFromXero()` (`services/xeroSync.js`, `POST
/xero/fill-missing-fields`, a "Fill in missing address/phone from Xero"
button on the Customers page's Xero panel next to "Sync now"). For every
already-linked customer, if Xero has a phone or address on file and
MC2's copy is still blank, it fills just that field in directly —
bypassing `xero_synced_at` entirely, never touching name/email, and
never overwriting a field that already has *something* in it (even if
that something is stale — reconciling an actually-differing value is
still the regular sync's job, once a real future change makes
`UpdatedDateUTC` move again). Safe to run more than once; it's a no-op
once nothing's missing. One click, after which the regular sync goes
back to being the only thing that touches customer fields.

### 2.58 Customer detail panel now stays in view while scrolling the list

Will: on `/customers`, scrolling down a long customer list to find
someone scrolled the selected customer's detail panel on the right out
of view too, since both live in the same page-level scroll and the
detail panel started level with the top of the list. Gave
`.customer-detail-panel` (both the populated and empty-state cards in
`CustomersView.vue`) `position: sticky` in `styles.css`, offset below
`.topbar` (new `--topbar-height` var — the topbar is already `sticky`
itself, see App.vue's layout) with its own `max-height` and
`overflow-y: auto`, so once the panel's own content (a customer with a
long ticket history, say) is taller than the remaining viewport, it
scrolls internally instead of pushing the page taller. Scoped to a
dedicated class rather than `.grid.cols-2` generally, since that grid
class is shared with a few other pages (TicketDetailView, HoursView,
InstrumentDefaultsView) that don't have this same long-list-next-to-
detail shape and shouldn't get sticky behavior by side effect.

### 2.59 Fix: address had no view anywhere in the app

Will, after §2.57's fill-in-missing-addresses catch-up: "it says it
synced addresses but I am not seeing it." Root cause had nothing to do
with the Xero work — `customers.address` has existed since migration 001
and every backend route already reads/writes it fine, but no view ever
rendered it: `CustomersView.vue`'s detail panel showed only
email/phone/source, and the "New customer" form had no address field
either (so before Xero, the only way an address ever got into that
column was routes/customers.js's PATCH being called directly, which
nothing in the UI did). Added an address line to the detail panel and an
Address input to the new-customer form — `form` already had `address` in
its default object, just no input bound to it.

Noted, not fixed here: there's still no way to *edit* an existing
customer's address (or name/email/phone/notes) from the app at all —
only create. Worth a follow-up if that's wanted; a small, separate
decision (inline edit vs. a dedicated edit form) rather than something to
bundle into this fix.

### 2.60 Edit an existing customer, pushes to Xero when linked

Follow-up to §2.59's "there's no way to edit a customer" note. Added an
inline "Edit" toggle to `CustomersView.vue`'s detail panel — same
toggle-shown-form convention this page already uses for "New customer"
(`showNew`), rather than a separate route: click Edit, the summary block
becomes editable name/email/phone/address/source/notes fields, Save
PATCHes `/customers/:id` same as before.

The new part: `routes/customers.js`'s PATCH handler now also pushes the
change to Xero immediately, via `services/xeroSync.js`'s new
`pushCustomerToXero()`, whenever the customer being edited has a
`xero_contact_id` — an edit made here shouldn't have to wait for "Sync
now" or the nightly run to reach Xero. If the MC2 update succeeds but the
Xero push fails (network blip, Xero rejects a field), the edit still
saves — the response carries `xero_push_error` instead of failing the
whole request, and the edit form shows it as a warning rather than
silently losing the local save. `xero_synced_at` is stamped right after a
successful push, same as `runXeroSync()`'s own push branch, so the next
regular sync doesn't try to push it again.

### 2.61 Fix: customers linked through backfill/merge kept missing their Xero email

Will: some customers had address and phone synced in but not email, even
after §2.57's fill-in-missing-fields catch-up (which deliberately only
ever touched phone/address — see that entry). Root cause was one level
up, in `runXeroSync()` itself: a first-time link (`isNewLink` — matched
directly here, or confirmed via the backfill/duplicate-merge review
screens, both of which leave `xero_synced_at` null on purpose) had no
real "last synced" baseline, so the code fell through to the same
timestamp race as any later conflict: whichever of Xero's `UpdatedDateUTC`
or MC2's `updated_at` was more recent won. That race was rigged against
Xero almost every time for a fresh link, because `mc.updated_at` had
usually just been bumped by the very same write that set
`xero_contact_id` (the `customers_touch` trigger fires on any UPDATE to
the row, linking included) — a "just linked" timestamp beats a real but
older Xero edit time nearly always, so the sync kept "pushing" MC2's
(usually email-less, since a missing/differing email is often *why* that
customer needed backfill or a duplicate-merge instead of matching
automatically) data over Xero's, instead of pulling Xero's in.

Fixed by giving `isNewLink` its own branch: always `pull` on a fresh
link, no timestamp comparison — and pull via a fill-if-missing merge
(keep whatever MC2 already has per field, take Xero's value only where
MC2's is blank) rather than the wholesale overwrite a normal pull does,
so a fresh link can't blank out real MC2 data either. Every later,
already-`xero_synced_at`-stamped reconciliation still works exactly as
before (real last-write-wins, unaffected).

For customers already caught by this before the fix: `services/
xeroSync.js`'s `fillMissingFieldsFromXero()` (§2.57's "Fill in missing
contact info from Xero" button) now also fills a missing name or email,
not just phone/address, so running it again catches these up too.

### 2.62 Ticket view: customer contact info in a dropdown

Will: wanted the ticket page's "Customer" field to show contact info
directly instead of clicking through to the customer page for it. Added
`c.email`/`c.phone`/`c.address`/`c.xero_contact_id` to `routes/
tickets.js`'s shared `TICKET_SELECT` (used by both the ticket list and
single-ticket fetch — harmless extra columns on the list side, avoids a
second query on the detail side), and turned the ticket detail page's
customer name into a small popover toggle (`.customer-contact-*` in
`styles.css`, same click-outside/Escape convention as `QueueView.vue`'s
hide-statuses menu) showing email/phone/address, plus a "View full
profile →" link into `/customers?id=` for anything that actually needs
the full record (instrument/ticket history, editing).

### 2.63 Real instrument model trees, sourced from Listing Trees

The instrument model picker (`instrument_models`, migration 036 — the
tree the wizard's family/model screens and the older `InstrumentModelPicker.vue`
both walk one level at a time) only ever had placeholder seed data: a
"1970s" root for Rhodes, a bare "Mark II," nothing at all for Hohner/
Strings/Organ. Migration 050 replaces it with the shop's real catalog,
pulled from the Listing Trees app (the product-description-copy source of
truth — see the `listing-trees` skill) rather than typed up by hand, so it
stays consistent with what the shop's own listings already say about each
model.

Per Will's call: collapsed to root + one level, even where Listing Trees
itself goes deeper for marketing-copy purposes (Rhodes Mark I splits into
Fender-era/Late Torrington/Singer Tines/Schaller Tines sub-eras before
cabinet type; Wurlitzer's 200/200A eras separately list "Early" and "Late"
sub-periods that turned out to share an identical model-number list
underneath, so collapsing them lost no real information). Root nodes:

- **Rhodes** — Mark I / Mark II (each → Stage 73/88, Suitcase 73/88),
  Sparkletop, Rhodes 54, Mark V, Mark 8, Piano Bass, Other (→ Pre-Piano,
  Student Model, Instructor Model).
- **Wurlitzer** — 110 & 120 Era, 140/145 Era (Pre-B), 140B/145B Era, 200
  Era, 200A Era (each → its individual model numbers), Other.
- **Hohner** — Clavinet, Pianet, Cembalet (each → its individual models),
  Other. First real data this family has ever had.
- **Strings** — Yamaha CP Series (→ CP-70/70B/70D/70M/80/80B/80D/80M),
  Helpinstill Roadmaster (→ Roadmaster 64/88), Other. Also first data.
- **Organ** — every combo-organ brand CEPCo has a Listing Trees entry for,
  as sibling root nodes rather than a single flat list: Farfisa (→ Combo
  Compact/Mini Compact/Compact Deluxe/Compact Duo/FAST 2-5), Vox (→
  Continental/Continental II/Jaguar), Gibson & Kalamazoo (→ Kalamazoo
  K-101/Gibson G-101/Gibson G-201), plus four single-model brands as bare
  root leaves (Rheem Mark VII, RMI 368X Electra-Piano, Lowrey T2, Fender
  Contempo Organ) and Howard Combo Organ. Also first data.
- **Other** (the amp/rarity catch-all, §2.40) is untouched — no Listing
  Trees copy exists for it.

`is_suitcase` (migration 045's per-node "self-contained amp" flag, which
the estimate wizard checks anywhere along a picked path, not just at the
leaf) is set on Rhodes' own Suitcase 73/88 leaves and on Wurlitzer's three
eras that are inherently self-contained tube-amp pianos (110 & 120 / 140-
145 Pre-B / 140B-145B — flagged once at the era root rather than on every
child, since the wizard's path check makes that equivalent). Left FALSE
throughout the Wurlitzer 200/200A model numbers, since which of those
specifically have a built-in speaker vs. need an external amp is a finer
distinction than this migration was confident calling one by one — worth
a pass in Settings → Instrument models from whoever knows that lineup's
cabinets by number.

Since no live estimates reference the old placeholder rows yet, the
migration deletes every `rhodes`/`wurlitzer`/`hohner`/`strings`/`organ`
row outright (cascading to their children via the existing `parent_id`
FK) rather than trying to preserve or remap old ids. No code changed —
both the wizard's `childrenOf()`/`pickModelNode()` and
`InstrumentModelPicker.vue`'s own walker are already fully generic over
depth and shape, so this was a pure data fix.

### 2.64 Fix: duplicate customer records on a failed estimate submit

Will reported that making a test estimate created a duplicate customer
record, even though he'd typed the same email both times — he'd had to
"send the email twice." Traced it to `EstimateNewView.vue`'s `submit()`:
creating the customer, creating each new instrument, creating the
estimate, and (when sending) emailing it were five separate sequential
API calls with nothing tying them together. If any later call failed —
most likely the `/quotes/:id/send` call itself, e.g. while `APP_BASE_URL`
was still missing from `docker-compose.yml` (§ above/see the env-var fix)
— the customer, instruments, and estimate created by the earlier calls
in that same attempt were already committed to the database. `busy`
cleared, the error showed, and clicking "Save & send to customer" again
re-ran `submit()` from scratch: since nothing remembered what the first
attempt had already created, it inserted a second customer, second set
of instruments, and second estimate, then (this time) sent successfully.
Same root shape exists in `TicketNewView.vue`'s inline "add a new
customer instead" step, not yet touched here.

Two layers of fix, since only the backend one is a full guarantee if
something else in the app ever hits the same retry pattern:

- **`POST /customers`** (`backend/src/routes/customers.js`) now looks up
  an existing customer by case-insensitive email match before inserting,
  and returns that row instead of creating a new one when found. No
  schema change — `customers.email` has no unique index (only
  `portal_email` and the Xero contact id do, §2.60ish/047), so this is an
  application-level dedup, not a DB constraint. Every "add a customer"
  screen in the app goes through this one endpoint, so this closes the
  gap everywhere at once, including the untouched `TicketNewView.vue`
  path above.
- **`EstimateNewView.vue`'s `submit()`** now remembers the customer id,
  each block's instrument id, and the estimate id as they're created
  (`createdCustomerId` / `createdInstrumentByBlock` / `createdEstimateId`,
  module-scoped so they survive a retry within the same page load), and
  skips any step whose id is already resolved. A retry after a failed
  send now only re-attempts the send — no new customer, instrument, or
  estimate rows at all, not even ones the email-based backend dedup
  would have to clean up after the fact.

### 2.65 Generalized the Xero duplicate-merge tool to any two customers

Follow-up to §2.64: fixing the estimate wizard stops it from creating new
duplicates, but it doesn't do anything about a duplicate the bug already
created (or any other non-Xero duplicate — Will asked "will this merge
duplicate records?" while reviewing that fix, and the honest answer was
no). The only merge tool in the app (Customers → Review duplicates,
§2.56) was built specifically for Xero-sync duplicates and refused
outright on anything else: `mergeDuplicate()` threw `"That record was
not created by the Xero sync — nothing to merge"` unless the duplicate
side had `source = 'xero'` and a `xero_contact_id`, and the candidate
scan in `computeDuplicateCandidates()` only ever paired "no Xero link"
customers against "source = 'xero', has a Xero link" customers in the
first place — two ordinary customers would never even show up as a
candidate pair.

`backend/src/services/xeroDuplicates.js` — both changed:

- `computeDuplicateCandidates()` now scores every pair of customers
  (still small enough for an admin-triggered, on-demand page — this
  isn't polled anywhere), ordering each pair with a new `orderPair()`:
  a Xero-linked customer still always survives over an unlinked one (the
  sync only creates a new row when matching an existing one fails, so
  that's still the right call), and otherwise the older row (lower id)
  survives over the newer one, on the theory that the newer one is the
  accidental repeat.
- `mergeDuplicate()` dropped the "duplicate must be Xero-sourced" /
  "survivor must be unlinked" checks entirely. It only refuses one case
  now: both customers already linked to two *different* Xero contacts,
  which is genuinely ambiguous to auto-resolve. Otherwise the duplicate's
  Xero link (if any) moves onto the survivor exactly as before; two
  plain customers merge with no Xero step at all.

`frontend/src/views/XeroDuplicatesView.vue` copy updated to not overclaim
a Xero connection when there isn't one (heading, description, table
header, and the merge confirmation dialog now only mention Xero when
`r.duplicate.xero_linked` is actually true), plus a small "· Xero" tag on
rows where it applies. The candidate/merge routes in `routes/xero.js`
needed no changes — they already just passed ids through.

Also added a "Review duplicates" link to the Customers page header
itself (previously this screen was only reachable from inside the
"Xero sync" config panel, so a shop that's never touched Xero — or an
admin who hasn't opened that panel — had no way to find it even though
it now handles ordinary duplicates too).

Did not do a one-off cleanup of the specific duplicate Will's test
estimate created — he can now merge it himself from Customers → Review
duplicates, or ask for that cleanup separately if it's not showing up
as a candidate.

### 2.66 Estimate wizard: Review's Back no longer skips to the start

`EstimateNewView.vue`'s per-screen Back buttons inside an instrument
block were already correctly incremental (each has its own
`backFrom*()` that steps back exactly one screen — pick-existing,
family, model, details, standard_setup/electronics/cosmetics/parts).
The one broken jump was Review's own "← Back to customer" button, which
hardcoded `stage = 'customer'` — one click from Review skipped every
instrument screen and went straight back to the very first one,
regardless of how many instruments or screens it took to get there.
Replaced with `backFromReview()`, which lands on the last instrument's
"Instrument added" screen (`instrument-done`) instead — the same
re-entry point `exitBlock()` already uses when backing out of a later
block — so Review's Back is now one real step back, not a reset. Going
all the way back to Customer still works, just incrementally: back out
of each instrument in turn (same as before) until none are left.

### 2.67 Estimate wizard: capture address, push new customers to Xero immediately

Two related changes to the final "Email & contact" screen and customer
creation:

- Added an **Address** field alongside Email/Phone, wired the same way
  those already were: included in the `POST /customers` body when
  adding a new customer, and folded into the existing "confirm this is
  still how to reach them" diff-and-PATCH check for an existing
  customer (`backend/src/routes/customers.js` already accepted
  `address` on both routes — migration 001's `customers.address` column
  — so no backend schema change was needed, just wiring the frontend up
  to it). `xeroPayloadFromMc()` in `services/xeroSync.js` already maps
  `address` to Xero's `AddressLine1` as a flat string, so this was
  already "Xero-compatible" the moment the column had a value in it —
  see that function's own comment on the deliberate flattening of
  Xero's structured Addresses into one free-text field.
- `POST /customers` now also pushes a *brand-new* customer to Xero right
  away, not just an edited one. `pushCustomerToXero()` (used by PATCH,
  §2.60) only ever updates an *existing* Xero contact — new-customer
  creation had nothing pushing at all, so a customer created here sat
  unlinked until the next "Sync now" or nightly run's own "MC2-only
  customer" branch noticed and created it. Added
  `createCustomerInXero()` next to it in `xeroSync.js`, factoring out
  the exact same create-and-stamp-link steps `runXeroSync()`'s own
  bottom branch does, and call it from `POST /customers` — skipped
  entirely (no error surfaced) when Xero isn't configured at all, same
  reasoning as everywhere else this shows up.

### 2.68 Standard procedures page: stop losing scroll position on every edit

Every field on Settings → Standard procedures autosaves on change
through one shared `updateField()`, which called `await load()` — a
full re-fetch of the whole procedures list — after each save.
`load()` sets `loading.value = true` first, and the template gates the
*entire* list behind `v-if="loading"`, so every single edit (a price, a
checkbox, retire/restore, anything) briefly unmounted the whole table
behind a "Loading…" placeholder and remounted it fresh once the request
came back — collapsing the page and throwing the scroll position back
to the top, however far down the list you'd scrolled. `PATCH
/procedures/:id` already returns the updated row in full (`RETURNING
*`), so `updateField()` now splices that row back into the local
`procedures` array in place instead of refetching — no loading flicker,
no remount, and Vue only touches the one changed row's DOM. Left
`createProcedure()`'s own `load()` call alone — adding a brand-new
procedure is a rarer action from a form, not the scroll-position problem
being reported.

### 2.69 Estimate email: card processing fee notice

Added a line below the estimated-total table in
`templates/quoteEmail.js`: "payments made by credit or debit card are
subject to an additional processing fee of 3.5%." Static text, not a
configurable setting — nothing else in the shop currently has a notion
of a card surcharge rate to hang a setting off of, and 3.5% is what
Will asked for by name; worth promoting to a real setting later if the
rate ever needs to change without a deploy.

### 2.70 Email admin-level employees when an estimate is accepted

`publicQuotes.js`'s `POST /:token/confirm` is the only place an
estimate's status becomes `confirmed` (confirmed via the "Review &
respond to this estimate" link's public page — see that file's header
for why this can only ever be a POST the customer's own click
triggers). Added `notifyAdminsEstimateAccepted(estimate, customerName)`
next to `createTicketsForEstimate` in `routes/quotes.js` (same file,
same "one shared function so there's exactly one definition of what
this does" reasoning, exported the same way) and call it right after
ticket creation. It emails every `employees` row with `role = 'admin'`
and an email on file — one send + one `emails` log row per recipient,
same convention as `services/ceppys.js`'s digest — using a new,
internal-facing template (`templates/estimateAcceptedNotice.js`, same
visual language as the customer-facing emails, much shorter: which
customer, which estimate, the accepted total, a link into the app's own
`/estimates/:id` detail screen).

Deliberately fails silent and swallows everything, right down to
wrapping its own body in a try/catch that just `console.error`s — a
customer's successful accept must never turn into an error response
because a notification email had trouble, whether that's Resend being
unconfigured, an admin with a bad address, or something unexpected in
between. Skips sending entirely (no attempt, no log rows) when Resend
isn't configured at all, same posture as every other optional-mailer
feature in this codebase.

### 2.71 Daily To-Do's: end-of-day archive, start "in progress", auto-task from title

Three related requests, all scoped to the `daily_todo` ticket category
("Daily To-Do's" — the catch-all category staff pick by hand from the
Queue page's "By category" picker, distinct from the automated AM/PM
recurring-ticket-template firings under `housekeeping`/
`orders_shipping`, which this section does not touch).

**End-of-day archive.** `services/recurringTickets.js` gained
`dailyTodoArchiveSweep()`, called from the same 60-second `tick()` that
already drives the recurring-ticket engine (mirrors that file's own
shop-timezone-guarded, missed-tick-recovers pattern rather than a
separate OS-level cron): once the shop-local clock passes 23:00 and the
sweep hasn't already run today, it archives every non-archived
`daily_todo` ticket and records the run in a new `shop_config` /
`daily_todo_archive` settings row's `meta.last_run_at`.

**Start "in progress".** `settings.js`'s `defaultStatusForCategory()`
now checks a new `ticket_category.meta.default_status_key` override
before falling back to its old "first non-retired status applicable to
this category" behavior. `daily_todo` is seeded with
`default_status_key: 'in_progress'`. No Settings UI for this override
yet — it's DB/migration-only this round, deliberately scoped down; a
picker can follow if other categories want one.

**Auto-task from title.** `tickets.js`'s `insertTicketRow()` used to
create a ticket's first `ticket_tasks` row from the ticket's own title
only `if (category.key === 'housekeeping')` — a hardcoded key check of
exactly the kind N4a warns against. Generalized to a Settings-editable
`ticket_category.meta.auto_task_from_title` flag (Housekeeping keeps
`true`, nothing changes for it) and turned it on for `daily_todo` too,
with a matching checkbox added to Settings → Ticket categories. Answers
the "double check" directly: Daily To-Do tickets did not get this
before — they do now.

Migration: `051_daily_todo_workflow.sql`.

### 2.72 Kiosk mode: PIN autofocus, switch-to-home, and a refresh bug that skipped profile select

Three fixes to `UserSwitcher.vue` (the kiosk lock/switch overlay) and
`App.vue`:

**PIN input wasn't highlighted.** The PIN `<input>` had a static
`autofocus` attribute, but it's rendered into an already-mounted page via
`v-if`/`v-else` when an admin's tile is tapped — not present at the
page's initial parse — and browsers don't reliably honor `autofocus` on
an element that appears after the fact. Added a template ref plus a
`watch(target, ...)` that imperatively calls `.focus()`/`.select()` on
the input every time the PIN step is entered (including switching from
one admin's PIN entry back to the grid and into a different admin's).

**Switching accounts left you on the old page.** `UserSwitcher.vue`'s
`doSwitch()` called `auth.switchTo()` and `kiosk.unlock()` but never
navigated, and because `App.vue` mounts `<UserSwitcher>` unconditionally
alongside `<RouterView>` (so the view never unmounts across a lock/
switch — that's what lets a tech's in-progress typing survive a lock),
whatever page was showing before the lock kept showing after the
switch. `doSwitch()` now finishes with `router.push({ name:
'dashboard' })` so switching in always lands on a known, neutral
starting point.

**Refresh silently restored the previous session, skipping profile
select.** `kiosk.locked` is in-memory Pinia state that always
initializes to `false` on every store creation — i.e. on every page
load — while `auth.load()` restores a signed-in session from the
server-side cookie on boot. The `watch(() => auth.signedIn, ...)` in
`App.vue` only fires on a *transition* into signed-in, which never
happens on a refresh where the cookie was already valid, so nothing
ever re-locked the kiosk. `App.vue`'s `onMounted(() => { if
(!auth.ready) auth.load(); })` now locks the kiosk (`kiosk.lock()`)
once `auth.load()` resolves, if the restored session is signed in and
kiosk mode is on for this device — the boot/restore path only; an
interactive `login()` or `switchTo()` never calls `auth.load()`, so this
can't undo a switch that just happened.

## 4. Suggested first moves after deploy


1. Set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, deploy, log in, change the
   password immediately (`POST /api/auth/change-password`).
2. Create the real staff accounts under Settings → Staff accounts.
3. Run the import: `docker compose exec backend node backend/src/scripts/importCsv.js`
   (add `--dry-run` first to see the report without writing).
4. Walk `/fleet` and fix any instrument families the classifier got wrong (§2.6).
5. Map the `shop_contact_raw` initials onto real employees (§2.5).
6. Get the GCS bucket up (§3) before the shop starts relying on photos.
7. After the amp/rarity consolidation (§2.40), scan Settings → QC templates
   and Settings → Standard procedures for any leftover amp- or rarity-specific
   row that now duplicates one under "other" and needs reconciling.
