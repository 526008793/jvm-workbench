<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { Environment, Project, Service } from '../../../shared/models';
import {
  ARTHAS_VERSION,
  ARTHAS_DEFAULT_HOME,
  diagnosticCommand,
  sameJvm,
  traceScopeSchema,
  type TraceScopeInput,
  type ArthasAgent,
  type DiagnosticInput,
  type DiagnosticTask,
  type Jvm,
  type MethodCandidate,
} from '../../../shared/arthas';
import { unwrap, errorMessage } from '../api';
import TraceResults from './TraceResults.vue';
import TaskAnalysis from './TaskAnalysis.vue';
import type { AnalysisConfiguration } from '../../../shared/analysis';
import { canEnhanceMethod, traceMethodTarget, type TraceCall } from '../../../shared/trace';

const props = defineProps<{
  project: Project;
  environment: Environment;
  service?: Service;
  analysisConfiguration?: AnalysisConfiguration;
}>();
const emit = defineEmits<{ error: [message: string]; notice: [message: string] }>();
const instanceId = ref('');
const jvms = ref<Jvm[]>([]);
const selectedPid = ref(0);
const agents = ref<ArthasAgent[]>([]);
const tasks = ref<DiagnosticTask[]>([]);
// Keep one template root so Workspace can hide the complete workbench without destroying it.
const section = ref<'connection' | 'method' | 'results'>('connection');
const candidates = ref<MethodCandidate[]>([]);
const selectedMethod = ref(-1);
const busy = ref(false);
const home = ref(ARTHAS_DEFAULT_HOME);
const attachStatus = ref('');
const port = ref(8563);
const packageName = ref('');
const query = ref('');
const methodForm = ref<HTMLElement>();
watch(section, async () => {
  await nextTick();
  methodForm.value?.closest<HTMLElement>('.workspace-content')?.scrollTo({ top: 0 });
});
const searchInput = ref<HTMLInputElement>();
const traceClasses = ref('');
const traceNames = ref('');
const scopeMethods = ref<MethodCandidate[]>([]);
const classMethods = ref<MethodCandidate[]>([]);
const checkedScopeKey = ref('');
const traceEntry = ref<MethodCandidate>();
const options = reactive({
  kind: 'deep' as DiagnosticInput['kind'],
  cost: 200,
  count: 1,
  duration: 600,
  sampleIntervalMs: 1000,
});
const selectedJvm = computed(() => jvms.value.find((j) => j.pid === selectedPid.value));
const relevantAgents = computed(() =>
  agents.value.filter(
    (a) => a.jvm.environmentId === props.environment.id && a.jvm.serviceId === props.service?.id,
  ),
);
const agent = computed(() =>
  relevantAgents.value.find((a) => selectedJvm.value && sameJvm(a.jvm, selectedJvm.value)),
);
const method = computed(() => candidates.value[selectedMethod.value]);
const relevantTasks = computed(() =>
  tasks.value
    .filter(
      (t) => t.jvm.environmentId === props.environment.id && t.jvm.serviceId === props.service?.id,
    )
    .slice()
    .reverse(),
);
const active = (t: DiagnosticTask): boolean =>
  ['submitted', 'waiting', 'results', 'stopping'].includes(t.status);
