<script setup lang="ts">
import { onMounted, ref } from 'vue';
defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLDivElement>();
onMounted(() => panel.value?.querySelector<HTMLInputElement>('input')?.focus());
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div ref="panel" class="modal" role="dialog" aria-modal="true" :aria-label="title">
      <header>
        <h2>{{ title }}</h2>
        <button class="icon-button" aria-label="关闭弹窗" @click="emit('close')">×</button>
      </header>
      <slot />
    </div>
  </div>
</template>
