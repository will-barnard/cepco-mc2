// Date helpers for the plain 'YYYY-MM-DD' strings the API returns for DATE
// columns (backend/src/db.js keeps them as strings on purpose).
//
// Never `new Date('2026-10-14')` for display: that parses as UTC midnight,
// which a viewer in Central time sees as the 13th. Build the Date from its
// parts instead (same rule as TicketPurchase.vue / NOTES.md §2.13).

const SHOP_TZ = 'America/Chicago';

/** 'YYYY-MM-DD' -> the viewer's locale date string, or '—' when blank. */
export function formatYmd(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString();
}

/** An instant (ISO string / Date) -> the shop's calendar day, 'YYYY-MM-DD'.
 * A note typed at 9pm Central on the 14th is the 14th, not the 15th (UTC). */
export function shopDate(instant) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ }).format(new Date(instant));
}
