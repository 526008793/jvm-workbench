<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  Environment,
  Project,
  Server,
  Service,
  ServiceInstance,
} from '../../../shared/models';
import { buildDiagnosticCommand, type DiagnosticKind } from '../../../shared/commands';
import { unwrap, errorMessage } from '../api';
import Modal from './Modal.vue';
import RemoteWorkspace from './RemoteWorkspace.vue';

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ error: [message: string]; notice: [message: string] }>();
const environmentId = ref(props.project.environments[0].id);
const page = ref<'logs' | 'diagnostics' | 'servers'>('logs');
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
const diagnostic = reactive({
  kind: 'trace' as DiagnosticKind,
  className: '',
  method: '',
  cost: 200,
  count: 5,
});
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
const command = computed(() => {
  try {
    return buildDiagnosticCommand(
      diagnostic.kind,
      diagnostic.className,
      diagnostic.method,
      diagnostic.cost,
      diagnostic.count,
    );
  } catch {
    return '';
  }
});
const instanceCount = computed(() =>
  environment.value.services.reduce((n, s) => n + s.instances.length, 0),
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
async function copy(text: string): Promise<void> {
  try {
    await unwrap(window.tracelogdock.copyCommand(text));
    emit('notice', 'Arthas命令已复制，自动诊断尚未接入');
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
function serverName(id: string): string {
  return environment.value.servers.find((s) => s.id === id)?.name ?? '服务器已移除';
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
        <button :class="{ active: page === 'logs' }" @click="page = 'logs'">
          ▤ <span>服务日志</span
          ><span class="count">{{ environment.services.length }}</span></button
        ><button :class="{ active: page === 'diagnostics' }" @click="page = 'diagnostics'">
          ⌁ <span>方法诊断</span></button
        ><button :class="{ active: page === 'servers' }" @click="page = 'servers'">
          ▣ <span>服务器配置</span><span class="count">{{ environment.servers.length }}</span>
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
        /><button
          v-for="service in services"
          :key="service.id"
          class="service-link"
          :class="{ selected: serviceId === service.id }"
          @click="
            serviceId = service.id;
            if (page === 'servers') page = 'logs';
          "
        >
          <span class="service-dot"></span><span>{{ service.name }}</span
          ><span class="count">{{ service.instances.length }}</span>
        </button>
        <p v-if="!services.length" class="sidebar-empty">
          {{ search ? '没有匹配的服务' : '添加服务并配置容器映射' }}
        </p>
      </div>
      <div class="sidebar-bottom">
        <span class="status-dot"></span>服务器工作区<span class="version">v0.2.0</span>
      </div>
    </aside>
    <main class="workspace-main">
      <header class="workspace-top">
        <div class="breadcrumb">
          {{ project.name }}<span>/</span>{{ environment.name }}<span>/</span
          ><strong>{{
            page === 'servers' ? '服务器配置' : page === 'diagnostics' ? '方法诊断' : '服务日志'
          }}</strong>
        </div>
        <button class="text-button" @click="manager">项目管理 ↗</button>
      </header>
      <div class="workspace-content">
        <div class="page-heading">
          <div>
            <div class="eyebrow">
              {{
                page === 'servers'
                  ? 'CONNECTION INVENTORY'
                  : page === 'diagnostics'
                    ? 'METHOD DIAGNOSTICS'
                    : 'SERVICE OBSERVABILITY'
              }}
            </div>
            <h1>
              {{
                page === 'servers'
                  ? '服务器配置'
                  : (selectedService?.name ?? (page === 'diagnostics' ? '方法诊断' : '服务日志'))
              }}
            </h1>
            <p class="muted">
              {{
                page === 'servers'
                  ? '统一维护直连 SSH 和 JumpServer 服务器，按服务关联容器。'
                  : '在同一个工作区管理服务的所有节点，保留每个实例的来源。'
              }}
            </p>
          </div>
          <button v-if="page === 'servers'" class="primary" @click="begin('server')">
            ＋ 添加服务器</button
          ><button v-else class="primary" @click="begin('service', selectedService)">
            {{ selectedService ? '编辑服务' : '＋ 添加服务' }}
          </button>
        </div>
        <div class="summary-grid">
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
        <template v-else>
          <section v-if="selectedService" class="panel instance-panel">
            <div class="panel-heading">
              <h2>
                服务实例 <span class="count">{{ selectedService.instances.length }}</span>
              </h2>
              <button class="text-button danger" @click="remove('service', selectedService.id)">
                移除服务配置
              </button>
            </div>
            <div v-if="!selectedService.instances.length" class="panel-note">
              尚未关联容器，点击“编辑服务”添加实例。
            </div>
            <div v-else class="instance-list">
              <div
                v-for="instance in selectedService.instances"
                :key="instance.id"
                class="instance-item"
              >
                <span class="service-dot"></span
                ><strong class="mono">{{ instance.containerName }}</strong
                ><span class="muted">{{ serverName(instance.serverId) }}</span
                ><span class="pill">{{ remoteStates[instance.serverId] || '未连接' }}</span>
              </div>
            </div>
          </section>
          <section v-if="page === 'diagnostics'" class="panel diagnostic-panel">
            <div class="panel-heading">
              <h2>Arthas 快捷命令</h2>
              <span class="pill">命令预览 · 尚未连接 JVM</span>
            </div>
            <div class="diagnostic-form">
              <label
                >完整类名<input
                  v-model="diagnostic.className"
                  placeholder="com.example.catalog.CatalogService" /></label
              ><label>方法名<input v-model="diagnostic.method" placeholder="queryCatalog" /></label>
            </div>
            <div class="command-presets">
              <button
                v-for="preset in [
                  { id: 'trace', name: '慢调用' },
                  { id: 'watch', name: '参数与返回值' },
                  { id: 'exception', name: '异常调用' },
                  { id: 'monitor', name: '调用统计' },
                  { id: 'stack', name: '调用来源' },
                ]"
                :key="preset.id"
                :class="{ chosen: diagnostic.kind === preset.id }"
                @click="diagnostic.kind = preset.id as DiagnosticKind"
              >
                {{ preset.name }}
              </button>
            </div>
            <div class="diagnostic-options">
              <label v-if="diagnostic.kind === 'trace'"
                >耗时阈值（ms）<input
                  v-model.number="diagnostic.cost"
                  type="number"
                  min="0" /></label
              ><label v-if="diagnostic.kind !== 'monitor'"
                >采集次数<input v-model.number="diagnostic.count" type="number" min="1"
              /></label>
            </div>
            <p v-if="diagnostic.kind === 'monitor'" class="panel-note">
              每 5 秒输出一次统计。此命令持续运行，使用时需在 Arthas 中停止。
            </p>
            <div class="command-preview">
              <code>{{ command || '填写完整类名和方法名，预览 Arthas 命令' }}</code
              ><button class="primary" :disabled="!command" @click="copy(command)">复制命令</button>
            </div>
            <p class="panel-note">
              目前仅生成命令，不执行监控。后续接入将先确认容器、JVM 和候选方法，再按实例执行。
            </p>
          </section>
        </template>
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
          <button type="button" @click="modal = null">取消</button
          ><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存配置' }}</button>
        </div>
      </form>
    </Modal>
  </div>
</template>
