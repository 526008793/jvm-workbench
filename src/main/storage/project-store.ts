import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  configSchema,
  createProjectSchema,
  projectSchema,
  validateProjectReferences,
  type AppConfig,
  type CreateProject,
  type Project,
} from '../../shared/models';

export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async read(): Promise<AppConfig> {
    try {
      const config = configSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      const ids = new Set<string>();
      for (const project of config.projects) {
        if (ids.has(project.id)) throw new Error('项目标识重复');
        ids.add(project.id);
        validateProjectReferences(project);
      }
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: 1, projects: [] };
      throw new Error('项目配置无法读取，请检查配置文件；已有内容未被覆盖', { cause: error });
    }
  }

  async list(): Promise<Project[]> {
    await this.queue;
    return (await this.read()).projects;
  }

  // All windows share this queue. Atomic replacement avoids partial JSON and revision checks prevent stale writes.
  private mutate<T>(update: (config: AppConfig) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const config = await this.read();
      const result = update(config);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  create(input: CreateProject): Promise<Project> {
    const values = createProjectSchema.parse(input);
    return this.mutate((config) => {
      const project: Project = {
        id: randomUUID(),
        name: values.name,
        description: values.description,
        revision: 0,
        environments: [
          { id: randomUUID(), name: values.environmentName, servers: [], services: [] },
        ],
      };
      config.projects.push(project);
      return project;
    });
  }

  save(input: Project): Promise<Project> {
    const project = projectSchema.parse(input);
    validateProjectReferences(project);
    return this.mutate((config) => {
      const index = config.projects.findIndex((value) => value.id === project.id);
      if (index < 0) throw new Error('项目不存在');
      if (config.projects[index].revision !== project.revision)
        throw new Error('配置已在其他窗口更新，请重新打开编辑后保存');
      const saved = { ...project, revision: project.revision + 1 };
      config.projects[index] = saved;
      return saved;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((config) => {
      const index = config.projects.findIndex((project) => project.id === id);
      if (index < 0) throw new Error('项目不存在');
      config.projects.splice(index, 1);
    });
  }
}
