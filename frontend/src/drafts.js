/**
 * Unsaved-draft autosave (kiosk feedback, Oct 2026).
 *
 * A tech walked away from the shared shop computer mid-note, kiosk mode
 * idle-locked after 5 minutes (stores.js useKiosk), and everything they'd
 * typed was gone by the time they got back. The overlay itself never
 * unmounts the page (UserSwitcher.vue), but anything that *does* --
 * someone else switching in (App.vue keys the RouterView on the user id),
 * a refresh, the browser crashing, navigating away -- throws the in-memory
 * form state away. This keeps a copy of it in localStorage so it comes
 * back the next time the same person opens the same form.
 *
 * Deliberately browser-local, not a server table: the only failure being
 * fixed here is "this browser lost it", drafts are throwaway by nature,
 * and it keeps every form's existing save path exactly as it was. The
 * cost is that a draft doesn't follow someone to a different computer.
 *
 * Keys are `mc2_draft:<userId>:<formKey>` -- scoped per *person*, so on a
 * shared kiosk one tech's half-written note never appears in another
 * tech's composer. Drafts older than DRAFT_MAX_AGE_MS are pruned.
 *
 * Usage, simplest case (a form that starts out blank):
 *
 *   const body = ref('');
 *   const bodyDraft = useDraft(() => `ticket-note:${props.ticket.id}`, body);
 *   // ...after a successful save, once the field has been reset:
 *   bodyDraft.clear();
 *
 * Fields that edit a value loaded from the server pass { manual: true,
 * requireSameBase: true } and call draft.start() once that value is in
 * place. requireSameBase only restores a draft if the server value is
 * still exactly what it was when the draft was started -- if someone else
 * has saved a change since, their version wins and the stale draft is
 * dropped rather than silently overwriting it.
 *
 * Forms whose state can't just be assigned back (watchers that reset
 * dependent fields, lists that need re-fetching first) pass their own
 * { get, set } -- see NewTicketForm.vue / EstimateNewView.vue.
 *
 * Not covered: file inputs / photos (a File can't be serialized), and
 * fields that already save themselves on blur (@change) -- tapping
 * anything on the kiosk overlay blurs them, so they save before a switch.
 */
import { ref, unref, isRef, watch, onBeforeUnmount, getCurrentInstance } from 'vue';
import { useAuth } from './stores';

export const DRAFT_PREFIX = 'mc2_draft:';
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WRITE_DELAY_MS = 400;

