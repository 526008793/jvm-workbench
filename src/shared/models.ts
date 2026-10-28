import { z } from 'zod';

const id = z.string().min(1);
const name = z.string().trim().min(1, '名称不能为空');

export const serverSchema = z.object({
  id,
  name,
  kind: z.enum(['ssh', 'jumpserver']),
  host: z.string().trim().min(1, '请输入连接地址'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1, '请输入登录用户'),
  assetName: z.string().trim(),
});
export const instanceSchema = z.object({ id, serverId: id, containerName: name });
export const serviceSchema = z.object({ id, name, instances: z.array(instanceSchema) });
export const environmentSchema = z.object({
  id,
  name,
  servers: z.array(serverSchema),
  services: z.array(serviceSchema),
});
export const projectSchema = z.object({
  id,
  name,
  description: z.string().trim(),
  revision: z.number().int().nonnegative(),
  environments: z.array(environmentSchema).min(1, '项目至少保留一个环境'),
});
export const configSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(projectSchema),
});
export const createProjectSchema = z.object({
  name,
  description: z.string().trim(),
  environmentName: name,
});
export type Server = z.infer<typeof serverSchema>;
export type ServiceInstance = z.infer<typeof instanceSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type Environment = z.infer<typeof environmentSchema>;
export type Project = z.infer<typeof projectSchema>;
export type AppConfig = z.infer<typeof configSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type WindowContext = { kind: 'manager' } | { kind: 'workspace'; projectId: string };
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DesktopApi {
  context(): Promise<ApiResult<WindowContext>>;
  listProjects(): Promise<ApiResult<Project[]>>;
  createProject(input: CreateProject): Promise<ApiResult<Project>>;
  saveProject(project: Project): Promise<ApiResult<Project>>;
  deleteProject(id: string): Promise<ApiResult<void>>;
  openProject(id: string): Promise<ApiResult<void>>;
  openManager(): Promise<ApiResult<void>>;
  copyCommand(command: string): Promise<ApiResult<void>>;
  onProjectsChanged(callback: () => void): () => void;
}

// References are checked at the persistence boundary so a deleted server cannot leave live instances behind.
export function validateProjectReferences(project: Project): void {
  const environments = new Set<string>();
  for (const environment of project.environments) {
    if (environments.has(environment.id)) throw new Error('环境标识重复');
    environments.add(environment.id);
    const servers = new Set<string>();
    for (const server of environment.servers) {
      if (servers.has(server.id)) throw new Error('服务器标识重复');
      servers.add(server.id);
    }
    const services = new Set<string>();
    const instances = new Set<string>();
    for (const service of environment.services) {
      if (services.has(service.id)) throw new Error('服务标识重复');
      services.add(service.id);
      for (const instance of service.instances) {
        if (!servers.has(instance.serverId)) throw new Error('服务实例引用了不存在的服务器');
        if (instances.has(instance.id)) throw new Error('实例标识重复');
        instances.add(instance.id);
      }
    }
  }
}
