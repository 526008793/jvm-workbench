<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { Environment, Project, Server, Service } from '../../../shared/models';
import type {
  Challenge,
  ConnectionView,
  DockerContainer,
  LogRow,
  LogTask,
} from '../../../shared/remote';
import {
  buildLogCommand,
  connectionBinding,
  gatewayBinding,
  type LogMode,
} from '../../../shared/commands';
import { unwrap, errorMessage } from '../api';
import Modal from './Modal.vue';
import TerminalPane from './TerminalPane.vue';

const props = defineProps<{
  project: Project;
  environment: Environment;
  service?: Service;
  view: string;
}>();
const emit = defineEmits<{
  error: [message: string];
  notice: [message: string];
  status: [states: Record<string, string>, count: number];
  useContainer: [serverId: string, name: string];
}>();
const connections = ref<ConnectionView[]>([]);
const tasks = ref<LogTask[]>([]);
const rows = ref<LogRow[]>([]);
const selectedServerId = ref(props.environment.servers[0]?.id ?? '');
const selectedInstances = ref<string[]>([]);
const challenges = ref<Challenge[]>([]);
const answers = ref<string[]>([]);
const answering = ref(false);
const authenticationServer = ref<Server>();
const auth = reactive({
  kind: 'password' as 'password' | 'privateKey' | 'interactive',
  password: '',
  keyId: '',
  keyName: '',
  passphrase: '',
  rememberPassword: false,
  savedPassword: false,
  passwordStorageAvailable: false,
});
const terminalOpen = ref(false);
const operationBusy = ref(false);
const authBusy = ref(false);
const containers = ref<DockerContainer[]>([]);
const containersOpen = ref(false);
const discoveredServerId = ref('');
const mode = ref<LogMode>('new');
const lines = ref(100);
const since = ref('10m');
const rangeStart = ref('');
const rangeEnd = ref('');
const filter = ref('');
const showAllServices = ref(false);
const paused = ref(false);
const frozen = ref<LogRow[]>([]);
const logElement = ref<HTMLDivElement>();
const selectedServer = computed(() =>
  props.environment.servers.find((s) => s.id === selectedServerId.value),
);
const selectedConnection = computed(() =>
  [...connections.value]
    .reverse()
    .find((c) => c.environmentId === props.environment.id && c.serverId === selectedServerId.value),
);
const challenge = computed(() => challenges.value[0]);
const relevantTasks = computed(() =>
  tasks.value.filter(
    (t) => t.environmentId === props.environment.id && t.serviceId === props.service?.id,
  ),
);
const activeTasks = computed(() =>
  relevantTasks.value.filter(
    (t) =>
      selectedInstances.value.includes(t.instanceId) &&
      ['starting', 'running', 'stopping'].includes(t.status),
  ),
);
const visibleTasks = computed(() =>
  tasks.value.filter(
    (t) =>
      t.environmentId === props.environment.id &&
      (showAllServices.value ||
        (t.serviceId === props.service?.id && selectedInstances.value.includes(t.instanceId))),
  ),
);
const visibleActiveTasks = computed(() =>
  visibleTasks.value.filter((t) => ['starting', 'running', 'stopping'].includes(t.status)),
);
const terminalReadonly = computed(
  () =>
    !selectedConnection.value ||
    !selectedConnection.value.terminalReady ||
    !['ready', 'awaiting-target'].includes(selectedConnection.value.status) ||
    (selectedConnection.value.kind === 'jumpserver' &&
      tasks.value.some(
        (t) =>
          t.environmentId === props.environment.id &&
          t.serverId === selectedServerId.value &&
          ['starting', 'running', 'stopping'].includes(t.status),
      )),
);
const visibleRows = computed(() =>
  (paused.value ? frozen.value : rows.value).filter(
    (r) =>
      (showAllServices.value ||
        (r.serviceId === props.service?.id && selectedInstances.value.includes(r.instanceId))) &&
      (!filter.value ||
        r.text.toLowerCase().includes(filter.value.toLowerCase()) ||
        r.containerName.toLowerCase().includes(filter.value.toLowerCase()) ||
        props.environment.services
          .find((s) => s.id === r.serviceId)
          ?.name.toLowerCase()
          .includes(filter.value.toLowerCase())),
  ),
);
const labels: Record<string, string> = {
  connecting: '连接中',
  'verifying-host': '等待主机确认',
  authenticating: '认证中',
  'awaiting-target': '待选机确认',
  ready: '已连接',
  closed: '已断开',
  error: '失败',
  starting: '准备中',
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  ended: '已结束',
  unknown: '状态未知',
};
let unsubscribe: (() => void) | undefined;

