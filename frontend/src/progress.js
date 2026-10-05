/**
 * Per-ticket progress bar (migration 066) -- shared by every place a
 * ticket row can show it: QueueCard.vue, TicketTable.vue (Queue fallback
 * tables and the dashboard), and DashboardView.vue's To-Do list. The look
 * itself is the global `.progress-fill` / `.progress-pct` classes in
 * styles.css, so it's one implementation everywhere.
 */

/** The ticket's progress as a whole 1-100, or null when it isn't tracked. */
export function progressOf(ticket) {
  const n = Number(ticket?.progress_percent);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.round(n)) : null;
}

/** Inline style for a `.progress-fill` element, or null for no bar. */
export function progressStyle(ticket) {
  const p = progressOf(ticket);
  return p === null ? null : { '--progress': `${p}%` };
}
