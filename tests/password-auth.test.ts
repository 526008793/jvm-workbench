import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteController } from '../src/main/connections/remote-controller';
import { PasswordStore } from '../src/main/storage/password-store';
import { ProjectStore } from '../src/main/storage/project-store';
import { ContextRegistry } from '../src/main/workspaces/context-registry';
import { remoteChannels } from '../src/shared/channels';
import { connectionBinding } from '../src/shared/commands';
import type { ConnectionView, RemoteEvent, PasswordTarget } from '../src/shared/remote';
import { createSshFixture } from './helpers/ssh-fixture';
import { passwordEncryption } from './helpers/password-encryption';

async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Password auth fixture timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function setup(autoMfa = true) {
  const directory = await mkdtemp(join(tmpdir(), 'tld-password-auth-'));
  const fixture = await createSshFixture({ mfaAfterPassword: true });
  const store = new ProjectStore(join(directory, 'projects.json'));
  const encryption = passwordEncryption();
  const passwords = new PasswordStore(join(directory, 'passwords.json'), encryption);
  const registry = new ContextRegistry();
  const project = await store.create({
    name: 'Alpha',
    description: '',
    environmentName: 'Staging',
  });
  const server = {
    id: 'gateway',
    name: 'Order',
    kind: 'jumpserver' as const,
    host: '127.0.0.1',
    port: fixture.port,
    username: 'operator',
    assetName: 'order',
  };
  project.environments[0].servers = [server];
  await store.save(project);
  registry.register(1, { kind: 'workspace', projectId: project.id });
  registry.register(2, { kind: 'workspace', projectId: 'another-project' });
  const target: PasswordTarget = {
    projectId: project.id,
    environmentId: project.environments[0].id,
    serverId: server.id,
    binding: connectionBinding(server),
  };
  const scope = { ...target, server };
  const events: RemoteEvent[] = [];
  let controller: RemoteController;
  let handlers: Map<string, (owner: number, value: unknown) => unknown | Promise<unknown>>;
  function restart() {
    controller?.disposeOwner(1);
    controller = new RemoteController(
      store,
      registry,
      join(directory, 'hosts.json'),
      (owner, event) => {
        events.push(event);
        if (event.type === 'challenge' && (event.challenge.kind === 'host' || autoMfa))
          void controller.sessions.answer(owner, {
            connectionId: event.challenge.connectionId,
            challengeId: event.challenge.id,
            acceptHost: true,
            answers: event.challenge.prompts.map(() => '123456'),
          });
      },
      async () => undefined,
      new PasswordStore(join(directory, 'passwords.json'), encryption),
    );
    handlers = new Map();
    controller.register((name, handler) => handlers.set(name, handler));
  }
  restart();
  return {
    target,
    scope,
    events,
    passwords,
    directory,
    restart,
    controller: () => controller,
    call: async <T>(name: string, value: unknown, owner = 1) =>
      (await handlers.get(name)!(owner, value)) as T,
    close: async () => {
      controller.disposeOwner(1);
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('only authenticated passwords are remembered; a restarted controller can use ciphertext without exposing it over IPC', async () => {
  const ctx = await setup();
  try {
    const failed = await ctx.call<ConnectionView>(remoteChannels.connect, {
      ...ctx.target,
      authentication: { kind: 'password', password: 'wrong-fixture-password' },
      rememberPassword: true,
    });
    await until(() => ctx.controller().sessions.get(1, failed.id).view.status === 'error');
    assert.equal((await ctx.passwords.status(ctx.scope)).remembered, false);
    const connected = await ctx.call<ConnectionView>(remoteChannels.connect, {
      ...ctx.target,
      authentication: { kind: 'password', password: 'fixture-password' },
      rememberPassword: true,
    });
    await until(() => ctx.events.some((e) => e.type === 'password-state' && e.remembered));
    assert.equal(ctx.controller().sessions.get(1, connected.id).view.status, 'awaiting-target');
    const ciphertext = await readFile(join(ctx.directory, 'passwords.json'), 'utf8');
    assert.ok(!ciphertext.includes('fixture-password'));
    assert.ok(!ciphertext.includes('wrong-fixture-password'));
    assert.ok(!ciphertext.includes('123456'));
    assert.ok(
      !(await readFile(join(ctx.directory, 'projects.json'), 'utf8')).includes('fixture-password'),
    );
    ctx.restart();
    const status = await ctx.call(remoteChannels.passwordStatus, ctx.target);
    assert.deepEqual(status, { available: true, remembered: true });
    const restored = await ctx.call<ConnectionView>(remoteChannels.connect, {
      ...ctx.target,
      authentication: { kind: 'savedPassword' },
      rememberPassword: true,
    });
    await until(
      () => ctx.controller().sessions.get(1, restored.id).view.status === 'awaiting-target',
    );
    assert.equal(
      ctx.events.filter((e) => e.type === 'challenge' && e.challenge.kind === 'keyboard').length,
      2,
    );
    await assert.rejects(ctx.call(remoteChannels.passwordStatus, ctx.target, 2), /不属于/);
    await assert.rejects(ctx.call(remoteChannels.forgetPassword, ctx.target, 2), /不属于/);
    await assert.rejects(
      ctx.call(
        remoteChannels.connect,
        { ...ctx.target, authentication: { kind: 'savedPassword' } },
        2,
      ),
      /不属于/,
    );
    await ctx.call(remoteChannels.forgetPassword, ctx.target);
    assert.equal((await ctx.passwords.status(ctx.scope)).remembered, false);
    ctx.restart();
    await assert.rejects(
      ctx.call(remoteChannels.connect, {
        ...ctx.target,
        authentication: { kind: 'savedPassword' },
      }),
      /不存在/,
    );
    assert.ok(!JSON.stringify(ctx.events).includes('fixture-password'));
  } finally {
    await ctx.close();
  }
});

test('forgetting during MFA cancels the pending encrypted save even when authentication later succeeds', async () => {
  const ctx = await setup(false);
  try {
    const view = await ctx.call<ConnectionView>(remoteChannels.connect, {
      ...ctx.target,
      authentication: { kind: 'password', password: 'fixture-password' },
      rememberPassword: true,
    });
    await until(() =>
      ctx.events.some((e) => e.type === 'challenge' && e.challenge.kind === 'keyboard'),
    );
    await ctx.call(remoteChannels.forgetPassword, ctx.target);
    const event = ctx.events.find((e) => e.type === 'challenge' && e.challenge.kind === 'keyboard');
    assert.ok(event?.type === 'challenge');
    await ctx.controller().sessions.answer(1, {
      connectionId: event.challenge.connectionId,
      challengeId: event.challenge.id,
      answers: ['123456'],
    });
    await until(() => ctx.controller().sessions.get(1, view.id).view.status === 'awaiting-target');
    assert.equal((await ctx.passwords.status(ctx.scope)).remembered, false);
    assert.ok(!ctx.events.some((e) => e.type === 'password-state' && e.remembered));
  } finally {
    await ctx.close();
  }
});