function reusableConnection(server: Server): ConnectionView | undefined {
  if (server.kind !== 'jumpserver') return undefined;
  return [...connections.value].reverse().find((connection) => {
    const configured = props.environment.servers.find((s) => s.id === connection.serverId);
    return (
      connection.environmentId === props.environment.id &&
      connection.serverId !== server.id &&
      ['ready', 'awaiting-target'].includes(connection.status) &&
      configured?.kind === 'jumpserver' &&
      gatewayBinding(configured) === gatewayBinding(server)
    );
  });
}
function connectionStatus(serverId: string): string {
  const value = [...connections.value]
    .reverse()
    .find((c) => c.environmentId === props.environment.id && c.serverId === serverId);
  return value ? labels[value.status] : '未连接';
}
function putConnection(value: ConnectionView): void {
  const index = connections.value.findIndex((c) => c.id === value.id);
  if (index < 0) connections.value.push(value);
  else connections.value[index] = value;
}
function putTask(value: LogTask): void {
  tasks.value = tasks.value.filter(
    (t) =>
      t.id === value.id ||
      t.instanceId !== value.instanceId ||
      t.environmentId !== value.environmentId ||
      ['starting', 'running', 'stopping'].includes(t.status),
  );
  const index = tasks.value.findIndex((t) => t.id === value.id);
  if (index < 0) tasks.value.push(value);
  else tasks.value[index] = value;
}
watch(
  () => challenge.value?.id,
  () => {
    answers.value = challenge.value?.prompts.map(() => '') ?? [];
  },
);
watch(
  [connections, tasks, () => props.environment.id],
  () =>
    emit(
      'status',
      Object.fromEntries(props.environment.servers.map((s) => [s.id, connectionStatus(s.id)])),
      tasks.value.filter((t) => ['starting', 'running', 'stopping'].includes(t.status)).length,
    ),
  { deep: true, immediate: true },
);
watch(
  () => props.environment.servers.map((s) => s.id),
  (ids) => {
    if (!ids.includes(selectedServerId.value)) selectedServerId.value = ids[0] ?? '';
  },
);
watch(
  () => props.view,
  (view) => {
    if (view === 'diagnostics') terminalOpen.value = false;
  },
);
watch([selectedServerId, () => props.environment.id], () => {
  containers.value = [];
  containersOpen.value = false;
  discoveredServerId.value = '';
});
watch(
  () => props.environment.id,
  async (_id, previousId) => {
    const ids = tasks.value
      .filter(
        (t) =>
          t.environmentId === previousId && ['starting', 'running', 'stopping'].includes(t.status),
      )
      .map((t) => t.id);
    rows.value = [];
    frozen.value = [];
    if (ids.length)
      await unwrap(window.tracelogdock.stopLogs(ids)).catch((error) =>
        emit('error', errorMessage(error)),
      );
  },
);
// Changing the selected service only changes the view. Its subscriptions remain active in the background.
watch(
  [
    () => props.service?.id,
    () => props.service?.instances.map((i) => i.id).join(','),
    showAllServices,
  ],
  (_value, previous) => {
    const ids = props.service?.instances.map((i) => i.id) ?? [];
    const retained =
      previous?.[0] === props.service?.id
        ? selectedInstances.value.filter((id) => ids.includes(id))
        : [];
    const chosen = retained.length ? retained : ids;
    // Merge controls both multi-selection and visibility; switching back leaves other jobs running.
    selectedInstances.value = showAllServices.value ? chosen : chosen.slice(0, 1);
  },
  { immediate: true },
);
watch(paused, (value) => {
  if (value) frozen.value = [...rows.value];
});

