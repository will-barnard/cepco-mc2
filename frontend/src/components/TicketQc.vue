<script setup>
/**
 * QC rounds (PLAN §6). Phase 1 runs one round at Standard tier; the same UI
 * covers Phase 2's two-round / two-reviewer requirement, because the rule lives
 * in the qc_tier settings row rather than in this component.
 */
import { ref, computed, onMounted } from 'vue';
import api from '../api';
import { useAuth, useSettings } from '../stores';

const props = defineProps({
  ticket: { type: Object, required: true },
});
const emit = defineEmits(['changed']);

const auth = useAuth();
const settings = useSettings();

const templates = ref([]);
const tierKey = ref('standard');
const templateId = ref('');
const error = ref('');
const busy = ref(false);

const checks = computed(() => props.ticket.qc_checks || []);

onMounted(async () => {
  templates.value = await api.get('/qc/templates', {
    family: props.ticket.instrument_family || '',
    kind: 'qc',
  });
  if (templates.value.length) templateId.value = templates.value[0].id;
});

async function startRound() {
  error.value = '';
  busy.value = true;
  try {
    await api.post('/qc/checks', {
      ticket_id: props.ticket.id,
      tier_key: tierKey.value,
      template_id: templateId.value || null,
    });
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function saveNotes(check, value) {
  try {
    await api.patch(`/qc/checks/${check.id}`, { notes: value });
  } catch (err) {
    error.value = err.message;
  }
}

async function signOff(check, passed) {
  error.value = '';
  busy.value = true;
  try {
    const result = await api.post(`/qc/checks/${check.id}/sign-off`, { passed });
    if (!result.ticket_qc_passed && passed) {
      error.value = `Round signed off. Ticket still needs `
        + `${result.rounds_required - result.rounds_passed} more passing round(s)`
        + `${result.distinct_reviewers_required ? ' from a second reviewer' : ''}.`;
    }
    emit('changed');
  } catch (err) {
    // (No more "N items still incomplete" case — sign-off no longer gates
    // on checklist completion now that items aren't checkable.)
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Quality control</h2>
      <div class="spacer" />
      <span v-if="ticket.qc_passed_at" class="pill green">QC passed</span>
      <span v-else-if="!ticket.qc_required" class="pill slate">QC not required</span>
      <span v-else class="pill amber">QC outstanding</span>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-for="check in checks" :key="check.id" class="card tight" style="margin-bottom: 12px">
      <div class="row">
        <strong>Round {{ check.round_number }}</strong>
        <span class="tag">{{ check.tier_label || check.tier_key }}</span>
        <span class="muted small">{{ check.results.length }} item(s)</span>
        <div class="spacer" />
        <span v-if="check.signed_off_at" :class="['pill', check.passed ? 'green' : 'red']">
          {{ check.passed ? 'Passed' : 'Failed' }} — {{ check.reviewer_name }}
        </span>
      </div>

      <!-- Reference checklist — items are display-only now (no per-item
           checkboxes); the tech records what they actually found in the
           notes field below instead. Laid out in three columns so a
           longer template doesn't turn into a tall scroll. -->
      <ul class="qc-checklist" style="margin-top: 10px">
        <li v-for="(r, i) in check.results" :key="i">
          {{ r.label }}
          <span v-if="r.note" class="item-note">{{ r.note }}</span>
        </li>
      </ul>

      <template v-if="!check.signed_off_at">
        <div class="field" style="margin-top: 12px">
          <label>Notes</label>
          <textarea
            :value="check.notes" style="min-height: 110px"
            placeholder="What did you check, and what did you find?"
            @change="saveNotes(check, $event.target.value)"
          />
        </div>
        <div v-if="auth.isSenior" class="row">
          <button class="primary" :disabled="busy" @click="signOff(check, true)">
            Sign off as passed
          </button>
          <button :disabled="busy" @click="signOff(check, false)">Fail this round</button>
        </div>
        <p v-else class="muted small">Sign-off requires senior tech or admin.</p>
      </template>
      <p v-else-if="check.notes" class="muted small" style="margin: 8px 0 0">{{ check.notes }}</p>
    </div>

    <div class="card tight">
      <h3>Start a new QC round</h3>
      <div class="field-row">
        <div>
          <label>Rigor tier</label>
          <select v-model="tierKey">
            <option v-for="t in settings.active('qc_tier')" :key="t.key" :value="t.key">
              {{ t.label }}
            </option>
          </select>
        </div>
        <div>
          <label>Checklist template</label>
          <select v-model="templateId">
            <option value="">— blank —</option>
            <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>
      </div>
      <button :disabled="busy" @click="startRound">Start round {{ checks.length + 1 }}</button>
    </div>
  </div>
</template>
