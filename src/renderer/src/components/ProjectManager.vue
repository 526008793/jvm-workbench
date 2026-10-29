<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { Project } from '../../../shared/models';
import { unwrap, errorMessage } from '../api';
import Modal from './Modal.vue';

defineProps<{ projects: Project[] }>();
const emit = defineEmits<{ error: [message: string]; notice: [message: string] }>();
const showForm = ref(false);
const edited = ref<Project | null>(null);
const busy = ref(false);
const fields = reactive({ name: '', description: '', environmentName: '开发环境' });

function openForm(project?: Project): void {
  edited.value = project ? JSON.parse(JSON.stringify(project)) : null;
  Object.assign(fields, {
    name: project?.name ?? '',
    description: project?.description ?? '',
    environmentName: '开发环境',
  });
  showForm.value = true;
}
async function save(): Promise<void> {
  busy.value = true;
  try {
    if (edited.value)
      await unwrap(
        window.tracelogdock.saveProject({
          ...edited.value,
          name: fields.name,
          description: fields.description,
        }),
      );
    else await unwrap(window.tracelogdock.createProject({ ...fields }));
    showForm.value = false;
    emit('notice', edited.value ? '项目已更新' : '项目已创建');
  } catch (error) {
    emit('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
async function open(project: Project): Promise<void> {
  try {
    await unwrap(window.tracelogdock.openProject(project.id));
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
async function remove(project: Project): Promise<void> {
  try {
    await unwrap(window.tracelogdock.deleteProject(project.id));
  } catch (error) {
    emit('error', errorMessage(error));
  }
}
</script>

<template>
  <div class="manager-shell">
    <header class="manager-top">
      <div class="brand">
        <span class="brand-mark">⌁</span>TraceLogDock
        <span class="version">0.2 · 服务器接入版</span>
      </div>
      <span class="muted">项目工作区</span>
    </header>
    <main class="manager-main">
      <div class="manager-heading">
        <div>
          <div class="eyebrow">YOUR WORKSPACES</div>
          <h1>每个项目，都在自己的工作区。</h1>
          <p class="muted">集中管理服务和节点，同时打开多个项目，各自保留配置与视图。</p>
        </div>
        <button class="primary" @click="openForm()">＋ 新建项目</button>
      </div>
      <div class="section-heading">
        <h2>
          我的项目 <span class="count">{{ projects.length }}</span>
        </h2>
        <span class="muted">配置保存在此设备</span>
      </div>
      <section v-if="!projects.length" class="manager-empty">
        <div class="empty-symbol">⌘</div>
        <h2>从第一个项目开始</h2>
        <p>为项目添加环境、服务器和服务，再打开独立工作区。</p>
        <button class="primary" @click="openForm()">新建第一个项目</button>
      </section>
      <section v-else class="project-grid">
        <article v-for="project in projects" :key="project.id" class="project-card">
          <div class="project-card-top">
            <span class="project-icon">{{ project.name.slice(0, 1).toUpperCase() }}</span
            ><span class="pill">本地项目</span>
          </div>
          <h2>{{ project.name }}</h2>
          <p class="project-description">{{ project.description || '尚未填写项目说明' }}</p>
          <div class="project-stats">
            <span>{{ project.environments.length }} 个环境</span
            ><span
              >{{ project.environments.reduce((n, e) => n + e.servers.length, 0) }} 台服务器</span
            ><span
              >{{ project.environments.reduce((n, e) => n + e.services.length, 0) }} 个服务</span
            >
          </div>
          <footer>
            <button
              class="primary"
              :aria-label="`打开 ${project.name} 工作区`"
              @click="open(project)"
            >
              打开工作区 ↗</button
            ><button
              class="text-button"
              :aria-label="`编辑项目 ${project.name}`"
              @click="openForm(project)"
            >
              编辑</button
            ><button
              class="text-button danger"
              :aria-label="`删除项目 ${project.name}`"
              @click="remove(project)"
            >
              删除
            </button>
          </footer>
        </article>
        <button class="new-project-card" @click="openForm()"><span>＋</span>添加另一个项目</button>
      </section>
      <section class="capability-strip">
        <div>
          <span class="step">01</span>
          <h3>配置工作区</h3>
          <p>项目、环境与服务映射</p>
        </div>
        <div>
          <span class="step">02</span>
          <h3>接入服务器</h3>
          <p>SSH / JumpServer 交互终端</p>
        </div>
        <div>
          <span class="step">03</span>
          <h3>日志与诊断</h3>
          <p>Docker 实时日志 / Arthas 模板</p>
        </div>
      </section>
    </main>
    <footer class="manager-footer">
      <span><span class="status-dot"></span>工作区已就绪</span
      ><span>私有项目 · 配置不包含登录凭据</span>
    </footer>
    <Modal v-if="showForm" :title="edited ? '编辑项目' : '新建项目'" @close="showForm = false">
      <form @submit.prevent="save">
        <label>项目名称<input v-model="fields.name" required placeholder="例如：商城服务" /></label
        ><label
          >项目说明<textarea
            v-model="fields.description"
            rows="3"
            placeholder="记录项目用途或负责的服务"
          /></label
        ><label v-if="!edited"
          >初始环境<input v-model="fields.environmentName" required placeholder="例如：开发环境"
        /></label>
        <div class="form-actions">
          <button type="button" @click="showForm = false">取消</button
          ><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存项目' }}</button>
        </div>
      </form>
    </Modal>
  </div>
</template>
