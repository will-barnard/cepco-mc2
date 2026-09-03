<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth, useKiosk, useRefData } from '../stores';

// The kiosk lock screen. Mounted once, unconditionally, in App.vue — it
// shows itself based on kiosk.locked rather than being toggled by a parent
// v-if, so the RouterView underneath never unmounts (whatever a tech was
// mid-typing survives a lock/switch cycle).

const auth = useAuth();
const kiosk = useKiosk();
const refData = useRefData();
const router = useRouter();

const target = ref(null); // employee currently being switched into (pin step) or null (grid step)
const pin = ref('');
const error = ref('');
const busy = ref(false);
const pinInput = ref(null); // template ref — see the watch(target) below

const roster = computed(() => refData.employees.filter((e) => e.active));

// A static `autofocus` attribute doesn't reliably take effect on an element
// that's toggled into an already-mounted page via v-if (as opposed to one
// present at initial document parse), so focus the PIN input imperatively
// whenever the PIN step is entered — including going grid → PIN → back →
// grid → PIN again for a different admin.
watch(target, (employee) => {
  if (!employee) return;
  nextTick(() => {
    pinInput.value?.focus();
    pinInput.value?.select();
  });
});

function pick(employee) {
  error.value = '';
  if (employee.role === 'admin') {
    target.value = employee;
    pin.value = '';
  } else {
    doSwitch(employee.id);
  }
}

function backToGrid() {
  target.value = null;
  pin.value = '';
  error.value = '';
}

async function doSwitch(employeeId, pinValue) {
  error.value = '';
  busy.value = true;
  try {
    await auth.switchTo(employeeId, pinValue);
    target.value = null;
    pin.value = '';
    kiosk.unlock();
    // Switching accounts on a shared kiosk should land the new person on a
    // known, neutral starting point — not wherever the previous person's
    // browsing happened to leave the RouterView (which never unmounts
    // across a lock/switch cycle).
    router.push({ name: 'dashboard' });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

function submitPin() {
  if (pin.value.length !== 4) {
    error.value = 'PIN must be exactly 4 digits';
    return;
  }
  doSwitch(target.value.id, pin.value);
}

// A manual "Switch user" click can be dismissed with no change; an idle
// timeout can too — nothing destructive has happened either way.
function stayAsIs() {
  target.value = null;
  pin.value = '';
  error.value = '';
  kiosk.unlock();
}
</script>

<template>
  <div v-if="kiosk.locked && auth.signedIn" class="kiosk-overlay">
    <div class="kiosk-panel">
      <button class="link kiosk-dismiss" type="button" @click="stayAsIs">
        Stay signed in as {{ auth.user?.name }}
      </button>

      <template v-if="!target">
        <h1>Who's using this?</h1>
        <p class="muted">Tap your name to switch in.</p>

        <div class="kiosk-grid">
          <button
            v-for="e in roster" :key="e.id" type="button" class="kiosk-tile"
            :disabled="busy" @click="pick(e)"
          >
            <span class="kiosk-avatar">{{ e.initials || e.name.slice(0, 2) }}</span>
            <span class="kiosk-name">{{ e.name }}</span>
            <span v-if="e.role === 'admin'" class="tag">PIN required</span>
          </button>
        </div>

        <div v-if="error" class="alert" style="margin-top: 16px">{{ error }}</div>
      </template>

      <template v-else>
        <h1>Enter PIN</h1>
        <p class="muted">{{ target.name }}</p>

        <form class="stack" style="max-width: 220px; margin: 20px auto 0" @submit.prevent="submitPin">
          <input
            ref="pinInput"
            v-model="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4"
            autofocus placeholder="••••" style="text-align: center; font-size: 24px; letter-spacing: 10px"
          />
          <div v-if="error" class="alert">{{ error }}</div>
          <button class="primary" type="submit" :disabled="busy">
            {{ busy ? 'Checking…' : 'Unlock' }}
          </button>
          <button type="button" @click="backToGrid">Back</button>
        </form>
      </template>
    </div>
  </div>
</template>
