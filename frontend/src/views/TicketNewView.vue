<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const router = useRouter();
const settings = useSettings();
const refData = useRefData();

const customers = ref([]);
const instruments = ref([]);
const error = ref('');
const busy = ref(false);

const form = ref({
  title: '',
  category_key: 'servicing',
  priority_key: 'standard_setup',
  status_key: '',
  tech_level_key: '',
  customer_id: '',
  instrument_id: '',
  assigned_tech_id: '',
  notes: '',
  drop_off_date: '',
  due_date: '',
  multi_instrument: false,
  qc_required: true,
});

// Creating an instrument inline: retyping a customer's piano into a separate
// screen first is friction nobody will tolerate at intake.
const newInstrument = ref({ enabled: false, family: 'rhodes', model: '', year: '', serial_no: '' });

async function loadCustomerInstruments() {
  form.value.instrument_id = '';
  if (!form.value.customer_id) { instruments.value = []; return; }
  instruments.value = await api.get('/instruments', { customer_id: form.value.customer_id });
}

onMounted(async () => {
  customers.value = await api.get('/customers');
  form.value.status_key = settings.statuses.find((s) => !s.retired)?.key || '';
});

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const payload = { ...form.value };

    if (newInstrument.value.enabled && newInstrument.value.model) {
      const created = await api.post('/instruments', {
        family: newInstrument.value.family,
        model: newInstrument.value.model,
        year: newInstrument.value.year || null,
        serial_no: newInstrument.value.serial_no || null,
        customer_id: form.value.customer_id || null,
      });
      payload.instrument_id = created.id;
    }

    // Blank <select> values are '' — the API wants null.
    for (const k of ['customer_id', 'instrument_id', 'assigned_tech_id', 'tech_level_key',
      'drop_off_date', 'due_date']) {
      if (payload[k] === '') payload[k] = null;
    }

    const ticket = await api.post('/tickets', payload);
    router.push({ name: 'ticket', params: { id: ticket.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 780px">
    <div class="page-head"><h1>New ticket</h1></div>

    <form class="card" @submit.prevent="submit">
      <div class="field">
        <label>Title *</label>
        <input v-model="form.title" required placeholder="e.g. Steve Dawson — Wurlitzer 200A full resto" />
      </div>

      <div class="field-row">
        <div class="field">
          <label>Category *</label>
          <select v-model="form.category_key" required>
            <option v-for="c in settings.active('ticket_category')" :key="c.key" :value="c.key">
              {{ c.label }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>Priority *</label>
          <select v-model="form.priority_key" required>
            <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
              {{ p.label }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>Status</label>
          <select v-model="form.status_key">
            <option v-for="s in settings.active('ticket_status')" :key="s.key" :value="s.key">
              {{ s.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Customer</label>
          <select v-model="form.customer_id" @change="loadCustomerInstruments">
            <option value="">— none (internal / fleet) —</option>
            <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>Instrument</label>
          <select v-model="form.instrument_id" :disabled="newInstrument.enabled">
            <option value="">— none —</option>
            <option v-for="i in instruments" :key="i.id" :value="i.id">
              {{ i.family }} · {{ i.model }}
            </option>
          </select>
        </div>
      </div>

      <div class="field">
        <label class="checkbox">
          <input v-model="newInstrument.enabled" type="checkbox" />
          <span>Add a new instrument instead</span>
        </label>
      </div>

      <div v-if="newInstrument.enabled" class="card tight" style="margin-bottom: 14px">
        <div class="field-row">
          <div class="field">
            <label>Family</label>
            <select v-model="newInstrument.family">
              <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
            </select>
          </div>
          <div class="field">
            <label>Model</label>
            <input v-model="newInstrument.model" placeholder="Wurlitzer 200A" />
          </div>
          <div class="field">
            <label>Year</label>
            <input v-model="newInstrument.year" placeholder="1972" />
          </div>
          <div class="field">
            <label>Serial</label>
            <input v-model="newInstrument.serial_no" />
          </div>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Assign to</label>
          <select v-model="form.assigned_tech_id">
            <option value="">— unassigned —</option>
            <option v-for="e in refData.employees" :key="e.id" :value="e.id">
              {{ e.name }} ({{ e.role }})
            </option>
          </select>
        </div>
        <div class="field">
          <label>Tech level required</label>
          <select v-model="form.tech_level_key">
            <option value="">— any —</option>
            <option v-for="t in settings.active('tech_level')" :key="t.key" :value="t.key">
              {{ t.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Drop-off date</label>
          <input v-model="form.drop_off_date" type="date" />
        </div>
        <div class="field">
          <label>Target date</label>
          <input v-model="form.due_date" type="date" />
        </div>
      </div>

      <div class="field">
        <label>Notes &amp; parts</label>
        <textarea v-model="form.notes" placeholder="Grommets, hammer tips, tune & voice…" />
      </div>

      <div class="field row">
        <label class="checkbox" style="margin: 0">
          <input v-model="form.multi_instrument" type="checkbox" />
          <span>Multi-instrument job</span>
        </label>
        <label class="checkbox" style="margin: 0">
          <input v-model="form.qc_required" type="checkbox" />
          <span>QC required before invoicing</span>
        </label>
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 14px">{{ error }}</div>

      <div class="row">
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? 'Creating…' : 'Create ticket' }}
        </button>
        <button type="button" @click="router.back()">Cancel</button>
      </div>
    </form>
  </div>
</template>
