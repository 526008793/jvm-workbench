<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { emptyAnalysisSettings, type AnalysisConfiguration } from '../../../shared/analysis';
import { unwrap, errorMessage } from '../api';

const emit = defineEmits<{ configured: [configuration: AnalysisConfiguration] }>();
const form = reactive({ ...emptyAnalysisSettings(), apiKey: '', clearKey: false });
const configuration = ref<AnalysisConfiguration>();
const busy = ref(false);
const message = ref('');
const failed = ref(false);
function accept(value: AnalysisConfiguration): void {
  configuration.value = value;
  Object.assign(form, value, { apiKey: '', clearKey: false });
  emit('configured', value);
}
onMounted(async () => {
  try {
    accept(await unwrap(window.tracelogdock.analysisConfiguration()));
  } catch (error) {
    failed.value = true;
    message.value = errorMessage(error);
  }
});
async function choose(): Promise<void> {
  try {
    const path = await unwrap(window.tracelogdock.chooseSourceRoot());
    if (path) form.sourceRoot = path;
  } catch (error) {
    failed.value = true;
    message.value = errorMessage(error);
  }
}
async function save(): Promise<void> {
  busy.value = true;
  message.value = '';
  failed.value = false;
  try {
    accept(
      await unwrap(
        window.tracelogdock.saveAnalysisConfiguration({
          settings: {
            sourceRoot: form.sourceRoot,
            sourceMode: form.sourceMode,
            enabled: form.enabled,
            automatic: form.automatic,
            baseUrl: form.baseUrl,
            model: form.model,
          },
          apiKey: form.apiKey || undefined,
          clearKey: form.clearKey,
        }),
      ),
    );
    message.value = '已保存；未启用AI时仍会显示本地建议';
  } catch (error) {
    failed.value = true;
    message.value = errorMessage(error);
  } finally {
    busy.value = false;
  }
}
async function test(): Promise<void> {
  busy.value = true;
  message.value = '';
  failed.value = false;
  try {
    await unwrap(window.tracelogdock.testAnalysisConnection());
    message.value = '模型服务连接成功（使用已保存配置，未发送业务源码）';
  } catch (error) {
    failed.value = true;
    message.value = errorMessage(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="panel analysis-settings">
    <div class="panel-heading">
      <h2>模型服务配置</h2>
      <span class="pill">{{ configuration?.enabled ? 'AI已启用' : '本地建议可用 · AI可选' }}</span>
    </div>
    <form @submit.prevent="save">
      <p class="panel-note">
        本地建议无需AI。启用后会把选定来源的相关方法与采样路径发送到所配置的模型服务；测试连通性只发送测试文本，不读取业务源码。
      </p>
      <label
        >分析源码来源<select aria-label="分析源码来源" v-model="form.sourceMode">
          <option value="arthas">Arthas 运行源码（反编译）</option>
          <option value="local">本地源码（可补充 Mapper SQL）</option>
        </select></label
      >
      <p v-if="form.sourceMode === 'arthas'" class="panel-note">
        从原JVM读取采样方法，无需本地项目目录。反编译不保证还原注释、原始行号或Mapper
        XML；结果按诊断任务缓存。
      </p>
      <template v-if="form.sourceMode === 'local'">
        <label
          >本地源码目录<input
            aria-label="本地源码目录"
            :value="form.sourceRoot"
            readonly
            placeholder="选择Java项目或服务模块根目录"
        /></label>
        <button type="button" :disabled="busy" @click="choose">选择源码目录</button>
      </template>
      <label class="checkbox-label"
        ><input type="checkbox" v-model="form.enabled" />启用 AI 源码分析</label
      >
      <label
        >API地址<input
          aria-label="AI API地址"
          v-model="form.baseUrl"
          placeholder="https://服务地址/v1 或完整/chat/completions地址"
          :disabled="busy"
      /></label>
      <label
        >模型名称<input
          aria-label="AI模型名称"
          v-model="form.model"
          placeholder="填写服务支持的模型名"
          :disabled="busy"
      /></label>
      <label
        >API Key（可选）<input
          aria-label="AI API Key"
          v-model="form.apiKey"
          type="password"
          autocomplete="off"
          :placeholder="configuration?.keySaved ? '已加密保存；留空保留' : '本地无鉴权服务可留空'"
          :disabled="busy"
      /></label>
      <label v-if="configuration?.keySaved" class="checkbox-label"
        ><input type="checkbox" v-model="form.clearKey" />清除已保存密钥</label
      >
      <label class="checkbox-label"
        ><input
          type="checkbox"
          v-model="form.automatic"
          :disabled="!form.enabled"
        />新诊断完成后自动发送相关源码并分析</label
      >
      <div class="multi-trace-actions">
        <button class="primary" :disabled="busy">保存 AI 配置</button
        ><button
          type="button"
          :disabled="busy || !configuration?.baseUrl || !configuration?.model"
          @click="test"
        >
          测试连通性
        </button>
      </div>
      <p v-if="message" :class="failed ? 'remote-error' : 'panel-note'" role="status">
        {{ message }}
      </p>
    </form>
  </section>
</template>
