/**
 * The colors a status can be given in Settings -> Ticket statuses (and
 * Vendor work statuses). A status stores one of these *names* in
 * meta.color; every pill / row highlight just uses the name as a CSS class
 * (styles.css: .pill.<name>, tbody tr.row-highlight.<name>, and the
 * --<name> variables), so adding a color here also means adding it there.
 * The first six are the originals the seed data uses.
 */
export const STATUS_COLORS = [
  { key: 'slate', label: 'Gray' },
  { key: 'blue', label: 'Blue' },
  { key: 'cyan', label: 'Cyan' },
  { key: 'teal', label: 'Teal' },
  { key: 'green', label: 'Green' },
  { key: 'lime', label: 'Lime' },
  { key: 'amber', label: 'Amber' },
  { key: 'orange', label: 'Orange' },
  { key: 'red', label: 'Red' },
  { key: 'pink', label: 'Pink' },
  { key: 'violet', label: 'Violet' },
];
