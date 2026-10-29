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
import { buildLogCommand, connectionBinding, type LogMode } from '../../../shared/commands';
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
});
const terminalOpen = ref(false);
const operationBusy = ref(false);
const authBusy = ref(false);
const containers = ref<DockerContainer[]>([]);
const discoveredServerId = ref('');
const mode = ref<LogMode>('new');
const lines = ref(100);
const since = ref('10m');
const filter = ref('');
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
  relevantTasks.value.filter((t) => ['starting', 'running', 'stopping'].includes(t.status)),
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
      !filter.value ||
      r.text.toLowerCase().includes(filter.value.toLowerCase()) ||
      r.containerName.toLowerCase().includes(filter.value.toLowerCase()),
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
watch(selectedServerId, () => {
  containers.value = [];
  discoveredServerId.value = '';
});
watch(
  () => `${props.environment.id}:${props.service?.id ?? ''}`,
  async () => {
    const ids = tasks.value
      .filter((t) => ['starting', 'running'].includes(t.status))
      .map((t) => t.id);
    if (ids.length)
      await unwrap(window.tracelogdock.stopLogs(ids)).catch((error) =>
        emit('error', errorMessage(error)),
      );
    rows.value = [];
    frozen.value = [];
    selectedInstances.value = props.service?.instances.map((i) => i.id) ?? [];
  },
  { immediate: true },
);
watch(
  () => props.service?.instances.map((i) => i.id).join(','),
  () => {
    selectedInstances.value = props.service?.instances.map((i) => i.id) ?? [];
  },
);
watch(paused, (value) => {
  if (value) frozen.value = [...rows.value];
});

