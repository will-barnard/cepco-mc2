<script setup>
import { onMounted, watch } from 'vue';
import { RouterView, RouterLink, useRouter } from 'vue-router';
import { useAuth, useSettings, useRefData } from './stores';

const auth = useAuth();
const settings = useSettings();
const refData = useRefData();
const router = useRouter();

// Reference data is only fetchable once signed in, and must be refetched after
// a re-login (different account, possibly different permissions).
watch(() => auth.signedIn, (signedIn) => {
  if (signedIn) {
    settings.load(true);
    refData.load(true);
  }
}, { immediate: true });

onMounted(() => { if (!auth.ready) auth.load(); });

async function signOut() {
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="app-shell">
    <header v-if="auth.signedIn" class="topbar">
      <RouterLink to="/" class="brand">
        Mission Control
        <small>Chicago Electric Piano</small>
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
        <span class="muted small">{{ auth.user.name }}</span>
        <button class="small" @click="signOut">Sign out</button>
      </div>
    </header>

    <RouterView v-if="auth.ready" />
    <div v-else class="empty">Loading…</div>
  </div>
</template>
