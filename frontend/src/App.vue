<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { RouterView, RouterLink, useRouter, useRoute } from 'vue-router';
import { useAuth, useSettings, useRefData, useKiosk } from './stores';
import UserSwitcher from './components/UserSwitcher.vue';
import logoUrl from './assets/cepco-logo-light.png';

const auth = useAuth();
const settings = useSettings();
const refData = useRefData();
const kiosk = useKiosk();
const router = useRouter();
const route = useRoute();

// Mobile nav: the topbar's nav + account row collapse behind a hamburger
// button under the .topbar-collapse breakpoint (styles.css) — there are too
// many nav links (11) plus the account row to fit a phone width, so below
// that width they render as a stacked panel instead of the desktop's single
// scrollable-if-needed row. headerEl backs the click-outside handler below.
const mobileMenuOpen = ref(false);
const headerEl = ref(null);

function closeMobileMenu() {
  mobileMenuOpen.value = false;
}

function onDocumentClick(event) {
  if (mobileMenuOpen.value && headerEl.value && !headerEl.value.contains(event.target)) {
    closeMobileMenu();
  }
}

function onKeydown(event) {
  if (event.key === 'Escape') closeMobileMenu();
}

// Covers browser back/forward and any programmatic navigation (e.g.
// signOut()'s router.push below), on top of the nav's own click-to-close.
watch(() => route.fullPath, closeMobileMenu);

// Reference data is only fetchable once signed in, and must be refetched after
// a re-login (different account, possibly different permissions).
watch(() => auth.signedIn, (signedIn) => {
  if (signedIn) {
    settings.load(true);
    refData.load(true);
    if (kiosk.enabled) kiosk.armTimer();
  } else {
    // Nobody signed in (fresh browser, or just signed out) — no session to
    // idle-lock, and kiosk mode itself stays remembered for next time (it's
    // a device preference, not an account one).
    kiosk.reset();
  }
}, { immediate: true });

onMounted(() => { if (!auth.ready) auth.load(); });

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});

// Kiosk mode (§NOTES 2.12): any real interaction resets the 5-minute idle
// clock. The store itself no-ops when kiosk mode is off or already locked,
// so these listeners are cheap to leave attached all the time.
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
function onActivity() {
  if (auth.signedIn) kiosk.recordActivity();
}
onMounted(() => {
  ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, onActivity, { passive: true }));
});
onBeforeUnmount(() => {
  ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, onActivity));
});

async function signOut() {
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="app-shell">
    <header
      v-if="auth.signedIn" ref="headerEl"
      :class="['topbar', { 'menu-open': mobileMenuOpen }]"
    >
      <RouterLink to="/" class="brand">
        <img :src="logoUrl" alt="Chicago Electric Piano Company" class="brand-logo" />
        <span class="brand-text">Mission Control</span>
      </RouterLink>

      <button
        type="button" class="menu-toggle"
        :aria-expanded="mobileMenuOpen ? 'true' : 'false'" aria-label="Toggle navigation menu"
        @click="mobileMenuOpen = !mobileMenuOpen"
      >
        <span /><span /><span />
      </button>

      <nav @click="closeMobileMenu">
        <RouterLink to="/">Dashboard</RouterLink>
        <RouterLink to="/queue">Queue</RouterLink>
        <RouterLink to="/estimates">Estimates</RouterLink>
        <RouterLink to="/status-reports">Status Reports</RouterLink>
        <RouterLink to="/customers">Customers</RouterLink>
        <RouterLink to="/fleet">Fleet</RouterLink>
        <RouterLink to="/inventory">Inventory</RouterLink>
        <RouterLink to="/parts">Parts</RouterLink>
        <RouterLink to="/hours">Hours</RouterLink>
        <RouterLink to="/ceppys">Ceppys</RouterLink>
        <RouterLink v-if="auth.isAdmin" to="/settings">Settings</RouterLink>
      </nav>

      <div class="row nowrap account-row" @click="closeMobileMenu">
        <RouterLink to="/account" class="muted small">{{ auth.user.name }}</RouterLink>
        <button v-if="kiosk.enabled" class="small" @click="kiosk.lock()">Switch user</button>
        <button class="small" @click="signOut">Sign out</button>
      </div>
    </header>

    <RouterView v-if="auth.ready" />
    <div v-else class="empty">Loading…</div>

    <UserSwitcher />
  </div>
</template>
