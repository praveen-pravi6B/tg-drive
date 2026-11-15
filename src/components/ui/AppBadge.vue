<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps({
  tone: { type: String, default: 'neutral' },
  dot: { type: Boolean, default: false },
})

const tones = {
  neutral: 'border-border bg-white/5 text-muted-foreground',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  danger: 'border-red-500/30 bg-red-500/10 text-red-300',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
}

const classes = computed(() => cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', tones[props.tone] || tones.neutral))
</script>

<template>
  <span :class="classes">
    <span
      v-if="dot"
      class="h-1.5 w-1.5 rounded-full bg-current"
    />
    <slot />
  </span>
</template>
