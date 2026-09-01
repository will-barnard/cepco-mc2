-- Seeds Standard procedures (Settings -> Standard procedures) from the
-- shop's existing Rhodes/Wurlitzer estimates pricing sheet. Rhodes and
-- Wurlitzer only, per the ask — Clavinet/Pianet/Combo Organ sections of
-- that same sheet are left for a later pass.
--
-- Curation notes, so this is legible against the source sheet later:
--   - Rows that were pure spreadsheet placeholders ("General Repair Hours
--     Estimated", "Electronics Troubleshooting", "Other Parts:", and
--     similar "Notes/Comments:" rows with no actual number in them)
--     carry nothing to seed and are skipped.
--   - A few obvious typos are fixed on the way in ("Hamer" ->
--     "Hammer", "Replacment"/"Repacement" -> "Replacement"), and most
--     names gain a "Rhodes "/"Wurlitzer " prefix for a catalog that mixes
--     both instrument lines together (the sheet only implied the
--     instrument from its section header).
--   - Two cells didn't parse as plain numbers: "Tuning & Voicing 110-120
--     Models" had its low/high range embedded in a single "Average High"
--     cell ("3-5") instead of split across both columns — read as
--     min=3/max=5. "200A-Style Pickup Shield" gave only a high (.25) with
--     no low — read as min=max=.25 (a fixed, not ranged, quick job).
--   - The sheet's four parts-cost columns are headed "Piano Bass" /
--     "54-Key" / "Cost 73" / "Cost 88" under every Rhodes section, but
--     under every Wurlitzer section that same column position is
--     re-headed to a single generic "Parts Cost" — so a populated column
--     6 becomes one of the four `parts_cost_*` variant columns for a
--     Rhodes row, but plain `flat_cost` for a Wurlitzer row (Wurlitzer
--     parts don't price by key count the way Rhodes' do).
--   - Per migration 043's comment: when all four Rhodes variant columns
--     for a row were equal (the "Rhodes Replacement Parts" section, in
--     every case), that collapses to a single `flat_cost` instead —
--     there's no real variance to ask an estimator to pick between, so no
--     row here uses the variant columns unless the source numbers
--     actually differ (or one variant is genuinely blank, meaning that
--     part doesn't apply to that key count at all).
WITH base AS (
  SELECT COALESCE(MAX(sort_order), 0) AS start FROM standard_procedures
),
src (ord, name, family, pricing_type, min_hours, max_hours, flat_cost, outlier_hours,
     parts_cost_piano_bass, parts_cost_54_key, parts_cost_73_key, parts_cost_88_key) AS (
  VALUES
    -- Rhodes Standard Setup & Basic Repairs
    (1,  'Rhodes Setup (Light w/ Tuning & Voicing Only)',              'rhodes', 'hours', 2.5,  4,    NULL::numeric, 6,    NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric),
    (2,  'Rhodes Setup (Complete w/ Strikeline/Escapement Reset)',     'rhodes', 'hours', 3,    5,    NULL,          7,    NULL, NULL, NULL, NULL),
    (3,  'Rhodes Grommet Replacement',                                 'rhodes', 'hours', 2,    3,    NULL,          4,    40,   50,   60,   70),
    (4,  'Rhodes Hammer Tip Replacement (VV)',                         'rhodes', 'hours', 1.5,  2,    NULL,          2.5,  35,   50,   60,   70),
    (5,  'Rhodes Hammer Tip Replacement (RL)',                         'rhodes', 'hours', 1.5,  2,    NULL,          2.5,  45,   60,   75,   85),
    (6,  'Rhodes Hammer Tip Replacement (As-Needed)',                  'rhodes', 'hours', 0.25, 0.5,  NULL,          0.75, 10,   10,   15,   15),
    (7,  'Rhodes Tine Replacement',                                    'rhodes', 'hours', 0.25, 0.3,  NULL,          0.5,  20,   NULL, 20,   20),
    (8,  'Rhodes Pickup Replacement',                                  'rhodes', 'hours', 0.25, 0.3,  NULL,          0.5,  15,   NULL, 15,   15),

    -- Rhodes Action Services
    (9,  'Rhodes Key Bed Leveling',                                    'rhodes', 'hours', 1,    2,    NULL,          2.5,  NULL, NULL, NULL, NULL),
    (10, 'Rhodes Pedestal Bump Action Setup (1970-75)',                'rhodes', 'hours', 4,    6,    NULL,          7,    NULL, NULL, NULL, NULL),
    (11, 'Rhodes Action Setup (''75-77, Felt Backed Hammer Cams)',     'rhodes', 'hours', 5,    7,    NULL,          9,    NULL, NULL, NULL, NULL),
    (12, 'Rhodes Action Setup (Post-1978)',                            'rhodes', 'hours', 3.5,  4.5,  NULL,          5,    NULL, NULL, NULL, NULL),
    (13, 'Rhodes Other Action Repairs (Key Dip, Hammer Resting Height, etc.)', 'rhodes', 'hours', 1, 2, NULL,        2.5,  NULL, NULL, NULL, NULL),
    (14, 'Rhodes Bushing Felt Replacement',                            'rhodes', 'hours', 4,    5,    NULL,          6,    NULL, NULL, NULL, NULL),

    -- Rhodes Cosmetic Services
    (15, 'Rhodes Quick Cleaning',                                      'rhodes', 'hours', 0.25, 0.5,  NULL,          0.75, NULL, NULL, NULL, NULL),
    (16, 'Rhodes Hardware Rust Bath',                                  'rhodes', 'hours', 0.75, 1.5,  NULL,          2,    NULL, NULL, NULL, NULL),
    (17, 'Rhodes Tolex Color Treatment',                                'rhodes', 'hours', 2.5,  3.5,  NULL,          4,    NULL, NULL, NULL, NULL),
    (18, 'Rhodes New Tolex (Stage Model)',                              'rhodes', 'hours', 10,   15,   NULL,          18,   50,   65,   90,   100),
    (19, 'Rhodes New Tolex (Suitcase Model)',                           'rhodes', 'hours', 12,   17.5, NULL,          20,   NULL, NULL, 105,  115),
    (20, 'Rhodes Grill Cloth Replacement',                              'rhodes', 'hours', 1.5,  2,    NULL,          2.5,  NULL, NULL, 90,   90),

    -- Rhodes Electronics
    (21, 'Rhodes Peterson Power Supply Re-Cap',                         'rhodes', 'hours', 3,    4,    NULL,          5,    NULL, NULL, 25,   25),
    (22, 'Rhodes Peterson Preamplifier Re-Cap',                         'rhodes', 'hours', 1.25, 2,    NULL,          3,    NULL, NULL, 15,   15),
    (23, 'Rhodes Peterson Power Amplifier Module Basic Repairs',        'rhodes', 'hours', 1,    1.5,  NULL,          2,    NULL, NULL, 20,   20),
    (24, 'Rhodes Peterson Power Amp Module CEPCo Bias Upgrade',         'rhodes', 'hours', 2,    3,    NULL,          4,    NULL, NULL, NULL, NULL),
    (25, 'Rhodes Peterson Complete Restoration',                        'rhodes', 'hours', 6,    7.5,  NULL,          8,    NULL, NULL, 60,   60),
    (26, 'Rhodes Peterson Anti-Thump Mod',                               'rhodes', 'hours', 0.5,  1,    NULL,          1.25, NULL, NULL, 5,    5),
    (27, 'Rhodes Janus Preamp Power Supply Restoration',                 'rhodes', 'hours', 0.75, 1,    NULL,          1.25, NULL, NULL, 25,   25),
    (28, 'Rhodes Janus Power Amp Restoration',                           'rhodes', 'hours', 1,    1.5,  NULL,          2,    NULL, NULL, 15,   15),
    (29, 'Rhodes Janus Anti-Bleed Mod',                                  'rhodes', 'hours', 0.5,  1,    NULL,          1.25, NULL, NULL, 5,    5),
    (30, 'Rhodes Janus Complete Restoration',                            'rhodes', 'hours', 3.5,  4.5,  NULL,          6,    NULL, NULL, 45,   45),
    (31, 'Rhodes Janus Biasing & Offset',                                'rhodes', 'hours', 0.5,  0.75, NULL,          1,    NULL, NULL, NULL, NULL),

    -- Rhodes Replacement Parts (all four variant columns were identical
    -- for every row here, so these collapse to a single flat_cost)
    (32, 'Rhodes Legs & Crossbrace Set',      'rhodes', 'flat', NULL, NULL, 300, NULL, NULL, NULL, NULL, NULL),
    (33, 'Rhodes Legs (no Crossbraces)',      'rhodes', 'flat', NULL, NULL, 240, NULL, NULL, NULL, NULL, NULL),
    (34, 'Rhodes Crossbraces',                'rhodes', 'flat', NULL, NULL, 115, NULL, NULL, NULL, NULL, NULL),
    (35, 'Rhodes Crossbrace Knob',            'rhodes', 'flat', NULL, NULL, 10,  NULL, NULL, NULL, NULL, NULL),
    (36, 'Rhodes Sustain Pedal & Rod',        'rhodes', 'flat', NULL, NULL, 240, NULL, NULL, NULL, NULL, NULL),
    (37, 'Rhodes Sustain Pedal (no rod)',     'rhodes', 'flat', NULL, NULL, 150, NULL, NULL, NULL, NULL, NULL),
    (38, 'Rhodes Sustain Rod (no pedal)',     'rhodes', 'flat', NULL, NULL, 45,  NULL, NULL, NULL, NULL, NULL),
    (39, 'Rhodes Replacement White Key',      'rhodes', 'flat', NULL, NULL, NULL, NULL, 25, 26, 27, 28),
    (40, 'Rhodes Replacement Sharp',          'rhodes', 'flat', NULL, NULL, NULL, NULL, 10, 11, 12, 13),

    -- Wurlitzer 200 Series Services
    (41, 'Wurlitzer Tuning & Voicing (Standard)',                       'wurlitzer', 'hours', 2.5,  4,   NULL, 6,    NULL, NULL, NULL, NULL),
    (42, 'Wurlitzer Tuning & Voicing (Perfectionist)',                  'wurlitzer', 'hours', 5,    10,  NULL, 15,   NULL, NULL, NULL, NULL),
    (43, 'Wurlitzer Tuning & Voicing (110/120 Models)',                 'wurlitzer', 'hours', 3,    5,   NULL, 10,   NULL, NULL, NULL, NULL),
    (44, 'Wurlitzer Clean & Lubricate Key Bed & Action Centers',        'wurlitzer', 'hours', 1,    1.5, NULL, 2,    NULL, NULL, NULL, NULL),
    (45, 'Wurlitzer Key Bed Regulation',                                'wurlitzer', 'hours', 1.5,  2.5, NULL, 3,    NULL, NULL, NULL, NULL),
    (46, 'Wurlitzer Key Bed Leveling',                                  'wurlitzer', 'hours', 1,    2,   NULL, 2.5,  NULL, NULL, NULL, NULL),
    (47, 'Wurlitzer Fly Springs Replacement',                           'wurlitzer', 'hours', 2.5,  3,   15,   4,    NULL, NULL, NULL, NULL),
    (48, 'Wurlitzer Fly Felts Replacement',                             'wurlitzer', 'hours', 1,    1.5, NULL, 2,    NULL, NULL, NULL, NULL),

    -- Wurlitzer 200 Series Common Parts
    (49, 'Wurlitzer Reed Replacement',            'wurlitzer', 'hours', 0.25, 0.5,  24,   0.75, NULL, NULL, NULL, NULL),
    (50, 'Wurlitzer 200 Leg Set',                 'wurlitzer', 'flat',  NULL, NULL, 195,  NULL, NULL, NULL, NULL, NULL),
    (51, 'Wurlitzer 200 Leg (Single)',            'wurlitzer', 'flat',  NULL, NULL, 50,   NULL, NULL, NULL, NULL, NULL),
    (52, 'Wurlitzer Sustain Pedal',               'wurlitzer', 'flat',  NULL, NULL, 230,  NULL, NULL, NULL, NULL, NULL),
    (53, 'Wurlitzer Leg Plate Set',               'wurlitzer', 'flat',  NULL, NULL, 45,   NULL, NULL, NULL, NULL, NULL),
    (54, 'Wurlitzer Leg Plate (Single)',          'wurlitzer', 'flat',  NULL, NULL, 15,   NULL, NULL, NULL, NULL, NULL),
    (55, 'Wurlitzer Hammer Replacement',          'wurlitzer', 'flat',  NULL, NULL, 10,   NULL, NULL, NULL, NULL, NULL),
    (56, 'Wurlitzer Whip Replacement',            'wurlitzer', 'flat',  NULL, NULL, 10,   NULL, NULL, NULL, NULL, NULL),
    (57, 'Wurlitzer Damper Arm Replacement',      'wurlitzer', 'flat',  NULL, NULL, 10,   NULL, NULL, NULL, NULL, NULL),
    (58, 'Wurlitzer 200A-Style Pickup Shield',    'wurlitzer', 'hours', 0.25, 0.25, 75,   0.5,  NULL, NULL, NULL, NULL),
    (59, 'Wurlitzer Universal Harp Shield',       'wurlitzer', 'flat',  NULL, NULL, 90,   NULL, NULL, NULL, NULL, NULL),
    (60, 'Wurlitzer Replacement White Key',       'wurlitzer', 'flat',  NULL, NULL, 25,   NULL, NULL, NULL, NULL, NULL),
    (61, 'Wurlitzer Replacement Sharp',           'wurlitzer', 'flat',  NULL, NULL, 10,   NULL, NULL, NULL, NULL, NULL),

    -- Wurlitzer 200 Series Electronics
    (62, 'Wurlitzer IEC Installation',                                  'wurlitzer', 'hours', 0.25, 0.5,  10,  0.75, NULL, NULL, NULL, NULL),
    (63, 'Wurlitzer AC Lead Dress & Fuse Holder',                       'wurlitzer', 'hours', 0.25, 0.5,  5,   0.75, NULL, NULL, NULL, NULL),
    (64, 'Wurlitzer Warneck Research Amplifier (Variable Vibrato)',     'wurlitzer', 'hours', 1,    1.25, 605, 1.75, NULL, NULL, NULL, NULL),
    (65, 'Wurlitzer Warneck Research Amplifier (Fixed Vibrato)',        'wurlitzer', 'hours', 1,    1.25, 425, 1.75, NULL, NULL, NULL, NULL),
    (66, 'Wurlitzer 200/200A Re-Cap',                                    'wurlitzer', 'hours', 1,    1.5,  25,  2,    NULL, NULL, NULL, NULL),
    (67, 'Wurlitzer 200/200A Basic Troubleshooting',                     'wurlitzer', 'hours', 0.5,  2,    10,  3,    NULL, NULL, NULL, NULL),

    -- Wurlitzer 200 Cosmetic Services
    (68, 'Wurlitzer Quick Cleaning',                                     'wurlitzer', 'hours', 0.25, 0.5,  NULL, 0.75, NULL, NULL, NULL, NULL),
    (69, 'Wurlitzer Tray Refinish (Black)',                              'wurlitzer', 'hours', 1.25, 2,    NULL, 2.5,  NULL, NULL, NULL, NULL),

    -- Wurlitzer 140/145 Services
    (70, 'Wurlitzer 140B Re-Cap',                        'wurlitzer', 'hours', 2,    2.5,  NULL, 3,   NULL, NULL, NULL, NULL),
    (71, 'Wurlitzer 140B Troubleshooting',                'wurlitzer', 'hours', 1,    2,    NULL, 3,   NULL, NULL, NULL, NULL),
    (72, 'Wurlitzer 140/145 Aux Output',                  'wurlitzer', 'hours', 1,    1.5,  25,   2,   NULL, NULL, NULL, NULL),
    (73, 'Wurlitzer 145 Heater Elevation',                'wurlitzer', 'hours', 0.5,  1,    10,   1.5, NULL, NULL, NULL, NULL),
    (74, 'Wurlitzer 145 Re-Cap',                          'wurlitzer', 'hours', 2,    2.5,  30,   3,   NULL, NULL, NULL, NULL),
    (75, 'Wurlitzer 145 Power Tube Replacement',          'wurlitzer', 'hours', 0.25, 0.25, 120,  0.5, NULL, NULL, NULL, NULL),
    (76, 'Wurlitzer 145 Preamp Tube Replacement',         'wurlitzer', 'hours', 0.25, 0.25, 45,   0.5, NULL, NULL, NULL, NULL),

    -- Wurlitzer 110/120 Services
    (77, 'Wurlitzer 110/120 Aux Output',                  'wurlitzer', 'hours', 1,    1.5,  25,  2,   NULL, NULL, NULL, NULL),
    (78, 'Wurlitzer 110/120 Heater Elevation',            'wurlitzer', 'hours', 0.5,  1,    10,  1.5, NULL, NULL, NULL, NULL),
    (79, 'Wurlitzer 110/120 Re-Cap',                      'wurlitzer', 'hours', 2,    2.5,  25,  3,   NULL, NULL, NULL, NULL),
    (80, 'Wurlitzer 110/120 Preamp Tube Replacement',     'wurlitzer', 'hours', 0.25, 0.25, 25,  0.5, NULL, NULL, NULL, NULL),
    (81, 'Wurlitzer 110/120 Power Tube Replacement',      'wurlitzer', 'hours', 0.25, 0.25, 60,  0.5, NULL, NULL, NULL, NULL)
)
INSERT INTO standard_procedures
  (name, family, pricing_type, min_hours, max_hours, flat_cost, outlier_hours,
   parts_cost_piano_bass, parts_cost_54_key, parts_cost_73_key, parts_cost_88_key, sort_order)
SELECT src.name, src.family, src.pricing_type, src.min_hours, src.max_hours, src.flat_cost, src.outlier_hours,
       src.parts_cost_piano_bass, src.parts_cost_54_key, src.parts_cost_73_key, src.parts_cost_88_key,
       base.start + src.ord * 10
  FROM src, base
 ORDER BY src.ord;
