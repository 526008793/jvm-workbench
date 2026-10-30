import { methodSchema, type MethodCandidate } from './arthas';

export interface TraceCall {
  id: string;
  className: string;
  methodName: string;
  caller: string;
  lineNumber?: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
  times: number;
  percent: number;
}
export interface TraceSample {
  id: string;
  timestamp: string;
  threadName: string;
  totalMs: number;
  calls: TraceCall[];
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function traceSamples(results: Record<string, unknown>[]): TraceSample[] {
  return results.flatMap((result, index) => {
    const root = object(result.root);
    if (result.type !== 'trace' || !root) return [];
    const children = (node: Record<string, unknown>): Record<string, unknown>[] =>
      Array.isArray(node.children)
        ? node.children.flatMap((value) => {
            const item = object(value);
            return item ? [item] : [];
          })
        : [];
    const milliseconds = (node: Record<string, unknown>): number =>
      (nonnegative(node.totalCost) ? node.totalCost : nonnegative(node.cost) ? node.cost : 0) / 1e6;
    // A thread contains top-level invocation(s). Do not sum descendants: their time overlaps.
    const entries = root.type === 'method' ? [root] : children(root);
    const totalMs = entries.reduce((sum, node) => sum + milliseconds(node), 0);
    const calls: TraceCall[] = [];
    function visit(node: Record<string, unknown>, caller: string, path: string): void {
      const className = typeof node.className === 'string' ? node.className : '';
      const methodName = typeof node.methodName === 'string' ? node.methodName : '';
      const nested = children(node);
      const label = className && methodName ? `${className}#${methodName}` : caller;
      const proxyWrapper =
        className === 'org.springframework.cglib.proxy.MethodInterceptor' && nested.length > 0;
      // Invocation entries supply context/total time. Rank actual call sites, hiding proxy wrappers.
      if (
        node.type === 'method' &&
        node.invoking !== false &&
        !proxyWrapper &&
        className &&
        methodName
      ) {
        const times = nonnegative(node.times) && node.times >= 1 ? node.times : 1;
        const total = milliseconds(node);
        calls.push({
          id: path,
          className,
          methodName,
          caller,
          lineNumber: nonnegative(node.lineNumber) ? node.lineNumber : undefined,
          totalMs: total,
          averageMs: total / times,
          maxMs: nonnegative(node.maxCost) ? node.maxCost / 1e6 : total / times,
          times,
          percent: totalMs > 0 ? (total / totalMs) * 100 : 0,
        });
      }
      nested.forEach((child, childIndex) => visit(child, label, `${path}.${childIndex}`));
    }
    visit(root, '', 'root');
    calls.sort((a, b) => b.totalMs - a.totalMs);
    return [
      {
        id: `trace-${index}`,
        timestamp: String(root.timestamp ?? ''),
        threadName: String(root.threadName ?? ''),
        totalMs,
        calls,
      },
    ];
  });
}

export function traceMethodTarget(
  call: Pick<TraceCall, 'className' | 'methodName'>,
): { className: string; methodName: string } | undefined {
  const className = call.className.replace(/\$\$SpringCGLIB\$\$.*$/, '');
  if (
    !methodSchema.shape.className.safeParse(className).success ||
    !methodSchema.shape.methodName.safeParse(call.methodName).success
  )
    return undefined;
  return { className, methodName: call.methodName };
}

export function canEnhanceMethod(method: MethodCandidate): boolean {
  return !/\b(?:abstract|native)\b/.test(method.modifier ?? '');
}

export function traceDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(3)} 秒` : `${ms.toFixed(3)} 毫秒`;
}
