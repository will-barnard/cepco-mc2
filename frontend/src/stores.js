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
    labelFor: (s) => (category, key) => (s.data[category] || []).find((r) => r.key === key)?.label || key,
    colorFor: (s) => (key) => (s.data.ticket_status || []).find((r) => r.key === key)?.meta?.color || 'slate',
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
