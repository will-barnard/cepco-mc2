<script setup>
import { ref } from 'vue';
import api from '../api';
import { useAuth } from '../stores';

const auth = useAuth();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  notice.value = '';

  if (newPassword.value.length < 10) {
    error.value = 'New password must be at least 10 characters';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'New password and confirmation do not match';
    return;
  }

  busy.value = true;
  try {
    await api.post('/auth/change-password', {
      current_password: currentPassword.value,
      new_password: newPassword.value,
    });
    notice.value = 'Password changed.';
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 480px">
    <div class="page-head">
      <h1>Account</h1>
    </div>

    <div class="card" style="margin-bottom: 24px">
      <h2>Signed in as</h2>
      <p class="muted" style="margin: 0">
        {{ auth.user.name }} &lt;{{ auth.user.email }}&gt;
        <span class="tag" style="margin-left: 6px">{{ auth.user.role }}</span>
      </p>
    </div>

    <div class="card">
      <h2>Change password</h2>

      <form @submit.prevent="submit">
        <div class="field">
          <label for="current-password">Current password</label>
          <input
            id="current-password" v-model="currentPassword" type="password"
            autocomplete="current-password" required
          />
        </div>
        <div class="field">
          <label for="new-password">New password (min 10 characters)</label>
          <input
            id="new-password" v-model="newPassword" type="password" minlength="10"
            autocomplete="new-password" required
          />
        </div>
        <div class="field">
          <label for="confirm-password">Confirm new password</label>
          <input
            id="confirm-password" v-model="confirmPassword" type="password" minlength="10"
            autocomplete="new-password" required
          />
        </div>

        <div v-if="error" class="alert" style="margin-bottom: 14px">{{ error }}</div>
        <div v-if="notice" class="alert ok" style="margin-bottom: 14px">{{ notice }}</div>

        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? 'Changing…' : 'Change password' }}
        </button>
      </form>
    </div>
  </div>
</template>