onMounted(async () => {
  unsubscribe = window.tracelogdock.onRemoteEvent((event) => {
    if (event.type === 'connection') {
      putConnection(event.connection);
      if (['closed', 'error'].includes(event.connection.status))
        challenges.value = challenges.value.filter((c) => c.connectionId !== event.connection.id);
    } else if (event.type === 'challenge') challenges.value.push(event.challenge);
    else if (event.type === 'log-state') putTask(event.task);
    else if (event.type === 'logs') {
      const ids = new Set(relevantTasks.value.map((t) => t.id));
      const incoming = event.rows.filter((r) => ids.has(r.taskId));
      if (!incoming.length) return;
      const time = (r: LogRow): number => {
        const timestamp = /^\d{4}-\d\d-\d\dT\S+/.exec(r.text)?.[0];
        return timestamp && Number.isFinite(Date.parse(timestamp))
          ? Date.parse(timestamp)
          : r.receivedAt;
      };
      rows.value = [...rows.value, ...incoming].sort((a, b) => time(a) - time(b)).slice(-2000);
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

function openAuthentication(server: Server): void {
  selectedServerId.value = server.id;
  Object.assign(auth, {
    kind: server.kind === 'jumpserver' ? 'interactive' : 'password',
    password: '',
    keyId: '',
    keyName: '',
    passphrase: '',
  });
  authenticationServer.value = server;
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
        ? { kind: auth.kind, password: auth.password }
        : auth.kind === 'privateKey'
          ? { kind: auth.kind, keyId: auth.keyId, passphrase: auth.passphrase }
          : { kind: auth.kind };
    const value = await unwrap(
      window.tracelogdock.connect({
        projectId: props.project.id,
        environmentId: props.environment.id,
        serverId: authenticationServer.value.id,
        authentication,
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
  operationBusy.value = true;
  try {
    containers.value = await unwrap(
      window.tracelogdock.discoverContainers({
        projectId: props.project.id,
        environmentId: props.environment.id,
        serverId: selectedServer.value.id,
      }),
    );
    discoveredServerId.value = selectedServer.value.id;
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    operationBusy.value = false;
  }
}
async function start(): Promise<void> {
  if (!props.service) return;
  rows.value = [];
  frozen.value = [];
  terminalOpen.value = false;
  operationBusy.value = true;
  try {
    const result = await unwrap(
      window.tracelogdock.startLogs({
        projectId: props.project.id,
        environmentId: props.environment.id,
        serviceId: props.service.id,
        instanceIds: [...selectedInstances.value],
        mode: mode.value,
        lines: lines.value,
        since: since.value,
      }),
    );
    for (const task of result) putTask(task);
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    operationBusy.value = false;
  }
}
async function stop(ids: string[] = activeTasks.value.map((t) => t.id)): Promise<void> {
  try {
    await unwrap(window.tracelogdock.stopLogs(ids));
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
function preview(name: string): string {
  try {
    return buildLogCommand(name, mode.value, lines.value, since.value);
  } catch {
    return '';
  }
}
async function copy(text: string): Promise<void> {
  try {
    await unwrap(window.tracelogdock.copyCommand(text));
    emit('notice', '命令已复制');
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
</script>

<template>
  <div class="remote-workspace">
    <section v-show="view !== 'diagnostics'" class="panel remote-connections">
      <div class="panel-heading">
        <h2>服务器连接</h2>
        <span class="pill">凭据仅用于本次连接</span>
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
            :aria-label="`连接 ${server.name}`"
            @click="openAuthentication(server)"
          >
            连接
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
      <table v-if="containers.length" class="data-table">
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
                    (i) => i.serverId === discoveredServerId && i.containerName === container.name,
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
    </section>
    <section v-if="view === 'logs'" class="panel log-panel">
      <div class="panel-heading">
        <h2>实时日志</h2>
        <span class="muted">保留最近 2000 行显示 · 每行标明实例来源</span>
      </div>
      <div class="log-toolbar">
        <label
          >日志范围<select v-model="mode" :disabled="activeTasks.length > 0">
            <option value="new">只看新日志</option>
            <option value="recent">最近 N 行</option>
            <option value="since">指定时间</option>
          </select></label
        ><label v-if="mode === 'recent'"
          >行数<input v-model.number="lines" type="number" min="0" /></label
        ><label v-if="mode === 'since'"
          >开始时间<input v-model="since" placeholder="10m 或 ISO 时间" /></label
        ><button
          class="primary"
          :disabled="operationBusy || !selectedInstances.length || activeTasks.length > 0"
          @click="start"
        >
          开始日志</button
        ><button :disabled="!activeTasks.length" @click="stop()">停止日志</button
        ><button @click="paused = !paused">{{ paused ? '继续显示' : '暂停显示' }}</button
        ><button
          @click="
            rows = [];
            frozen = [];
          "
        >
          清空显示
        </button>
      </div>
      <div v-if="service?.instances.length" class="instance-checkboxes">
        <label v-for="instance in service.instances" :key="instance.id"
          ><input
            v-model="selectedInstances"
            type="checkbox"
            :value="instance.id"
            :disabled="activeTasks.length > 0"
          />{{ instance.containerName }}
          <span class="muted">{{
            environment.servers.find((s) => s.id === instance.serverId)?.name
          }}</span></label
        >
      </div>
      <div v-if="relevantTasks.length" class="log-task-list">
        <div v-for="task in relevantTasks" :key="task.id">
          <span
            >{{ environment.servers.find((s) => s.id === task.serverId)?.name }} /
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
        placeholder="筛选关键词、traceId、ERROR 或容器名…"
      />
      <div ref="logElement" class="live-log-view" aria-label="实时日志输出">
        <div v-if="!visibleRows.length" class="terminal-empty">
          <span class="terminal-cursor">▍</span>
          <h2>{{ activeTasks.length ? '等待所选实例的日志' : '尚未开始日志' }}</h2>
          <p>
            连接服务器，选中容器实例后点击“开始日志”。<br />暂停显示不停止远程读取；停止日志会请求中断当前命令。
          </p>
        </div>
        <div v-for="row in visibleRows" :key="row.id" class="live-log-row">
          <span class="log-source"
            >{{ environment.servers.find((s) => s.id === row.serverId)?.name }} /
            {{ row.containerName }}<small>{{ row.stream }}</small></span
          ><code>{{ row.text }}</code>
        </div>
      </div>
      <div v-if="service?.instances.length" class="command-list">
        <div v-for="instance in service.instances" :key="instance.id">
          <code>{{ preview(instance.containerName) || '请检查日志参数' }}</code
          ><button
            :disabled="!preview(instance.containerName)"
            @click="copy(preview(instance.containerName))"
          >
            复制命令
          </button>
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
        ><label v-if="auth.kind === 'password'"
          >SSH密码<input v-model="auth.password" type="password" autocomplete="off" /></label
        ><template v-if="auth.kind === 'privateKey'"
          ><button type="button" @click="chooseKey">选择私钥文件</button
          ><span class="muted"> {{ auth.keyName || '尚未选择' }}</span
          ><label
            >私钥口令（如有）<input
              v-model="auth.passphrase"
              type="password"
              autocomplete="off" /></label
        ></template>
        <p class="form-help">密码、口令和动态验证码不会写入项目配置或日志。</p>
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
