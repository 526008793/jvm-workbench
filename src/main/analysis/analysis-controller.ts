import { z } from 'zod';
import { analysisChannels } from '../../shared/channels';
import {
  analysisSettingsSchema,
  saveAnalysisSchema,
  type AnalysisSettings,
  type AnalysisState,
  type SourceBundle,
} from '../../shared/analysis';
import type { DiagnosticTask } from '../../shared/arthas';
import { ContextRegistry } from '../workspaces/context-registry';
import { ArthasService } from '../arthas/arthas-service';
import { AnalysisSettingsStore } from './settings-store';
import { collectSourceContext, verifySourceContext } from './source-context';
import { analyzeSource, testModel } from './model-client';
import { collectRuntimeSource } from './runtime-source';

type Register = (
  name: string,
  action: (owner: number, input: unknown) => unknown | Promise<unknown>,
) => void;
interface RecordState {
  owner: number;
  projectId: string;
  state: AnalysisState;
  abort?: AbortController;
}

export class AnalysisController {
  private readonly records = new Map<string, RecordState>();
  private readonly epochs = new Map<number, number>();
  private readonly tests = new Map<number, AbortController>();
  private readonly settingsVersions = new Map<string, number>();
  private readonly runtimeSources = new Map<
    string,
    { owner: number; projectId: string; pending: Promise<SourceBundle> }
  >();
  private readonly readers = new Map<number, Set<AbortController>>();
  constructor(
    private readonly registry: ContextRegistry,
    private readonly arthas: ArthasService,
    private readonly settings: AnalysisSettingsStore,
    private readonly chooseRoot: (owner: number) => Promise<string | undefined>,
    private readonly emit: (owner: number, state: AnalysisState) => void,
  ) {}

