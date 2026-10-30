import { z } from 'zod';
import { buildDiagnosticCommand } from './commands';
import { deepWatchCommand, type DeepProfile } from './deep';

export const ARTHAS_VERSION = '4.0.5';
export const ARTHAS_DEFAULT_HOME = `/tmp/tracelogdock-arthas-${ARTHAS_VERSION}`;
export const jvmTargetSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  serviceId: z.string().min(1),
  instanceId: z.string().min(1),
});
export const jvmSchema = jvmTargetSchema.extend({
  serverId: z.string().min(1),
  connectionId: z.string().min(1),
  containerName: z.string().min(1),
  containerId: z.string().regex(/^[a-f\d]{12,64}$/),
  startedAt: z.string().min(1),
  pid: z.number().int().positive(),
  uid: z.string().regex(/^\d+$/),
  startTicks: z.string().regex(/^\d+$/),
  java: z.string().startsWith('/'),
});
export const attachSchema = z.object({
  jvm: jvmSchema,
  home: z
    .string()
    .startsWith('/')
    .refine((s) => !/[\r\n\0]/.test(s)),
  port: z.number().int().min(1024).max(65535),
});
export const methodSchema = z.object({
  className: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/),
  methodName: z.string().regex(/^[A-Za-z_$][\w$]*$/),
  classLoaderHash: z.string().regex(/^[a-f\d]+$/i),
  parameters: z.array(z.string()),
  returnType: z.string(),
  descriptor: z.string(),
  modifier: z.string().optional(),
});
export const traceScopeSchema = z.object({
  agentId: z.string().min(1),
  classLoaderHash: methodSchema.shape.classLoaderHash,
  classes: z.array(methodSchema.shape.className).min(1, '请填写追踪类'),
  methods: z
    .array(z.union([methodSchema.shape.methodName, z.literal('*')]))
    .min(1, '请填写追踪方法'),
});
export const diagnosticSchema = z
  .object({
    agentId: z.string().min(1),
    method: methodSchema,
    kind: z.enum(['deep', 'trace', 'trace-multi', 'watch', 'exception', 'monitor', 'stack']),
    cost: z.number().finite().nonnegative(),
    count: z.number().int().positive(),
    duration: z.number().int().positive(),
    scope: z.array(methodSchema).optional(),
    sampleIntervalMs: z.number().int().positive().optional(),
  })
  .superRefine((input, context) => {
    if (input.kind !== 'trace-multi') return;
    if (!input.scope?.length)
      context.addIssue({ code: 'custom', message: '请先核对多层追踪范围', path: ['scope'] });
    if (
      !input.scope?.some(
        (method) =>
          method.className === input.method.className &&
          method.methodName === input.method.methodName,
      )
    )
      context.addIssue({
        code: 'custom',
        message: '追踪范围必须包含所选入口方法',
        path: ['scope'],
      });
    if (input.scope?.some((method) => method.classLoaderHash !== input.method.classLoaderHash))
      context.addIssue({
        code: 'custom',
        message: '多层追踪方法必须属于同一ClassLoader',
        path: ['scope'],
      });
  });
export type TraceScopeInput = z.infer<typeof traceScopeSchema>;
export type JvmTarget = z.infer<typeof jvmTargetSchema>;
export type Jvm = z.infer<typeof jvmSchema>;
export type AttachInput = z.infer<typeof attachSchema>;
export type MethodCandidate = z.infer<typeof methodSchema>;
export type DiagnosticInput = z.infer<typeof diagnosticSchema>;
export interface ArthasAgent {
  id: string;
  jvm: Jvm;
  version: string;
  port: number;
}
export interface DiagnosticTask {
  id: string;
  agentId: string;
  jvm: Jvm;
  command: string;
  status:
    'submitted' | 'waiting' | 'results' | 'stopping' | 'stopped' | 'ended' | 'error' | 'unknown';
  error?: string;
  results: Record<string, unknown>[];
  scope?: MethodCandidate[];
  method?: MethodCandidate;
  deep?: DeepProfile;
}
export function diagnosticCommand(input: DiagnosticInput): string {
  const value = diagnosticSchema.parse(input);
  const { kind, method, cost, count } = value;
  if (kind === 'deep') return deepWatchCommand(method);
  if (kind === 'trace-multi') {
    const patterns = multiTracePatterns(
      value.scope!.map((method) => method.className),
      value.scope!.map((method) => method.methodName),
    );
    // Nested trace advice has a separate condition timer. Collect the complete call, then rank the tree.
    // Only an outer invocation of the selected entry may complete this task. A helper called
    // independently by another endpoint must not consume the single requested sample.
    const entryCondition = `'clazz.name=="${method.className}" && method.name=="${method.methodName}"'`;
    return `trace -E ${patterns.classes} ${patterns.methods} ${entryCondition} --exclude-class-pattern ${patterns.excluded} -n ${count} -c ${method.classLoaderHash}`;
  }
  const loader = `${kind === 'monitor' ? '--classloader' : '-c'} ${method.classLoaderHash}`;
  return `${buildDiagnosticCommand(kind, method.className, method.methodName, cost, count)} ${loader}`;
}

export interface ArthasAttachProgress {
  jvm: Jvm;
  stage: 'checking' | 'installing' | 'attaching' | 'bootstrapping' | 'verifying';
}

export function multiTracePatterns(
  classes: string[],
  methods: string[],
): { classes: string; methods: string; excluded: string } {
  const input = traceScopeSchema.pick({ classes: true, methods: true }).parse({ classes, methods });
  const literal = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Quoted Arthas arguments preserve regex backslashes; only the outer shell/JSON layer escapes them.
  const quote = (value: string): string => `'${value}'`;
  const classNames = [...new Set(input.classes)].map(literal).join('|');
  const methodNames = input.methods.includes('*')
    ? '.*'
    : [...new Set(input.methods)].map(literal).join('|');
  return {
    classes: quote(`^(?:${classNames})$`),
    methods: quote(`^(?:${methodNames})$`),
    excluded: quote(`^(?!(?:${classNames})$).*$`),
  };
}

export function sameJvm(left: Jvm, right: Jvm): boolean {
  // PID alone can be reused after a deployment; container and process start identities must agree.
  return (Object.keys(jvmSchema.shape) as (keyof Jvm)[]).every((key) => left[key] === right[key]);
}
