import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  analysisSettingsSchema,
  emptyAnalysisSettings,
  saveAnalysisSchema,
  type AnalysisConfiguration,
  type SaveAnalysisInput,
} from '../../shared/analysis';
import type { PasswordEncryption } from '../storage/password-store';

const schema = z.object({
  version: z.literal(1),
  projects: z.record(
    z.string(),
    z.object({ settings: analysisSettingsSchema, ciphertext: z.string().optional() }),
  ),
});

export class AnalysisSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly encryption: PasswordEncryption,
  ) {}

  private available(): boolean {
    return (
      this.encryption.isEncryptionAvailable() &&
      !(
        process.platform === 'linux' &&
        this.encryption.getSelectedStorageBackend?.() === 'basic_text'
      )
    );
  }
  private async read(): Promise<z.infer<typeof schema>> {
    try {
      return schema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: {} };
      throw new Error('AI配置文件无法读取，已有配置未被覆盖');
    }
  }
  async configuration(projectId: string): Promise<AnalysisConfiguration> {
    await this.queue;
    const entry = (await this.read()).projects[projectId];
    return {
      ...(entry?.settings ?? emptyAnalysisSettings()),
      keySaved: Boolean(entry?.ciphertext),
      keyStorageAvailable: this.available(),
    };
  }
  async credentials(
    projectId: string,
    allowDisabled = false,
  ): Promise<{ settings: z.infer<typeof analysisSettingsSchema>; apiKey: string }> {
    await this.queue;
    const entry = (await this.read()).projects[projectId];
    const settings = entry?.settings ?? emptyAnalysisSettings();
    if (!settings.enabled && !allowDisabled) throw new Error('AI未启用，本地建议仍可使用');
    if (!entry?.ciphertext) return { settings, apiKey: '' };
    if (!this.available()) throw new Error('系统安全存储不可用，无法读取AI密钥');
    try {
      return {
        settings,
        apiKey: this.encryption.decryptString(Buffer.from(entry.ciphertext, 'base64')),
      };
    } catch {
      throw new Error('AI密钥无法解密，请在设置中重新填写');
    }
  }
  save(projectId: string, input: SaveAnalysisInput): Promise<void> {
    const value = saveAnalysisSchema.parse(input);
    return this.mutate((data) => {
      const previous = data.projects[projectId];
      let ciphertext = value.clearKey ? undefined : previous?.ciphertext;
      // A saved credential must not silently move to a different model service.
      if (ciphertext && previous?.settings.baseUrl !== value.settings.baseUrl && !value.apiKey)
        throw new Error('修改API地址后，请重新填写密钥或勾选清除密钥');
      if (value.apiKey) {
        if (!this.available()) throw new Error('系统安全存储不可用，无法安全保存AI密钥');
        ciphertext = this.encryption.encryptString(value.apiKey).toString('base64');
      }
      data.projects[projectId] = { settings: value.settings, ciphertext };
    });
  }
  remove(projectId: string): Promise<void> {
    return this.mutate((data) => {
      delete data.projects[projectId];
    });
  }
  private mutate(change: (data: z.infer<typeof schema>) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const data = await this.read();
      change(data);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
