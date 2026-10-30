import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteController } from '../src/main/connections/remote-controller';
import { ProjectStore } from '../src/main/storage/project-store';
import { ContextRegistry } from '../src/main/workspaces/context-registry';
import { remoteChannels } from '../src/shared/channels';
import { connectionBinding } from '../src/shared/commands';
import { SessionManager } from '../src/main/connections/session-manager';
import { DockerService } from '../src/main/docker/docker-service';
import { KnownHosts } from '../src/main/storage/known-hosts';
import { FramedShell } from '../src/main/connections/framed-shell';
import type { RemoteEvent } from '../src/shared/remote';
import type { Project, Server } from '../src/shared/models';
import { createSshFixture, generateFixtureKey } from './helpers/ssh-fixture';
import type { ClientChannel } from 'ssh2';

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('remote fixture timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
function server(port: number, kind: Server['kind'] = 'ssh'): Server {
  return {
    id: 'server-a',
    name: 'Fixture A',
    kind,
    host: '127.0.0.1',
    port,
    username: 'operator',
    assetName: 'example-app-a',
  };
}
function project(): Project {
  return {
    id: 'alpha',
    name: 'Alpha',
    description: '',
    revision: 0,
    environments: [
      {
        id: 'staging',
        name: 'Staging',
        servers: [],
        services: [
          {
            id: 'catalog',
            name: 'Catalog',
            instances: [{ id: 'instance-a', serverId: 'server-a', containerName: 'catalog-a' }],
          },
        ],
      },
    ],
  };
}
async function setup(options: Parameters<typeof createSshFixture>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tracelogdock-ssh-'));
  const fixture = await createSshFixture(options);
  const events: RemoteEvent[] = [];
  const owners: number[] = [];
  const trust = new KnownHosts(join(directory, 'known-hosts.json'));
  const manager = new SessionManager(trust, (owner, event) => {
    events.push(event);
    owners.push(owner);
    if (event.type === 'challenge')
      void manager.answer(owner, {
        connectionId: event.challenge.connectionId,
        challengeId: event.challenge.id,
        answers: event.challenge.prompts.map(() => '123456'),
        acceptHost: true,
      });
  });
  return {
    directory,
    fixture,
    events,
    owners,
    trust,
    manager,
    close: async () => {
      manager.disposeOwner(1);
      manager.disposeOwner(2);
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('real SSH transport verifies host, supports MFA, discovers containers and stops an independent log channel', async () => {
  const ctx = await setup({ mfa: true });
  const docker = new DockerService(ctx.manager, (owner, event) => {
    ctx.events.push(event);
    ctx.owners.push(owner);
  });
  try {
    const view = ctx.manager.connect(
      1,
      { projectId: 'alpha', environmentId: 'staging', serverId: 'server-a' },
      server(ctx.fixture.port),
      {},
    );
    await until(() => ctx.manager.get(1, view.id).view.status === 'ready');
    assert.equal(
      ctx.events.filter((e) => e.type === 'challenge' && e.challenge.kind === 'host').length,
      1,
    );
    assert.ok(
      ctx.events.some(
        (e) =>
          e.type === 'challenge' &&
          e.challenge.kind === 'keyboard' &&
          e.challenge.prompts[0].echo === false,
      ),
    );
    assert.match((await ctx.trust.lookup('127.0.0.1', ctx.fixture.port))!, /^SHA256:/);
    const session = ctx.manager.get(1, view.id);
    const found = await docker.discover(session);
    assert.equal(found[0].name, 'catalog-a');
    const started = await docker.start(1, project(), {
      projectId: 'alpha',
      environmentId: 'staging',
      serviceId: 'catalog',
      instanceIds: ['instance-a'],
      mode: 'new',
      lines: 0,
      since: '',
    });
    assert.equal(started[0].status, 'running');
    assert.equal(started[0].containerId, 'a'.repeat(64));
    await until(() =>
      ctx.events.some(
        (e) => e.type === 'logs' && e.rows.some((r) => r.text.includes('你好 fixture-live-log')),
      ),
    );
    assert.ok(ctx.fixture.commands.some((command) => command.includes(`-- '${'a'.repeat(64)}'`)));
    assert.throws(() => ctx.manager.get(2, view.id), /不属于/);
    await assert.rejects(docker.stop(2, [started[0].id]), /不属于/);
    await docker.stop(1, [started[0].id]);
    assert.equal(docker.list(1)[0].status, 'stopped');
    assert.equal(ctx.manager.get(1, view.id).view.status, 'ready');
    assert.equal((await docker.discover(session))[0].name, 'catalog-a');
    assert.ok(ctx.owners.every((owner) => owner === 1));
  } finally {
    docker.disposeOwner(1);
    await ctx.close();
  }
});

test('private-key authentication works without recording authentication material', async () => {
  const key = generateFixtureKey();
  const ctx = await setup({ publicKey: key });
  try {
    const view = ctx.manager.connect(
      1,
      { projectId: 'alpha', environmentId: 'staging', serverId: 'server-a' },
      server(ctx.fixture.port),
      { privateKey: Buffer.from(key) },
    );
    await until(() => ctx.manager.get(1, view.id).view.status === 'ready');
    assert.ok(!JSON.stringify(ctx.events).includes('PRIVATE KEY'));
  } finally {
    await ctx.close();
  }
});

test('changed host fingerprint is rejected instead of overwriting trust', async () => {
  const ctx = await setup();
  try {
    await ctx.trust.remember('127.0.0.1', ctx.fixture.port, 'SHA256:previous-key');
    const view = ctx.manager.connect(
      1,
      { projectId: 'alpha', environmentId: 'staging', serverId: 'server-a' },
      server(ctx.fixture.port),
      { password: 'fixture-password' },
    );
    await until(() => ctx.manager.get(1, view.id).view.status === 'error');
    assert.match(ctx.manager.get(1, view.id).view.error!, /指纹不一致/);
    assert.equal(await ctx.trust.lookup('127.0.0.1', ctx.fixture.port), 'SHA256:previous-key');
  } finally {
    await ctx.close();
  }
});

test('JumpServer manual selection is required before framed Docker commands and terminal input invalidates readiness', async () => {
  const ctx = await setup({ mfa: true });
  const docker = new DockerService(ctx.manager, (owner, event) => ctx.events.push(event));
  try {
    const view = ctx.manager.connect(
      1,
      { projectId: 'alpha', environmentId: 'staging', serverId: 'server-a' },
      server(ctx.fixture.port, 'jumpserver'),
      {},
    );
    await until(() => Boolean(ctx.manager.get(1, view.id).shell));
    assert.equal(ctx.manager.get(1, view.id).view.status, 'awaiting-target');
    assert.throws(() => ctx.manager.findReady(1, view), /确认目标/);
    ctx.manager.input(1, view.id, '1\r');
    await until(() => ctx.fixture.inputs.includes('1'));
    assert.equal((await ctx.manager.confirmTarget(1, view.id)).hostname, 'fixture-target');
    assert.equal((await docker.discover(ctx.manager.get(1, view.id)))[0].name, 'catalog-a');
    const started = await docker.start(1, project(), {
      projectId: 'alpha',
      environmentId: 'staging',
      serviceId: 'catalog',
      instanceIds: ['instance-a'],
      mode: 'new',
      lines: 0,
      since: '',
    });
    await until(() =>
      ctx.events.some(
        (e) => e.type === 'logs' && e.rows.some((r) => r.text.includes('fixture-pty-live-log')),
      ),
    );
    assert.throws(() => ctx.manager.input(1, view.id, 'whoami\r'), /Docker操作/);
    await docker.stop(1, [started[0].id]);
    assert.equal(docker.list(1)[0].status, 'stopped');
    ctx.manager.input(1, view.id, 'pwd\r');
    assert.equal(ctx.manager.get(1, view.id).view.status, 'awaiting-target');
  } finally {
    docker.disposeOwner(1);
    await ctx.close();
  }
});

test('unacknowledged interruption remains unknown and never closes another workspace connection', async () => {
  const ctx = await setup({ ignoreSignal: true });
  const docker = new DockerService(ctx.manager, () => undefined);
  try {
    const a = ctx.manager.connect(
      1,
      { projectId: 'alpha', environmentId: 'staging', serverId: 'server-a' },
      server(ctx.fixture.port),
      { password: 'fixture-password' },
    );
    const b = ctx.manager.connect(
      2,
      { projectId: 'beta', environmentId: 'staging', serverId: 'server-a' },
      server(ctx.fixture.port),
      { password: 'fixture-password' },
    );
    await until(
      () =>
        ctx.manager.get(1, a.id).view.status === 'ready' &&
        ctx.manager.get(2, b.id).view.status === 'ready',
    );
    const logs = await docker.start(1, project(), {
      projectId: 'alpha',
      environmentId: 'staging',
      serviceId: 'catalog',
      instanceIds: ['instance-a'],
      mode: 'new',
      lines: 0,
      since: '',
    });
    await docker.stop(1, [logs[0].id]);
    assert.equal(docker.list(1)[0].status, 'unknown');
    ctx.manager.disposeOwner(1);
    assert.equal(ctx.manager.get(2, b.id).view.status, 'ready');
  } finally {
    docker.disposeOwner(1);
    await ctx.close();
  }
});

test('framing ignores echoed command text and handles split markers without delaying ordinary output', () => {
  let sent = '';
  let output = '';
  let code: number | null = null;
  const shell = new FramedShell({
    write: (text: string) => {
      sent = text;
    },
  } as ClientChannel);
  shell.start(
    'hostname',
    (text) => {
      output += text;
    },
    (value) => {
      code = value;
    },
  );
  const token = /'([a-f0-9]{24})'/.exec(sent)![1];
  shell.feed(sent);
  assert.equal(output, '');
  const start = `\x1eTLD_BEGIN_${token}\x1f\n`;
  for (const char of start) shell.feed(char);
  shell.feed('target-host\n');
  assert.match(output, /target-host/);
  for (const char of `\x1eTLD_END_${token}:0\x1f\n`) shell.feed(char);
  assert.equal(code, 0);
  assert.equal(shell.busy, false);
  assert.equal(output.trim(), 'target-host');
});

test('failed password authentication does not create a ready session or expose the password in events', async () => {
  const ctx = await setup();
  try {
    const view = ctx.manager.connect(
      1,
      { projectId: 'alpha', environmentId: 'staging', serverId: 'server-a' },
      server(ctx.fixture.port),
      { password: 'wrong-fixture-password' },
    );
    await until(() => ctx.manager.get(1, view.id).view.status === 'error');
    assert.throws(() => ctx.manager.findReady(1, view), /先连接/);
    assert.ok(!JSON.stringify(ctx.events).includes('wrong-fixture-password'));
  } finally {
    await ctx.close();
  }
});

test('stale connection form cannot dispatch credentials after the configured host changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracelogdock-stale-target-'));
  const store = new ProjectStore(join(directory, 'projects.json'));
  const registry = new ContextRegistry();
  const controller = new RemoteController(
    store,
    registry,
    join(directory, 'known-hosts.json'),
    () => undefined,
    async () => undefined,
  );
  const handlers = new Map<string, (owner: number, input: unknown) => unknown | Promise<unknown>>();
  controller.register((name, handler) => handlers.set(name, handler));
  try {
    const created = await store.create({
      name: 'Alpha',
      description: '',
      environmentName: 'Staging',
    });
    const old = server(2222);
    old.host = 'before.example.invalid';
    created.environments[0].servers = [old];
    const saved = await store.save(created);
    registry.register(1, { kind: 'workspace', projectId: saved.id });
    const changed = structuredClone(saved);
    changed.environments[0].servers[0].host = 'after.example.invalid';
    await store.save(changed);
    await assert.rejects(
      async () =>
        handlers.get(remoteChannels.connect)!(1, {
          projectId: saved.id,
          environmentId: saved.environments[0].id,
          serverId: old.id,
          binding: connectionBinding(old),
          authentication: { kind: 'password', password: 'fixture-password' },
        }),
      /连接配置已变化/,
    );
    assert.equal(controller.sessions.list(1).length, 0);
  } finally {
    controller.disposeOwner(1);
    await rm(directory, { recursive: true, force: true });
  }
});

test('JumpServer password-first authentication reaches MFA while interactive-only login is rejected', async () => {
  const ctx = await setup({ mfaAfterPassword: true });
  try {
    const target = { projectId: 'alpha', environmentId: 'staging', serverId: 'server-a' };
    const configured = server(ctx.fixture.port, 'jumpserver');
    const failed = ctx.manager.connect(1, target, configured, {});
    await until(() => ctx.manager.get(1, failed.id).view.status === 'error');
    assert.ok(!ctx.events.some((e) => e.type === 'challenge' && e.challenge.kind === 'keyboard'));
    const view = ctx.manager.connect(1, target, configured, { password: 'fixture-password' });
    await until(() => Boolean(ctx.manager.get(1, view.id).shell));
    assert.equal(ctx.manager.get(1, view.id).view.status, 'awaiting-target');
    assert.ok(ctx.events.some((e) => e.type === 'challenge' && e.challenge.kind === 'keyboard'));
    assert.deepEqual(ctx.fixture.commands, []);
    assert.ok(!JSON.stringify(ctx.events).includes('fixture-password'));
  } finally {
    await ctx.close();
  }
});

test('one gateway password/MFA opens independent target PTYs and disconnecting the first keeps its sibling logs alive', async () => {
  const ctx = await setup({ mfaAfterPassword: true });
  const docker = new DockerService(ctx.manager, (_owner, event) => ctx.events.push(event));
  try {
    const a = server(ctx.fixture.port, 'jumpserver');
    const b = { ...a, id: 'server-b', name: 'Goods', assetName: 'example-app-b' };
    const target = { projectId: 'alpha', environmentId: 'staging', serverId: a.id };
    const first = ctx.manager.connect(1, target, a, { password: 'fixture-password' });
    await until(() => Boolean(ctx.manager.get(1, first.id).shell));
    ctx.manager.input(1, first.id, '1\r');
    await ctx.manager.confirmTarget(1, first.id);
    const p = project();
    p.environments[0].servers = [a, b];
    p.environments[0].services[0].instances.push({
      id: 'instance-b',
      serverId: b.id,
      containerName: 'catalog-a',
    });
    const request = {
      projectId: 'alpha',
      environmentId: 'staging',
      serviceId: 'catalog',
      instanceIds: ['instance-a'],
      mode: 'new' as const,
      lines: 0,
      since: '',
    };
    const logsA = await docker.start(1, p, request);
    const second = ctx.manager.connect(1, { ...target, serverId: b.id }, b, {}, first.id);
    await until(() => Boolean(ctx.manager.get(1, second.id).shell));
    assert.equal(ctx.manager.get(1, first.id).client, ctx.manager.get(1, second.id).client);
    assert.notEqual(ctx.manager.get(1, first.id).shell, ctx.manager.get(1, second.id).shell);
    assert.equal(ctx.manager.get(1, second.id).view.status, 'awaiting-target');
    assert.throws(() => ctx.manager.findReady(1, { ...target, serverId: b.id }), /确认目标/);
    ctx.manager.input(1, second.id, '1\r');
    await ctx.manager.confirmTarget(1, second.id);
    const logsB = await docker.start(1, p, { ...request, instanceIds: ['instance-b'] });
    assert.equal(logsB[0].status, 'running');
    assert.equal(
      ctx.events.filter((e) => e.type === 'challenge' && e.challenge.kind === 'keyboard').length,
      1,
    );
    await docker.stop(1, [logsA[0].id]);
    ctx.manager.disconnect(1, first.id);
    assert.equal(ctx.manager.get(1, second.id).view.status, 'ready');
    ctx.fixture.emitLog('sibling-still-streaming');
    await until(() =>
      ctx.events.some(
        (e) =>
          e.type === 'logs' &&
          e.rows.some(
            (r) => r.taskId === logsB[0].id && r.text.includes('sibling-still-streaming'),
          ),
      ),
    );
    assert.equal(docker.list(1).find((t) => t.id === logsB[0].id)?.status, 'running');
    const thirdServer = { ...b, id: 'server-c', assetName: 'example-app-c' };
    const third = ctx.manager.connect(
      1,
      { ...target, serverId: thirdServer.id },
      thirdServer,
      {},
      second.id,
    );
    await until(() => Boolean(ctx.manager.get(1, third.id).shell));
    ctx.manager.disconnect(1, third.id);
    assert.equal(ctx.manager.get(1, second.id).view.status, 'ready');
    await docker.stop(1, [logsB[0].id]);
    ctx.manager.disconnect(1, second.id);
  } finally {
    docker.disposeOwner(1);
    await ctx.close();
  }
});

test('a gateway that rejects a second PTY reports reuse failure without closing the first target', async () => {
  const ctx = await setup({ mfaAfterPassword: true, maxShellsPerConnection: 1 });
  try {
    const a = server(ctx.fixture.port, 'jumpserver');
    const target = { projectId: 'alpha', environmentId: 'staging', serverId: a.id };
    const first = ctx.manager.connect(1, target, a, { password: 'fixture-password' });
    await until(() => Boolean(ctx.manager.get(1, first.id).shell));
    const b = { ...a, id: 'server-b' };
    const second = ctx.manager.connect(1, { ...target, serverId: b.id }, b, {}, first.id);
    await until(() => ctx.manager.get(1, second.id).view.status === 'error');
    assert.match(ctx.manager.get(1, second.id).view.error!, /并发通道/);
    assert.equal(ctx.manager.get(1, first.id).view.status, 'awaiting-target');
    ctx.manager.input(1, first.id, '1\r');
    assert.equal((await ctx.manager.confirmTarget(1, first.id)).hostname, 'fixture-target');
    assert.equal(
      ctx.events.filter((e) => e.type === 'challenge' && e.challenge.kind === 'keyboard').length,
      1,
    );
    const separate = ctx.manager.connect(1, { ...target, serverId: b.id }, b, {
      password: 'fixture-password',
    });
    await until(() => Boolean(ctx.manager.get(1, separate.id).shell));
    assert.notEqual(ctx.manager.get(1, first.id).client, ctx.manager.get(1, separate.id).client);
    assert.equal(ctx.manager.get(1, first.id).view.status, 'ready');
    assert.equal(
      ctx.events.filter((e) => e.type === 'challenge' && e.challenge.kind === 'keyboard').length,
      2,
    );
  } finally {
    await ctx.close();
  }
});

test('gateway login reuse rejects other owners, projects, environments, users and endpoints', async () => {
  const ctx = await setup();
  try {
    const a = server(ctx.fixture.port, 'jumpserver');
    const target = { projectId: 'alpha', environmentId: 'staging', serverId: a.id };
    const first = ctx.manager.connect(1, target, a, { password: 'fixture-password' });
    await until(() => Boolean(ctx.manager.get(1, first.id).shell));
    const b = { ...a, id: 'server-b' };
    const destination = { ...target, serverId: b.id };
    assert.throws(() => ctx.manager.connect(2, destination, b, {}, first.id), /不属于/);
    assert.throws(
      () => ctx.manager.connect(1, { ...destination, projectId: 'beta' }, b, {}, first.id),
      /不匹配/,
    );
    assert.throws(
      () =>
        ctx.manager.connect(1, { ...destination, environmentId: 'production' }, b, {}, first.id),
      /不匹配/,
    );
    assert.throws(
      () => ctx.manager.connect(1, destination, { ...b, username: 'another-user' }, {}, first.id),
      /不匹配/,
    );
    assert.throws(
      () =>
        ctx.manager.connect(1, destination, { ...b, host: 'other.example.invalid' }, {}, first.id),
      /不匹配/,
    );
    assert.throws(
      () => ctx.manager.connect(1, destination, { ...b, kind: 'ssh' }, {}, first.id),
      /不匹配/,
    );
    assert.equal(ctx.manager.list(1).length, 1);
  } finally {
    await ctx.close();
  }
});

test('a shared gateway transport closing updates every target instead of leaving a sibling ready', async () => {
  const ctx = await setup();
  try {
    const a = server(ctx.fixture.port, 'jumpserver');
    const target = { projectId: 'alpha', environmentId: 'staging', serverId: a.id };
    const first = ctx.manager.connect(1, target, a, { password: 'fixture-password' });
    await until(() => Boolean(ctx.manager.get(1, first.id).shell));
    const b = { ...a, id: 'server-b' };
    const second = ctx.manager.connect(1, { ...target, serverId: b.id }, b, {}, first.id);
    await until(() => Boolean(ctx.manager.get(1, second.id).shell));
    ctx.manager.get(1, first.id).client.destroy();
    await until(() =>
      [first, second].every((v) => ctx.manager.get(1, v.id).view.status === 'closed'),
    );
  } finally {
    await ctx.close();
  }
});

test('an unforwarded JumpServer interrupt stays unknown and requires confirmation only for that target', async () => {
  const ctx = await setup({ ignoreSignal: true });
  const docker = new DockerService(ctx.manager, () => undefined);
  try {
    const a = server(ctx.fixture.port, 'jumpserver');
    const target = { projectId: 'alpha', environmentId: 'staging', serverId: a.id };
    const first = ctx.manager.connect(1, target, a, { password: 'fixture-password' });
    await until(() => Boolean(ctx.manager.get(1, first.id).shell));
    ctx.manager.input(1, first.id, '1\r');
    await ctx.manager.confirmTarget(1, first.id);
    const b = { ...a, id: 'server-b' };
    const second = ctx.manager.connect(1, { ...target, serverId: b.id }, b, {}, first.id);
    await until(() => Boolean(ctx.manager.get(1, second.id).shell));
    ctx.manager.input(1, second.id, '1\r');
    await ctx.manager.confirmTarget(1, second.id);
    const logs = await docker.start(1, project(), {
      projectId: 'alpha',
      environmentId: 'staging',
      serviceId: 'catalog',
      instanceIds: ['instance-a'],
      mode: 'new',
      lines: 0,
      since: '',
    });
    await until(() => ctx.manager.get(1, first.id).framed?.started === true);
    await docker.stop(1, [logs[0].id]);
    assert.equal(docker.list(1)[0].status, 'unknown');
    assert.equal(ctx.manager.get(1, first.id).view.status, 'awaiting-target');
    assert.equal(ctx.manager.get(1, second.id).view.status, 'ready');
  } finally {
    docker.disposeOwner(1);
    await ctx.close();
  }
});

test('a delayed JumpServer exit confirmation keeps the selected target ready after stopping logs', async () => {
  const ctx = await setup({ interruptDelayMs: 1800 });
  const docker = new DockerService(ctx.manager, () => undefined);
  try {
    const a = server(ctx.fixture.port, 'jumpserver');
    const target = { projectId: 'alpha', environmentId: 'staging', serverId: a.id };
    const view = ctx.manager.connect(1, target, a, { password: 'fixture-password' });
    await until(() => Boolean(ctx.manager.get(1, view.id).shell));
    ctx.manager.input(1, view.id, '1\r');
    await ctx.manager.confirmTarget(1, view.id);
    const logs = await docker.start(1, project(), {
      projectId: 'alpha',
      environmentId: 'staging',
      serviceId: 'catalog',
      instanceIds: ['instance-a'],
      mode: 'new',
      lines: 0,
      since: '',
    });
    await until(() => ctx.manager.get(1, view.id).framed?.started === true);
    await Promise.all([docker.stop(1, [logs[0].id]), docker.stop(1, [logs[0].id])]);
    assert.equal(ctx.fixture.inputs.filter((value) => value === '\x03').length, 1);
    assert.equal(docker.list(1)[0].status, 'stopped');
    assert.equal(ctx.manager.get(1, view.id).view.status, 'ready');
    assert.equal((await docker.discover(ctx.manager.get(1, view.id)))[0].name, 'catalog-a');
  } finally {
    docker.disposeOwner(1);
    await ctx.close();
  }
});

test('real SSH log continuation updates one message across delivery batches and separates the next header', async () => {
  const ctx = await setup();
  const docker = new DockerService(ctx.manager, (_owner, event) => ctx.events.push(event));
  try {
    const view = ctx.manager.connect(
      1,
      { projectId: 'alpha', environmentId: 'staging', serverId: 'server-a' },
      server(ctx.fixture.port),
      { password: 'fixture-password' },
    );
    await until(() => ctx.manager.get(1, view.id).view.status === 'ready');
    const tasks = await docker.start(1, project(), {
      projectId: 'alpha',
      environmentId: 'staging',
      serviceId: 'catalog',
      instanceIds: ['instance-a'],
      mode: 'new',
      lines: 0,
      since: '',
    });
    const updates = () => ctx.events.flatMap((e) => (e.type === 'logs' ? e.rows : []));
    ctx.fixture.emitLog(
      '2026-10-29T07:42:21.704000000Z 2026-10-29T15:42:21.704+08:00 INFO 6 --- SQL日志',
    );
    await until(() => updates().some((row) => row.text.includes('SQL日志')));
    const first = updates().find((row) => row.text.includes('SQL日志'))!;
    ctx.fixture.emitLog('2026-10-29T07:42:21.704000001Z 完整SQL：SELECT shop_id FROM shop_base');
    await until(() => updates().some((row) => row.text.includes('完整SQL')));
    const combined = updates().find((row) => row.text.includes('完整SQL'))!;
    assert.equal(combined.id, first.id);
    assert.match(combined.text, /SQL日志\n完整SQL/);
    assert.ok(!first.text.includes('完整SQL'), 'delivered snapshots remain immutable');
    ctx.fixture.emitLog(
      '2026-10-29T07:42:21.704000002Z 2026-10-29T15:42:21.704+08:00 INFO 6 --- next-request',
    );
    await until(() => updates().some((row) => row.text.includes('next-request')));
    assert.notEqual(updates().find((row) => row.text.includes('next-request'))!.id, first.id);
    await docker.stop(1, [tasks[0].id]);
  } finally {
    docker.disposeOwner(1);
    await ctx.close();
  }
});
