import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from './stores';

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
  // Tickets + Queue merged into one page (NOTES.md §2.27) — the queue view
  // is the canonical list now, /tickets just redirects here (keeping the
  // query string, e.g. DashboardView.vue's status-filtered links).
  { path: '/tickets', redirect: (to) => ({ path: '/queue', query: to.query }) },
  { path: '/tickets/new', name: 'ticket-new', component: () => import('./views/TicketNewView.vue') },
  { path: '/queue', name: 'queue', component: () => import('./views/QueueView.vue') },
  { path: '/tickets/:id', name: 'ticket', component: () => import('./views/TicketDetailView.vue'), props: true },
  { path: '/estimates', name: 'estimates', component: () => import('./views/EstimatesView.vue') },
  { path: '/estimates/new', name: 'estimate-new', component: () => import('./views/EstimateNewView.vue') },
  { path: '/estimates/:id', name: 'estimate', component: () => import('./views/EstimateDetailView.vue'), props: true },
  { path: '/progress-updates', name: 'progress-updates', component: () => import('./views/ProgressUpdatesView.vue') },
  {
    path: '/progress-updates/:id', name: 'progress-update',
    component: () => import('./views/ProgressUpdateDetailView.vue'), props: true,
  },
  { path: '/customers', name: 'customers', component: () => import('./views/CustomersView.vue') },
  { path: '/fleet', name: 'fleet', component: () => import('./views/FleetView.vue') },
  { path: '/inventory', name: 'inventory', component: () => import('./views/InventoryRestorationsView.vue') },
  { path: '/inventory/new', name: 'inventory-purchase-new', component: () => import('./views/InventoryPurchaseNewView.vue') },
  { path: '/fleet/calendar', name: 'fleet-calendar', component: () => import('./views/RentalCalendarView.vue') },
  { path: '/parts', name: 'parts', component: () => import('./views/PartsView.vue') },
  { path: '/hours', name: 'hours', component: () => import('./views/HoursView.vue') },
  { path: '/ceppys', name: 'ceppys', component: () => import('./views/CeppysView.vue') },
  { path: '/account', name: 'account', component: () => import('./views/AccountView.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { admin: true } },
  { path: '/settings/qc-templates', name: 'qc-templates', component: () => import('./views/QcTemplatesView.vue'), meta: { admin: true } },
  { path: '/settings/procedures', name: 'procedures', component: () => import('./views/ProceduresView.vue'), meta: { admin: true } },
  {
    path: '/settings/instrument-defaults', name: 'instrument-defaults',
    component: () => import('./views/InstrumentDefaultsView.vue'), meta: { admin: true },
  },
  {
    path: '/settings/recurring-tickets', name: 'recurring-tickets',
    component: () => import('./views/RecurringTicketsView.vue'), meta: { admin: true },
  },
  {
    path: '/settings/instrument-models', name: 'instrument-models',
    component: () => import('./views/InstrumentModelsView.vue'), meta: { admin: true },
  },
  // Public: opened from the confirm/decline link in a customer-quote
  // email (backend/src/templates/quoteEmail.js). `alwaysPublic` keeps the
  // guard below from bouncing a *signed-in* employee previewing their own
  // link back to the dashboard the way every other `meta.public` route does.
  {
    path: '/quote/:token', name: 'quote-confirm',
    component: () => import('./views/QuoteConfirmView.vue'),
    props: true, meta: { public: true, alwaysPublic: true },
  },
  // Public: opened from the "View full progress update" link in a
  // progress-update email (backend/src/templates/progressUpdateEmail.js).
  // Same alwaysPublic reasoning as /quote/:token above.
  {
    path: '/progress-update/:token', name: 'progress-update-view',
    component: () => import('./views/ProgressUpdatePublicView.vue'),
    props: true, meta: { public: true, alwaysPublic: true },
  },
  // Legacy alias — pre-rename (NOTES.md, migration 046) emails already
  // sent to customers link to /status-report/:token. Those links live in
  // real inboxes indefinitely, so this path keeps resolving to the same
  // (renamed) public view rather than 404ing on an old email.
  {
    path: '/status-report/:token', name: 'status-report-view-legacy',
    component: () => import('./views/ProgressUpdatePublicView.vue'),
    props: true, meta: { public: true, alwaysPublic: true },
  },
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
  if (to.meta.public && auth.signedIn && !to.meta.alwaysPublic) return { name: 'dashboard' };
  if (to.meta.admin && !auth.isAdmin) return { name: 'dashboard' };
  return true;
});

export default router;
