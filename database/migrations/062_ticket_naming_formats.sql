-- Ticket naming scheme from shop feedback (Sep 2026). Three changes to
-- the naming panel (migrations 056/057), all per-category settings meta:
--
-- 1. meta.naming_mode replaces the on/off meta.naming_enforced with three
--    behaviors for the New Ticket form's Title box:
--      'suggest'     -- the old default: type anything; left blank, the
--                       template is used (shown as the placeholder)
--      'prefill'     -- NEW: the box starts out *containing* the rendered
--                       template ("To-Do: ") and the person types the rest;
--                       they can still delete the prefix
--      'standardize' -- the old naming_enforced = true: the template is
--                       the title, locked; {ticket_name} (if the template
--                       uses it) is the one thing typed
--    naming_enforced is kept in step (true exactly when 'standardize') so
--    anything still reading it keeps working.
--
-- 2. A sub-category can carry its own template/mode, used instead of its
--    parent's when a ticket is filed under it -- this is how Orders &
--    Shipping gets three formats (Shipping / Shopify / uShip) without a
--    new "format" concept: they're sub-categories, picked with the same
--    button row the New Ticket form already shows for SideQuests.
--
-- 3. meta.naming_name_label: what the {ticket_name} box is called on the
--    New Ticket form ("What's being shipped", "Order #") instead of a
--    generic "Name". meta.naming_name_from_instrument: pre-fill that box
--    with the picked instrument's brand + model.
--
-- Only new tickets are affected -- no existing title is rewritten here.
-- (A Standardize category's tickets still re-render their title on PATCH
-- when their customer/instrument changes, as before.)

-- Existing categories: carry today's enforced flag over as the mode.
UPDATE settings
   SET meta = meta || jsonb_build_object(
     'naming_mode', CASE WHEN (meta->>'naming_enforced')::boolean THEN 'standardize' ELSE 'suggest' END)
 WHERE category = 'ticket_category' AND NOT (meta ? 'naming_mode');

-- Daily To-Do's, Housekeeping, SideQuests: "To-Do: [typed]". The prefix is
-- literal text rather than {category}, since the shop wants "To-Do" and
-- "Sidequest", not the category labels "Daily To-Do's" / "SideQuests".
UPDATE settings SET meta = meta || jsonb_build_object(
  'naming_template', 'To-Do:', 'naming_mode', 'prefill', 'naming_enforced', false)
 WHERE category = 'ticket_category' AND key = 'daily_todo';
UPDATE settings SET meta = meta || jsonb_build_object(
  'naming_template', 'Housekeeping:', 'naming_mode', 'prefill', 'naming_enforced', false)
 WHERE category = 'ticket_category' AND key = 'housekeeping';
UPDATE settings SET meta = meta || jsonb_build_object(
  'naming_template', 'Sidequest:', 'naming_mode', 'prefill', 'naming_enforced', false)
 WHERE category = 'ticket_category' AND key = 'sidequests';

-- Repairs & Restoration: Wurlitzer 200 (1972) "Big Boi" - Joe Biden
UPDATE settings SET meta = meta || jsonb_build_object(
  'naming_template', '[{family}][ {model}][ ({year})][ "{nickname}"][ - {customer}]',
  'naming_mode', 'standardize', 'naming_enforced', true)
 WHERE category = 'ticket_category' AND key = 'repairs_restoration';

-- Orders & Shipping: the parent itself uses the Shipping format, so a
-- ticket filed under Orders & Shipping with no sub-category still gets a
-- sensible title (and "Ship this instrument" keeps working if the
-- sub-categories below are ever retired).
UPDATE settings SET meta = meta || jsonb_build_object(
  'naming_template', 'Shipping: {ticket_name}[ - {customer}]',
  'naming_mode', 'standardize', 'naming_enforced', true,
  'naming_name_label', 'What''s being shipped',
  'naming_name_from_instrument', true)
 WHERE category = 'ticket_category' AND key = 'orders_shipping';

INSERT INTO settings (category, key, label, sort_order, meta) VALUES
  ('ticket_category', 'order_shipping', 'Shipping', 10, jsonb_build_object(
     'parent_key', 'orders_shipping',
     'naming_template', 'Shipping: {ticket_name}[ - {customer}]',
     'naming_mode', 'standardize', 'naming_enforced', true,
     'naming_name_label', 'What''s being shipped',
     'naming_name_from_instrument', true)),
  -- Order # is typed for a hand-made ticket; the Shopify webhook fills it
  -- in from the order itself (routes/shopifyWebhooks.js).
  ('ticket_category', 'order_shopify', 'Shopify', 20, jsonb_build_object(
     'parent_key', 'orders_shipping',
     'naming_template', 'Shopify: {ticket_name}[ - {customer}]',
     'naming_mode', 'standardize', 'naming_enforced', true,
     'naming_name_label', 'Order #')),
  ('ticket_category', 'order_uship', 'uShip', 30, jsonb_build_object(
     'parent_key', 'orders_shipping',
     'naming_template', 'uShip: [{family}][ {model}][ "{nickname}"][ - {customer}]',
     'naming_mode', 'standardize', 'naming_enforced', true))
ON CONFLICT (category, key) DO NOTHING;
