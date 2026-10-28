<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { Project, WindowContext } from '../../shared/models';
import { errorMessage, unwrap } from './api';
import ProjectManager from './components/ProjectManager.vue';
import Workspace from './components/Workspace.vue';

const context = ref<WindowContext>();
const projects = ref<Project[]>([]);
const loading = ref(true);
const startupError = ref('');
const toast = ref<{ text: string; error: boolean }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | undefined;

function notify(text: string, error = false): void {
  if (timer) clearTimeout(timer);
  toast.value = { text, error };
  timer = setTimeout(() => {
    toast.value = undefined;
  }, 5500);
}
async function refresh(): Promise<void> {
  try {
    projects.value = await unwrap(window.tracelogdock.listProjects());
  } catch (error) {
    notify(errorMessage(error), true);
  }
}
async function bootstrap(): Promise<void> {
  loading.value = true;
  startupError.value = '';
  try {
    context.value = await unwrap(window.tracelogdock.context());
    projects.value = await unwrap(window.tracelogdock.listProjects());
    unsubscribe ??= window.tracelogdock.onProjectsChanged(() => {
      void refresh();
    });
  } catch (error) {
    startupError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  void bootstrap();
});
onUnmounted(() => {
  unsubscribe?.();
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div v-if="loading" class="startup">
    <span class="brand-mark">⌁</span>
    <p>正在打开工作区…</p>
  </div>
  <div v-else-if="startupError" class="startup">
    <h1>工作区暂时无法打开</h1>
    <p>{{ startupError }}</p>
    <button @click="bootstrap">重试</button>
  </div>
  <ProjectManager
    v-else-if="context?.kind === 'manager'"
    :projects="projects"
    @error="notify($event, true)"
    @notice="notify($event)"
  />
  <Workspace
    v-else-if="projects[0]"
    :project="projects[0]"
    @error="notify($event, true)"
    @notice="notify($event)"
  />
  <div v-else class="startup">
    <h1>项目不存在</h1>
    <p>该项目可能已在项目管理中删除。</p>
  </div>
  <div v-if="toast" class="toast" :class="{ 'toast-error': toast.error }" role="status">
    {{ toast.error ? '!' : '✓' }} {{ toast.text }}
  </div>
</template>
