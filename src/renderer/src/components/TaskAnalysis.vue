<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { DiagnosticTask } from '../../../shared/arthas';
import type { AnalysisConfiguration, AnalysisState, SourceBundle } from '../../../shared/analysis';
import { unwrap, errorMessage } from '../api';
import DeepResults from './DeepResults.vue';

const props = defineProps<{ task: DiagnosticTask; configuration?: AnalysisConfiguration }>();
const state = ref<AnalysisState>({ taskId: props.task.id, status: 'idle' });
const preview = ref<SourceBundle>();
const previewBusy = ref(false);
const previewError = ref('');
watch(
  () => [props.configuration?.sourceMode, props.configuration?.sourceRoot],
  () => {
    preview.value = undefined;
    previewError.value = '';
  },
);
const visibleReport = computed(() =>
  props.configuration?.enabled ? state.value.report : undefined,
);
let unsubscribe: (() => void) | undefined;
let version = 0;
onMounted(async () => {
  unsubscribe = window.tracelogdock.onSourceAnalysis((value) => {
    if (value.taskId === props.task.id) {
      version++;
      state.value = value;
    }
  });
  const initial = version;
  try {
    const value = await unwrap(window.tracelogdock.sourceAnalysisState(props.task.id));
    if (initial === version) state.value = value;
  } catch {
    /* The task may still be running; source analysis becomes available after it ends. */
  }
});
onUnmounted(() => {
  version++;
  unsubscribe?.();
});
async function analyze(): Promise<void> {
  const initial = version;
  try {
    const value = await unwrap(window.tracelogdock.analyzeSource(props.task.id));
    if (initial === version) state.value = value;
  } catch (error) {
    state.value = { taskId: props.task.id, status: 'error', error: errorMessage(error) };
  }
}
async function cancel(): Promise<void> {
  try {
    await unwrap(window.tracelogdock.cancelSourceAnalysis(props.task.id));
  } catch (error) {
    state.value.error = errorMessage(error);
  }
}
async function inspect(): Promise<void> {
  previewBusy.value = true;
  previewError.value = '';
  preview.value = undefined;
  try {
    preview.value = await unwrap(window.tracelogdock.sourceContext(props.task.id));
  } catch (error) {
    previewError.value = errorMessage(error);
  } finally {
    previewBusy.value = false;
  }
}
</script>

<template>
  <section class="task-analysis">
    <div class="analysis-toolbar">
      <span class="pill">{{ visibleReport ? 'AI 源码分析' : '本地建议' }}</span>
      <span v-if="state.status === 'running'" class="panel-note"
        >AI正在结合源码分析，本地建议仍可查看</span
      >
      <button v-if="state.status === 'running'" @click="cancel">取消 AI 分析</button>
      <button
        v-else-if="
          configuration?.enabled &&
          !['submitted', 'waiting', 'results', 'stopping'].includes(task.status)
        "
        @click="analyze"
      >
        {{ visibleReport ? '重新分析源码' : 'AI 源码分析' }}
      </button>
      <button
        v-if="
          (configuration?.sourceMode === 'arthas' || configuration?.sourceRoot) &&
          !['submitted', 'waiting', 'results', 'stopping'].includes(task.status)
        "
        :disabled="previewBusy"
        @click="inspect"
      >
        {{ configuration?.sourceMode === 'arthas' ? '查看运行源码' : '查看关联源码' }}
      </button>
    </div>
    <p v-if="configuration?.enabled && state.error" class="remote-error">
      {{ state.error }}；本地建议仍可查看。
    </p>
    <p v-if="configuration?.enabled && state.status === 'cancelled'" class="panel-note">
      AI分析已取消，本地建议保留。
    </p>
    <p v-if="previewError" class="remote-error">{{ previewError }}</p>
    <section v-if="visibleReport" class="ai-report">
      <p class="panel-note">
        模型 {{ visibleReport.model }} · {{ visibleReport.createdAt }} ·
        {{
          visibleReport.sources.some((source) => source.origin === 'arthas')
            ? '源码来自任务原JVM反编译'
            : '请核对本地源码与部署版本一致'
        }}
      </p>
      <p class="ai-summary">{{ visibleReport.summary }}</p>
      <article
        v-for="(finding, index) in visibleReport.findings"
        :key="index"
        class="diagnosis-finding"
      >
        <h3>{{ finding.title }}</h3>
        <span class="pill">{{
          finding.evidenceLevel === 'code-observation' ? '源码中可见' : '原因待验证'
        }}</span>
        <p>{{ finding.conclusion }}</p>
        <strong>优化建议</strong>
        <ul>
          <li v-for="suggestion in finding.suggestions" :key="suggestion">{{ suggestion }}</li>
        </ul>
        <details
          v-for="source in visibleReport.sources.filter((source) =>
            finding.evidenceIds.includes(source.id),
          )"
          :key="source.id"
          class="analysis-source"
        >
          <summary>
            {{ source.origin === 'arthas' ? '反编译依据' : '源码依据' }}：{{ source.path }}:{{
              source.startLine
            }}（{{ source.id }}）
          </summary>
          <pre>{{ source.text }}</pre>
        </details>
      </article>
      <div v-if="visibleReport.checks.length">
        <strong>仍需验证</strong>
        <ul>
          <li v-for="check in visibleReport.checks" :key="check">{{ check }}</li>
        </ul>
      </div>
      <details v-if="visibleReport.notes.length" class="analysis-source">
        <summary>源码核对提示（{{ visibleReport.notes.length }}处）</summary>
        <p v-for="note in visibleReport.notes" :key="note" class="panel-note">{{ note }}</p>
      </details>
    </section>
    <details v-if="visibleReport" class="local-suggestions">
      <summary>查看本地建议</summary>
      <DeepResults v-if="task.deep" :profile="task.deep" />
    </details>
    <DeepResults v-else-if="task.deep" :profile="task.deep" />
    <details v-if="preview" open class="source-preview">
      <summary>
        {{ preview.origin === 'arthas' ? '运行源码（Arthas反编译）' : '关联源码' }}（{{
          preview.pieces.length
        }}段，查看不会调用模型）
      </summary>
      <p v-for="note in preview.notes" :key="note" class="panel-note">{{ note }}</p>
      <details v-for="source in preview.pieces" :key="source.id" class="analysis-source">
        <summary>{{ source.path }}:{{ source.startLine }} · {{ source.method }}</summary>
        <pre>{{ source.text }}</pre>
      </details>
    </details>
  </section>
</template>