  private project(owner: number): string {
    const context = this.registry.get(owner);
    if (context.kind !== 'workspace') throw new Error('请在项目工作区配置源码与AI');
    return context.projectId;
  }
  private task(owner: number, id: string) {
    const projectId = this.project(owner);
    const task = this.arthas
      .listTasks(owner)
      .find((task) => task.id === id && task.jvm.projectId === projectId);
    if (!task) throw new Error('诊断任务不属于当前工作区或已清除');
    if (!task.deep || !['ended', 'stopped', 'unknown', 'error'].includes(task.status))
      throw new Error('请等待深入诊断结束后再分析源码');
    return task;
  }
  private async context(
    owner: number,
    task: DiagnosticTask,
    settings: AnalysisSettings,
    signal: AbortSignal,
  ): Promise<SourceBundle> {
    if (settings.sourceMode === 'local') {
      if (!settings.sourceRoot)
        throw new Error('请在AI配置中选择本地源码目录，或改用Arthas运行源码');
      return collectSourceContext(settings.sourceRoot, task, signal);
    }
    const existing = this.runtimeSources.get(task.id);
    if (existing?.owner === owner) return structuredClone(await existing.pending);
    const epoch = this.epochs.get(owner) ?? 0;
    const pending = collectRuntimeSource(this.arthas, owner, task, signal).then((bundle) => {
      if ((this.epochs.get(owner) ?? 0) !== epoch) throw new Error('工作区已变化，源码读取已取消');
      this.task(owner, task.id);
      return bundle;
    });
    this.runtimeSources.set(task.id, { owner, projectId: task.jvm.projectId, pending });
    try {
      return structuredClone(await pending);
    } catch (error) {
      if (this.runtimeSources.get(task.id)?.pending === pending)
        this.runtimeSources.delete(task.id);
      throw error;
    }
  }
  register(handle: Register): void {
    handle(analysisChannels.configuration, (owner) =>
      this.settings.configuration(this.project(owner)),
    );
    handle(analysisChannels.save, async (owner, input) => {
      const projectId = this.project(owner);
      await this.settings.save(projectId, saveAnalysisSchema.parse(input));
      console.info('[analysis] settings saved', { projectId });
      this.settingsVersions.set(projectId, (this.settingsVersions.get(projectId) ?? 0) + 1);
      for (const record of this.records.values())
        if (record.projectId === projectId) this.cancel(record);
      this.tests.get(owner)?.abort();
      return this.settings.configuration(projectId);
    });
    handle(analysisChannels.chooseRoot, (owner) => {
      this.project(owner);
      return this.chooseRoot(owner);
    });
    handle(analysisChannels.test, async (owner) => {
      const projectId = this.project(owner);
      const epoch = this.epochs.get(owner) ?? 0;
      const { settings: saved, apiKey } = await this.settings.credentials(projectId, true);
      const settings = analysisSettingsSchema.parse({ ...saved, enabled: true, automatic: false });
      if ((this.epochs.get(owner) ?? 0) !== epoch || this.project(owner) !== projectId)
        throw new Error('工作区已变化，请重新测试');
      const abort = new AbortController();
      this.tests.get(owner)?.abort();
      this.tests.set(owner, abort);
      try {
        await testModel(
          settings,
          apiKey,
          AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
        );
      } catch (error) {
        if (abort.signal.aborted) throw new Error('连接测试已取消');
        throw new Error(
          error instanceof Error && error.message.startsWith('模型')
            ? error.message
            : '模型服务连接失败或超时，请检查地址及网络',
        );
      } finally {
        if (this.tests.get(owner) === abort) this.tests.delete(owner);
      }
      this.project(owner);
    });
    handle(analysisChannels.context, async (owner, input) => {
      const task = this.task(owner, z.string().parse(input));
      const configuration = await this.settings.configuration(task.jvm.projectId);
      const abort = new AbortController();
      const active = this.readers.get(owner) ?? new Set<AbortController>();
      active.add(abort);
      this.readers.set(owner, active);
      try {
        return await this.context(
          owner,
          task,
          configuration,
          AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
        );
      } finally {
        active.delete(abort);
        if (!active.size) this.readers.delete(owner);
      }
    });
    handle(analysisChannels.state, (owner, input) => {
      const id = z.string().parse(input);
      this.task(owner, id);
      const record = this.records.get(id);
      return record?.owner === owner
        ? structuredClone(record.state)
        : { taskId: id, status: 'idle' };
    });
    handle(analysisChannels.run, async (owner, input) => {
      const epoch = this.epochs.get(owner) ?? 0;
      const id = z.string().parse(input);
      const task = this.task(owner, id);
      const settingsVersion = this.settingsVersions.get(task.jvm.projectId) ?? 0;
      const existing = this.records.get(id);
      if (existing?.owner === owner && existing.state.status === 'running')
        return structuredClone(existing.state);
      const { settings, apiKey } = await this.settings.credentials(task.jvm.projectId);
      if (settings.sourceMode === 'local' && !settings.sourceRoot)
        throw new Error('请在AI配置中选择本地源码目录，或改用Arthas运行源码');
      this.task(owner, id);
      if ((this.epochs.get(owner) ?? 0) !== epoch) throw new Error('工作区已重新加载，请重新分析');
      if ((this.settingsVersions.get(task.jvm.projectId) ?? 0) !== settingsVersion)
        throw new Error('AI设置已变化，请重新分析');
      const pending = this.records.get(id);
      if (pending?.owner === owner && pending.state.status === 'running')
        return structuredClone(pending.state);
      const record: RecordState = {
        owner,
        projectId: task.jvm.projectId,
        state: { taskId: id, status: 'running' },
        abort: new AbortController(),
      };
      this.records.set(id, record);
      this.publish(record);
      void (async () => {
        try {
          const signal = AbortSignal.any([record.abort!.signal, AbortSignal.timeout(180000)]);
          const bundle = await this.context(owner, task, settings, signal);
          signal.throwIfAborted();
          console.info('[analysis] source request', {
            taskId: id,
            sourceCount: bundle.pieces.length,
          });
          const report = await analyzeSource(settings, apiKey, task.deep!, bundle, signal);
          if (settings.sourceMode === 'local')
            await verifySourceContext(settings.sourceRoot, bundle);
          signal.throwIfAborted();
          if ((this.epochs.get(owner) ?? 0) !== epoch) return;
          this.project(owner);
          record.state = { taskId: id, status: 'done', report };
          this.publish(record);
        } catch (error) {
          if ((this.epochs.get(owner) ?? 0) !== epoch || record.state.status === 'cancelled')
            return;
          const message = error instanceof Error ? error.message : '';
          // Do not return provider/network exception bodies, which may contain source or credentials.
          const safe =
            /^(?:模型|分析期间源码|源码|所选源码|此任务|深入|AI|Arthas|容器|连接|此JVM)/.test(
              message,
            )
              ? message
              : 'AI源码分析失败或超时，本地建议仍可使用';
          record.state = { taskId: id, status: 'error', error: safe };
          this.publish(record);
          console.warn('[analysis] request failed', { taskId: id });
        } finally {
          record.abort = undefined;
        }
      })();
      return structuredClone(record.state);
    });
    handle(analysisChannels.cancel, (owner, input) => {
      const id = z.string().parse(input);
      this.task(owner, id);
      const record = this.records.get(id);
      if (record?.owner === owner) this.cancel(record);
    });
  }
  private publish(record: RecordState): void {
    this.emit(record.owner, structuredClone(record.state));
  }
  private cancel(record: RecordState): void {
    if (record.state.status !== 'running') return;
    record.abort?.abort();
    record.state = { taskId: record.state.taskId, status: 'cancelled' };
    this.publish(record);
  }
  disposeOwner(owner: number): void {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    this.tests.get(owner)?.abort();
    this.tests.delete(owner);
    for (const reader of this.readers.get(owner) ?? []) reader.abort();
    this.readers.delete(owner);
    for (const [id, source] of this.runtimeSources)
      if (source.owner === owner) this.runtimeSources.delete(id);
    for (const [id, record] of this.records)
      if (record.owner === owner) {
        record.abort?.abort();
        this.records.delete(id);
      }
  }
  async removeProject(projectId: string): Promise<void> {
    for (const [id, source] of this.runtimeSources)
      if (source.projectId === projectId) this.runtimeSources.delete(id);
    for (const [id, record] of this.records)
      if (record.projectId === projectId) {
        record.abort?.abort();
        this.records.delete(id);
      }
    await this.settings.remove(projectId);
  }
}
