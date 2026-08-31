-- Customer status reports — the "Generate status report" button on ticket
-- detail. Same shape as migration 011's customer_quote flow: a record
-- built from ticket data, then sent to the customer as a link to a public,
-- token-looked-up page (never a numeric id), editable afterward without
-- silently drifting out from under a link the customer already has.
--
-- One report per ticket (UNIQUE ticket_id) rather than a history of
-- versions: "Generate status report" creates it once, and the same
-- row/link is reused across "Update from ticket" and any re-send, the
-- same way estimates.confirm_token is reused across quote re-sends
-- (routes/quotes.js). See NOTES.md.
--
-- service_done_notes/service_needed_notes are *snapshots*, pulled from the
-- ticket's own columns (migration 016) only on generate/refresh, never
-- read live — a report a customer may already be looking at should never
-- change out from under them just because someone edited the ticket
-- afterward. summary is the opposite: it's the reporter's own writing, not
-- ticket data, so a refresh never touches it.
CREATE TABLE status_reports (
    id                    SERIAL PRIMARY KEY,
    ticket_id             INTEGER NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
    customer_id           INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    summary               TEXT,
    service_done_notes    TEXT,
    service_needed_notes  TEXT,
    confirm_token         TEXT UNIQUE,
    status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'sent')),
    generated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    refreshed_at          TIMESTAMPTZ,
    sent_at               TIMESTAMPTZ,
    viewed_at             TIMESTAMPTZ,
    created_by            INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX status_reports_ticket_idx ON status_reports (ticket_id);
CREATE INDEX status_reports_customer_idx ON status_reports (customer_id) WHERE customer_id IS NOT NULL;

-- Snapshot of which ticket_attachments were included as of the last
-- generate/refresh — a join to the existing row, not a copy of the file
-- bytes, so nothing is duplicated in storage. The public report page
-- resolves a fresh viewing URL for each photo on every page load (signed
-- GCS URL, or a proxied read for the local driver — see
-- routes/publicStatusReports.js), the same way the internal ticket gallery
-- already does, rather than baking a URL in once at send time: GCS signed
-- URLs expire in minutes (GCS_SIGNED_URL_TTL_SECONDS), far short of how
-- long a customer might sit on an emailed link.
CREATE TABLE status_report_attachments (
    status_report_id  INTEGER NOT NULL REFERENCES status_reports(id) ON DELETE CASCADE,
    attachment_id     INTEGER NOT NULL REFERENCES ticket_attachments(id) ON DELETE CASCADE,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (status_report_id, attachment_id)
);
CREATE INDEX status_report_attachments_report_idx ON status_report_attachments (status_report_id, sort_order);

CREATE TRIGGER status_reports_touch BEFORE UPDATE ON status_reports
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
