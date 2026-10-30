<script setup lang="ts">
import { computed } from 'vue';
import type { DiagnosticTask } from '../../../shared/arthas';
import {
  traceSamples,
  traceDuration,
  traceMethodTarget,
  type TraceCall,
} from '../../../shared/trace';
const props = defineProps<{ task: DiagnosticTask; disabled: boolean }>();
const emit = defineEmits<{ continue: [call: TraceCall] }>();
const samples = computed(() => traceSamples(props.task.results));
</script>

<template>
  <div v-if="samples.length" class="trace-samples">
    <section v-for="(sample, index) in samples" :key="sample.id" class="trace-sample">
      <div class="trace-summary">
        <strong>调用 {{ index + 1 }} · 总耗时 {{ traceDuration(sample.totalMs) }}</strong>
        <span>{{ sample.timestamp }} · {{ sample.threadName }}</span>
      </div>
      <p class="panel-note">
        按累计耗时排序；父子调用耗时可能重叠，不能相加。行号是调用方的源码位置。
      </p>
      <div v-if="sample.calls.length" class="trace-table-scroll">
        <table class="trace-table">
          <thead>
            <tr>
              <th>调用方法</th>
              <th>累计耗时 / 占总耗时</th>
              <th>次数</th>
              <th>调用位置</th>
              <th>下一步</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="call in sample.calls" :key="call.id">
              <td>
                <code
                  >{{ call.className }}<strong>#{{ call.methodName }}</strong></code
                >
              </td>
              <td
                :title="`平均 ${traceDuration(call.averageMs)} · 最大 ${traceDuration(call.maxMs)}`"
              >
                <strong>{{ traceDuration(call.totalMs) }}</strong
                ><small>{{ call.percent.toFixed(1) }}%</small>
              </td>
              <td>{{ call.times }}</td>
              <td class="trace-caller" :title="call.caller">
                <span>{{ call.caller.split('.').at(-1) }}</span
                ><small>{{
                  call.lineNumber === undefined ? '无行号' : `第 ${call.lineNumber} 行`
                }}</small>
              </td>
              <td>
                <button
                  :disabled="disabled || !traceMethodTarget(call)"
                  @click="emit('continue', call)"
                >
                  继续诊断
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="panel-note">当前结果没有展开内部调用，可继续诊断原始实现方法。</p>
    </section>
  </div>
  <p v-else class="panel-note">
    {{
      task.results.some((r) => r.type === 'enhancer' && r.success)
        ? '方法已增强，尚未采集到符合条件的调用；请在诊断启动后触发业务，并等待调用完成。'
        : '等待诊断结果'
    }}
  </p>
</template>
