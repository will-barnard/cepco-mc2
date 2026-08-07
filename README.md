# Mission Control v2 — Chicago Electric Piano Company

Ticket-driven shop system: intake → estimate → servicing → QC → invoicing →
shipping, with actual hours logged against every ticket. Replaces the Google
Sheets operation described in [`PLAN.md`](PLAN.md).

Build notes, known gaps, and the GCS setup guide are in [`NOTES.md`](NOTES.md).

## Stack

- **Frontend** — Vue 3 + Vite, served by nginx
- **Backend** — Node 20 / Express, REST
- **Database** — PostgreSQL 16
- **Storage** — pluggable: local volume (dev) or Google Cloud Storage (prod)
- **Hosting** — Beachhead

```
frontend/  Vue SPA + nginx config
backend/   Express API, migrations runner, seeder, CSV importer, tests
database/  migrations/*.sql — applied automatically on boot
assets/    the original Google Sheets exports (source data for the import)
```

## Running locally

Needs Docker and a `.env` (copy `.env.example`).

```bash
cp .env.example .env       # set DB_PASSWORD and JWT_SECRET at minimum
docker compose up --build
```

The app comes up on the frontend container's port 80. On boot the backend
applies migrations, seeds the configurable enums and checklist templates, and
creates the first admin account from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
if no employees exist yet.

Without Docker, run the two halves separately against a local Postgres:

```bash
cd backend  && npm install && npm start     # :3001
cd frontend && npm install && npm run dev   # :5173, proxies /api to :3001
```

## Importing the historical sheets

```bash
docker compose exec backend node backend/src/scripts/importCsv.js --dry-run
docker compose exec backend node backend/src/scripts/importCsv.js
```

`--dry-run` parses and reports without writing. `--reset` replaces a previous
import. Either way it writes `import-report.json` listing every row skipped and
why — the sheets contain section headers, year dividers, labour-rate rows and
half-typed rows that aren't data.

Current result: 118 tickets, 102 customers, 188 instruments (70 of them the
showroom fleet), 13 parts orders, 20 rows skipped as formatting artifacts.

## Tests

```bash
cd backend && npm test    # smoke.mjs + photos.mjs, against a running API
```

`test/smoke.mjs` walks the whole Phase 1 loop: auth and RBAC, ticket creation,
estimates, hours, the QC gate on invoicing, the status audit trail, and the
settings guardrails (rename propagates, in-use values can't be deleted).
`test/photos.mjs` covers the attachment path end to end.

## Deploying

Push to the configured branch; the Beachhead webhook does the rest.

Set these as **global** env vars in the Beachhead dashboard (not targeted —
`docker-compose.yml` reads them via `${VAR}` substitution, which only resolves
from globals):

`DB_PASSWORD`, `JWT_SECRET`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`,
`STORAGE_DRIVER`, `PUBLIC_BASE_URL`, and — once the bucket exists —
`GCS_BUCKET_NAME`, `GCS_PROJECT_ID`, `GCS_SERVICE_ACCOUNT_KEY`.

Postgres is declared as a `stateful_service`, so it isn't recreated on
blue/green swaps. Both volumes have fixed names (`cepco-mc2-postgres`,
`cepco-mc2-uploads`) so redeploys don't wipe them.

## Configurable by admin, not by deploy

Ticket statuses, priority tiers, QC rigor tiers, tech levels and ticket
categories all live in the `settings` table and are editable at `/settings`
(PLAN §8). Tickets reference settings by stable `key`, never by row id, which
means:

- renaming a value updates it everywhere, including historical tickets
- deleting a value still in use is refused — retire it instead
- a label snapshot taken at write time preserves what it said at the time

QC rigor is configuration too: the Perfectionist tier ships with
`required_rounds: 2` and `require_distinct_reviewers: true`, so PLAN §6's
two-person sign-off is enforceable without a code change.
