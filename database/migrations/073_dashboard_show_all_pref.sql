-- Per-person default for the Dashboard's "In-Progress Tickets" card.
-- FALSE (the existing behaviour): the card opens on In Progress + QC only,
-- with "Show all" to widen it. TRUE: it opens on everything assigned to
-- you, with the same button to narrow it. Set by each person on their own
-- Account page (PATCH /api/auth/preferences), not by an admin — it's a
-- viewing preference, unlike show_parts_on_dashboard (migration 058).
ALTER TABLE employees ADD COLUMN dashboard_show_all_tickets BOOLEAN NOT NULL DEFAULT FALSE;
