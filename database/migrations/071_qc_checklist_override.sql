-- QC checklist override: anyone working a QC round can switch it onto a
-- different checklist than the one standardized for that round and
-- instrument family (routes/qc.js: PUT /qc/checks/:id/checklist, and the
-- optional checklist_template_id on POST /qc/checks).
--
-- qc_checks.template_id stays exactly what it was — the STANDARD template
-- for this round — and keeps deciding how many signatures the round needs
-- (qc_templates.required_signoffs, migration 035), so swapping the
-- checklist can't be used to dodge the two-signature rule on a closing
-- round. This new column records the override only:
--   NULL  = the round is using its standard checklist (every existing row)
--   set   = the checklist whose items were copied into `results` instead
-- ON DELETE SET NULL like template_id: if a template is ever deleted the
-- round keeps its copied items and just stops naming where they came from.
ALTER TABLE qc_checks
  ADD COLUMN IF NOT EXISTS checklist_template_id INTEGER REFERENCES qc_templates(id) ON DELETE SET NULL;
