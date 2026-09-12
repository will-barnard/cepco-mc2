-- Naming panel (Settings -> Ticket categories -> Naming): every ticket
-- category gets its own configurable title template instead of the one
-- hardcoded format routes/tickets.js's composeTicketTitle used to render
-- unconditionally for every category. Two new per-category meta keys,
-- same pattern as hide_qc/hide_ship_button/etc:
--
--   meta.naming_template  — a string like
--     `[{customer} - ]["{nickname}"][ {year}][ {family}][ {model}]`
--     rendered by composeTicketTitle/renderNamingTemplate. Seeded below
--     with the exact template that reproduces N10's old fixed format
--     ("[Client Name] - ["Nickname"] [Year] [Family] [Model leaf]"), so no
--     category's tickets are renamed by this migration itself — an admin
--     opts a category into a different look from Settings afterward.
--
--   meta.naming_enforced  — boolean, absent/false = free-naming (today's
--     behavior: a hand-typed title always wins, the template is only a
--     fallback for a blank one). true = the template is the *only* name
--     that category's tickets ever get — POST/PATCH /tickets both ignore
--     a client-supplied title for such a category (see routes/tickets.js).
--     Deliberately left unset here rather than defaulted anywhere: an
--     admin turns it on per category from the same panel once they've
--     actually reviewed that category's template, rather than every
--     category silently losing free-naming the moment this migration runs.
UPDATE settings
   SET meta = meta || jsonb_build_object(
     'naming_template', '[{customer} - ]["{nickname}"][ {year}][ {family}][ {model}]'
   )
 WHERE category = 'ticket_category'
   AND NOT (meta ? 'naming_template');
