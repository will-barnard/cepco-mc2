# Chicago Electric Piano — Mission Control v2
## Formal Project Plan (Draft v2)

Source material: hand-drawn workflow sketches (`assets/IMG_0802-0804.HEIC`) and the current
Google Sheets operation (`assets/*.csv`) — instrument job sheets (RHODES, WURLITZER,
HOHNER + STRINGS, KOMBO), JOB QUEUE, PARTS ORDERS, SHOWROOM QC, and the Wurlitzer QC/Shipping
checklists. This document translates that sketch + spreadsheet system into a buildable web app.

---

## 1. Vision

CEPCo currently runs its repair/restoration shop across a dozen loosely-linked Google Sheets and
email threads. Mission Control v2 replaces that with one app: a ticket-driven system that carries
a job from intake through estimate, servicing, QC, invoicing, and shipping — while logging actual
labor hours against each ticket so future estimates get more accurate over time. Internal staff
(admin, senior techs, junior techs) run the shop from it day to day; customers get a lightweight
portal to check status and see invoices.

## 2. Users & Roles

| Role | Access |
|---|---|
| **Admin** (Will / shop owner) | Full access: tickets, estimates, QC sign-off, invoicing, parts orders, employee hours, reporting, system settings |
| **Senior Tech** | Assigned higher-skill tickets (action regulation, tuning, electronics); logs hours; participates in QC sign-off; uploads photos to tickets |
| **Junior Tech** | Assigned simple tasks (grommets, felts, basic prep); logs hours; uploads photos to tickets |
| **Customer** | Portal login scoped to their own instrument(s): ticket status, QC/shipping milestones, invoices/payment status. No internal data. |

Auth: standard email/password with role field for internal accounts; separate, more restricted
auth scope for customer accounts (tied to a customer record, not a shop role).

## 3. Core Workflow

This is the loop from the first sketch page, formalized:

```
Web Sales / Email Sales ─┐
                          ▼
                    TICKET SYSTEM ◄──────────┐
                          │                   │
                          ▼                   │
                     ESTIMATES ────────► RECORD ACTUAL HOURS
                          │                   │
                          ▼                   │
                          QC ─────────────────┘
                          │
                          ▼
                     INVOICING ──► SHIPPING
                          │
                          ▼
                   Daily Email & To-Do ──► Email Client
```

Estimates set expected hours per task; techs log actual hours against tickets; actual-vs-estimate
variance feeds back into future estimates for the same instrument/task type. QC gates a ticket
before it can be invoiced. A recurring "Daily Email & To-Do" process clears inbox/order emails
each morning and evening and can spin up new tickets.

## 4. Ticket Categories

Every ticket belongs to one of five categories (from the sketch's "Tickets Categories" page):

1. **Daily To-Do's** — recurring, not tied to a specific instrument: email clear (AM/PM),
   shipping/orders clear (AM/PM). Staff can add ad hoc daily tickets.
2. **Orders & Shipping** — sourced from Shopify (which is itself the unified source of truth for
   Shopify, Reverb, and eBay orders) or email/direct sale; flagged as "pack for shipping" vs.
   "ship as-is."
3. **Servicing** — the core repair/restoration jobs. Sub-routed by order of operations: vendor
   work, junior tech track, senior tech track, electronics, custom shop fabrication.
4. **Inventory Restorations** — CEPCo's own showroom/rental fleet (see SHOWROOM QC data: Rhodes,
   Wurlitzer, Hohner/Strings, Organs, Mellotron/Synth/Rarities, Amplifiers), handled as a service
   job against internal "clients" rather than external customers, same order-of-ops split. This
   fleet is already customer-visible via the Shopify storefront, so the app's job here is
   internal shop tracking only — no dedicated public-facing view planned (see §9).
5. **Shipping** — packing/scheduling; folded into the daily to-do cadence for basic web orders,
   escalated to a standalone ticket for deeper packing jobs (crating, international, fragile).

### Priority Levels (applies to all ticket types)
Daily To-Do → Expedited → Standard Setup (5–10 hr) → Deep Dive (10+ hr) → Custom Shop.
This maps directly to the "Quick Setup (3-6hr)/Expedited," "Standard Setup (7-15hr)," and
"Custom Shop & Deep Dive" section headers already used in the RHODES/WURLITZER/HOHNER/KOMBO
sheets.

