<script setup lang="ts">
import { version } from '../../../../package.json';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type {
  Environment,
  Project,
  Server,
  Service,
  ServiceInstance,
} from '../../../shared/models';
import { unwrap, errorMessage } from '../api';
import Modal from './Modal.vue';
import RemoteWorkspace from './RemoteWorkspace.vue';
import ArthasWorkspace from './ArthasWorkspace.vue';
import AnalysisSettings from './AnalysisSettings.vue';
import type { AnalysisConfiguration } from '../../../shared/analysis';

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ error: [message: string]; notice: [message: string] }>();
const environmentId = ref(props.project.environments[0].id);
const page = ref<'logs' | 'diagnostics' | 'servers' | 'ai'>('servers');
const analysisConfiguration = ref<AnalysisConfiguration>();
const workspaceContent = ref<HTMLElement>();
watch(page, async () => {
  await nextTick();
  workspaceContent.value?.scrollTo({ top: 0 });
});
const serviceId = ref('');
const search = ref('');
const modal = ref<'environment' | 'server' | 'service' | null>(null);
const editedId = ref('');
const busy = ref(false);
const draft = ref<Project>();
const fields = reactive({
  name: '',
  kind: 'ssh' as Server['kind'],
  host: '',
  port: 22,
  username: '',
  assetName: '',
});
const instanceFields = ref<ServiceInstance[]>([]);
const remoteStates = ref<Record<string, string>>({});
const remoteTaskCount = ref(0);
const environment = computed(
  () =>
    props.project.environments.find((e) => e.id === environmentId.value) ??
    props.project.environments[0],
);
const services = computed(() =>
  environment.value.services.filter((s) =>
    s.name.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const selectedService = computed(() =>
  environment.value.services.find((s) => s.id === serviceId.value),
);
const instanceCount = computed(() =>
  environment.value.services.reduce((n, s) => n + s.instances.length, 0),
);
const sectionTitle = computed(
  () =>
    ({ logs: '服务日志', diagnostics: '方法诊断', servers: '服务器配置', ai: 'AI 配置' })[
      page.value
    ],
);
const diagnosticConnected = computed(
  () =>
    Boolean(selectedService.value?.instances.length) &&
    selectedService.value!.instances.every(
      (instance) => remoteStates.value[instance.serverId] === '已连接',
    ),
);

watch(
  () => props.project.environments.map((e) => e.id),
  (ids) => {
    if (!ids.includes(environmentId.value)) environmentId.value = ids[0];
  },
);
watch(
  () => environment.value.id,
  () => {
    serviceId.value = '';
    search.value = '';
  },
);
watch(
  () => environment.value.services.map((s) => s.id),
  (ids) => {
    if (!ids.includes(serviceId.value)) serviceId.value = ids[0] ?? '';
  },
  { immediate: true },
);

function begin(
  kind: NonNullable<typeof modal.value>,
  entity?: Server | Service | Environment,
): void {
  draft.value = JSON.parse(JSON.stringify(props.project));
  editedId.value = entity?.id ?? '';
  const server = kind === 'server' ? (entity as Server | undefined) : undefined;
  Object.assign(fields, {
    name: entity?.name ?? '',
    kind: server?.kind ?? 'ssh',
    host: server?.host ?? '',
    port: server?.port ?? 22,
    username: server?.username ?? '',
    assetName: server?.assetName ?? '',
  });
  instanceFields.value =
    kind === 'service' && entity ? JSON.parse(JSON.stringify((entity as Service).instances)) : [];
  modal.value = kind;
}
async function save(): Promise<void> {
  if (!draft.value) return;
  busy.value = true;
  try {
    const current = draft.value.environments.find((e) => e.id === environment.value.id);
    if (!current) throw new Error('当前环境已变化，请重新编辑');
    if (modal.value === 'environment') {
      if (editedId.value)
        draft.value.environments.find((e) => e.id === editedId.value)!.name = fields.name;
      else
        draft.value.environments.push({
          id: crypto.randomUUID(),
          name: fields.name,
          servers: [],
          services: [],
        });
    } else if (modal.value === 'server') {
      const server: Server = {
        id: editedId.value || crypto.randomUUID(),
        name: fields.name,
        kind: fields.kind,
        host: fields.host,
        port: fields.port,
        username: fields.username,
        assetName: fields.kind === 'jumpserver' ? fields.assetName : '',
      };
      const index = current.servers.findIndex((s) => s.id === server.id);
      if (index < 0) current.servers.push(server);
      else current.servers[index] = server;
    } else if (modal.value === 'service') {
      const service: Service = {
        id: editedId.value || crypto.randomUUID(),
        name: fields.name,
        instances: JSON.parse(JSON.stringify(instanceFields.value)),
      };
      const index = current.services.findIndex((s) => s.id === service.id);
      if (index < 0) current.services.push(service);
      else current.services[index] = service;
      serviceId.value = service.id;
    }
    await unwrap(window.tracelogdock.saveProject(JSON.parse(JSON.stringify(draft.value))));
    modal.value = null;
    emit('notice', '配置已保存');
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
async function remove(kind: 'server' | 'service' | 'environment', id: string): Promise<void> {
  const next: Project = JSON.parse(JSON.stringify(props.project));
  const current = next.environments.find((e) => e.id === environment.value.id)!;
  try {
    if (kind === 'server') {
      if (current.services.some((s) => s.instances.some((i) => i.serverId === id)))
        throw new Error('此服务器仍被服务实例引用，请先调整服务配置');
      current.servers = current.servers.filter((s) => s.id !== id);
    } else if (kind === 'service') current.services = current.services.filter((s) => s.id !== id);
    else {
      if (next.environments.length === 1) throw new Error('项目至少保留一个环境');
      const target = next.environments.find((e) => e.id === id)!;
      if (target.servers.length || target.services.length)
        throw new Error('请先移除该环境的服务和服务器配置');
      next.environments = next.environments.filter((e) => e.id !== id);
    }
    await unwrap(window.tracelogdock.saveProject(next));
    if (kind === 'service') modal.value = null;
    emit('notice', '本地配置已移除');
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
function addInstance(): void {
  instanceFields.value.push({
    id: crypto.randomUUID(),
    serverId: environment.value.servers[0]?.id ?? '',
    containerName: '',
  });
}
async function useContainer(serverId: string, name: string): Promise<void> {
  if (!selectedService.value) return;
  const next: Project = JSON.parse(JSON.stringify(props.project));
  const service = next.environments
    .find((e) => e.id === environment.value.id)
    ?.services.find((s) => s.id === selectedService.value!.id);
  if (
    !service ||
    service.instances.some((i) => i.serverId === serverId && i.containerName === name)
  )
    return;
  service.instances.push({ id: crypto.randomUUID(), serverId, containerName: name });
  try {
    await unwrap(window.tracelogdock.saveProject(next));
    emit('notice', '容器已关联到当前服务');
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
async function manager(): Promise<void> {
  try {
    await unwrap(window.tracelogdock.openManager());
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
</script>

<template>
  <div class="workspace-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-mark">⌁</span><strong>TraceLogDock</strong>
      </div>
      <button class="project-switch" @click="manager">
        <span class="project-icon small">{{ project.name.slice(0, 1).toUpperCase() }}</span
        ><span>{{ project.name }}<small>项目工作区</small></span
        ><span class="muted">↗</span>
      </button>
      <div class="environment-select">
        <label for="environment">当前环境</label
        ><select id="environment" v-model="environmentId">
          <option v-for="e in project.environments" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
        <div class="inline-actions">
          <button class="text-button" @click="begin('environment')">＋ 新环境</button
          ><button class="text-button" @click="begin('environment', environment)">编辑</button
          ><button
            class="text-button danger"
            aria-label="删除当前环境"
            @click="remove('environment', environment.id)"
          >
            ×
          </button>
        </div>
      </div>
      <nav class="workspace-nav">
        <button :class="{ active: page === 'servers' }" @click="page = 'servers'">
          ▣ <span>服务器配置</span><span class="count">{{ environment.servers.length }}</span>
        </button>
        <button :class="{ active: page === 'logs' }" @click="page = 'logs'">
          ▤ <span>服务日志</span
          ><span class="count">{{ environment.services.length }}</span></button
        ><button :class="{ active: page === 'diagnostics' }" @click="page = 'diagnostics'">
          ⌁ <span>方法诊断</span>
        </button>
        <button aria-label="AI 配置" :class="{ active: page === 'ai' }" @click="page = 'ai'">
          ✦ <span>AI 配置</span>
        </button>
      </nav>
      <div class="service-section">
        <div class="section-heading">
          <span class="eyebrow">SERVICES</span
          ><button class="text-button" aria-label="新增服务" @click="begin('service')">＋</button>
        </div>
        <input
          v-model="search"
          class="service-search"
          aria-label="搜索服务"
          placeholder="搜索服务…"
        />
        <div v-for="service in services" :key="service.id" class="service-entry">
          <button
            class="service-link"
            :class="{ selected: serviceId === service.id }"
            :title="service.name"
            @click="
              serviceId = service.id;
              if (page === 'servers') page = 'logs';
            "
          >
            <span class="service-dot"></span><span>{{ service.name }}</span
            ><span class="count">{{ service.instances.length }}</span>
          </button>
          <button
            class="service-action"
            :aria-label="`编辑服务 ${service.name}`"
            title="编辑服务"
            @click="begin('service', service)"
          >
            ✎
          </button>
          <button
            class="service-action danger"
            :aria-label="`删除服务 ${service.name}`"
            title="删除服务"
            @click="remove('service', service.id)"
          >
            ×
          </button>
        </div>
        <p v-if="!services.length" class="sidebar-empty">
          {{ search ? '没有匹配的服务' : '添加服务并配置容器映射' }}
        </p>
      </div>
      <div class="sidebar-bottom">
        <span class="status-dot"></span>服务器工作区<span class="version">v{{ version }}</span>
      </div>
    </aside>
    <main class="workspace-main">
      <header class="workspace-top">
        <div class="breadcrumb">
          {{ project.name }}<span>/</span>{{ environment.name }}<span>/</span
          ><strong>{{ sectionTitle }}</strong>
        </div>
        <button class="text-button" @click="manager">项目管理 ↗</button>
      </header>
      <div ref="workspaceContent" class="workspace-content">
        <div class="page-heading">
          <div>
            <div class="eyebrow">
              {{
                page === 'ai'
                  ? 'AI CONFIGURATION'
                  : page === 'servers'
                    ? 'CONNECTION INVENTORY'
                    : page === 'diagnostics'
                      ? 'METHOD DIAGNOSTICS'
                      : 'SERVICE OBSERVABILITY'
              }}
            </div>
            <h1>
              {{
                page === 'servers' || page === 'ai'
                  ? sectionTitle
                  : (selectedService?.name ?? (page === 'diagnostics' ? '方法诊断' : '服务日志'))
              }}
            </h1>
            <p class="muted">
              {{
                page === 'ai'
                  ? '独立配置模型服务、测试连通性，选择分析源码来源。'
                  : page === 'diagnostics'
                    ? '接入 JVM → 定位慢点 → 查看源码与分析建议。'
                    : page === 'servers'
                      ? '统一维护直连 SSH 和 JumpServer 服务器，按服务关联容器。'
                      : '在同一个工作区管理服务的所有节点，保留每个实例的来源。'
              }}
            </p>
          </div>
          <button v-if="page === 'servers'" class="primary" @click="begin('server')">
            ＋ 添加服务器</button
          ><button
            v-else-if="page !== 'ai'"
            class="primary"
            @click="begin('service', selectedService)"
          >
            {{ selectedService ? '编辑服务' : '＋ 添加服务' }}
          </button>
        </div>
        <div v-if="page === 'servers'" class="summary-grid">
          <div class="summary-card">
            <span>当前环境</span><strong>{{ environment.name }}</strong
            ><small>项目配置独立保存</small>
          </div>
          <div class="summary-card">
            <span>服务器</span><strong>{{ environment.servers.length }} <em>台</em></strong
            ><small
              >{{ environment.servers.filter((s) => s.kind === 'jumpserver').length }} 台通过
              JumpServer</small
            >
          </div>
          <div class="summary-card">
            <span>服务实例</span><strong>{{ instanceCount }} <em>个</em></strong
            ><small>分布在 {{ environment.services.length }} 个服务</small>
          </div>
          <div class="summary-card">
            <span>连接状态</span
            ><strong
              >{{
                Object.values(remoteStates).filter((s) => s === '已连接').length
              }}
              台已连接</strong
            ><small>JumpServer选机后需确认目标主机</small>
          </div>
        </div>
        <AnalysisSettings v-show="page === 'ai'" @configured="analysisConfiguration = $event" />
        <details
          v-show="page !== 'ai'"
          class="connection-surface"
          :class="{ 'diagnostic-connections': page === 'diagnostics' }"
          :open="page !== 'diagnostics' || !diagnosticConnected"
        >
          <summary v-show="page === 'diagnostics'">
            服务器连接 ·
            {{
              diagnosticConnected ? '已就绪（点击展开终端与连接操作）' : '请连接并确认目标服务器'
            }}
          </summary>
          <RemoteWorkspace
            :project="project"
            :environment="environment"
            :service="selectedService"
            :view="page"
            @error="emit('error', $event)"
            @notice="emit('notice', $event)"
            @status="
              (states, count) => {
                remoteStates = states;
                remoteTaskCount = count;
              }
            "
            @use-container="useContainer"
          />
        </details>
        <section v-if="page === 'servers'" class="panel">
          <div class="panel-heading">
            <h2>连接清单</h2>
            <span class="pill">仅保存连接信息，不保存密码</span>
          </div>
          <div v-if="!environment.servers.length" class="empty-state">
            <span class="empty-symbol">▣</span>
            <h2>添加第一台服务器</h2>
            <p>选择直连 SSH，或填写 JumpServer 连接信息与目标资产。</p>
            <button @click="begin('server')">添加服务器</button>
          </div>
          <table v-else class="data-table">
            <thead>
              <tr>
                <th>服务器</th>
                <th>连接方式</th>
                <th>连接地址</th>
                <th>用户 / 目标资产</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="server in environment.servers" :key="server.id">
                <td>
                  <strong>{{ server.name }}</strong>
                </td>
                <td>
                  <span class="pill" :class="{ 'pill-teal': server.kind === 'jumpserver' }">{{
                    server.kind === 'ssh' ? 'SSH 直连' : 'JumpServer'
                  }}</span>
                </td>
                <td class="mono">{{ server.host }}:{{ server.port }}</td>
                <td>
                  {{ server.username }}<small v-if="server.assetName">{{ server.assetName }}</small>
                </td>
                <td>
                  <span class="muted">{{ remoteStates[server.id] || '未连接' }}</span>
                </td>
                <td class="table-actions">
                  <button
                    class="text-button"
                    :aria-label="`编辑服务器 ${server.name}`"
                    @click="begin('server', server)"
                  >
                    编辑</button
                  ><button
                    class="text-button danger"
                    :aria-label="`移除服务器 ${server.name}`"
                    @click="remove('server', server.id)"
                  >
                    移除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <ArthasWorkspace
          v-show="page === 'diagnostics'"
          :project="project"
          :environment="environment"
          :service="selectedService"
          :analysis-configuration="analysisConfiguration"
          @error="emit('error', $event)"
          @notice="emit('notice', $event)"
        />
      </div>
      <footer class="taskbar">
        <span
          ><span class="status-dot muted-dot"></span
          >{{ remoteTaskCount ? `运行日志任务 ${remoteTaskCount} 个` : '暂无运行中的日志任务' }}
          <button v-if="remoteTaskCount" class="text-button" @click="page = 'logs'">
            查看日志
          </button></span
        ><span>配置版本 {{ project.revision }} · {{ project.name }} / {{ environment.name }}</span>
      </footer>
    </main>
    <Modal
      v-if="modal"
      :title="`${editedId ? '编辑' : '新增'}${modal === 'environment' ? '环境' : modal === 'server' ? '服务器' : '服务'}`"
      @close="modal = null"
    >
      <form @submit.prevent="save">
        <label
          >{{ modal === 'environment' ? '环境名称' : modal === 'server' ? '服务器名称' : '服务名称'
          }}<input
            v-model="fields.name"
            required
            :placeholder="modal === 'service' ? '例如：catalog-service' : '用于工作区展示'"
        /></label>
        <template v-if="modal === 'server'"
          ><label
            >连接方式<select
              v-model="fields.kind"
              @change="fields.port = fields.kind === 'jumpserver' ? 2222 : 22"
            >
              <option value="ssh">SSH 直连</option>
              <option value="jumpserver">JumpServer</option>
            </select></label
          >
          <div class="form-row">
            <label
              >{{ fields.kind === 'jumpserver' ? '堡垒机地址' : '服务器地址'
              }}<input v-model="fields.host" required placeholder="app.example.invalid" /></label
            ><label class="port-field"
              >端口<input v-model.number="fields.port" type="number" required min="1" max="65535"
            /></label>
          </div>
          <label>登录用户<input v-model="fields.username" required placeholder="operator" /></label
          ><label v-if="fields.kind === 'jumpserver'"
            >目标资产名称<input v-model="fields.assetName" placeholder="例如：生产应用节点 A"
          /></label>
          <p v-if="fields.kind === 'jumpserver'" class="form-help">
            每条配置对应一台目标服务器；其他目标可用相同堡垒机账号“复用登录”，分别在各自终端选机。
          </p>
          <p class="form-help">
            此处只保存连接信息；在连接面板输入本次密码或选择私钥，MFA按服务器提示提交。
          </p></template
        >
        <template v-if="modal === 'service'"
          ><div class="section-heading">
            <h3>容器实例</h3>
            <button
              type="button"
              class="text-button"
              :disabled="!environment.servers.length"
              @click="addInstance"
            >
              ＋ 添加实例
            </button>
          </div>
          <p v-if="!environment.servers.length" class="form-help">
            先在“服务器配置”添加服务器，再为服务关联容器。
          </p>
          <div v-for="(instance, index) in instanceFields" :key="instance.id" class="instance-form">
            <label
              >所在服务器<select v-model="instance.serverId" required>
                <option v-for="server in environment.servers" :key="server.id" :value="server.id">
                  {{ server.name }}
                </option>
              </select></label
            ><label
              >容器名称<input
                v-model="instance.containerName"
                required
                placeholder="catalog-api" /></label
            ><button
              type="button"
              class="icon-button danger"
              aria-label="移除此实例"
              @click="instanceFields.splice(index, 1)"
            >
              ×
            </button>
          </div></template
        >
        <div class="form-actions">
          <button
            v-if="modal === 'service' && editedId"
            type="button"
            class="text-button danger"
            @click="remove('service', editedId)"
          >
            移除服务配置
          </button>
          <button type="button" @click="modal = null">取消</button
          ><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存配置' }}</button>
        </div>
      </form>
    </Modal>
  </div>
</template>