onMounted(async () => {
  unsubscribe = window.tracelogdock.onRemoteEvent((event) => {
    if (event.type === 'password-state') {
      if (
        authenticationServer.value?.id === event.target.serverId &&
        props.environment.id === event.target.environmentId
      )
        auth.savedPassword = event.remembered;
      if (event.error) emit('error', event.error);
    } else if (event.type === 'connection') {
      putConnection(event.connection);
      if (['closed', 'error'].includes(event.connection.status))
        challenges.value = challenges.value.filter((c) => c.connectionId !== event.connection.id);
    } else if (event.type === 'challenge') challenges.value.push(event.challenge);
    else if (event.type === 'log-state') putTask(event.task);
    else if (event.type === 'logs') {
      const ids = new Set(
        tasks.value.filter((t) => t.environmentId === props.environment.id).map((t) => t.id),
      );
      const incoming = event.rows.filter((r) => ids.has(r.taskId));
      if (!incoming.length) return;
      const time = (r: LogRow): number => {
        const timestamp = r.timestamp ?? /^\d{4}-\d\d-\d\dT\S+/.exec(r.text)?.[0];
        return timestamp && Number.isFinite(Date.parse(timestamp))
          ? Date.parse(timestamp)
          : r.receivedAt;
      };
      // Continuation lines update the same event; sort complete messages instead of individual lines.
      const merged = new Map(rows.value.map((row) => [row.id, row]));
      for (const row of incoming) merged.set(row.id, row);
      rows.value = [...merged.values()].sort((a, b) => time(a) - time(b)).slice(-2000);
      if (!paused.value)
        void nextTick(() => {
          if (logElement.value) logElement.value.scrollTop = logElement.value.scrollHeight;
        });
    }
  });
  try {
    connections.value = await unwrap(window.tracelogdock.listConnections());
    tasks.value = await unwrap(window.tracelogdock.listLogTasks());
  } catch (error) {
    emit('error', errorMessage(error));
  }
});
onUnmounted(() => unsubscribe?.());

