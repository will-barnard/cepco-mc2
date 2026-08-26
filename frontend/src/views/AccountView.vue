<script setup>
import { ref } from 'vue';
import api from '../api';
import { useAuth, useKiosk } from '../stores';

const auth = useAuth();
const kiosk = useKiosk();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);

// Switch-in PIN (kiosk mode) — only admins are ever asked for this, since
// junior/senior staff switch in with no credential on a shared computer.
const pinCurrentPassword = ref('');
const newPin = ref('');
const confirmPin = ref('');
const pinError = ref('');
const pinNotice = ref('');
const pinBusy = ref(false);

async function submitPin() {
  pinError.value = '';
  pinNotice.value = '';

  if (!/^\d{4}$/.test(newPin.value)) {
    pinError.value = 'PIN must be exactly 4 digits';
    return;
  }
  if (newPin.value !== confirmPin.value) {
    pinError.value = 'PIN and confirmation do not match';
    return;
  }

  pinBusy.value = true;
  try {
    await auth.setPin(pinCurrentPassword.value, newPin.value);
    pinNotice.value = 'PIN set.';
    pinCurrentPassword.value = '';
    newPin.value = '';
    confirmPin.value = '';
  } catch (err) {
    pinError.value = err.message;
  } finally {
    pinBusy.value = false;
  }
}

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

    <div v-if="auth.isAdmin" class="card" style="margin-top: 24px">
      <h2>Shared computer</h2>
      <p class="muted small">
        Turns this browser into a kiosk: after 5 minutes idle (or any time via
        "Switch user" next to Sign out) it shows a picker so staff can switch
        identities without your password. Switching into another admin still
        needs that admin's PIN below. This is a setting for this device, not
        your account — it won't follow you to a different computer.
      </p>
      <label class="checkbox" style="margin-top: 12px">
        <input
          type="checkbox" :checked="kiosk.enabled"
          @change="kiosk.setEnabled($event.target.checked)"
        />
        <span>This is a shared computer</span>
      </label>
    </div>

    <div v-if="auth.isAdmin" class="card" style="margin-top: 24px">
      <h2>Switch-in PIN</h2>
      <p class="muted small">
        Required before anyone can switch into your account from a shared
        computer's picker screen.
      </p>

      <form @submit.prevent="submitPin">
        <div class="field">
          <label for="pin-current-password">Current password</label>
          <input
            id="pin-current-password" v-model="pinCurrentPassword" type="password"
            autocomplete="current-password" required
          />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="new-pin">New 4-digit PIN</label>
            <input
              id="new-pin" v-model="newPin" type="password" inputmode="numeric"
              pattern="[0-9]*" maxlength="4" autocomplete="off" required
            />
          </div>
          <div class="field">
            <label for="confirm-pin">Confirm PIN</label>
            <input
              id="confirm-pin" v-model="confirmPin" type="password" inputmode="numeric"
              pattern="[0-9]*" maxlength="4" autocomplete="off" required
            />
          </div>
        </div>

        <div v-if="pinError" class="alert" style="margin-bottom: 14px">{{ pinError }}</div>
        <div v-if="pinNotice" class="alert ok" style="margin-bottom: 14px">{{ pinNotice }}</div>

        <button class="primary" type="submit" :disabled="pinBusy">
          {{ pinBusy ? 'Saving…' : 'Set PIN' }}
        </button>
      </form>
    </div>
  </div>
</template>
