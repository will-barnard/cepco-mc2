<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
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

// "More" nav dropdown: the less-frequently-used links (Fleet, Inventory,
// Parts/Supplies, Hours, Ceppys) tucked behind a single nav item so the
// main row stays short. Same open/close + click-outside/Escape convention
// as the mobile menu just above and QueueView's hide-statuses dropdown.
const moreMenuOpen = ref(false);
const moreMenuEl = ref(null);

function toggleMoreMenu() {
  moreMenuOpen.value = !moreMenuOpen.value;
}
function closeMoreMenu() {
  moreMenuOpen.value = false;
}

// Highlights the "More" toggle itself when the current page is one of the
// links tucked inside it — those pages otherwise have nothing in the
// always-visible row showing they're active. Parts/Supplies lives at
// /new?tab=parts (shared with New Ticket/New Task), so it only counts when
// that tab is the one actually selected.
const MORE_PATHS = ['/fleet', '/inventory', '/hours', '/ceppys'];
const moreActive = computed(() => {
  if (MORE_PATHS.includes(route.path)) return true;
  return route.path === '/new' && route.query.tab === 'parts';
});

function onDocumentClick(event) {
  if (mobileMenuOpen.value && headerEl.value && !headerEl.value.contains(event.target)) {
    closeMobileMenu();
  }
  if (moreMenuOpen.value && moreMenuEl.value && !moreMenuEl.value.contains(event.target)) {
    closeMoreMenu();
  }
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    closeMobileMenu();
    closeMoreMenu();
  }
}

// Covers browser back/forward and any programmatic navigation (e.g.
// signOut()'s router.push below), on top of the nav's own click-to-close.
watch(() => route.fullPath, () => {
  closeMobileMenu();
  closeMoreMenu();
});

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

onMounted(() => {
  if (!auth.ready) {
    auth.load().then(() => {
      // A page refresh restores the session from the server-side cookie
      // before this component (or its watch(() => auth.signedIn, ...)
      // above) ever runs — that watch only fires on a *transition* into
      // signedIn, not on this "already signed in on boot" path, and
      // kiosk.locked always starts false on every store init regardless of
      // prior lock state. Without this, refreshing a kiosk device silently
      // restores whoever was last signed in, skipping the profile-select
      // screen entirely. Only the boot/restore path needs this — an
      // interactive login() or switchTo() never calls auth.load().
      if (auth.signedIn && kiosk.enabled) kiosk.lock();
    });
  }
});

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
        <RouterLink to="/progress-updates">Progress Updates</RouterLink>
        <RouterLink to="/customers">Customers</RouterLink>

        <div class="nav-more" ref="moreMenuEl">
          <button
            type="button" :class="['nav-more-toggle', { active: moreActive }]"
            :aria-expanded="moreMenuOpen ? 'true' : 'false'"
            @click.stop="toggleMoreMenu"
          >
            More <span class="nav-more-caret">{{ moreMenuOpen ? '▴' : '▾' }}</span>
          </button>
          <div v-if="moreMenuOpen" class="nav-more-menu">
            <RouterLink to="/fleet">Fleet</RouterLink>
            <RouterLink to="/inventory">Inventory</RouterLink>
            <RouterLink to="/new?tab=parts">Parts / Supplies</RouterLink>
            <RouterLink to="/hours">Hours</RouterLink>
            <RouterLink to="/ceppys">Ceppys</RouterLink>
          </div>
        </div>

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
