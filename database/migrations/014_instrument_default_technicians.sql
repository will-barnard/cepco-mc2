-- ===========================================================================
-- Default technicians per instrument type.
--
-- An admin can now say "every Rhodes job goes to Sam and Jamie by default"
-- (Settings -> Default instrument assignments). TicketNewView.vue reads
-- this to pre-fill the technician picker as soon as an instrument/family is
-- chosen — still just a starting point, not a hard rule: the picker stays
-- fully editable per NOTES.md, same as every other "default" in this app
-- (see the ticket_category.meta.default_assignee_id single-assignee
-- default this sits alongside).
--
-- `family` is a plain TEXT key with no FK/CHECK, matching instruments.family
-- itself (migration 001) — the family list is a fixed array in
-- routes/instruments.js (FAMILIES), not a DB-backed enum, so there's
-- nothing to reference. family is the PK's leading column, so it's already
-- indexed for "give me every default for this family" — no extra index
-- needed (contrast migration 013's ticket_technicians, where employee_id
-- isn't the PK's leading column and does need one).
-- ===========================================================================

CREATE TABLE instrument_default_technicians (
    family      TEXT NOT NULL,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    PRIMARY KEY (family, employee_id)
);
