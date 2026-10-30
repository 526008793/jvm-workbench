import type { Server } from './models';

export type LogMode = 'new' | 'recent' | 'since' | 'range';
export type DiagnosticKind = 'trace' | 'watch' | 'exception' | 'monitor' | 'stack';

// Quote shell arguments literally; diagnostic templates use the separate Arthas command parser.
export function shellQuote(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('参数不能为空或包含换行');
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function buildLogCommand(
  container: string,
  mode: LogMode,
  lines: number,
  since: string,
  until = '',
): string {
  let scope = '--tail 0';
  if (mode === 'recent') {
    if (!Number.isInteger(lines) || lines < 0) throw new Error('日志行数需为非负整数');
    scope = `--tail ${lines}`;
  } else if (mode === 'since') {
    scope = `--since ${shellQuote(since)}`;
  } else if (mode === 'range') {
    const start = Date.parse(since);
    const end = until ? Date.parse(until) : undefined;
    if (!Number.isFinite(start)) throw new Error('请选择有效的日志开始时间');
    if (end !== undefined && (!Number.isFinite(end) || end <= start))
      throw new Error('日志结束时间必须晚于开始时间');
    // Absolute UTC timestamps keep the APP's selected time independent of the server timezone.
    scope = `--since ${shellQuote(new Date(start).toISOString())}`;
    if (end !== undefined) scope += ` --until ${shellQuote(new Date(end).toISOString())}`;
  }
  // A bounded history query completes on its own; an open end keeps following new output.
  const follow = mode === 'range' && until ? '' : ' --follow';
  return `docker logs${follow} ${scope} --timestamps -- ${shellQuote(container)}`;
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

// Credential submission and live sessions bind to connection-relevant fields, not a mutable display name.
export function connectionBinding(server: Server): string {
  return JSON.stringify([server.kind, server.host, server.port, server.username, server.assetName]);
}

// Target assets have independent PTYs but may share authentication to the same gateway account.
export function gatewayBinding(server: Server): string {
  return JSON.stringify([server.kind, server.host.toLowerCase(), server.port, server.username]);
}
