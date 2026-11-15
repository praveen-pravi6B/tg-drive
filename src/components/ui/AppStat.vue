<script setup>
defineProps({
  label: { type: String, default: '' },
  value: { type: [String, Number], default: '' },
  hint: { type: String, default: '' },
})
</script>

<template>
  <div class="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
    <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
      {{ label }}
    </div>
    <div class="mt-1 truncate text-sm font-medium">
      {{ value }}
    </div>
    <div
      v-if="hint"
      class="mt-0.5 truncate text-[11px] text-muted-foreground"
    >
      {{ hint }}
    </div>
  </div>
</template>
