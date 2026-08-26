import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from './stores';

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
  { path: '/tickets', name: 'tickets', component: () => import('./views/TicketsView.vue') },
  { path: '/tickets/new', name: 'ticket-new', component: () => import('./views/TicketNewView.vue') },
  { path: '/tickets/:id', name: 'ticket', component: () => import('./views/TicketDetailView.vue'), props: true },
  { path: '/customers', name: 'customers', component: () => import('./views/CustomersView.vue') },
  { path: '/fleet', name: 'fleet', component: () => import('./views/FleetView.vue') },
  { path: '/fleet/calendar', name: 'fleet-calendar', component: () => import('./views/RentalCalendarView.vue') },
  { path: '/parts', name: 'parts', component: () => import('./views/PartsView.vue') },
  { path: '/hours', name: 'hours', component: () => import('./views/HoursView.vue') },
  { path: '/account', name: 'account', component: () => import('./views/AccountView.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { admin: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.ready) await auth.load();

  if (!to.meta.public && !auth.signedIn) {
    return { name: 'login', query: { next: to.fullPath } };
  }
  if (to.meta.public && auth.signedIn) return { name: 'dashboard' };
  if (to.meta.admin && !auth.isAdmin) return { name: 'dashboard' };
  return true;
});

export default router;