### Tech Levels (for delegation)
- **Junior Tech** — simple tasks: grommets, felts, basic prep
- **Senior Tech** — higher-skill tasks: action regulation, tuning, electronics diagnostics

All of the above (ticket statuses, priority tiers, QC rigor tiers, tech levels) are **configurable
by admin** rather than hardcoded — see §8.

## 5. Estimates

- **Instrument taxonomy** (drives estimate templates and reporting):
  Rhodes · Wurlitzer · Hohner (Clavinet, Pianet/Cembalet) · Electric Strings (Yamaha CP,
  Helpinstill, etc.) · Combo Organ — extended in practice (per SHOWROOM QC) to also cover
  Amplifiers and Mellotron/Synth/Rarities as service categories.
- An estimate includes: parts cost, labor hours, a confidence flag (High/Med/Low), and an
  optional manual "additional estimated hours" line for scope that doesn't fit the template.
- Confirming an estimate should auto-generate the associated ticket(s) and an outbound email to
  the customer (quote/approval request) — this was explicit in the sketch ("Generate Tickets,"
  "Generate Email").
- Estimate templates should be seeded from the historical `Estimated Hrs` values already present
  in the CSVs, bucketed by instrument + priority tier, as a starting point for the confidence
  scoring.

## 6. QC

- Two tiers of rigor: **Standard Setup** level vs. **Perfectionist/Custom Shop** level, with
  different checklist templates (the existing Wurlitzer "QC Round 1" and "QC Final" sheets are
  the reference model — replicate this pattern per instrument family). Checklist templates and
  tier definitions are admin-editable (§8).
- **Two-person sign-off required.** At least one back-and-forth round between two staff members
  before a ticket can be marked QC-complete (minimum two rounds, per the sketch's explicit note).
- QC must pass before a ticket can move to Invoicing.

## 7. Shipping

- **Basic web orders** — standard pack-and-ship, folded into daily to-do queue.
- **Deeper packing jobs** — custom crating, international, high-value/fragile — own ticket type,
  reuses the existing Wurlitzer "Shipping Checklist" pattern (method of shipment, contact info,
  international flag) generalized across instrument families.

## 8. Admin Configuration & Settings

A settings area, admin-only, makes the following editable without a code change so the shop can
tune the system as real usage reveals what works:

- **Ticket status enum** — add/rename/reorder/retire statuses (seed values from history: Reservation,
  Not Started, In Progress, QC, Invoice Sent, Invoice Paid, Done, On Hold). Statuses are free-form
  for now — no enforced transition rules (a ticket can move to any status from any status). Every
  change is written to a `status_change_log` (§12) so there's a full audit trail even without a
  rules engine; if certain transitions turn out to need guardrails once the shop is using it day
  to day, that can be layered on later without a schema change.
- **Priority tiers** — labels and hour-range boundaries (Daily To-Do / Expedited / Standard Setup
  / Deep Dive / Custom Shop).
- **QC rigor tiers** — tier names, checklist template per tier, required sign-off rounds.
- **Tech levels** — labels and which task types map to which level.
- **Ticket categories** — the 5 top-level categories, in case the shop wants to split or merge
  them later.

Design note: changing a config value should not silently break historical tickets — store the
tier/status *value* on the ticket at time of creation, not just a foreign key to a mutable config
row that could later be deleted or renumbered. Renames should propagate; deletions of an in-use
value should be blocked or require migration of affected tickets.

## 9. Customer Portal

- **Account creation:** manually triggered, not automatic. The ticket detail view has a
  **"Send Sign-Up Email"** button — staff fires it when they're ready (no fixed rule tying it to
  ticket creation, estimate approval, etc., since that call varies job to job). Firing it sends
  the customer a sign-up link via Resend (§11); following the link creates their portal account
  already matched to that instrument/ticket on the backend — no manual matching step, no
  self-service "search for my instrument" flow.
- A customer can have multiple instruments in progress at once, each generally its own ticket
  (one instrument per main ticket, per §4/§12). The sign-up button is per-ticket, so a returning
  customer with a second instrument gets matched to that instrument too without creating a
  duplicate account — if they already have a portal account, firing the button just links the new
  instrument to it rather than emailing a second sign-up link.
