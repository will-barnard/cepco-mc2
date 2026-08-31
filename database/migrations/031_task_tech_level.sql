-- N8 (boss-list scope): tech level moves from the ticket to the task. A
-- ticket's ~10 tasks are frequently a mix of skill levels (a bass reed
-- replacement and a full action rebuild landing on the same Wurlitzer
-- ticket, say) — one tech_level_key per ticket could only ever describe
-- one of them, so it's added here at the level where it's actually
-- meaningful, using the exact same key + label-snapshot convention every
-- other settings-backed column in this app already uses.
--
-- tickets.tech_level_key itself is left exactly as it is — column, index,
-- route logic, all untouched. The boss's own framing: "the column costs
-- nothing," and ripping it out would mean a migration to backfill
-- historical tickets' tech level onto some task that may not even exist
-- for them. New tickets simply stop populating it going forward (removed
-- from TicketNewView.vue/TicketDetailView.vue below); it just quietly
-- stops being the place this information lives.
ALTER TABLE ticket_tasks ADD COLUMN tech_level_key TEXT;
ALTER TABLE ticket_tasks ADD COLUMN tech_level_label_snapshot TEXT;

-- Nice-to-have from the same packet: a standard_procedures row can name the
-- tech level its own work usually calls for (e.g. "Full action rebuild"
-- defaulting to "Senior tech"), so a task created from that procedure
-- arrives pre-tagged instead of every single one needing to be set by
-- hand. Nullable/optional — "applies to every level" is the sensible
-- default for a procedure that doesn't specify, same as `family` already
-- being nullable on this same table.
ALTER TABLE standard_procedures ADD COLUMN default_tech_level_key TEXT;
ALTER TABLE standard_procedures ADD COLUMN default_tech_level_label_snapshot TEXT;
