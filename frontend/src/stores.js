import { defineStore } from 'pinia';
import api from './api';

export const useAuth = defineStore('auth', {
  state: () => ({ user: null, ready: false }),
  getters: {
    isAdmin: (s) => s.user?.role === 'admin',
    isSenior: (s) => s.user?.role === 'admin' || s.user?.role === 'senior',
    signedIn: (s) => !!s.user,
  },
  actions: {
    async load() {
      try {
        const { user } = await api.get('/auth/me');
        this.user = user;
      } catch {
        this.user = null;
      } finally {
        this.ready = true;
      }
    },
    async login(email, password) {
      const { user } = await api.post('/auth/login', { email, password });
      this.user = user;
      return user;
    },
    async logout() {
      await api.post('/auth/logout');
      this.user = null;
    },
    /** Switch the active identity on this browser (kiosk mode) without a full re-login. */
    async switchTo(employeeId, pin) {
      const { user } = await api.post('/auth/switch', { employee_id: employeeId, pin });
      this.user = user;
      return user;
    },
    /** Set/replace the 4-digit PIN used to switch *into* this account from kiosk mode. */
    async setPin(currentPassword, pin) {
      await api.post('/auth/pin', { current_password: currentPassword, pin });
    },
  },
});

/**
 * Settings (§8) are loaded once and cached — nearly every view needs the enum
 * labels, and they change rarely.
 */
export const useSettings = defineStore('settings', {
  state: () => ({ data: {}, loaded: false }),
  getters: {
    statuses: (s) => s.data.ticket_status || [],
    categories: (s) => s.data.ticket_category || [],
    // Queue page's "By category" picker (QueueView.vue) — narrowed to
    // categories an admin hasn't opted out of via Settings -> Ticket
    // categories' "Queue picker" column (meta.hide_from_category_queue).
    // The idea: categories tied to a specific instrument (Servicing,
    // Inventory Restorations) are better browsed "By instrument family,"
    // so this lets an admin leave just the catch-all categories (Shipping,
    // Daily To-Do's, ...) as their own pickable queue. Absent/false meta
    // means "shown," same default-is-permissive convention as
    // shipButtonAllowed below, so nothing changes until an admin opts a
    // category out.
    categoriesForQueuePicker: (s) => (s.data.ticket_category || [])
      .filter((r) => !r.retired && !r.meta?.hide_from_category_queue),
    priorities: (s) => s.data.priority_tier || [],
    techLevels: (s) => s.data.tech_level || [],
    active: (s) => (category) => (s.data[category] || []).filter((r) => !r.retired),
    // N2a: a category can now nest one level (settings.meta.parent_key) —
    // these split an active() list into the top level and a given parent's
    // children, for any two-level picker to consume (N2c's category
    // buttons, N3's SideQuests tree) rather of each inventing its own
    // parent/child split over the flat active() list.
    topLevel: (s) => (category) => (s.data[category] || [])
      .filter((r) => !r.retired && !r.meta?.parent_key),
    childrenOf: (s) => (category, parentKey) => (s.data[category] || [])
      .filter((r) => !r.retired && r.meta?.parent_key === parentKey),
    // Ticket statuses, narrowed to whichever ones a given ticket_category is
    // allowed to use (meta.excluded_categories — empty/absent means every
    // category, e.g. Not Started/In Progress/Done; Shipping's the first
    // category that's actually restricted — see NOTES.md). A denylist
    // rather than an allowlist so a category added later in Settings
    // automatically keeps every status that hasn't specifically excluded
    // it (N4a — see backend/src/services/settings.js's
    // statusAppliesToCategory, which this mirrors).
    // is_shipping (migration 028) narrows this further for shipping
    // sub-tickets — see backend/src/services/settings.js's
    // statusAppliesToCategory, which this mirrors. Optional/defaulted so
    // every other call site (which has no is_shipping to pass) keeps
    // working unchanged.
    statusesForCategory: (s) => (categoryKey, isShipping = false) => (s.data.ticket_status || [])
      .filter((r) => {
        if (r.retired) return false;
        const excluded = r.meta?.excluded_categories;
        if (Array.isArray(excluded) && excluded.includes(categoryKey)) return false;
        if (isShipping && r.meta?.excluded_for_shipping) return false;
        return true;
      }),
    labelFor: (s) => (category, key) => (s.data[category] || []).find((r) => r.key === key)?.label || key,
    colorFor: (s) => (key) => (s.data.ticket_status || []).find((r) => r.key === key)?.meta?.color || 'slate',
    // Whether a ticket sitting in this status should have its tasks show
    // up on anyone's dashboard (Settings -> Ticket statuses' "Unlocks
    // tasks" checkbox, meta.unlocks_tasks — migration 022, NOTES.md
    // §2.28). Admin-configurable per status rather than a hardcoded key,
    // same reasoning as every other status-driven behavior here.
    unlocksTasks: (s) => (key) => !!(s.data.ticket_status || []).find((r) => r.key === key)?.meta?.unlocks_tasks,
    // TicketSubTickets.vue's "Ship this instrument" quick-action — a
    // Settings -> Ticket categories toggle per category (meta.hide_ship_button),
    // e.g. a Shipping-category ticket has no business offering to spin off
    // *another* shipping ticket. Absent/false meta means "shown," same
    // default-is-permissive convention as excluded_categories above, so
    // every category already behaves exactly as it does today until an
    // admin explicitly turns one off.
    shipButtonAllowed: (s) => (categoryKey) => (
      !(s.data.ticket_category || []).find((r) => r.key === categoryKey)?.meta?.hide_ship_button
    ),
    // TicketDetailView.vue's "Status notes" section (Service done / Service
    // needed) — another Settings -> Ticket categories per-category toggle,
    // same meta-on-the-category-row mechanism as shipButtonAllowed just
    // above, but opposite default: a brand-new field starts OFF everywhere
    // until an admin opts a category in, rather than starting on and being
    // opted out.
    statusNotesAllowed: (s) => (categoryKey) => (
      !!(s.data.ticket_category || []).find((r) => r.key === categoryKey)?.meta?.show_status_notes
    ),
  },
  actions: {
    async load(force = false) {
      if (this.loaded && !force) return;
      this.data = await api.get('/settings');
      this.loaded = true;
    },
  },
});