- Notifications (status updates, QC milestones, invoice/shipping) are scoped per instrument/ticket,
  not bundled across a customer's whole account — so a customer with two instruments in the shop
  gets separate, instrument-specific updates rather than one combined digest.
- Customer logs in and sees: all of their instrument(s), each with its own current ticket
  status/stage (Estimate → In Progress → QC → Invoicing → Shipping), and invoice/payment status
  (synced from Xero, §10).
- No pricing internals, no vendor/parts detail, no other customers' data.
- Out of scope for v1: online payment collection, messaging/chat with shop staff (start with
  status visibility only; revisit once the core loop is stable).
- **Inventory Restorations (CEPCo's own fleet):** already visible to customers through the
  Shopify storefront, so no separate public-facing page is planned in the app. Treated as
  internal-only in Mission Control (see §4).

## 10. Ticket Attachments (Photos)

Techs need to attach photos to tickets quickly from the shop floor:

- Upload from the ticket detail view, mobile-friendly (camera capture on phone, drag/drop on
  desktop), multiple photos per upload.
- Photos stored in object storage (not the Postgres DB) with a `ticket_attachments` table holding
  metadata (ticket_id, uploader_id, file url, caption/optional note, uploaded_at).
- Displayed as a gallery/timeline on the ticket, ordered by upload time — useful for before/after
  documentation, QC evidence, and parts-condition notes.
- Since Beachhead deploys are containerized with no durable local disk guarantee across
  redeploys, plan to store files in **Google Cloud Storage (GCS)** rather than the container
  filesystem — see §11 for provider rationale.
- Upload flow: backend issues a short-lived signed URL, tech's browser/phone uploads the photo
  directly to GCS (not proxied through the Express server), then confirms the attachment record
  via a small API call. Keeps large image uploads off the app server entirely.

## 11. Integrations

### Shopify (full app integration)
Shopify is the single source of truth for orders — Reverb and eBay are already fully integrated
into Shopify, so all three channels' orders propagate through Shopify rather than needing
separate integrations.

Rather than a bare webhook listener, plan to register Mission Control as a **full Shopify app**
from the start (a custom app created via the store's Shopify Admin → "Develop apps," since this
is a single-store internal tool with no need for an embedded Shopify-admin UI or multi-store
distribution). A custom app gets one Admin API access token with whatever scopes we request —
this covers both webhook subscriptions and full REST/GraphQL Admin API access under a single
integration, so future needs don't require a second integration project later:

- **Webhooks:** `orders/create`, `orders/updated`, `orders/cancelled` auto-create/update tickets
  in the "Orders & Shipping" category without manual re-entry.
- **Scopes to request up front** (even if unused in Phase 1): `read_orders`, `read_fulfillments`
  and `write_fulfillments` (to push tracking numbers back once shipping is built), `read_products`
  and `read_inventory` (for the restoration-fleet listings, §4/§9), `read_customers`. Requesting
  broad-but-relevant scopes at setup avoids re-authorizing the app later.
- Primary day-to-day usage stays the custom Vue/Node/Express web UI — Shopify's app framework
  here is purely the auth/access layer (one access token, one place to manage scopes), not an
  embedded admin surface.

### Xero (invoicing)
Integrate with Xero rather than building invoicing natively. Ticket → Invoice flow creates/updates
a Xero invoice via their API; invoice status (sent/paid) syncs back into Mission Control so the
customer portal and internal ticket view reflect real payment state without duplicate data entry.
Requires a Xero OAuth app connection (per-organization), stored securely, with a background sync
job or webhook listener (Xero supports webhooks for invoice updates) to keep status current.

### Resend (transactional email)
All outbound email — customer portal sign-up links, estimate/quote emails, daily
email-clear-related notifications if needed — goes through Resend rather than a generic SMTP
client. Plan for a small `emails` table logging what was sent, to whom, and when, for
troubleshooting delivery issues.

### Google Cloud Storage (file storage)
Beachhead runs on GCP infrastructure, so use **Google Cloud Storage** for ticket photo
attachments rather than AWS S3 or a self-hosted MinIO container:

- Same cloud/project as the rest of the hosting — no cross-cloud egress fees, and IAM/service
  accounts are managed in one place (the GCP console/project you already have).
- No extra stateful service to run and back up on Beachhead (a self-hosted MinIO container would
  need its own persistent volume, backup plan, and would still be a single point of failure on
  the same box as everything else — GCS is durable, multi-region-capable storage outside that
  blast radius).
- Use the native `@google-cloud/storage` Node SDK (not the S3-interop shim) — simpler auth via a
  service account key or Workload Identity if the VM is a GCE instance, and native support for
  signed URLs, lifecycle rules, and object versioning.
- Bucket setup: a single regional bucket (co-located with the Beachhead VM's region to minimize
  latency/egress cost), private by default, access only via signed URLs issued by the backend —
  never a public bucket.
- Lifecycle rule to consider: nothing needs auto-deletion (photos are job records), but enabling
  object versioning is worth it as cheap protection against accidental overwrite/delete.
- Service account used by the backend should be scoped to Storage Object Admin on that one
  bucket only, not project-wide storage access.

## 12. Data Model (first pass)

Entities to formalize during technical design — listed here so the plan can be honed before
handoff:

- `customers` (name, contact, portal login, source: shopify/email/direct — Reverb and eBay orders
  arrive as Shopify orders, so they're not separate source values)
- `instruments` (family: Rhodes/Wurlitzer/Hohner/Strings/Organ/Amp/Mellotron-Synth-Rarity, model,
  year, serial/identifying notes, owner: customer_id nullable for CEPCo-owned fleet)
- `tickets` (category, priority_tier, status — all referencing admin-configurable settings values,
  instrument_id nullable, customer_id nullable, assigned_tech_id, tech_level_required, created_at,
  notes, shopify_order_id nullable)
- `ticket_attachments` (ticket_id, uploader_id, file_url, caption, uploaded_at)
- `estimates` (ticket_id, parts_cost, estimated_hours, confidence: high/med/low,
  additional_hours_note, approved_at)
- `hours_log` (ticket_id, employee_id, hours, task_description, logged_at)
- `qc_checks` (ticket_id, tier, round_number, reviewer_id, passed, notes)
- `shipments` (ticket_id, type: basic/deep-pack, method, contact_info, international: bool,
  scheduled_date)
- `invoices` (ticket_id, xero_invoice_id, amount, status: draft/sent/paid, sent_at, paid_at)
- `parts_orders` (vendor, item, notes, linked ticket(s)) — vendors per PARTS ORDERS.csv:
  Vintage Vibe, Retro Linear, Schaff/Howard, Hardware/McMaster, Mouser/CEDist, CVK/KRSS,
  Fabricators+Paint, ULINE
- `employees` (name, role: admin/senior/junior, login)
- `settings` (config category, key, value, label, sort_order) — backs §8's admin-editable enums
- `status_change_log` (ticket_id, old_status, new_status, changed_by, changed_at) — audit trail
  for the free-form, rule-less status field described in §8
- `emails` (recipient, template/type, resend_message_id, sent_at, related ticket/customer id)

## 13. Data Migration

Import existing CSVs as seed/reference data rather than starting blank:

- `RHODES.csv`, `WURLITZER.csv`, `HOHNER + STRINGS.csv`, `KOMBO.csv` → historical + in-flight
  tickets, split into priority tiers by their existing section headers, mapped to `tickets` +
  `estimates` + `shipments`/vendor sub-columns (Shipping, Painting, Key Tops, Woodshop, Plastics,
  Metal Fab, Other Vendor become status flags or sub-tasks on the ticket).
- `JOB QUEUE.csv` → historical ticket records, one row per job, status normalized against the
  configurable status list (values seen: Reservation, Not Started, In Progress, QC, Invoice Sent,
  Invoice Paid, Done, On Hold). Note the labor-rate rows ($175/hr) and year-divider rows are
  formatting artifacts, not data — filter these out during import.
- `SHOWROOM QC.csv` → seed data for CEPCo's own inventory-restoration fleet
  (`instruments` with customer_id = null), including `Last QC` and `History` as initial
  `qc_checks`/notes.
- `Wurlitzer Checklists - *.csv` (QC Round 1, QC Final, Shipping Checklist, Wurli Evaluation) →
  become the seed templates for `qc_checks` and `shipments` checklist structures, generalized to
  other instrument families.
- `PARTS ORDERS.csv` → seed `parts_orders` vendor list.
- Going forward, new orders arrive live via the Shopify webhook (§11) rather than CSV import —
  the CSV migration only covers historical/in-flight backlog at cutover.

A one-time import script (Node) should run against these CSVs into the new schema; expect manual
cleanup afterward since the sheets contain inconsistent statuses, blank rows, and free-text notes
that don't map cleanly to structured fields.

## 14. Tech Stack & Deployment

- **Frontend:** Vue 3
- **Backend:** Node/Express, REST API
- **Database:** PostgreSQL
- **File storage:** Google Cloud Storage for ticket photo attachments
- **External services:** Shopify (webhooks, order intake), Xero (invoicing), Resend
  (transactional email), Google Cloud Storage (file storage)
- **Hosting:** Beachhead (Will's self-hosted Docker orchestrator)
  - `beachhead.json` at repo root defining `public_service`/`public_port`
  - `docker-compose.yml`: no `version:` key, `expose:` not `ports:`, no `container_name`, all
    services on a named `internal` network, Postgres with `start_period: 30s` healthcheck and a
    fixed named volume (e.g. `cepco-mc2-postgres`), Postgres declared as a `stateful_service` so
    it survives blue/green redeploys
  - Frontend nginx proxies to backend via Docker service name using the embedded DNS
    resolver pattern (`resolver 127.0.0.11 valid=30s ipv6=off;`) rather than a bare `proxy_pass`
  - Dockerfiles at repo root (or explicit `context`/`dockerfile` in compose if nested);
    `npm install`, not `npm ci`
  - Secrets set as Beachhead global env vars, not committed to the repo. Expected vars (exact
    names to be finalized at build time, but the app should read from env rather than hardcode):
    `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_ADMIN_API_TOKEN`,
    `SHOPIFY_API_SCOPES`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (Will is setting
    up the Resend account/sending domain himself — the app just needs these two vars populated),
    `GCS_BUCKET_NAME`, `GCS_SERVICE_ACCOUNT_KEY` (or none, if using Workload Identity on a GCE
    host), `DB_PASSWORD`

## 15. Phased Roadmap

**Phase 1 — MVP (core loop)**
Auth (internal roles only) · ticket CRUD across all 5 categories · estimates (manual entry, no
auto-confidence scoring yet) · hours logging · ticket photo attachments · basic QC sign-off
(single tier, single round) · admin settings page for status/priority/QC-tier configuration ·
free-form status changes with `status_change_log` audit trail · CSV data migration · deployed
on Beachhead.

**Phase 2 — Full shop workflow + integrations**
Two-tier QC with required two-person/two-round sign-off · Shopify custom app integration (order
webhooks covering Shopify/Reverb/eBay, full Admin API access token with scopes for orders,
fulfillments, products/inventory, customers) · Xero invoicing integration · Resend transactional
email · "Send Sign-Up Email" button on ticket detail (fires the customer portal invite, matches
to instrument/links existing account) · shipping (basic + deep-pack distinction, including
pushing tracking numbers back to Shopify via `write_fulfillments`) · parts orders tracking ·
daily to-do recurring tickets · estimate confidence scoring fed by historical hours data.

**Phase 3 — Customer-facing + polish**
Customer portal itself (multi-instrument view, per-instrument status + notifications,
Xero-synced invoices) · auto-generated estimate emails/tickets · reporting/dashboards (job queue
view, tech workload, estimate-vs-actual accuracy) · pull product/inventory data from Shopify for
the restoration-fleet listings if still useful once the app is in daily use.

## 16. Open Questions to Resolve Before Handoff

- Confirm which GCP project/billing account the GCS bucket should live under, and whether the
  Beachhead host is a GCE VM (enabling Workload Identity) or something else (falling back to a
  service account key file).

**Deferred (not blocking a build start):**
- Xero integration granularity — build against a single connected org for now; revisit
  multi-entity support later if the shop structure changes.
- Resend account/sending-domain setup is being handled directly by Will, outside this build —
  the app only needs the env vars below wired up, not the Resend dashboard configuration itself.
