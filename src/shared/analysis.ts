import { z } from 'zod';

export const analysisSettingsSchema = z
  .object({
    sourceRoot: z.string().trim(),
    sourceMode: z.enum(['arthas', 'local']).default('local'),
    enabled: z.boolean(),
    automatic: z.boolean(),
    baseUrl: z.string().trim(),
    model: z.string().trim(),
  })
  .superRefine((settings, context) => {
    if (!settings.enabled) return;
    try {
      const url = new URL(settings.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        throw new Error();
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: '请输入不含账号密码的HTTP或HTTPS模型API地址',
      });
    }
    if (!settings.model)
      context.addIssue({ code: 'custom', path: ['model'], message: '请输入模型名称' });
    if (settings.automatic && settings.sourceMode === 'local' && !settings.sourceRoot)
      context.addIssue({
        code: 'custom',
        path: ['sourceRoot'],
        message: '自动分析需要先关联本地源码目录',
      });
  });
export const saveAnalysisSchema = z.object({
  settings: analysisSettingsSchema,
  apiKey: z.string().trim().optional(),
  clearKey: z.boolean().optional(),
});
export type AnalysisSettings = z.infer<typeof analysisSettingsSchema>;
export type SaveAnalysisInput = z.infer<typeof saveAnalysisSchema>;
export interface AnalysisConfiguration extends AnalysisSettings {
  keySaved: boolean;
  keyStorageAvailable: boolean;
}
export const emptyAnalysisSettings = (): AnalysisSettings => ({
  sourceRoot: '',
  sourceMode: 'arthas',
  enabled: false,
  automatic: false,
  baseUrl: '',
  model: '',
});
export interface SourcePiece {
  id: string;
  kind: 'java' | 'sql' | 'decompiled';
  path: string;
  startLine: number;
  endLine: number;
  method: string;
  text: string;
  context: string;
  match: 'line' | 'method' | 'sql' | 'runtime';
  origin?: 'arthas' | 'local';
  sha256: string;
}
export interface SourceBundle {
  origin?: 'arthas' | 'local';
  pieces: SourcePiece[];
  notes: string[];
}
export const aiReportSchema = z.object({
  summary: z.string().trim().min(1),
  findings: z.array(
    z.object({
      title: z.string().trim().min(1),
      conclusion: z.string().trim().min(1),
      evidenceLevel: z.enum(['code-observation', 'needs-verification']),
      evidenceIds: z.array(z.string().min(1)).min(1),
      suggestions: z.array(z.string().trim().min(1)).min(1),
    }),
  ),
  checks: z.array(z.string().trim().min(1)),
});
export type AiReport = z.infer<typeof aiReportSchema> & {
  model: string;
  createdAt: string;
  sources: SourcePiece[];
  notes: string[];
};
export interface AnalysisState {
  taskId: string;
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  report?: AiReport;
  error?: string;
}
