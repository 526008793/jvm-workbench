export type LogMode = 'new' | 'recent' | 'since';
export type DiagnosticKind = 'trace' | 'watch' | 'exception' | 'monitor' | 'stack';

// Commands are copied for manual use in this milestone; nothing here executes a remote shell.
export function shellQuote(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('参数不能为空或包含换行');
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function buildLogCommand(
  container: string,
  mode: LogMode,
  lines: number,
  since: string,
): string {
  let scope = '--tail 0';
  if (mode === 'recent') {
    if (!Number.isInteger(lines) || lines < 0) throw new Error('日志行数需为非负整数');
    scope = `--tail ${lines}`;
  } else if (mode === 'since') {
    scope = `--since ${shellQuote(since)}`;
  }
  return `docker logs --follow ${scope} --timestamps -- ${shellQuote(container)}`;
}

export function buildDiagnosticCommand(
  kind: DiagnosticKind,
  className: string,
  method: string,
  cost: number,
  count: number,
): string {
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(className))
    throw new Error('请输入完整 Java 类名');
  if (!/^[A-Za-z_$][\w$]*$/.test(method)) throw new Error('请输入具体方法名');
  if (kind !== 'monitor' && (!Number.isInteger(count) || count < 1))
    throw new Error('采集次数需为正整数');
  if (kind === 'trace' && (!Number.isFinite(cost) || cost < 0)) throw new Error('耗时条件无效');
  const target = `${className} ${method}`;
  switch (kind) {
    case 'trace':
      return `trace ${target} '#cost > ${cost}' -n ${count}`;
    case 'watch':
      return `watch ${target} '{params,returnObj}' -s -x 2 -n ${count}`;
    case 'exception':
      return `watch ${target} '{params,throwExp}' -e -x 2 -n ${count}`;
    case 'monitor':
      return `monitor -c 5 ${target}`;
    case 'stack':
      return `stack ${target} -n ${count}`;
  }
}
