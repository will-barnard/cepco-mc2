-- N4a (boss-list scope): flips ticket_status.meta.applicable_categories from
-- an allowlist to meta.excluded_categories, a denylist.
--
-- The allowlist read exactly backwards for what every existing row actually
-- meant: "every category except shipping." Under an allowlist, a ticket
-- category added later (Settings -> Ticket categories) is *absent* from
-- that list until someone remembers to go add it to all five status rows —
-- so Reservation / QC / Invoice Sent / Invoice Paid / On Hold would silently
-- stop being offered on brand-new categories the moment one is created,
-- exactly the kind of landmine this sweep exists to defuse (see N2b, which
-- is about to add Housekeeping, SideQuests and Repairs & Restoration).
-- A denylist has the opposite, correct default: a new category
-- automatically gets every status that hasn't specifically excluded it.
--
-- This UPDATE is data-driven rather than hardcoding 'shipping' — it computes
-- the actual complement (every currently-active ticket_category key NOT
-- present in the row's old allowlist) so it does the right thing even if an
-- admin already edited these away from the seeded default before this ran.
-- See backend/src/services/settings.js's statusAppliesToCategory() and
-- backend/src/scripts/seed.js for the code-side half of this change.
UPDATE settings s
   SET meta = (s.meta - 'applicable_categories') || jsonb_build_object(
         'excluded_categories',
         (SELECT COALESCE(jsonb_agg(c.key ORDER BY c.key), '[]'::jsonb)
            FROM settings c
           WHERE c.category = 'ticket_category'
             AND NOT (s.meta->'applicable_categories' ? c.key))
       )
 WHERE s.category = 'ticket_status'
   AND s.meta ? 'applicable_categories'
   AND jsonb_typeof(s.meta->'applicable_categories') = 'array'
   AND jsonb_array_length(s.meta->'applicable_categories') > 0;

-- A status row whose old allowlist was present but empty meant "every
-- category" already (see the old statusAppliesToCategory) — just drop the
-- now-meaningless key rather than computing a denylist of everything.
UPDATE settings
   SET meta = meta - 'applicable_categories'
 WHERE category = 'ticket_status'
   AND meta ? 'applicable_categories'
   AND jsonb_typeof(meta->'applicable_categories') = 'array'
   AND jsonb_array_length(meta->'applicable_categories') = 0;
