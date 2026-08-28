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
    priorities: (s) => s.data.priority_tier || [],
    qcTiers: (s) => s.data.qc_tier || [],
    techLevels: (s) => s.data.tech_level || [],
    active: (s) => (category) => (s.data[category] || []).filter((r) => !r.retired),
    // Ticket statuses, narrowed to whichever ones a given ticket_category is
    // allowed to use (meta.applicable_categories — empty/absent means every
    // category, e.g. Not Started/In Progress/Done; Shipping's the first
    // category that's actually restricted — see NOTES.md).
    statusesForCategory: (s) => (categoryKey) => (s.data.ticket_status || []).filter((r) => {
      if (r.retired) return false;
      const allowed = r.meta?.applicable_categories;
      return !Array.isArray(allowed) || allowed.length === 0 || allowed.includes(categoryKey);
    }),
    labelFor: (s) => (category, key) => (s.data[category] || []).find((r) => r.key === key)?.label || key,
    colorFor: (s) => (key) => (s.data.ticket_status || []).find((r) => r.key === key)?.meta?.color || 'slate',
    // TicketSubTickets.vue's "Ship this instrument" quick-action — a
    // Settings -> Ticket categories toggle per category (meta.hide_ship_button),
    // e.g. a Shipping-category ticket has no business offering to spin off
    // *another* shipping ticket. Absent/false meta means "shown," same
    // default-is-permissive convention as applicable_categories above, so
    // every category already behaves exactly as it does today until an
    // admin explicitly turns one off.
    shipButtonAllowed: (s) => (categoryKey) => (
      !(s.data.ticket_category || []).find((r) => r.key === categoryKey)?.meta?.hide_ship_button
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
  state: () => ({ employees: [], families: [], loaded: false }),
  actions: {
    async load(force = false) {
      if (this.loaded && !force) return;
      const [employees, families] = await Promise.all([
        api.get('/employees'),
        api.get('/instruments/families'),
      ]);
      this.employees = employees;
      this.families = families;
      this.loaded = true;
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
