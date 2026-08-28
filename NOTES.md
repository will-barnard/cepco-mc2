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
