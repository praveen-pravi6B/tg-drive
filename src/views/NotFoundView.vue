<script setup>
import { RouterLink } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'

defineProps({
  title: { type: String, default: 'Page not found' },
  description: { type: String, default: 'That route does not exist in this build.' },
})
</script>

<template>
  <div class="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-4 px-5 text-center">
    <div class="text-5xl font-semibold tracking-tight text-white/10">
      404
    </div>
    <h1 class="text-lg font-semibold">
      {{ title }}
    </h1>
    <p class="text-sm text-muted-foreground">
      {{ description }}
    </p>
    <RouterLink to="/drive">
      <AppButton variant="outline">Back to drive</AppButton>
    </RouterLink>
  </div>
</template>