async function openAuthentication(server: Server, reuseLogin = true): Promise<void> {
  selectedServerId.value = server.id;
  const source = reuseLogin ? reusableConnection(server) : undefined;
  if (source) {
    authBusy.value = true;
    try {
      const value = await unwrap(
        window.tracelogdock.connect({
          projectId: props.project.id,
          environmentId: props.environment.id,
          serverId: server.id,
          binding: connectionBinding(server),
          authentication: { kind: 'reuse', connectionId: source.id },
        }),
      );
      if (!connections.value.some((c) => c.id === value.id)) putConnection(value);
      terminalOpen.value = true;
      emit('notice', '已复用堡垒机登录，请在新终端选择目标服务器并确认');
    } catch (error) {
      emit('error', errorMessage(error));
    } finally {
      authBusy.value = false;
    }
    return;
  }
  Object.assign(auth, {
    kind: 'password',
    password: '',
    keyId: '',
    keyName: '',
    passphrase: '',
    rememberPassword: false,
    savedPassword: false,
    passwordStorageAvailable: false,
  });
  authenticationServer.value = server;
  authBusy.value = true;
  try {
    const status = await unwrap(
      window.tracelogdock.passwordStatus({
        projectId: props.project.id,
        environmentId: props.environment.id,
        serverId: server.id,
        binding: connectionBinding(server),
      }),
    );
    if (authenticationServer.value?.id === server.id) {
      auth.passwordStorageAvailable = status.available;
      auth.savedPassword = status.remembered;
      auth.rememberPassword = status.remembered && status.available;
    }
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    authBusy.value = false;
  }
}
async function forgetPassword(): Promise<void> {
  const server = authenticationServer.value;
  if (!server) return;
  authBusy.value = true;
  try {
    await unwrap(
      window.tracelogdock.forgetPassword({
        projectId: props.project.id,
        environmentId: props.environment.id,
        serverId: server.id,
        binding: connectionBinding(server),
      }),
    );
    auth.savedPassword = false;
    auth.rememberPassword = false;
    emit('notice', '已忘记此账号保存的密码');
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    authBusy.value = false;
  }
}
async function chooseKey(): Promise<void> {
  try {
    const file = await unwrap(window.tracelogdock.choosePrivateKey());
    if (file) {
      auth.keyId = file.id;
      auth.keyName = file.name;
    }
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
async function connect(): Promise<void> {
  if (!authenticationServer.value) return;
  authBusy.value = true;
  try {
    const authentication =
      auth.kind === 'password'
        ? !auth.password && auth.savedPassword && auth.passwordStorageAvailable
          ? { kind: 'savedPassword' as const }
          : { kind: auth.kind, password: auth.password }
        : auth.kind === 'privateKey'
          ? { kind: auth.kind, keyId: auth.keyId, passphrase: auth.passphrase }
          : { kind: auth.kind };
    const value = await unwrap(
      window.tracelogdock.connect({
        projectId: props.project.id,
        environmentId: props.environment.id,
        serverId: authenticationServer.value.id,
        authentication,
        rememberPassword:
          auth.kind === 'password' && auth.passwordStorageAvailable
            ? auth.rememberPassword
            : undefined,
        binding: connectionBinding(authenticationServer.value),
      }),
    );
    if (!connections.value.some((c) => c.id === value.id)) putConnection(value);
    authenticationServer.value = undefined;
    terminalOpen.value = true;
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    authBusy.value = false;
    auth.password = '';
    auth.passphrase = '';
  }
}
async function disconnect(): Promise<void> {
  if (!selectedConnection.value) return;
  try {
    await unwrap(window.tracelogdock.disconnect(selectedConnection.value.id));
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
async function answer(acceptHost?: boolean): Promise<void> {
  if (!challenge.value) return;
  const current = challenge.value;
  answering.value = true;
  try {
    await unwrap(
      window.tracelogdock.answerChallenge({
        connectionId: current.connectionId,
        challengeId: current.id,
        answers: [...answers.value],
        acceptHost,
      }),
    );
    challenges.value = challenges.value.filter((c) => c.id !== current.id);
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    answering.value = false;
    answers.value = challenges.value[0]?.prompts.map(() => '') ?? [];
  }
}
async function cancelChallenge(): Promise<void> {
  if (!challenge.value) return;
  const id = challenge.value.connectionId;
  try {
    await unwrap(window.tracelogdock.disconnect(id));
  } catch (error) {
    emit('error', errorMessage(error));
  }
  challenges.value = challenges.value.filter((c) => c.connectionId !== id);
}
async function confirmTarget(): Promise<void> {
  if (!selectedConnection.value) return;
  operationBusy.value = true;
  try {
    putConnection(await unwrap(window.tracelogdock.confirmTarget(selectedConnection.value.id)));
    emit('notice', '已确认目标主机，请核对显示的主机名');
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    operationBusy.value = false;
  }
}
async function discover(): Promise<void> {
  if (!selectedServer.value) return;
  const target = {
    projectId: props.project.id,
    environmentId: props.environment.id,
    serverId: selectedServer.value.id,
  };
  operationBusy.value = true;
  try {
    const found = await unwrap(window.tracelogdock.discoverContainers(target));
    if (props.environment.id !== target.environmentId || selectedServerId.value !== target.serverId)
      return;
    containers.value = found;
    discoveredServerId.value = target.serverId;
    containersOpen.value = true;
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    operationBusy.value = false;
  }
}
async function start(): Promise<void> {
  if (!props.service) return;
  terminalOpen.value = false;
  operationBusy.value = true;
  try {
    const time = logTime();
    const container = props.service.instances.find((i) => selectedInstances.value.includes(i.id));
    // Validate before clearing the current view or opening remote channels.
    buildLogCommand(
      container?.containerName ?? '',
      mode.value,
      lines.value,
      time.since,
      time.until,
    );
    rows.value = rows.value.filter((r) => !selectedInstances.value.includes(r.instanceId));
    frozen.value = frozen.value.filter((r) => !selectedInstances.value.includes(r.instanceId));
    const result = await unwrap(
      window.tracelogdock.startLogs({
        projectId: props.project.id,
        environmentId: props.environment.id,
        serviceId: props.service.id,
        instanceIds: [...selectedInstances.value],
        mode: mode.value,
        lines: lines.value,
        ...time,
      }),
    );
    for (const task of result) putTask(task);
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    operationBusy.value = false;
  }
}
async function stop(ids: string[] = visibleActiveTasks.value.map((t) => t.id)): Promise<void> {
  try {
    await unwrap(window.tracelogdock.stopLogs(ids));
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
function selectInstance(id: string, checked: boolean): void {
  if (!showAllServices.value) selectedInstances.value = [id];
  else if (checked) selectedInstances.value = [...new Set([...selectedInstances.value, id])];
  else selectedInstances.value = selectedInstances.value.filter((value) => value !== id);
}
function logTime(): { since: string; until: string } {
  if (mode.value !== 'range') return { since: since.value, until: '' };
  const start = new Date(rangeStart.value);
  const end = rangeEnd.value ? new Date(rangeEnd.value) : undefined;
  if (!Number.isFinite(start.getTime())) throw new Error('请选择有效的日志开始时间');
  if (end && !Number.isFinite(end.getTime())) throw new Error('请选择有效的日志结束时间');
  return { since: start.toISOString(), until: end?.toISOString() ?? '' };
}
</script>

<template>
  <div class="remote-workspace">
    <section v-show="view !== 'logs'" class="panel remote-connections">
      <div class="panel-heading">
        <h2>服务器连接</h2>
        <span class="pill">支持安全记住密码</span>
      </div>
      <div v-if="!environment.servers.length" class="panel-note">
        先添加服务器，再从这里建立连接。
      </div>
      <div v-else class="connection-strip">
        <div
          v-for="server in environment.servers"
          :key="server.id"
          class="connection-chip"
          :class="{ chosen: selectedServerId === server.id }"
        >
          <button class="text-button" @click="selectedServerId = server.id">
            <strong>{{ server.name }}</strong
            ><span class="pill">{{ connectionStatus(server.id) }}</span></button
          ><button
            v-if="['未连接', '已断开', '失败'].includes(connectionStatus(server.id))"
            :aria-label="`${reusableConnection(server) ? '复用登录' : '连接'} ${server.name}`"
            :disabled="authBusy"
            @click="openAuthentication(server)"
          >
            {{ reusableConnection(server) ? '复用登录' : '连接' }}
          </button>
          <button
            v-if="
              ['已断开', '失败'].includes(connectionStatus(server.id)) && reusableConnection(server)
            "
            class="text-button"
            :aria-label="`单独登录 ${server.name}`"
            :disabled="authBusy"
            @click="openAuthentication(server, false)"
          >
            单独登录
          </button>
        </div>
      </div>
      <div v-if="selectedConnection" class="remote-actions">
        <span
          >{{ selectedServer?.name }}
          <span class="muted">{{
            selectedConnection.hostname ||
            (selectedConnection.kind === 'jumpserver' ? '请在终端中完成目标资产选机' : 'SSH直连')
          }}</span></span
        ><button @click="terminalOpen = !terminalOpen">
          {{ terminalOpen ? '收起终端' : '打开终端' }}</button
        ><button
          v-if="selectedConnection.kind === 'jumpserver'"
          :disabled="
            operationBusy || !['awaiting-target', 'ready'].includes(selectedConnection.status)
          "
          @click="confirmTarget"
        >
          确认已进入目标服务器</button
        ><button
          :disabled="operationBusy || selectedConnection.status !== 'ready'"
          @click="discover"
        >
          发现容器</button
        ><button v-if="discoveredServerId && !containersOpen" @click="containersOpen = true">
          显示容器列表</button
        ><button
          class="danger"
          :disabled="['closed', 'error'].includes(selectedConnection.status)"
          @click="disconnect"
        >
          断开
        </button>
      </div>
      <p v-if="selectedConnection?.error" class="remote-error">{{ selectedConnection.error }}</p>
      <div v-if="selectedConnection" v-show="terminalOpen" class="terminal-panel">
        <div class="terminal-hint">
          {{
            terminalReadonly
              ? '终端只读：连接尚未就绪或此JumpServer通道正在读取日志'
              : '可在此输入命令；JumpServer完成选机且shell空闲后，再确认目标服务器'
          }}
        </div>
        <TerminalPane
          :key="selectedConnection.id"
          :connection-id="selectedConnection.id"
          :readonly="terminalReadonly"
          @error="emit('error', $event)"
        />
      </div>
      <div v-if="containersOpen" class="discovered-containers">
        <div class="panel-heading">
          <h3>发现的容器（{{ containers.length }}）</h3>
          <button class="text-button" aria-label="关闭容器列表" @click="containersOpen = false">
            关闭列表 ×
          </button>
        </div>
        <div v-if="!containers.length" class="panel-note">未发现正在运行的容器</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>容器</th>
              <th>镜像</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="container in containers" :key="container.id">
              <td class="mono">
                {{ container.name }}<small>{{ container.id.slice(0, 12) }}</small>
              </td>
              <td>{{ container.image }}</td>
              <td>{{ container.status }}</td>
              <td>
                <button
                  :disabled="
                    !service ||
                    service.instances.some(
                      (i) =>
                        i.serverId === discoveredServerId && i.containerName === container.name,
                    )
                  "
                  @click="emit('useContainer', discoveredServerId, container.name)"
                >
                  关联当前服务
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section v-if="view === 'logs'" class="panel log-panel">
      <div class="panel-heading">
        <h2>实时日志</h2>
        <span class="muted">保留本环境最近 2000 条记录 · SQL/堆栈多行整体显示</span>
      </div>
      <div class="log-toolbar">
        <label
          >日志范围<select v-model="mode" aria-label="日志范围" :disabled="activeTasks.length > 0">
            <option value="new">只看新日志</option>
            <option value="recent">最近 N 行</option>
            <option value="since">最近一段时间</option>
            <option value="range">自定义时间</option>
          </select></label
        ><label v-if="mode === 'recent'"
          >行数<input
            v-model.number="lines"
            type="number"
            min="0"
            :disabled="activeTasks.length > 0" /></label
        ><label v-if="mode === 'since'"
          >最近时间<select v-model="since" aria-label="最近时间" :disabled="activeTasks.length > 0">
            <option value="5m">最近 5 分钟</option>
            <option value="10m">最近 10 分钟</option>
            <option value="30m">最近 30 分钟</option>
            <option value="1h">最近 1 小时</option>
            <option value="6h">最近 6 小时</option>
            <option value="24h">最近 24 小时</option>
          </select></label
        ><template v-if="mode === 'range'">
          <label
            >开始时间<input
              v-model="rangeStart"
              type="datetime-local"
              step="1"
              :disabled="activeTasks.length > 0"
          /></label>
          <label
            >结束时间（可选）<input
              v-model="rangeEnd"
              type="datetime-local"
              step="1"
              :disabled="activeTasks.length > 0"
          /></label> </template
        ><button
          class="primary"
          :disabled="operationBusy || !selectedInstances.length || activeTasks.length > 0"
          @click="start"
        >
          开始日志</button
        ><button :disabled="!visibleActiveTasks.length" @click="stop()">
          {{ showAllServices ? '停止全部服务日志' : '停止日志' }}</button
        ><button @click="paused = !paused">{{ paused ? '继续显示' : '暂停显示' }}</button
        ><button
          @click="
            rows = showAllServices
              ? []
              : rows.filter(
                  (r) => r.serviceId !== service?.id || !selectedInstances.includes(r.instanceId),
                );
            frozen = showAllServices
              ? []
              : frozen.filter(
                  (r) => r.serviceId !== service?.id || !selectedInstances.includes(r.instanceId),
                );
          "
        >
          清空显示
        </button>
      </div>
      <p v-if="mode === 'range'" class="panel-note log-time-hint">
        按本机时区选择时间；不填结束时间会持续跟随，填写后仅读取该时间段并自动结束。修改时间后点击“开始日志”生效。
      </p>
      <div class="instance-checkboxes">
        <label><input v-model="showAllServices" type="checkbox" />合并查看本环境服务日志</label
        ><span class="muted">{{
          showAllServices
            ? '可多选实例；“开始日志”启动当前服务所选实例'
            : '单选一个实例查看；切换不会停止后台日志'
        }}</span>
      </div>
      <div v-if="service?.instances.length" class="instance-checkboxes">
        <label v-for="instance in service.instances" :key="instance.id"
          ><input
            :key="showAllServices ? 'multiple' : 'single'"
            :type="showAllServices ? 'checkbox' : 'radio'"
            name="log-instance"
            :value="instance.id"
            :checked="selectedInstances.includes(instance.id)"
            @change="selectInstance(instance.id, ($event.target as HTMLInputElement).checked)"
          />{{ instance.containerName }}
          <span class="muted">{{
            environment.servers.find((s) => s.id === instance.serverId)?.name
          }}</span></label
        >
      </div>
      <p v-else class="panel-note">尚未关联容器，点击“编辑服务”添加实例或发现容器后关联。</p>
      <div v-if="visibleTasks.length" class="log-task-list">
        <div v-for="task in visibleTasks" :key="task.id">
          <span
            >{{ environment.services.find((s) => s.id === task.serviceId)?.name }} /
            {{ environment.servers.find((s) => s.id === task.serverId)?.name }} /
            {{ task.containerName }}</span
          ><span class="pill">{{ labels[task.status] }}</span
          ><span v-if="task.containerId" class="mono muted">{{
            task.containerId.slice(0, 12)
          }}</span
          ><span v-if="task.error" class="remote-error">{{ task.error }}</span
          ><button
            v-if="['starting', 'running'].includes(task.status)"
            class="text-button"
            @click="stop([task.id])"
          >
            停止此实例
          </button>
        </div>
      </div>
      <input
        v-model="filter"
        class="log-filter"
        aria-label="筛选日志"
        placeholder="筛选服务名、容器名、traceId 或日志关键词…"
      />
      <div ref="logElement" class="live-log-view" aria-label="实时日志输出">
        <div v-if="!visibleRows.length" class="terminal-empty">
          <span class="terminal-cursor">▍</span>
          <h2>{{ visibleActiveTasks.length ? '等待日志输出' : '尚未开始日志' }}</h2>
          <p>
            连接服务器，选中容器实例后点击“开始日志”。<br />暂停显示不停止远程读取；停止日志会请求中断当前命令。
          </p>
        </div>
        <div v-for="row in visibleRows" :key="row.id" class="live-log-row">
          <span class="log-source"
            >{{ environment.services.find((s) => s.id === row.serviceId)?.name }} /
            {{ environment.servers.find((s) => s.id === row.serverId)?.name }} /
            {{ row.containerName }}<small>{{ row.stream }}</small
            ><small v-if="row.timestamp" :title="row.timestamp">{{
              row.timestamp.slice(0, 19).replace('T', ' ')
            }}</small></span
          ><code>{{ row.text }}</code>
        </div>
      </div>
    </section>
    <Modal
      v-if="authenticationServer"
      :title="`连接 ${authenticationServer.name}`"
      @close="
        authenticationServer = undefined;
        auth.password = '';
        auth.passphrase = '';
      "
    >
      <form @submit.prevent="connect">
        <p class="form-help">
          {{ authenticationServer.host }}:{{ authenticationServer.port }} ·
          {{ authenticationServer.username }}
        </p>
        <label
          >认证方式<select v-model="auth.kind">
            <option value="password">密码</option>
            <option value="privateKey">私钥文件</option>
            <option value="interactive">按服务器提示交互认证</option>
          </select></label
        ><template v-if="auth.kind === 'password'">
          <label
            >SSH密码<input
              v-model="auth.password"
              type="password"
              autocomplete="off"
              :placeholder="
                auth.savedPassword && auth.passwordStorageAvailable
                  ? '已记住密码，可直接连接；输入可更换'
                  : '请输入登录密码'
              "
          /></label>
          <div class="password-options">
            <label class="remember-password"
              ><input
                v-model="auth.rememberPassword"
                type="checkbox"
                :disabled="!auth.passwordStorageAvailable || authBusy"
              />在此设备上记住密码</label
            >
            <button
              v-if="auth.savedPassword"
              class="text-button"
              type="button"
              :disabled="authBusy"
              @click="forgetPassword"
            >
              忘记密码
            </button>
          </div>
          <p v-if="!auth.passwordStorageAvailable" class="form-help">
            当前系统安全存储不可用，密码仅用于本次连接。
          </p> </template
        ><template v-if="auth.kind === 'privateKey'"
          ><button type="button" @click="chooseKey">选择私钥文件</button
          ><span class="muted"> {{ auth.keyName || '尚未选择' }}</span
          ><label
            >私钥口令（如有）<input
              v-model="auth.passphrase"
              type="password"
              autocomplete="off" /></label
        ></template>
        <p v-if="authenticationServer.kind === 'jumpserver'" class="form-help">
          先用JumpServer登录密码或私钥认证；如需MFA，连接后会继续提示输入验证码。
        </p>
        <p class="form-help">
          勾选后仅加密保存登录密码；私钥口令、验证码不会保存，密码不会写入项目配置或日志。
        </p>
        <div class="form-actions">
          <button
            type="button"
            @click="
              authenticationServer = undefined;
              auth.password = '';
              auth.passphrase = '';
            "
          >
            取消</button
          ><button
            class="primary"
            :disabled="authBusy || (auth.kind === 'privateKey' && !auth.keyId)"
          >
            建立连接
          </button>
        </div>
      </form>
    </Modal>
    <Modal v-if="challenge" :title="challenge.title" @close="cancelChallenge"
      ><form @submit.prevent="answer(challenge?.kind === 'host' ? true : undefined)">
        <p class="form-help">{{ challenge.instruction }}</p>
        <template v-if="challenge.kind === 'host'"
          ><p>请核对服务器的 SSH 指纹。确认后会在本机记录，此后身份变化将拒绝连接。</p>
          <code class="host-fingerprint">{{ challenge.fingerprint }}</code></template
        ><label v-for="(prompt, index) in challenge.prompts" :key="index"
          >{{ prompt.prompt
          }}<input
            v-model="answers[index]"
            :type="prompt.echo ? 'text' : 'password'"
            autocomplete="off"
        /></label>
        <div class="form-actions">
          <button type="button" @click="cancelChallenge">取消连接</button
          ><button class="primary" :disabled="answering">
            {{ challenge.kind === 'host' ? '信任并连接' : '提交认证' }}
          </button>
        </div>
      </form></Modal
    >
  </div>
</template>
