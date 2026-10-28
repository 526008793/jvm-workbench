import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextRegistry } from '../src/main/workspaces/context-registry';

test('workspace cannot access another project or manager-only operations', () => {
  const contexts = new ContextRegistry();
  contexts.register(1, { kind: 'manager' });
  contexts.register(2, { kind: 'workspace', projectId: 'alpha' });
  contexts.register(3, { kind: 'workspace', projectId: 'beta' });
  contexts.assertProject(1, 'beta');
  contexts.assertProject(2, 'alpha');
  assert.throws(() => contexts.assertProject(2, 'beta'), /其他项目/);
  assert.throws(() => contexts.assertManager(2), /项目管理窗口/);
  contexts.remove(2);
  assert.throws(() => contexts.get(2), /不存在/);
  contexts.assertProject(3, 'beta');
});
