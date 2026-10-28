import type { WindowContext } from '../../shared/models';

export class ContextRegistry {
  private readonly contexts = new Map<number, WindowContext>();

  register(senderId: number, context: WindowContext): void {
    this.contexts.set(senderId, context);
  }
  remove(senderId: number): void {
    this.contexts.delete(senderId);
  }
  get(senderId: number): WindowContext {
    const context = this.contexts.get(senderId);
    if (!context) throw new Error('窗口上下文不存在');
    return context;
  }
  assertManager(senderId: number): void {
    if (this.get(senderId).kind !== 'manager') throw new Error('请在项目管理窗口执行此操作');
  }
  assertProject(senderId: number, projectId: string): void {
    const context = this.get(senderId);
    if (context.kind === 'workspace' && context.projectId !== projectId)
      throw new Error('不能访问其他项目的工作区');
  }
}
