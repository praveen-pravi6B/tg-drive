<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps({
  variant: { type: String, default: 'primary' },
  size: { type: String, default: 'md' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
})

const variants = {
  primary:
    'bg-primary text-primary-foreground shadow-glow hover:bg-primary/90 active:bg-primary/80',
  secondary: 'bg-accent text-accent-foreground hover:bg-accent/80',
  outline: 'border border-border bg-transparent hover:bg-accent/60',
  ghost: 'bg-transparent hover:bg-accent/60',
  danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  subtle: 'bg-white/5 text-foreground hover:bg-white/10',
}

const sizes = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
  icon: 'h-9 w-9 text-sm',
}

const classes = computed(() =>
  cn(
    'inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors focus-ring disabled:pointer-events-none disabled:opacity-50',
    variants[props.variant] || variants.primary,
    sizes[props.size] || sizes.md,
  ),
)
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
  >
    <svg
      v-if="loading"
      class="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-opacity="0.25"
        stroke-width="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
      />
    </svg>
    <slot />
  </button>
</template>
