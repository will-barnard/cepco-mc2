<script setup>
/**
 * Structured customer address (migration 060) -- line 1/2, city, state,
 * ZIP, country -- laid out the way an address is read. Maps one-to-one
 * onto the Xero contact's billing address (services/xeroSync.js), which is
 * what prints on an invoice.
 *
 * v-model is the whole address object (see customerSources.js's
 * blankAddress/addressFrom); fields are edited in place on it, so the
 * parent's own ref sees every keystroke without an emit per field.
 */
defineProps({
  modelValue: { type: Object, required: true },
});
</script>

<template>
  <div class="address-fields">
    <div class="field">
      <label>Street address</label>
      <input v-model="modelValue.address_line1" autocomplete="address-line1" placeholder="123 Main St" />
    </div>
    <div class="field">
      <label>Apt / suite / line 2</label>
      <input v-model="modelValue.address_line2" autocomplete="address-line2" />
    </div>
    <div class="field-row">
      <div class="field">
        <label>City</label>
        <input v-model="modelValue.city" autocomplete="address-level2" />
      </div>
      <div class="field">
        <label>State</label>
        <input v-model="modelValue.region" autocomplete="address-level1" placeholder="TX" />
      </div>
      <div class="field">
        <label>ZIP</label>
        <input v-model="modelValue.postal_code" autocomplete="postal-code" />
      </div>
      <div class="field">
        <label>Country</label>
        <input v-model="modelValue.country" autocomplete="country-name" placeholder="USA" />
      </div>
    </div>
  </div>
</template>
