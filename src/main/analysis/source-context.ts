import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { DiagnosticTask } from '../../shared/arthas';
import type { SourceBundle, SourcePiece } from '../../shared/analysis';

// Preserve offsets/newlines while ignoring braces and fake method declarations in literals/comments.
function maskJava(text: string): string {
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    (value) => value.replace(/[^\r\n]/g, ' '),
  );
}
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function closePair(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return index;
  }
  return -1;
}
export function javaMethodRanges(text: string, name: string): { start: number; end: number }[] {
  const masked = maskJava(text);
  const pattern = new RegExp(`\\b${escape(name)}\\s*\\(`, 'g');
  const ranges: { start: number; end: number }[] = [];
  for (const match of masked.matchAll(pattern)) {
    const before = masked.slice(0, match.index);
    const boundary =
      Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1;
    const prefix = masked.slice(boundary, match.index);
    if (!/[\w$>\]]\s+$/.test(prefix) || /\b(?:return|throw|new)\s+$/.test(prefix)) continue;
    const parameterEnd = closePair(masked, masked.indexOf('(', match.index), '(', ')');
    if (parameterEnd < 0) continue;
    const tail = /^\s*(?:throws\s+[\w$.,\s]+)?([;{])/.exec(masked.slice(parameterEnd + 1));
    if (!tail) continue;
    const bodyStart = parameterEnd + tail[0].length;
    const end = tail[1] === ';' ? bodyStart : closePair(masked, bodyStart, '{', '}');
    if (end < 0) continue;
    const nonspace = /\S/.exec(masked.slice(boundary, match.index));
    const declaration = boundary + (nonspace?.index ?? 0);
    const start = text.lastIndexOf('\n', declaration - 1) + 1;
    ranges.push({ start, end: end + 1 });
  }
  return ranges;
}
const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