const scopeDraft = computed(() => ({
  agentId: agent.value?.id ?? '',
  classLoaderHash: traceEntry.value?.classLoaderHash ?? '',
  classes: [...new Set(traceClasses.value.split(/[\s,，]+/).filter(Boolean))],
  methods: [...new Set(traceNames.value.split(/[\s,，]+/).filter(Boolean))],
}));
const scopeKey = computed(() => JSON.stringify([scopeDraft.value, traceEntry.value]));
const scopeChecked = computed(
  () => checkedScopeKey.value === scopeKey.value && scopeMethods.value.length > 0,
);
watch(scopeKey, () => {
  scopeMethods.value = [];
  checkedScopeKey.value = '';
});
watch(
  () => [agent.value?.id, method.value?.classLoaderHash],
  () => {
    classMethods.value = [];
  },
);
function clearTraceScope(): void {
  traceClasses.value = '';
  traceNames.value = '';
  scopeMethods.value = [];
  classMethods.value = [];
  checkedScopeKey.value = '';
  traceEntry.value = undefined;
}
watch(
  () => agent.value?.id,
  (id, previous) => {
    if (id !== previous) {
      clearTraceScope();
      candidates.value = [];
      selectedMethod.value = -1;
    }
  },
);
const command = computed(() => {
  const entry = options.kind === 'trace-multi' ? traceEntry.value : method.value;
  if (!agent.value || !entry || !canEnhanceMethod(entry)) return '';
  if (options.kind === 'trace-multi' && !scopeChecked.value) return '';
  try {
    return diagnosticCommand({
      ...options,
      agentId: agent.value.id,
      method: entry,
      scope: options.kind === 'trace-multi' ? scopeMethods.value : undefined,
    });
  } catch {
    return '';
  }
});
const labels: Record<DiagnosticTask['status'], string> = {
  submitted: '已提交',
  waiting: '增强完成，等待调用',
  results: '已有结果',
  stopping: '停止中',
  stopped: '已停止',
  ended: '已结束',
  error: '失败',
  unknown: '远端状态未知',
};
let unsubscribe: (() => void) | undefined;
let generation = 0;
function putTask(task: DiagnosticTask): void {
  const index = tasks.value.findIndex((t) => t.id === task.id);
  const previouslyEnded = index >= 0 && tasks.value[index].status === 'ended';
  if (index >= 0) tasks.value[index] = task;
  else tasks.value.push(task);
  // Auto-analysis is opt-in and applies only to a newly completed invocation, never loaded history.
  if (
    task.deep &&
    task.status === 'ended' &&
    !previouslyEnded &&
    props.analysisConfiguration?.enabled &&
    props.analysisConfiguration.automatic
  )
    void unwrap(window.tracelogdock.analyzeSource(task.id)).catch((error) =>
      emit('error', errorMessage(error)),
    );
}
watch(
  () => [
    props.environment.id,
    props.service?.id,
    props.service?.instances.map((i) => `${i.id}:${i.serverId}:${i.containerName}`).join(','),
  ],
  () => {
    clearTraceScope();
    section.value = 'connection';
    instanceId.value = props.service?.instances[0]?.id ?? '';
    jvms.value = [];
    selectedPid.value = 0;
    candidates.value = [];
    selectedMethod.value = -1;
    generation += 1;
  },
  { immediate: true },
);
watch(instanceId, () => {
  clearTraceScope();
  jvms.value = relevantAgents.value
    .filter((a) => a.jvm.instanceId === instanceId.value)
    .map((a) => a.jvm);
  selectedPid.value = jvms.value[0]?.pid ?? 0;
  candidates.value = [];
  selectedMethod.value = -1;
  generation += 1;
});
watch(selectedPid, () => {
  clearTraceScope();
  candidates.value = [];
  selectedMethod.value = -1;
  generation += 1;
});
onMounted(async () => {
  unsubscribe = window.tracelogdock.onRemoteEvent((event) => {
    if (
      event.type === 'arthas-attach-progress' &&
      attachStatus.value &&
      event.progress.jvm.connectionId === selectedJvm.value?.connectionId &&
      event.progress.jvm.instanceId === instanceId.value &&
      event.progress.jvm.pid === selectedPid.value
    ) {
      const labels = {
        checking: '正在检查工具包…',
        installing: '正在下载并校验官方启动JAR…',
        bootstrapping: '官方启动器正在准备依赖并接入JVM，无需unzip（最长约2分钟）…',
        attaching: '正在接入JVM…',
        verifying: '正在核对Arthas版本与JVM…',
      };
      attachStatus.value = labels[event.progress.stage];
    }
    if (event.type === 'diagnostic-state') putTask(event.task);
    if (event.type === 'connection' && event.connection.status !== 'ready') {
      agents.value = agents.value.filter((a) => a.jvm.connectionId !== event.connection.id);
      if (selectedJvm.value?.connectionId === event.connection.id) {
        jvms.value = [];
        selectedPid.value = 0;
        generation += 1;
      }
    }
  });
  try {
    agents.value = await unwrap(window.tracelogdock.listArthasAgents());
    tasks.value = await unwrap(window.tracelogdock.listDiagnosticTasks());
  } catch (error) {
    emit('error', errorMessage(error));
  }
});
onUnmounted(() => {
  generation += 1;
  unsubscribe?.();
});
async function discover(): Promise<void> {
  if (!props.service) return;
  const current = generation;
  busy.value = true;
  try {
    const result = await unwrap(
      window.tracelogdock.discoverJvms({
        projectId: props.project.id,
        environmentId: props.environment.id,
        serviceId: props.service.id,
        instanceId: instanceId.value,
      }),
    );
    if (current !== generation) return;
    const currentAgents = await unwrap(window.tracelogdock.listArthasAgents());
    if (current !== generation) return;
    agents.value = currentAgents;
    jvms.value = result;
    selectedPid.value = result[0]?.pid ?? 0;
    if (!result.length) emit('notice', '容器中未发现可见的Java进程');
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
async function attach(): Promise<void> {
  if (!selectedJvm.value) return;
  const current = generation;
  busy.value = true;
  attachStatus.value = '正在检查工具包…';
  try {
    const result = await unwrap(
      window.tracelogdock.attachArthas({
        jvm: JSON.parse(JSON.stringify(selectedJvm.value)),
        home: home.value,
        port: port.value,
      }),
    );
    if (current !== generation) return;
    agents.value = [...agents.value.filter((a) => a.id !== result.id), result];
    section.value = 'method';
    emit('notice', `已核对Arthas ${result.version}，PID ${result.jvm.pid}`);
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
    attachStatus.value = '';
  }
}
async function search(): Promise<void> {
  if (!agent.value) return;
  const current = generation;
  busy.value = true;
  candidates.value = [];
  selectedMethod.value = -1;
  try {
    const result = await unwrap(
      window.tracelogdock.searchMethods(agent.value.id, query.value, packageName.value),
    );
    if (current !== generation) return;
    candidates.value = result;
    if (!result.length) emit('notice', '未找到已加载的匹配方法，请检查业务包、类名及当前实例版本');
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
async function returnToParameters(): Promise<void> {
  section.value = 'method';
  await nextTick();
  const panel = methodForm.value;
  const viewport = panel?.closest<HTMLElement>('.workspace-content');
  // Scroll only the workspace viewport; scrolling every ancestor can hide fields behind the header.
  if (panel && viewport) {
    viewport.scrollTo({
      top:
        viewport.scrollTop +
        panel.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        18,
      behavior: 'smooth',
    });
  }
  searchInput.value?.focus({ preventScroll: true });
}
async function continueTrace(task: DiagnosticTask, call: TraceCall): Promise<void> {
  const source = agents.value.find((a) => a.id === task.agentId);
  const target = traceMethodTarget(call);
  if (!source || !target || busy.value) return;
  busy.value = true;
  candidates.value = [];
  selectedMethod.value = -1;
  try {
    // Bind to the task's JVM before searching; the user may have selected another instance since.
    instanceId.value = source.jvm.instanceId;
    await nextTick();
    if (
      props.environment.id !== source.jvm.environmentId ||
      props.service?.id !== source.jvm.serviceId
    )
      return;
    jvms.value = relevantAgents.value
      .filter((a) => a.jvm.instanceId === source.jvm.instanceId)
      .map((a) => a.jvm);
    selectedPid.value = source.jvm.pid;
    await nextTick();
    if (
      props.environment.id !== source.jvm.environmentId ||
      props.service?.id !== source.jvm.serviceId
    )
      return;
    const current = generation;
    packageName.value = target.className.slice(0, target.className.lastIndexOf('.'));
    query.value = `${target.className}#${target.methodName}`;
    options.kind = 'trace';
    await returnToParameters();
    let found = await unwrap(
      window.tracelogdock.searchMethods(source.id, query.value, packageName.value),
    );
    if (current !== generation) return;
    let implementationSearch = false;
    if (found.length && !found.some(canEnhanceMethod)) {
      // An interface call does not identify its implementation. Show same-package concrete candidates
      // for an explicit choice instead of guessing an implementation or reusing the caller's loader.
      implementationSearch = true;
      found = await unwrap(
        window.tracelogdock.searchMethods(source.id, target.methodName, packageName.value),
      );
      if (current !== generation) return;
    }
    candidates.value = found;
    const concrete = found
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => canEnhanceMethod(m) && !m.className.includes('$$SpringCGLIB$$'));
    if (!implementationSearch && concrete.length === 1) selectedMethod.value = concrete[0].index;
    emit(
      'notice',
      !found.length
        ? '未找到该调用的已加载方法，请填写具体实现类重新搜索'
        : selectedMethod.value >= 0
          ? '已填入下一步方法及真实ClassLoader，请核对后执行诊断'
          : '已查到候选，请选择具体实现、重载或ClassLoader后执行诊断',
    );
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
function addScopeMethod(target: Pick<MethodCandidate, 'className' | 'methodName'>): void {
  const classes = new Set(scopeDraft.value.classes);
  const methods = new Set(scopeDraft.value.methods);
  classes.add(target.className);
  methods.add(target.methodName);
  traceClasses.value = [...classes].join('\n');
  traceNames.value = [...methods].join(', ');
}
function choosePreset(kind: DiagnosticInput['kind']): void {
  if (kind === 'deep' && options.kind !== kind) {
    options.count = 1;
    options.duration = 600;
  }
  if (kind === 'trace-multi') {
    if (options.kind !== kind) {
      options.count = 1;
      options.duration = 300;
    }
    if (!traceEntry.value && method.value) setTraceEntry();
  }
  options.kind = kind;
}
function setTraceEntry(): void {
  if (!method.value || !canEnhanceMethod(method.value)) return;
  traceEntry.value = JSON.parse(JSON.stringify(method.value));
  addScopeMethod(method.value);
}
function addCurrentScopeMethod(): void {
  if (!method.value) return;
  if (traceEntry.value && method.value.classLoaderHash !== traceEntry.value.classLoaderHash) {
    emit('error', '当前候选与入口ClassLoader不同，请选择同一ClassLoader的候选');
    return;
  }
  if (!traceEntry.value) setTraceEntry();
  else addScopeMethod(method.value);
}
function selectScopeMethod(target: MethodCandidate, checked: boolean): void {
  if (checked) addScopeMethod(target);
  else
    traceNames.value = scopeDraft.value.methods
      .filter((name) => name !== target.methodName)
      .join(', ');
}
function importTraceHistory(): void {
  for (const task of relevantTasks.value.filter((task) => task.agentId === agent.value?.id)) {
    if (task.scope) {
      for (const target of task.scope.filter(
        (target) => target.classLoaderHash === traceEntry.value?.classLoaderHash,
      ))
        addScopeMethod(target);
    } else {
      const match = /^trace ([\w.$]+) ([\w$]+) /.exec(task.command);
      const loader = / -c ([a-f\d]+)$/i.exec(task.command)?.[1];
      if (match && loader === traceEntry.value?.classLoaderHash) {
        const target = traceMethodTarget({ className: match[1], methodName: match[2] });
        if (target) addScopeMethod(target);
      }
    }
  }
}
async function listTraceClassMethods(): Promise<void> {
  if (!agent.value || !method.value) return;
  const current = generation;
  const selected = method.value;
  if (traceEntry.value && selected.classLoaderHash !== traceEntry.value.classLoaderHash) {
    emit('error', '当前候选与入口ClassLoader不同，请先选择同一加载器的候选');
    return;
  }
  busy.value = true;
  try {
    const found = await unwrap(
      window.tracelogdock.resolveTraceScope({
        agentId: agent.value.id,
        classLoaderHash: selected.classLoaderHash,
        classes: [selected.className],
        methods: ['*'],
      }),
    );
    if (current !== generation) return;
    // Selecting a method name includes all of its overloads; one choice per name is enough here.
    classMethods.value = [
      ...new Map(
        found.map((target) => [target.className + '#' + target.methodName, target]),
      ).values(),
    ];
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
async function checkTraceScope(): Promise<void> {
  let input: TraceScopeInput;
  try {
    input = traceScopeSchema.parse(scopeDraft.value);
  } catch {
    emit('error', '请填写完整追踪类和具体方法名，并选择入口候选的ClassLoader');
    return;
  }
  if (
    !traceEntry.value ||
    !input.classes.includes(traceEntry.value.className) ||
    (!input.methods.includes('*') && !input.methods.includes(traceEntry.value.methodName))
  ) {
    emit('error', '追踪范围必须包含所选入口的类和方法名');
    return;
  }
  const key = scopeKey.value;
  const current = generation;
  busy.value = true;
  scopeMethods.value = [];
  checkedScopeKey.value = '';
  try {
    const found = await unwrap(window.tracelogdock.resolveTraceScope(input));
    if (current !== generation || key !== scopeKey.value) return;
    scopeMethods.value = found;
    checkedScopeKey.value = key;
    emit(
      'notice',
      `已核对${new Set(found.map((target) => target.className)).size}个类、${found.length}个方法，请查看范围后执行`,
    );
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
async function start(): Promise<void> {
  const entry = options.kind === 'trace-multi' ? traceEntry.value : method.value;
  if (!agent.value || !entry) return;
  busy.value = true;
  try {
    const task = await unwrap(
      window.tracelogdock.startDiagnostic({
        ...options,
        agentId: agent.value.id,
        method: JSON.parse(JSON.stringify(entry)),
        scope:
          options.kind === 'trace-multi'
            ? JSON.parse(JSON.stringify(scopeMethods.value))
            : undefined,
      }),
    );
    // The state event can arrive before the IPC response. Preserve the newest state.
    if (!tasks.value.some((t) => t.id === task.id)) putTask(task);
    section.value = 'results';
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
async function stop(task: DiagnosticTask): Promise<void> {
  try {
    await unwrap(window.tracelogdock.stopDiagnostic(task.id));
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
async function copy(): Promise<void> {
  try {
    await unwrap(window.tracelogdock.copyCommand(command.value));
    emit('notice', '命令已复制');
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
</script>

<template>
  <div class="arthas-workbench">
    <nav class="diagnostic-tabs" aria-label="诊断步骤">
      <button :class="{ chosen: section === 'connection' }" @click="section = 'connection'">
        1 · 接入 JVM</button
      ><button :class="{ chosen: section === 'method' }" @click="section = 'method'">
        2 · 方法诊断</button
      ><button
        :class="{ chosen: section === 'results' }"
        :disabled="!relevantTasks.length"
        @click="section = 'results'"
      >
        3 · 诊断结果 <span v-if="relevantTasks.length">({{ relevantTasks.length }})</span>
      </button>
    </nav>
    <section v-show="section !== 'results'" class="panel diagnostic-panel">
      <div v-show="section === 'connection'" class="diagnostic-connection">
        <div class="panel-heading">
          <h2>Arthas 方法诊断</h2>
          <span class="pill">工具包 {{ ARTHAS_VERSION }}</span>
        </div>
        <p class="panel-note">
          先连接服务器并确认目标，再选择实例和真实JVM。接入时先检查工具包，缺失则下载官方启动JAR，由Java准备固定版本依赖。容器需sh、curl和可attach的Java运行环境；JumpServer操作前请停止占用该终端的日志。
        </p>
        <div class="arthas-form">
          <label
            >诊断实例<select aria-label="诊断实例" v-model="instanceId" :disabled="busy">
              <option
                v-for="instance in service?.instances"
                :key="instance.id"
                :value="instance.id"
              >
                {{ environment.servers.find((s) => s.id === instance.serverId)?.name }} /
                {{ instance.containerName }}
              </option>
            </select></label
          >
          <button :disabled="busy || !instanceId" @click="discover">发现 JVM</button>
          <label
            >Java进程<select aria-label="Java进程" v-model.number="selectedPid" :disabled="busy">
              <option v-for="jvm in jvms" :key="jvm.pid" :value="jvm.pid">
                PID {{ jvm.pid }} · UID {{ jvm.uid }} · {{ jvm.java }}
              </option>
            </select></label
          >
        </div>
        <div class="arthas-form">
          <label
            >容器内工具包目录<input
              v-model="home"
              :placeholder="ARTHAS_DEFAULT_HOME"
              :disabled="busy"
          /></label>
          <label
            >容器内HTTP端口<input
              v-model.number="port"
              type="number"
              min="1024"
              max="65535"
              :disabled="busy"
          /></label>
          <button :disabled="busy || !selectedJvm" @click="attach">
            {{ agent ? '重新核对接入' : '接入 Arthas' }}
          </button>
        </div>
        <p v-if="attachStatus" class="panel-note" role="status">{{ attachStatus }}</p>
        <p class="panel-note">
          无需unzip：可填写已有arthas-boot.jar所在目录，也可自动下载；首次接入需官方站点/Maven
          Central的HTTPS出网与目录写权限。
        </p>
        <p v-if="agent" class="panel-note mono">
          已核对 {{ agent.version }} · PID {{ agent.jvm.pid }} · 容器
          {{ agent.jvm.containerId.slice(0, 12) }} · {{ agent.jvm.startedAt }}
        </p>
      </div>
      <div v-show="section === 'method'" ref="methodForm" class="diagnostic-config">
        <div class="panel-heading">
          <h2>方法诊断</h2>
          <span class="muted">{{
            agent ? `PID ${agent.jvm.pid} · ${agent.jvm.containerName}` : '请先接入JVM'
          }}</span>
        </div>
        <div class="arthas-form">
          <label>业务包名<input v-model="packageName" placeholder="com.example.catalog" /></label>
          <label
            >搜索方法<input
              ref="searchInput"
              v-model="query"
              placeholder="queryCatalog 或 com.example.CatalogService#queryCatalog"
              @keyup.enter="search"
          /></label>
          <button :disabled="busy || !agent || !query" @click="search">搜索已加载方法</button>
        </div>
        <div v-if="candidates.length" class="method-candidates">
          <label
            v-for="(candidate, index) in candidates"
            :key="`${candidate.className}:${candidate.descriptor}:${candidate.classLoaderHash}`"
            class="method-candidate"
          >
            <input
              v-model="selectedMethod"
              type="radio"
              name="arthas-method"
              :value="index"
              :disabled="busy || !canEnhanceMethod(candidate)"
            />
            <span class="mono"
              >{{ candidate.className }}#{{ candidate.methodName }}({{
                candidate.parameters.join(', ')
              }}) → {{ candidate.returnType
              }}<small
                >ClassLoader {{ candidate.classLoaderHash }} · {{ agent?.jvm.containerName }} ·
                {{
                  !canEnhanceMethod(candidate)
                    ? '抽象/本地方法，不可增强'
                    : candidate.className.includes('$$SpringCGLIB$$')
                      ? 'Spring代理类'
                      : '原始实现类'
                }}</small
              ></span
            >
          </label>
        </div>
        <div class="command-presets">
          <button
            v-for="preset in [
              { id: 'deep', name: '深入追踪（单次请求）' },
              { id: 'trace', name: '慢调用' },
              { id: 'trace-multi', name: '多层追踪' },
              { id: 'watch', name: '参数与返回值' },
              { id: 'exception', name: '异常调用' },
              { id: 'monitor', name: '调用统计' },
              { id: 'stack', name: '调用来源' },
            ]"
            :key="preset.id"
            :class="{ chosen: options.kind === preset.id }"
            :disabled="busy"
            @click="choosePreset(preset.id as DiagnosticInput['kind'])"
          >
            {{ preset.name }}
          </button>
        </div>
        <p v-if="options.kind === 'deep'" class="panel-note">
          选择入口并执行诊断，再触发一次业务。完成后直接查看慢点、代码位置和优化建议。
        </p>
        <details v-if="options.kind === 'deep'" class="deep-mode-note">
          <summary>诊断说明</summary>
          <p class="panel-note">
            只选Controller等同步入口即可，无需填写下游类。启动后捕获首个进入的同名入口调用（含重载），仅增强入口并定期读取该请求线程的完整调用栈，实时展示深层路径、源码位置和数据库/网络/锁等待线索。目标间隔默认1秒，实际受HTTP长轮询与SSH往返影响；采样有开销、会漏过短暂调用。入口完成后自动停止采集；并发时可能先捕获其他用户发起的同名请求。停止诊断只结束监测，不会取消正在执行的业务。
          </p>
        </details>
        <section v-if="options.kind === 'trace-multi'" class="multi-trace-panel">
          <h3>多层追踪范围</h3>
          <div class="multi-trace-entry">
            <span
              >入口：<code>{{
                traceEntry ? `${traceEntry.className}#${traceEntry.methodName}` : '尚未选择'
              }}</code></span
            >
            <button :disabled="busy || !method || !canEnhanceMethod(method)" @click="setTraceEntry">
              将当前候选设为入口
            </button>
          </div>
          <p class="panel-note">
            选择最外层入口（例如Controller）；同一次入口调用追踪这些类内匹配的方法名，包含全部重载。使用入口ClassLoader，先核对范围再执行；不要把入口的上层调用加入范围。
          </p>
          <div class="multi-trace-inputs">
            <label
              >追踪类（每行一个完整类名）<textarea
                aria-label="追踪类"
                v-model="traceClasses"
                rows="3"
                placeholder="com.example.Controller\ncom.example.ServiceImpl\ncom.example.Assembler"
              ></textarea>
            </label>
            <label
              >追踪方法名（逗号或换行分隔）<textarea
                aria-label="追踪方法名"
                v-model="traceNames"
                rows="3"
                placeholder="exportAllOrderList, assembleForExport, doAssemble"
              ></textarea>
            </label>
          </div>
          <div class="multi-trace-actions">
            <button :disabled="busy || !method" @click="addCurrentScopeMethod">加入当前候选</button>
            <button :disabled="busy || !method || !agent" @click="listTraceClassMethods">
              列出当前类方法
            </button>
            <button
              :disabled="
                busy || !traceEntry || !relevantTasks.some((task) => task.agentId === agent?.id)
              "
              @click="importTraceHistory"
            >
              加入历史诊断方法
            </button>
            <button :disabled="busy || !traceEntry || !agent" @click="checkTraceScope">
              核对追踪范围
            </button>
          </div>
          <div v-if="classMethods.length" class="multi-trace-choices">
            <p>选择需要同时追踪的方法名；取消某个名称会将它从整个范围移除。</p>
            <label v-for="target in classMethods" :key="target.className + '#' + target.methodName">
              <input
                type="checkbox"
                :aria-label="`追踪 ${target.className}#${target.methodName}`"
                :checked="
                  scopeDraft.classes.includes(target.className) &&
                  scopeDraft.methods.includes(target.methodName)
                "
                @change="selectScopeMethod(target, ($event.target as HTMLInputElement).checked)"
              />
              <code>{{ target.className }}#{{ target.methodName }}</code
              ><small>{{ target.modifier }}</small>
            </label>
          </div>
          <div v-if="scopeChecked" class="multi-trace-preview">
            <strong
              >已核对 {{ new Set(scopeMethods.map((target) => target.className)).size }} 个类 ·
              {{ scopeMethods.length }} 个方法 · ClassLoader
              {{ traceEntry?.classLoaderHash }}</strong
            >
            <ul>
              <li
                v-for="target in scopeMethods"
                :key="target.className + target.descriptor + target.methodName"
              >
                <code
                  >{{ target.className }}#{{ target.methodName }}({{
                    target.parameters.join(', ')
                  }})</code
                >
              </li>
            </ul>
          </div>
          <p v-else class="panel-note">范围尚未核对；修改类、方法或ClassLoader后需要重新核对。</p>
          <p class="panel-note">
            多层模式不使用耗时阈值过滤，采集后按累计耗时排序；仅增强明确列出的类，不自动扩展其他派生类。可先列出类内方法再选择私有辅助方法。
          </p>
        </section>
        <div class="diagnostic-options">
          <label v-if="options.kind === 'trace'"
            >耗时阈值（ms）<input v-model.number="options.cost" type="number" min="0"
          /></label>
          <label v-if="options.kind !== 'monitor' && options.kind !== 'deep'"
            >采集次数<input v-model.number="options.count" type="number" min="1"
          /></label>
          <label v-if="options.kind === 'deep'"
            >采样间隔<select aria-label="采样间隔" v-model.number="options.sampleIntervalMs">
              <option :value="500">500 ms</option>
              <option :value="1000">1000 ms（默认）</option>
              <option :value="2000">2000 ms</option>
            </select></label
          >
          <label
            >最长运行（秒）<input v-model.number="options.duration" type="number" min="1"
          /></label>
        </div>
        <p v-if="options.kind !== 'deep'" class="panel-note">
          命令匹配所选ClassLoader下此方法的全部重载。多实例需分别搜索并执行；参数与返回值可能包含业务敏感数据。到时会中断当前任务；应用退出或掉线后需重新核对远端状态。
        </p>
        <div class="command-preview">
          <code>{{
            options.kind === 'deep' && method && command
              ? `深入追踪 ${method.className}#${method.methodName} · 单次请求 · 目标采样间隔 ${options.sampleIntervalMs} ms`
              : command || '接入JVM并选择方法候选后预览命令'
          }}</code
          ><button v-if="options.kind !== 'deep'" :disabled="!command" @click="copy">
            复制命令</button
          ><button
            class="primary"
            :disabled="
              busy || !command || relevantTasks.some((t) => t.agentId === agent?.id && active(t))
            "
            @click="start"
          >
            执行诊断
          </button>
        </div>
      </div>
    </section>
    <section
      v-if="relevantTasks.length"
      v-show="section === 'results'"
      class="panel diagnostic-results-panel"
    >
      <div class="panel-heading">
        <h2>诊断任务与结果</h2>
        <span class="muted">自动分析慢点与优化建议</span
        ><button @click="returnToParameters">回到诊断参数</button>
      </div>
      <article v-for="(task, taskIndex) in relevantTasks" :key="task.id" class="diagnostic-task">
        <details :open="taskIndex === 0 || active(task)">
          <summary class="diagnostic-task-heading">
            <strong
              >{{ environment.servers.find((s) => s.id === task.jvm.serverId)?.name }} /
              {{ task.jvm.containerName }} · PID {{ task.jvm.pid }}</strong
            ><span v-if="task.scope" class="pill">多层 · {{ task.scope.length }} 方法</span
            ><span v-if="task.deep" class="pill">深入 · 单次请求</span
            ><span class="pill">{{ labels[task.status] }}</span
            ><button
              v-if="active(task)"
              :disabled="task.status === 'stopping'"
              @click.stop.prevent="stop(task)"
            >
              停止此诊断
            </button>
          </summary>
          <code class="diagnostic-command">{{
            task.deep
              ? `深入追踪入口：${task.deep.entryClass}#${task.deep.entryMethod}`
              : task.command
          }}</code>
          <p v-if="task.error" class="remote-error">{{ task.error }}</p>
          <TaskAnalysis v-if="task.deep" :task="task" :configuration="analysisConfiguration" />
          <TraceResults
            v-if="task.command.startsWith('trace ')"
            :task="task"
            :disabled="busy || !agents.some((a) => a.id === task.agentId)"
            @continue="continueTrace(task, $event)"
          />
          <details class="diagnostic-raw" :open="!task.deep && !task.command.startsWith('trace ')">
            <summary>原始结果（{{ task.results.length }}条）</summary>
            <pre class="diagnostic-results">{{
              task.results.length ? JSON.stringify(task.results, null, 2) : '尚无诊断结果'
            }}</pre>
          </details>
        </details>
      </article>
    </section>
  </div>
</template>
