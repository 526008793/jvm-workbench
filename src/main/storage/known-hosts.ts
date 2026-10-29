import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const schema = z.object({ schemaVersion: z.literal(1), hosts: z.record(z.string(), z.string()) });
export class KnownHosts {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private async read(): Promise<z.infer<typeof schema>> {
    try {
      return schema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: 1, hosts: {} };
      throw new Error('SSH主机信任文件无法读取，未覆盖原文件', { cause: error });
    }
  }
  async lookup(host: string, port: number): Promise<string | undefined> {
    await this.queue;
    return (await this.read()).hosts[JSON.stringify([host.toLowerCase(), port])];
  }
  remember(host: string, port: number, fingerprint: string): Promise<void> {
    const operation = this.queue.then(async () => {
      const data = await this.read();
      const key = JSON.stringify([host.toLowerCase(), port]);
      if (data.hosts[key] && data.hosts[key] !== fingerprint)
        throw new Error('主机身份已变化，拒绝覆盖已有信任');
      data.hosts[key] = fingerprint;
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
