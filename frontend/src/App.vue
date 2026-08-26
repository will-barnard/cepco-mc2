<script setup>
import { onMounted, onBeforeUnmount, watch } from 'vue';
import { RouterView, RouterLink, useRouter } from 'vue-router';
import { useAuth, useSettings, useRefData, useKiosk } from './stores';
import UserSwitcher from './components/UserSwitcher.vue';
import logoUrl from './assets/cepco-logo-light.png';

const auth = useAuth();
const settings = useSettings();
const refData = useRefData();
const kiosk = useKiosk();
const router = useRouter();

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
    <header v-if="auth.signedIn" class="topbar">
      <RouterLink to="/" class="brand">
        <img :src="logoUrl" alt="Chicago Electric Piano Company" class="brand-logo" />
        <span class="brand-text">Mission Control</span>
      </RouterLink>

      <nav>
        <RouterLink to="/">Dashboard</RouterLink>
        <RouterLink to="/tickets">Tickets</RouterLink>
        <RouterLink to="/customers">Customers</RouterLink>
        <RouterLink to="/fleet">Fleet</RouterLink>
        <RouterLink to="/parts">Parts</RouterLink>
        <RouterLink to="/hours">Hours</RouterLink>
        <RouterLink v-if="auth.isAdmin" to="/settings">Settings</RouterLink>
      </nav>

      <div class="row nowrap">
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
