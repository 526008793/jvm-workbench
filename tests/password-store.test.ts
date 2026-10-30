import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PasswordStore, type PasswordScope } from '../src/main/storage/password-store';
import type { Project } from '../src/shared/models';
import { passwordEncryption } from './helpers/password-encryption';

const scope: PasswordScope = {
  projectId: 'alpha',
  environmentId: 'staging',
  server: {
    id: 'target-a',
    name: 'Order',
    kind: 'jumpserver',
    host: 'gateway.example.invalid',
    port: 2222,
    username: 'operator',
    assetName: 'order-node',
  },
};
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'tld-passwords-'));
  const file = join(directory, 'passwords.json');
  const encryption = passwordEncryption();
  return {
    file,
    encryption,
    store: new PasswordStore(file, encryption),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test('remembered passwords survive restart as ciphertext, share gateway targets and remain scoped to the exact account', async () => {
  const ctx = await setup();
  try {
    await ctx.store.remember(scope, ctx.store.prepare('fixture-secret-password'));
    const raw = await readFile(ctx.file, 'utf8');
    assert.ok(!raw.includes('fixture-secret-password'));
    if (process.platform !== 'win32') assert.equal((await stat(ctx.file)).mode & 0o777, 0o600);
    const restarted = new PasswordStore(ctx.file, ctx.encryption);
    assert.equal(await restarted.get(scope), 'fixture-secret-password');
    assert.equal(
      await restarted.get({
        ...scope,
        server: { ...scope.server, id: 'target-b', assetName: 'goods-node' },
      }),
      'fixture-secret-password',
    );
    for (const other of [
      { ...scope, projectId: 'beta' },
      { ...scope, environmentId: 'prod' },
      { ...scope, server: { ...scope.server, username: 'other' } },
      { ...scope, server: { ...scope.server, port: 22 } },
      { ...scope, server: { ...scope.server, host: 'other.example.invalid' } },
    ]) {
      assert.equal((await restarted.status(other)).remembered, false);
      await assert.rejects(restarted.get(other), /不存在/);
    }
    const status = await restarted.status(scope);
    assert.deepEqual(status, { available: true, remembered: true });
    assert.ok(!JSON.stringify(status).includes('secret'));
  } finally {
    await ctx.close();
  }
});

test('unavailable OS encryption never falls back to plaintext and still allows forgetting ciphertext', async () => {
  const ctx = await setup();
  try {
    await ctx.store.remember(scope, ctx.store.prepare('fixture-secret-password'));
    ctx.encryption.isEncryptionAvailable = () => false;
    assert.throws(() => ctx.store.prepare('new-secret'), /不可用/);
    await assert.rejects(ctx.store.get(scope), /不可用/);
    assert.deepEqual(await ctx.store.status(scope), { available: false, remembered: true });
    await ctx.store.forget(scope);
    assert.equal((await ctx.store.status(scope)).remembered, false);
    assert.ok(!(await readFile(ctx.file, 'utf8')).includes('new-secret'));
  } finally {
    await ctx.close();
  }
});

test('corrupt files and decryption failures are reported without overwriting or exposing credentials', async () => {
  const ctx = await setup();
  try {
    await ctx.store.remember(scope, ctx.store.prepare('fixture-secret-password'));
    const otherUser = new PasswordStore(ctx.file, passwordEncryption());
    await assert.rejects(otherUser.get(scope), /无法解密/);
    await writeFile(ctx.file, '{broken');
    await assert.rejects(
      ctx.store.remember(scope, ctx.store.prepare('another-secret')),
      /无法读取/,
    );
    assert.equal(await readFile(ctx.file, 'utf8'), '{broken');
  } finally {
    await ctx.close();
  }
});

test('serialized writes and project cleanup preserve other scopes and remove changed endpoints', async () => {
  const ctx = await setup();
  try {
    const beta = { ...scope, projectId: 'beta' };
    await Promise.all([
      ctx.store.remember(scope, ctx.store.prepare('alpha-secret')),
      ctx.store.remember(beta, ctx.store.prepare('beta-secret')),
    ]);
    const project: Project = {
      id: 'alpha',
      name: 'Alpha',
      description: '',
      revision: 0,
      environments: [
        {
          id: 'staging',
          name: 'Staging',
          services: [],
          servers: [{ ...scope.server, host: 'changed.example.invalid' }],
        },
      ],
    };
    await ctx.store.reconcile(project);
    assert.equal((await ctx.store.status(scope)).remembered, false);
    assert.equal(await ctx.store.get(beta), 'beta-secret');
    await ctx.store.removeProject('beta');
    assert.equal((await ctx.store.status(beta)).remembered, false);
  } finally {
    await ctx.close();
  }
});
