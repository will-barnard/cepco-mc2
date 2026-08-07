<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuth } from '../stores';
import logoUrl from '../assets/cepco-logo-light-lg.png';

const auth = useAuth();
const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await auth.login(email.value, password.value);
    router.push(route.query.next || '/');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 400px; padding-top: 10vh">
    <img
      :src="logoUrl" alt="Chicago Electric Piano Company"
      style="width: 100%; max-width: 340px; height: auto; display: block"
    />
    <h1 style="margin-top: 20px">Mission Control</h1>

    <form class="card" style="margin-top: 20px" @submit.prevent="submit">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" v-model="email" type="email" autocomplete="username" required />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input
          id="password" v-model="password" type="password"
          autocomplete="current-password" required
        />
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 14px">{{ error }}</div>

      <button class="primary" type="submit" :disabled="busy" style="width: 100%">
        {{ busy ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </div>
</template>
