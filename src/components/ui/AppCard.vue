<script setup>
import { cn } from '@/lib/utils'

defineProps({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  padded: { type: Boolean, default: true },
})
</script>

<template>
  <section class="glass rounded-xl">
    <header
      v-if="title || description || $slots.header"
      class="flex items-start justify-between gap-4 border-b border-white/5 px-5 py-4"
    >
      <slot name="header">
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold tracking-tight">
            {{ title }}
          </h2>
          <p
            v-if="description"
            class="mt-0.5 text-xs text-muted-foreground"
          >
            {{ description }}
          </p>
        </div>
      </slot>
      <slot name="actions" />
    </header>
    <div :class="cn(padded && 'p-5')">
      <slot />
    </div>
    <footer
      v-if="$slots.footer"
      class="border-t border-white/5 px-5 py-3"
    >
      <slot name="footer" />
    </footer>
  </section>
</template>
