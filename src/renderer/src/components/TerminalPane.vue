<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { unwrap, errorMessage } from '../api';

const props = defineProps<{ connectionId: string; readonly: boolean }>();
const emit = defineEmits<{ error: [message: string] }>();
const root = ref<HTMLDivElement>();
let terminal: Terminal | undefined;
let observer: ResizeObserver | undefined;
let unsubscribe: (() => void) | undefined;
let disposed = false;
watch(
  () => props.readonly,
  (value) => {
    if (terminal) terminal.options.disableStdin = value;
  },
);
onMounted(async () => {
  terminal = new Terminal({
    fontSize: 12,
    fontFamily: 'SFMono-Regular, Consolas, monospace',
    scrollback: 5000,
    disableStdin: props.readonly,
    theme: { background: '#0b1119', foreground: '#d4e3ef', cursor: '#59d3b7' },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(root.value!);
  let initialized = false;
  let seq = 0;
  const buffered: { seq: number; data: string }[] = [];
  unsubscribe = window.tracelogdock.onRemoteEvent((event) => {
    if (event.type !== 'terminal' || event.connectionId !== props.connectionId) return;
    if (!initialized) buffered.push(event);
    else if (event.seq > seq) {
      terminal?.write(event.data);
      seq = event.seq;
    }
  });
  try {
    const snapshot = await unwrap(window.tracelogdock.terminalSnapshot(props.connectionId));
    if (disposed) return;
    terminal.write(snapshot.data);
    seq = snapshot.seq;
    initialized = true;
    for (const event of buffered)
      if (event.seq > seq) {
        terminal.write(event.data);
        seq = event.seq;
      }
  } catch (error) {
    emit('error', errorMessage(error));
  }
  if (disposed) return;
  terminal.onData((data) => {
    void unwrap(window.tracelogdock.terminalInput(props.connectionId, data)).catch((error) =>
      emit('error', errorMessage(error)),
    );
  });
  terminal.onResize(({ cols, rows }) => {
    void unwrap(window.tracelogdock.terminalResize(props.connectionId, cols, rows)).catch(
      () => undefined,
    );
  });
  observer = new ResizeObserver(() => {
    if (!disposed && root.value?.clientWidth && root.value.clientHeight) fit.fit();
  });
  observer.observe(root.value!);
});
onUnmounted(() => {
  disposed = true;
  unsubscribe?.();
  observer?.disconnect();
  terminal?.dispose();
});
</script>

<template><div ref="root" class="ssh-terminal" aria-label="服务器交互终端"></div></template>