export const useRefData = defineStore('refdata', {
  state: () => ({ employees: [], families: [], familyLabels: {}, loaded: false }),
  actions: {
    async load(force = false) {
      if (this.loaded && !force) return;
      const [employees, families, familyLabels] = await Promise.all([
        api.get('/employees'),
        api.get('/instruments/families'),
        api.get('/instruments/family-labels'),
      ]);
      this.employees = employees;
      this.families = families;
      this.familyLabels = familyLabels;
      this.loaded = true;
    },
    // N7 (boss-list scope, scaffold): falls back to the raw key so callers
    // never have to guard against familyLabels still being empty (e.g. a
    // component that renders before load() resolves).
    familyLabel(key) {
      return this.familyLabels[key] || key;
    },
  },
});


const KIOSK_STORAGE_KEY = 'cepco_kiosk_mode';
const IDLE_MS = 5 * 60 * 1000; // 5 minutes of inactivity before the picker shows

// Plain module-level (non-reactive) timer bookkeeping — a setTimeout handle
// and a throttle timestamp have no business being Vue-reactive state.
let idleTimer = null;
let lastActivityAt = 0;

/**
 * Kiosk ("shared computer") mode — a per-*browser* preference, not a
 * shop-wide setting (see NOTES.md §2.12). Deliberately localStorage-only:
 * it describes this device, not this account, so it survives sign-out/
 * sign-in and doesn't follow a staff member to their own laptop.
 */
export const useKiosk = defineStore('kiosk', {
  state: () => ({
    enabled: typeof localStorage !== 'undefined' && localStorage.getItem(KIOSK_STORAGE_KEY) === '1',
    locked: false,
  }),
  actions: {
    setEnabled(value) {
      this.enabled = !!value;
      localStorage.setItem(KIOSK_STORAGE_KEY, this.enabled ? '1' : '0');
      if (this.enabled) this.armTimer();
      else this.disarmTimer();
    },
    lock() {
      this.disarmTimer();
      this.locked = true;
    },
    unlock() {
      this.locked = false;
      this.armTimer();
    },
    /** Call on any real user interaction. Cheap to call often — throttled internally. */
    recordActivity() {
      if (!this.enabled || this.locked) return;
      const now = Date.now();
      if (now - lastActivityAt < 1000) return;
      lastActivityAt = now;
      this.armTimer();
    },
    armTimer() {
      this.disarmTimer();
      if (!this.enabled) return;
      idleTimer = setTimeout(() => { this.locked = true; }, IDLE_MS);
    },
    disarmTimer() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    },
    /** Called on sign-out — no active session means nothing to idle-lock. */
    reset() {
      this.disarmTimer();
      this.locked = false;
    },
  },
});
