<script setup>
import { useId } from 'vue'
import { cn } from '@/lib/utils'

const model = defineModel({ type: [String, Number], default: '' })

defineProps({
  label: { type: String, default: '' },
  hint: { type: String, default: '' },
  error: { type: String, default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  autocomplete: { type: String, default: 'off' },
  inputmode: { type: String, default: undefined },
  mono: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  min: { type: [String, Number], default: undefined },
  max: { type: [String, Number], default: undefined },
})

const id = useId()
</script>

<template>
  <label
    :for="id"
    class="block space-y-1.5"
  >
    <span
      v-if="label"
      class="text-xs font-medium text-muted-foreground"
    >{{ label }}</span>
    <input
      :id="id"
      v-model="model"
      :type="type"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :disabled="disabled"
      :min="min"
      :max="max"
      :class="
        cn(
          'focus-ring h-10 w-full rounded-lg border border-input bg-background/60 px-3 text-sm text-foreground placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60',
          mono && 'font-mono text-xs',
          error && 'border-destructive/70',
        )
      "
    >
    <span
      v-if="error"
      class="block text-xs text-destructive"
    >{{ error }}</span>
    <span
      v-else-if="hint"
      class="block text-xs text-muted-foreground/80"
    >{{ hint }}</span>
  </label>
</template>