export async function collectSourceContext(
  rootPath: string,
  task: DiagnosticTask,
  signal?: AbortSignal,
): Promise<SourceBundle> {
  if (!task.deep || !task.deep.samples)
    throw new Error('此任务没有有效深入采样，暂不能结合源码分析');
  const root = await realpath(rootPath);
  const files: string[] = [];
  const skipped = new Set([
    '.git',
    '.idea',
    'node_modules',
    'target',
    'build',
    'dist',
    'out',
    'output',
  ]);
  async function walk(directory: string): Promise<void> {
    signal?.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || skipped.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test') await walk(path);
      } else if (/\.(?:java|xml)$/.test(entry.name)) files.push(path);
    }
  }
  await walk(root);
  const contents = new Map<string, string>();
  const pieces = new Map<string, SourcePiece>();
  const notes = new Set<string>();
  async function read(path: string): Promise<string> {
    signal?.throwIfAborted();
    const actual = await realpath(path);
    const local = relative(root, actual);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error('源码文件不在所选项目目录内');
    if (!contents.has(path)) contents.set(path, await readFile(actual, 'utf8'));
    return contents.get(path)!;
  }
  function add(
    path: string,
    text: string,
    start: number,
    end: number,
    method: string,
    kind: SourcePiece['kind'],
    match: SourcePiece['match'],
    context = '',
  ): void {
    const key = `${path}:${start}:${end}`;
    const existing = pieces.get(key);
    if (existing) {
      if (match === 'line') existing.match = match;
      return;
    }
    pieces.set(key, {
      id: `S${pieces.size + 1}`,
      origin: 'local',
      kind,
      method,
      context,
      path: relative(root, path).split(sep).join('/'),
      startLine: lineAt(text, start),
      endLine: lineAt(text, end - 1),
      text: text.slice(start, end),
      match,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  }
  const mapperTargets = new Map<string, Set<string>>();
  const targets = task.deep.paths.flatMap((path) => path.frames);
  if (
    !targets.some(
      (target) =>
        target.className === task.deep!.entryClass && target.methodName === task.deep!.entryMethod,
    )
  )
    targets.push({ className: task.deep.entryClass, methodName: task.deep.entryMethod });
  for (const target of targets) {
    signal?.throwIfAborted();
    const runtimeClass = target.className.replace(/\$\$.*$/, '');
    const className = runtimeClass.split('$')[0];
    const suffix = className.replaceAll('.', sep) + '.java';
    const candidates = files.filter((path) => path.endsWith(`${sep}${suffix}`));
    if (candidates.length > 1) {
      notes.add(`${className}匹配多个模块，未自动选择，请缩小源码目录`);
      continue;
    }
    if (!candidates.length) continue;
    const path = candidates[0];
    const text = await read(path);
    const packageName = className.slice(0, className.lastIndexOf('.'));
    if (!new RegExp(`\\bpackage\\s+${escape(packageName)}\\s*;`).test(maskJava(text))) continue;
    const methodName = target.methodName.replace(/^lambda\$(.+)\$\d+$/, '$1');
    if (!/^[\w$]+$/.test(methodName)) continue;
    const ranges = javaMethodRanges(text, methodName);
    const runtimeLine =
      'lineNumber' in target && typeof target.lineNumber === 'number'
        ? target.lineNumber
        : undefined;
    const aligned = ranges.filter(
      (range) =>
        runtimeLine !== undefined &&
        runtimeLine >= lineAt(text, range.start) &&
        runtimeLine <= lineAt(text, range.end - 1),
    );
    const selected = aligned.length ? aligned : ranges;
    if (!selected.length) {
      notes.add(
        `${className}#${target.methodName}未找到可读方法，可能由编译器生成或源码版本不一致`,
      );
      continue;
    }
    if (!aligned.length && runtimeLine !== undefined && runtimeLine > 0)
      notes.add(`${className}#${methodName}运行时行号与方法范围不一致，未确认部署源码版本`);
    const imports = new Map(
      [...text.matchAll(/\bimport\s+([\w$.]+);/g)].map((match) => [
        match[1].split('.').at(-1)!,
        match[1],
      ]),
    );
    const fields = [
      ...maskJava(text).matchAll(
        /\b(?:private|protected|public)\s+(?:final\s+)?([\w$.<>]+)\s+(\w+)\s*[;=]/g,
      ),
    ];
    const context =
      [...text.matchAll(/^\s*(?:package|import)\s+[^;]+;/gm)]
        .map((match) => match[0].trim())
        .join('\n') +
      '\n' +
      fields.map((field) => `${field[1]} ${field[2]};`).join('\n');
    for (const range of selected) {
      add(
        path,
        text,
        range.start,
        range.end,
        `${runtimeClass}#${methodName}`,
        'java',
        aligned.length ? 'line' : 'method',
        context,
      );
      const body = maskJava(text.slice(range.start, range.end));
      for (const field of fields) {
        const type =
          imports.get(field[1]) ??
          (field[1].includes('.') ? field[1] : `${packageName}.${field[1]}`);
        if (!type.endsWith('Mapper')) continue;
        for (const call of body.matchAll(
          new RegExp(`\\b${escape(field[2])}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g'),
        )) {
          const names = mapperTargets.get(type) ?? new Set<string>();
          names.add(call[1]);
          mapperTargets.set(type, names);
        }
      }
    }
    if (className.endsWith('Mapper')) {
      const names = mapperTargets.get(className) ?? new Set<string>();
      names.add(methodName);
      mapperTargets.set(className, names);
    }
  }
  for (const [namespace, names] of mapperTargets) {
    const xmls = files.filter((path) => basename(path) === `${namespace.split('.').at(-1)}.xml`);
    for (const path of xmls) {
      const text = await read(path);
      const searchable = text.replace(/<!--[\s\S]*?-->/g, (value) =>
        value.replace(/[^\r\n]/g, ' '),
      );
      if (!new RegExp(`<mapper\\b[^>]*namespace=["']${escape(namespace)}["']`).test(searchable))
        continue;
      const queue = [...names];
      const seen = new Set<string>();
      for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);
        const expression = new RegExp(
          `<((?:select|insert|update|delete|sql))\\b[^>]*\\bid=["']${escape(name)}["'][^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
          'g',
        );
        for (const block of searchable.matchAll(expression)) {
          add(
            path,
            text,
            block.index,
            block.index + block[0].length,
            `${namespace}#${name}`,
            'sql',
            'sql',
          );
          for (const include of block[0].matchAll(/<include\b[^>]*refid=["']([\w$.]+)["']/g)) {
            if (!include[1].includes('.')) queue.push(include[1]);
            else notes.add(`SQL片段${include[1]}为跨namespace引用，当前未展开`);
          }
        }
      }
    }
  }
  if (!pieces.size)
    throw new Error('所选源码中未匹配到采样业务方法，请选择与部署版本对应的Java项目目录');
  return { origin: 'local', pieces: [...pieces.values()], notes: [...notes] };
}

export async function verifySourceContext(rootPath: string, bundle: SourceBundle): Promise<void> {
  const root = await realpath(rootPath);
  for (const piece of bundle.pieces) {
    const path = await realpath(join(root, piece.path));
    const local = relative(root, path);
    if (local.startsWith(`..${sep}`) || local === '..' || isAbsolute(local))
      throw new Error('源码位置已变化，请重新分析');
    const digest = createHash('sha256')
      .update(await readFile(path, 'utf8'))
      .digest('hex');
    if (digest !== piece.sha256) throw new Error('分析期间源码已修改，请重新分析');
  }
}