// Every storage touch is wrapped: private windows, a full quota, or
// storage disabled entirely must never break the form the draft is for.
function store() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}
export function readDraft(storageKey) {
  try {
    const raw = store()?.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export function writeDraft(storageKey, entry) {
  try { store()?.setItem(storageKey, JSON.stringify(entry)); } catch { /* best effort */ }
}
export function removeDraft(storageKey) {
  try { store()?.removeItem(storageKey); } catch { /* best effort */ }
}
export function draftStorageKey(userId, formKey) {
  return userId != null && formKey ? `${DRAFT_PREFIX}${userId}:${formKey}` : null;
}

/** Drop expired or unreadable drafts. Cheap; runs once per page load. */
export function pruneDrafts(now = Date.now()) {
  const s = store();
  if (!s) return;
  try {
    const keys = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k && k.startsWith(DRAFT_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const entry = readDraft(k);
      if (!entry || typeof entry.at !== 'number' || now - entry.at > DRAFT_MAX_AGE_MS) removeDraft(k);
    }
  } catch { /* best effort */ }
}
pruneDrafts();

/**
 * @param {string|(() => string|null)} key  form key; a getter re-targets the
 *   draft when it changes (e.g. the ticket id under a still-mounted view).
 *   Returning null/'' pauses drafting.
 * @param {import('vue').Ref|object|null} target  a ref or reactive object
 *   holding the form state (ignored when get/set are given).
 * @param {object} [options]
 * @param {() => any} [options.get]  snapshot the state (must be JSON-safe)
 * @param {(value: any) => void|Promise<void>} [options.set]  put a snapshot back
 * @param {boolean} [options.manual]  don't start until start() is called
 * @param {boolean} [options.requireSameBase]  see the header comment
 */
export function useDraft(key, target, options = {}) {
  const auth = useAuth();
  const keyOf = typeof key === 'function' ? key : () => key;
  const get = options.get || (() => unref(target));
  const set = options.set || ((value) => {
    if (isRef(target)) target.value = value;
    else Object.assign(target, value);
  });

  /** When the restored draft was last written, or null if nothing was restored. */
  const restoredAt = ref(null);

  // { storageKey, base } -- base is the JSON of the state when drafting
  // started (blank form / freshly loaded server value). Matching it again
  // means there's nothing unsaved, so the stored copy is removed.
  let active = null;
  let timer = null;
  let applying = false;

  const snapshot = () => {
    try { return JSON.stringify(get() ?? null); } catch { return null; }
  };

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!active) return;
    const current = snapshot();
    if (current == null) return;
    if (current === active.base) removeDraft(active.storageKey);
    else writeDraft(active.storageKey, { v: JSON.parse(current), base: active.base, at: Date.now() });
  }

  function schedule() {
    if (!active || applying) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, WRITE_DELAY_MS);
  }

  /**
   * Begin drafting under the current key: records the current state as the
   * baseline, then restores a saved draft if there is one. Resolves true
   * when something was restored.
   */
  async function start() {
    flush();
    restoredAt.value = null;
    // The user id is captured here, not at write time: after a kiosk
    // switch auth.user is already the *next* person by the time the
    // outgoing view's unmount flush runs.
    const storageKey = draftStorageKey(auth.user?.id, keyOf());
    if (!storageKey) { active = null; return false; }
    const base = snapshot();
    active = { storageKey, base };

    const saved = readDraft(storageKey);
    if (!saved || !('v' in saved)) return false;
    const stale = Date.now() - saved.at > DRAFT_MAX_AGE_MS;
    const conflicted = options.requireSameBase && saved.base !== base;
    if (stale || conflicted || JSON.stringify(saved.v) === base) {
      removeDraft(storageKey);
      return false;
    }

    applying = true;
    try {
      await set(JSON.parse(JSON.stringify(saved.v)));
    } finally {
      applying = false;
    }
    // A key change (or clear()) while an async set() was in flight means
    // this restore no longer applies to what's on screen.
    if (!active || active.storageKey !== storageKey) return false;
    restoredAt.value = saved.at;
    return true;
  }

  /** Call after a successful save, once the form shows its post-save state. */
  function clear() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (active) {
      removeDraft(active.storageKey);
      active.base = snapshot();
    }
    restoredAt.value = null;
  }

  /**
   * The server value underneath changed while a draft may be open (e.g. a
   * "pull from ticket" refresh) -- move the baseline without touching what's
   * on screen, so requireSameBase compares against the new server value.
   */
  function rebase(value) {
    if (!active) return;
    active.base = JSON.stringify(value ?? null);
    flush();
  }

  /**
   * Stop drafting entirely and forget the stored copy -- for a form that
   * has already created something server-side and must not be restorable
   * into a duplicate submit. start() resumes.
   */
  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (active) removeDraft(active.storageKey);
    active = null;
    restoredAt.value = null;
  }

  /** Throw away a restored draft and put the form back to its baseline. */
  async function discard() {
    if (!active) return;
    const base = active.base;
    if (timer) { clearTimeout(timer); timer = null; }
    removeDraft(active.storageKey);
    restoredAt.value = null;
    if (base == null) return;
    applying = true;
    try {
      await set(JSON.parse(base));
    } finally {
      applying = false;
    }
    clear();
  }

  watch(snapshot, schedule);

  watch(keyOf, (next, prev) => {
    if (next === prev) return;
    if (options.manual) {
      // The new record's value isn't loaded yet -- persist the old one and
      // wait for the component to call start() again.
      flush();
      active = null;
      restoredAt.value = null;
    } else {
      start();
    }
  });

  if (!options.manual) start();

  if (getCurrentInstance()) {
    const onPageHide = () => flush();
    window.addEventListener('pagehide', onPageHide);
    onBeforeUnmount(() => {
      window.removeEventListener('pagehide', onPageHide);
      flush();
    });
  }

  return { restoredAt, start, clear, discard, flush, rebase, stop };
}
