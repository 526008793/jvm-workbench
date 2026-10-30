import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Project, Server } from '../../shared/models';
import { gatewayBinding } from '../../shared/commands';

export interface PasswordEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
export interface PasswordScope {
  projectId: string;
  environmentId: string;
  server: Server;
}
const schema = z.object({
  schemaVersion: z.literal(1),
  passwords: z.record(
    z.string(),
    z.object({ projectId: z.string(), ciphertext: z.string().min(1) }),
  ),
});

// Only OS-encrypted bytes are persisted. The renderer can query presence, never retrieve a password.
export class PasswordStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly encryption: PasswordEncryption,
  ) {}

  available(): boolean {
    return (
      this.encryption.isEncryptionAvailable() &&
      !(
        process.platform === 'linux' &&
        this.encryption.getSelectedStorageBackend?.() === 'basic_text'
      )
    );
  }
  prepare(password: string): Buffer {
    if (!this.available())
      throw new Error('系统安全存储不可用，无法记住密码；可取消勾选后仅用于本次连接');
    try {
      return this.encryption.encryptString(password);
    } catch {
      throw new Error('密码加密失败，未保存；可取消勾选后仅用于本次连接');
    }
  }
  async status(scope: PasswordScope): Promise<{ available: boolean; remembered: boolean }> {
    await this.queue;
    return {
      available: this.available(),
      remembered: Boolean((await this.read()).passwords[this.key(scope)]),
    };
  }
  async get(scope: PasswordScope): Promise<string> {
    if (!this.available()) throw new Error('系统安全存储不可用，请重新输入本次连接密码');
    await this.queue;
    const entry = (await this.read()).passwords[this.key(scope)];
    if (!entry) throw new Error('已记住的密码不存在，请重新输入');
    try {
      return this.encryption.decryptString(Buffer.from(entry.ciphertext, 'base64'));
    } catch {
      throw new Error('无法解密已记住的密码，请忘记后重新输入');
    }
  }
  remember(scope: PasswordScope, encrypted: Buffer): Promise<void> {
    const key = this.key(scope);
    return this.update((data) => {
      data.passwords[key] = {
        projectId: scope.projectId,
        ciphertext: encrypted.toString('base64'),
      };
      return true;
    });
  }
  forget(scope: PasswordScope): Promise<void> {
    const key = this.key(scope);
    return this.update((data) => {
      if (!data.passwords[key]) return false;
      delete data.passwords[key];
      return true;
    });
  }
  reconcile(project: Project): Promise<void> {
    const allowed = new Set(
      project.environments.flatMap((environment) =>
        environment.servers.map((server) =>
          this.key({ projectId: project.id, environmentId: environment.id, server }),
        ),
      ),
    );
    return this.update((data) => {
      let changed = false;
      for (const [key, value] of Object.entries(data.passwords)) {
        if (value.projectId === project.id && !allowed.has(key)) {
          delete data.passwords[key];
          changed = true;
        }
      }
      return changed;
    });
  }
  removeProject(projectId: string): Promise<void> {
    return this.update((data) => {
      let changed = false;
      for (const [key, value] of Object.entries(data.passwords)) {
        if (value.projectId === projectId) {
          delete data.passwords[key];
          changed = true;
        }
      }
      return changed;
    });
  }
  private key(scope: PasswordScope): string {
    return createHash('sha256')
      .update(JSON.stringify([scope.projectId, scope.environmentId, gatewayBinding(scope.server)]))
      .digest('hex');
  }
  private async read(): Promise<z.infer<typeof schema>> {
    try {
      return schema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: 1, passwords: {} };
      throw new Error('密码存储文件无法读取，未覆盖原文件');
    }
  }
  private update(change: (data: z.infer<typeof schema>) => boolean): Promise<void> {
    const operation = this.queue.then(async () => {
      const data = await this.read();
      if (!change(data)) return;
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
