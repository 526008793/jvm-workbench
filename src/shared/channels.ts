export const channels = {
  context: 'desktop:context',
  list: 'projects:list',
  create: 'projects:create',
  save: 'projects:save',
  remove: 'projects:delete',
  open: 'workspaces:open',
  manager: 'workspaces:manager',
  copy: 'commands:copy',
  changed: 'projects:changed',
} as const;

export const remoteChannels = {
  list: 'remote:list',
  connect: 'remote:connect',
  disconnect: 'remote:disconnect',
  answer: 'remote:answer',
  key: 'remote:key',
  terminal: 'remote:terminal',
  input: 'remote:input',
  resize: 'remote:resize',
  confirm: 'remote:confirm-target',
  discover: 'docker:discover',
  logs: 'docker:logs',
  stop: 'docker:stop',
  tasks: 'docker:tasks',
  event: 'remote:event',
} as const;
