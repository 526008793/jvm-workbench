import { createHash } from 'node:crypto';
import { methodSchema, type DiagnosticTask } from '../../shared/arthas';
import type { SourceBundle, SourcePiece } from '../../shared/analysis';
import { ArthasService } from '../arthas/arthas-service';
import { javaMethodRanges } from './source-context';

export async function collectRuntimeSource(
  arthas: ArthasService,
  owner: number,
  task: DiagnosticTask,
  signal?: AbortSignal,
): Promise<SourceBundle> {
  if (!task.deep || !task.deep.samples)
    throw new Error('此任务没有有效深入采样，暂不能读取运行源码');
  if (
    arthas
      .listTasks(owner)
      .some(
        (candidate) =>
          candidate.agentId === task.agentId &&
          ['submitted', 'waiting', 'results', 'stopping'].includes(candidate.status),
      )
  )
    throw new Error('此JVM仍有诊断运行，请结束后再读取运行源码');
  arthas.getAgent(owner, task.agentId);
  const namespace = task.deep.entryClass.split('.').slice(0, 2).join('.') + '.';
  const targets = new Map<string, Set<string>>();
  for (const frame of [
    ...task.deep.paths.flatMap((path) => path.frames),
    { className: task.deep.entryClass, methodName: task.deep.entryMethod },
  ]) {
    const className = frame.className.replace(/\$\$.*$/, '');
    const methodName = frame.methodName.replace(/^lambda\$(.+)\$\d+$/, '$1');
    if (
      !className.startsWith(namespace) ||
      !methodSchema.shape.className.safeParse(className).success ||
      !methodSchema.shape.methodName.safeParse(methodName).success
    )
      continue;
    const names = targets.get(className) ?? new Set<string>();
    names.add(methodName);
    targets.set(className, names);
  }
  const notes = new Set<string>([
    `运行源码读取时间：${new Date().toISOString()}；重复查看或分析复用该任务的此份快照。`,
    '源码来自该任务原JVM的Arthas jad反编译；注释、原始变量名及Mapper XML可能不可用，片段行号不是原始Java源码行号。',
    `读取对象：容器${task.jvm.containerId.slice(0, 12)} · PID ${task.jvm.pid}；源码为读取时版本，不能排除采样后热更新。`,
  ]);
  const pieces: SourcePiece[] = [];
  const classes = new Map<string, string>();
  for (const [className, names] of targets) {
    for (const name of names) {
      signal?.throwIfAborted();
      // Resolve the callee loader here; it may differ from the entry or thread context.
      const found = (await arthas.search(owner, task.agentId, `${className}#${name}`, '')).filter(
        (method) => method.className === className && method.methodName === name,
      );
      let loaders = [...new Set(found.map((method) => method.classLoaderHash))];
      if (className === task.method?.className && name === task.method.methodName)
        loaders = loaders.filter((loader) => loader === task.method!.classLoaderHash);
      if (loaders.length !== 1) {
        notes.add(`${className}#${name}未匹配唯一的真实ClassLoader，未猜测源码`);
        continue;
      }
      const loader = loaders[0];
      const key = `${className}:${loader}`;
      // jad reconstructs the whole class once; only sampled methods enter the analysis bundle.
      if (!classes.has(key))
        classes.set(key, await arthas.decompile(owner, task.agentId, className, loader));
      signal?.throwIfAborted();
      const source = classes.get(key)!;
      const ranges = javaMethodRanges(source, name);
      if (!ranges.length) {
        notes.add(`${className}#${name}未提取到反编译方法，可能为抽象、本地或继承方法`);
        continue;
      }
      const header = [...source.matchAll(/^\s*(?:package|import)\s+[^;]+;/gm)]
        .map((match) => match[0].trim())
        .join('\n');
      for (const range of ranges) {
        const text = source.slice(range.start, range.end);
        if (/This method has failed to decompile|Could not decompile/i.test(text)) {
          notes.add(`${className}#${name}反编译不完整，未作为有效代码依据`);
          continue;
        }
        pieces.push({
          id: `S${pieces.length + 1}`,
          origin: 'arthas',
          kind: 'decompiled',
          match: 'runtime',
          path: `Arthas/${className.replaceAll('.', '/')}.java`,
          startLine: source.slice(0, range.start).split('\n').length,
          endLine: source.slice(0, range.end - 1).split('\n').length,
          method: `${className}#${name}`,
          text,
          context: `${header}\n真实ClassLoader：${loader}；行号为反编译输出行号，同名重载可能同时包含。`,
          sha256: createHash('sha256').update(source).digest('hex'),
        });
      }
    }
  }
  signal?.throwIfAborted();
  if (!pieces.length)
    throw new Error('Arthas未取得可分析的运行方法源码，请核对JVM、加载器与方法实现');
  notes.add('运行源码未自动读取Mapper XML或数据库执行计划，不据反编译结果断言缺索引。');
  return { origin: 'arthas', pieces, notes: [...notes] };
}
