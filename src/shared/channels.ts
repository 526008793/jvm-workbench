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
  passwordStatus: 'passwords:status',
  forgetPassword: 'passwords:forget',
} as const;

export const arthasChannels = {
  discover: 'arthas:discover',
  attach: 'arthas:attach',
  agents: 'arthas:agents',
  scope: 'arthas:scope',
  search: 'arthas:search',
  start: 'arthas:start',
  stop: 'arthas:stop',
  tasks: 'arthas:tasks',
} as const;

export const analysisChannels = {
  configuration: 'analysis:configuration',
  save: 'analysis:save',
  chooseRoot: 'analysis:choose-root',
  test: 'analysis:test',
  context: 'analysis:context',
  run: 'analysis:run',
  cancel: 'analysis:cancel',
  state: 'analysis:state',
  event: 'analysis:event',
} as const;
