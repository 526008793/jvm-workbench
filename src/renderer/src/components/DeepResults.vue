<script setup lang="ts">
import { computed } from 'vue';
import {
  deepConclusions,
  deepEvidence,
  type DeepProfile,
  type StackFrame,
} from '../../../shared/deep';
import { traceDuration } from '../../../shared/trace';

const props = defineProps<{ profile: DeepProfile }>();
const paths = computed(() => [...props.profile.paths].sort((a, b) => b.hits - a.hits));
const conclusions = computed(() => deepConclusions(props.profile));
const businessPrefix = computed(() => {
  const name = props.profile.entryClass;
  const boundary = /\.(?:controller|service|web|api)\./.exec(name)?.index;
  return boundary === undefined ? name.slice(0, name.lastIndexOf('.')) : name.slice(0, boundary);
});
const hotspots = computed(() => {
  const rows = new Map<string, { frame: StackFrame; hits: number; deepest: number }>();
  for (const path of paths.value) {
    const business = path.frames.filter((frame) =>
      frame.className.startsWith(businessPrefix.value + '.'),
    );
    const seen = new Set<string>();
    for (const [index, frame] of business.entries()) {
      const key = `${frame.className}#${frame.methodName}:${frame.lineNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = rows.get(key) ?? { frame, hits: 0, deepest: 0 };
      row.hits += path.hits;
      if (index === 0) row.deepest += path.hits;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.deepest - a.deepest || b.hits - a.hits);
});
const location = (frame: StackFrame): string =>
  `${frame.fileName || frame.className.split('.').at(-1)}${frame.lineNumber !== undefined && frame.lineNumber >= 0 ? `:${frame.lineNumber}` : '（无源码行号）'}`;
</script>

<template>
  <section class="deep-results">
    <div class="diagnosis-summary">
      <div class="trace-summary">
        <strong>{{
          profile.phase === 'waiting' || profile.phase === 'running'
            ? '正在诊断，完成后显示结论'
            : '诊断结论'
        }}</strong
        ><span v-if="profile.durationMs !== undefined"
          >总耗时 {{ traceDuration(profile.durationMs) }}</span
        >
      </div>
      <p v-if="profile.phase === 'partial'" class="panel-note">
        本次诊断未完成，以下仅为已采集到的线索。
      </p>
      <p v-else-if="profile.phase === 'complete' && profile.samples === 1" class="panel-note">
        本次仅有一个有效样本，以下为初步线索，尚不能确认主要瓶颈。
      </p>
      <p v-if="profile.phase === 'complete' && profile.exceptional" class="remote-error">
        入口异常退出；以下分析仅解释采集到的耗时位置。
      </p>
      <template v-if="profile.phase === 'complete' || profile.phase === 'partial'">
        <p v-if="!conclusions.length" class="panel-note">
          本次未定位到明确的业务慢点，暂不能给出具体代码优化建议。
        </p>
        <article
          v-for="(conclusion, index) in conclusions"
          :key="conclusion.id"
          class="diagnosis-finding"
        >
          <h3>
            {{ index === 0 ? '优先排查' : '同时关注' }}：{{ conclusion.method.split('.').at(-1) }}
          </h3>
          <p>{{ conclusion.finding }}</p>
          <p class="diagnosis-location">
            <span>代码位置</span
            ><code :title="conclusion.method">{{
              conclusion.locations.map(location).join('、')
            }}</code
            ><small v-if="conclusion.callers.length"
              >调用方：{{
                conclusion.callers
                  .map(
                    (caller) =>
                      `${caller.className.split('.').at(-1)}#${caller.methodName} · ${location(caller)}`,
                  )
                  .join('；')
              }}</small
            >
          </p>
          <strong>优化建议</strong>
          <ul>
            <li v-for="suggestion in conclusion.suggestions" :key="suggestion">{{ suggestion }}</li>
          </ul>
        </article>
        <p v-if="conclusions.length && profile.samples > 1" class="panel-note">
          以上根据调用栈给出排查和优化方向，具体修改需结合源码与对应系统指标确认。
        </p>
      </template>
    </div>
    <details class="diagnosis-details">
      <summary>查看诊断依据</summary>
      <div class="trace-summary">
        <strong>{{
          profile.phase === 'waiting'
            ? '已就绪，等待一次入口请求'
            : profile.phase === 'running'
              ? '深入采样中 · 当前请求无需重复执行'
              : profile.phase === 'complete'
                ? '单次请求采集完成'
                : '部分采样结果'
        }}</strong>
        <span v-if="profile.threadId"
          >线程 {{ profile.threadName || profile.threadId }} · ID {{ profile.threadId }}</span
        >
      </div>
      <p v-if="profile.durationMs !== undefined">
        入口总耗时 <strong>{{ traceDuration(profile.durationMs) }}</strong
        >{{ profile.exceptional ? ' · 入口异常退出' : '' }}
      </p>
      <p class="panel-note">
        有效样本 {{ profile.samples }} · 目标间隔
        {{ profile.intervalMs }}
        ms（实际还包含远程往返）；占比表示路径出现的采样比例，不是精确方法耗时或调用次数。短暂调用可能漏采，父子帧不能相加；只观察入口线程，不自动追踪异步线程或远端服务内部。
      </p>
      <p v-if="profile.reason" class="remote-error">{{ profile.reason }}</p>
      <p v-if="profile.meanIntervalMs !== undefined" class="panel-note">
        实际平均采样间隔
        {{ Math.round(profile.meanIntervalMs) }}
        ms。Arthas无事件时的长轮询、SSH往返和目标JVM响应均会延长间隔。
      </p>
      <p v-if="profile.skipped" class="panel-note">
        {{ profile.skipped }} 次采样未见入口栈，已排除，未混入线程池后续请求。
      </p>
      <p v-if="!paths.length" class="panel-note">
        {{
          profile.phase === 'waiting'
            ? '在此任务启动后触发一次业务。请求过程中会实时显示深层调用栈，无需等待导出完成。'
            : profile.phase === 'running'
              ? '入口已捕获，等待第一个有效线程样本。'
              : '未采集到有效入口栈，无法判断深层瓶颈；请求可能短于采样间隔，或采集已中断。'
        }}
      </p>
      <div v-if="hotspots.length" class="trace-table-scroll">
        <table class="trace-table deep-hotspots">
          <thead>
            <tr>
              <th>业务调用位置</th>
              <th>出现样本 / 占比</th>
              <th>位于最深业务帧</th>
              <th>源码位置</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in hotspots"
              :key="row.frame.className + row.frame.methodName + row.frame.lineNumber"
            >
              <td>
                <code
                  >{{ row.frame.className }}<strong>#{{ row.frame.methodName }}</strong></code
                >
              </td>
              <td>{{ row.hits }} · {{ ((row.hits / profile.samples) * 100).toFixed(1) }}%</td>
              <td>{{ row.deepest }} 个样本</td>
              <td>{{ location(row.frame) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-for="(path, index) in paths" :key="path.id" class="deep-path">
        <div class="trace-summary">
          <strong>线索 {{ index + 1 }} · {{ deepEvidence(path).label }}</strong
          ><span
            >{{ path.hits }} 个样本 · {{ ((path.hits / profile.samples) * 100).toFixed(1) }}% ·
            {{ path.state }}</span
          >
        </div>
        <p>{{ deepEvidence(path).detail }}</p>
        <p v-if="path.lockName" class="panel-note">
          等待对象：<code>{{ path.lockName }}</code>
        </p>
        <details :open="index === 0">
          <summary>完整路径（入口 → 当前栈顶） · {{ path.frames.length }} 帧</summary>
          <ol class="deep-stack">
            <li
              v-for="(frame, frameIndex) in [...path.frames].reverse()"
              :key="frameIndex"
              :class="{ 'deep-business': frame.className.startsWith(businessPrefix + '.') }"
            >
              <code
                >{{ frame.className }}<strong>#{{ frame.methodName }}</strong></code
              ><small>{{ location(frame) }}</small>
            </li>
          </ol>
        </details>
      </div>
    </details>
  </section>
</template>
