import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { shellQuote } from '../src/shared/commands';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/main/connections/session-manager';
import { KnownHosts } from '../src/main/storage/known-hosts';
import { ArthasService } from '../src/main/arthas/arthas-service';
import { diagnosticCommand, type DiagnosticInput } from '../src/shared/arthas';
import type { Project, Server } from '../src/shared/models';
import type { RemoteEvent } from '../src/shared/remote';
import { createSshFixture } from './helpers/ssh-fixture';
import { createArthasResponder } from './helpers/arthas-fixture';

async function until(predicate: () => boolean) {
  const end = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Arthas fixture timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function setup(jump = false) {
  const directory = await mkdtemp(join(tmpdir(), 'tld-arthas-'));
  const responder = createArthasResponder();
  const fixture = await createSshFixture({ commandOutput: responder.output });
  const events: RemoteEvent[] = [];
  const manager = new SessionManager(new KnownHosts(join(directory, 'hosts.json')), (owner, e) => {
    events.push(e);
    if (e.type === 'challenge')
      void manager.answer(owner, {
        connectionId: e.challenge.connectionId,
        challengeId: e.challenge.id,
        acceptHost: true,
        answers: [],
      });
  });
  const arthas = new ArthasService(manager, (_owner, e) => events.push(e));
  const server: Server = {
    id: 'server',
    kind: jump ? 'jumpserver' : 'ssh',
    host: '127.0.0.1',
    port: fixture.port,
    username: 'operator',
    assetName: '',
    name: 'Fixture',
  };
  const project: Project = {
    id: 'project',
    name: 'Project',
    description: '',
    revision: 0,
    environments: [
      {
        id: 'env',
        name: 'Staging',
        servers: [server],
        services: [
          {
            id: 'service',
            name: 'Catalog',
            instances: [{ id: 'instance', serverId: 'server', containerName: 'catalog-a' }],
          },
        ],
      },
    ],
  };
  const target = {
    projectId: project.id,
    environmentId: 'env',
    serviceId: 'service',
    instanceId: 'instance',
  };
  const view = manager.connect(1, { ...target, serverId: 'server' }, server, {
    password: 'fixture-password',
  });
  await until(() => Boolean(manager.get(1, view.id).shell));
  if (jump) {
    manager.input(1, view.id, '1\r');
    await until(() => fixture.inputs.includes('1'));
    await manager.confirmTarget(1, view.id);
  }
  const jvms = await arthas.discover(1, project, target);
  return {
    responder,
    fixture,
    manager,
    arthas,
    project,
    target,
    view,
    jvms,
    events,
    close: async () => {
      arthas.disposeOwner(1);
      manager.disposeOwner(1);
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function attach(ctx: Awaited<ReturnType<typeof setup>>) {
  return ctx.arthas.attach(1, { jvm: ctx.jvms[0], home: '/opt/arthas', port: 8563 });
}
async function diagnostic(ctx: Awaited<ReturnType<typeof setup>>): Promise<DiagnosticInput> {
  const agent = await attach(ctx);
  const methods = await ctx.arthas.search(1, agent.id, 'query', 'com.example');
  return {
    agentId: agent.id,
    method: methods[0],
    kind: 'trace',
    count: 5,
    cost: 200,
    duration: 60,
  };
}

test('Arthas uses real SSH channels, discovers non-PID1 JVMs, verifies agent, searches overloads and ends a task', async () => {
  const ctx = await setup();
  try {
    assert.deepEqual(
      ctx.jvms.map((j) => j.pid),
      [7, 42],
    );
    if (process.platform !== 'win32') {
      const proc = await mkdtemp(join(tmpdir(), 'tld-proc-'));
      try {
        await mkdir(join(proc, '7'));
        await symlink('/usr/bin/java', join(proc, '7', 'exe'));
        await writeFile(join(proc, '7', 'status'), 'Uid: 1000 1000 1000 1000\n');
        await writeFile(
          join(proc, '7', 'stat'),
          `7 (fixture (java)) S ${Array(18).fill('0').join(' ')} 98765 0`,
        );
        const script = ctx.responder.state.commands.find((c) => c.startsWith('for p in /proc/'))!;
        const output = execFileSync(
          '/bin/sh',
          ['-c', script.replace('/proc/[0-9]*', `${shellQuote(proc)}/[0-9]*`)],
          { encoding: 'utf8' },
        );
        assert.equal(output, '7\t1000\t98765\t/usr/bin/java\n');
      } finally {
        await rm(proc, { recursive: true, force: true });
      }
    }
    const input = await diagnostic(ctx);
    const methods = await ctx.arthas.search(
      1,
      input.agentId,
      'com.example.CatalogService#query',
      '',
    );
    assert.equal(methods.length, 2);
    assert.notEqual(methods[0].descriptor, methods[1].descriptor);
    assert.throws(() => ctx.arthas.getAgent(2, input.agentId), /不属于/);
    const task = ctx.arthas.start(1, input);
    await assert.rejects(ctx.arthas.stop(2, task.id), /不属于/);
    await until(() => ctx.arthas.listTasks(1)[0].status === 'ended');
    await until(() => ctx.responder.state.requests.some((r) => r.action === 'close_session'));
    assert.ok(ctx.arthas.listTasks(1)[0].results.some((r) => r.type === 'trace'));
    assert.ok(ctx.events.some((e) => e.type === 'diagnostic-state' && e.task.status === 'waiting'));
    assert.match(task.command, /-c abc123$/);
    assert.ok(
      ctx.responder.state.requests.every((r) => r.command !== 'stop' && r.command !== 'reset'),
    );
    assert.ok(
      ctx.responder.state.commands.some((c) => c.includes('--target-ip 127.0.0.1 --telnet-port 0')),
    );
    const snapshot = ctx.arthas.listTasks(1);
    snapshot[0].results.length = 0;
    assert.ok(ctx.arthas.listTasks(1)[0].results.length > 0);
  } finally {
    await ctx.close();
  }
});

test('manual interruption is scoped to the dedicated Arthas session over a JumpServer shell', async () => {
  const ctx = await setup(true);
  ctx.responder.state.finish = false;
  try {
    const input = await diagnostic(ctx);
    const task = ctx.arthas.start(1, input);
    await until(() => ctx.arthas.listTasks(1)[0].status === 'waiting');
    assert.throws(() => ctx.arthas.start(1, input), /已有诊断/);
    await ctx.arthas.stop(1, task.id);
    assert.equal(ctx.arthas.listTasks(1)[0].status, 'stopped');
    const interrupt = ctx.responder.state.requests.find((r) => r.action === 'interrupt_job');
    const scheduled = ctx.responder.state.requests.find((r) => r.action === 'async_exec');
    assert.equal(interrupt?.sessionId, scheduled?.sessionId);
    assert.equal(ctx.manager.get(1, ctx.view.id).view.status, 'ready');
  } finally {
    await ctx.close();
  }
});

test('no-call deadline still interrupts the remote task and unconfirmed interruption stays unknown', async () => {
  const ctx = await setup();
  ctx.responder.state.finish = false;
  ctx.responder.state.interrupt = false;
  try {
    const input = await diagnostic(ctx);
    ctx.arthas.start(1, { ...input, duration: 1 });
    await until(() => ctx.arthas.listTasks(1)[0].status === 'unknown');
    assert.ok(ctx.responder.state.requests.some((r) => r.action === 'interrupt_job'));
    await until(() => ctx.responder.state.requests.some((r) => r.action === 'close_session'));
  } finally {
    await ctx.close();
  }
});

test('container restart and reconnect cannot reuse a previous JVM identity', async () => {
  const ctx = await setup();
  try {
    const agent = await attach(ctx);
    ctx.responder.state.startedAt = '2026-10-29T02:00:00Z';
    await assert.rejects(ctx.arthas.search(1, agent.id, 'query', 'com.example'), /重建或重启/);
    ctx.manager.disconnect(1, ctx.view.id);
    assert.throws(() => ctx.arthas.getAgent(1, agent.id), /先连接/);
  } finally {
    await ctx.close();
  }
});

test('jad reads the verified JVM only and rejects stale containers and foreign owners', async () => {
  const ctx = await setup();
  try {
    const agent = await attach(ctx);
    ctx.responder.state.jadSources['com.example.CatalogService'] =
      'public class CatalogService { public String query() { return "actual bytecode"; } }';
    const source = await ctx.arthas.decompile(1, agent.id, 'com.example.CatalogService', 'abc123');
    assert.match(source, /actual bytecode/);
    assert.ok(
      ctx.responder.state.requests.some((request) =>
        String(request.command).includes('jad --source-only --lineNumber false -c abc123'),
      ),
    );
    await assert.rejects(
      ctx.arthas.decompile(2, agent.id, 'com.example.CatalogService', 'abc123'),
      /不属于/,
    );
    ctx.responder.state.startedAt = '2026-10-30T23:59:59Z';
    await assert.rejects(
      ctx.arthas.decompile(1, agent.id, 'com.example.CatalogService', 'abc123'),
      /重建或重启/,
    );
  } finally {
    await ctx.close();
  }
});

test('rediscovery retires stale attachments and reattaches the same PID without reconnecting JumpServer', async () => {
  const ctx = await setup(true);
  try {
    let agent = await attach(ctx);
    const repeated = await ctx.arthas.discover(1, ctx.project, ctx.target);
    assert.deepEqual(repeated, ctx.jvms);
    assert.equal((await attach(ctx)).id, agent.id);
    for (const change of [
      { containerId: 'b'.repeat(64) },
      { startedAt: '2026-10-30T02:00:00Z' },
      { startTicks: '123456' },
    ]) {
      Object.assign(ctx.responder.state, change);
      ctx.jvms = await ctx.arthas.discover(1, ctx.project, ctx.target);
      assert.equal(ctx.jvms[0].pid, agent.jvm.pid);
      assert.equal(ctx.jvms[0].connectionId, ctx.view.id);
      assert.deepEqual(ctx.arthas.listAgents(1), []);
      assert.throws(() => ctx.arthas.getAgent(1, agent.id), /已失效/);
      const next = await attach(ctx);
      assert.notEqual(next.id, agent.id);
      assert.equal((await ctx.arthas.search(1, next.id, 'query', 'com.example')).length, 2);
      assert.equal(ctx.manager.get(1, ctx.view.id).view.status, 'ready');
      agent = next;
    }
  } finally {
    await ctx.close();
  }
});

test('deep diagnosis captures a single entry and downstream stacks, then interrupts only its observer session', async () => {
  const ctx = await setup(true);
  try {
    const input = await diagnostic(ctx);
    const task = ctx.arthas.start(1, { ...input, kind: 'deep', count: 1, sampleIntervalMs: 100 });
    await until(() => ctx.arthas.listTasks(1)[0].status === 'ended');
    await until(() => ctx.responder.state.requests.some((r) => r.action === 'close_session'));
    const result = ctx.arthas.listTasks(1)[0];
    assert.equal(result.deep?.phase, 'complete');
    assert.equal(result.deep?.durationMs, 45000);
    assert.ok(result.deep!.samples > 0);
    assert.ok(result.deep!.paths[0].frames.some((frame) => frame.methodName === 'fillGoodsList'));
    assert.ok(result.deep!.paths[0].frames.some((frame) => frame.lineNumber === 129));
    const scheduled = ctx.responder.state.requests.find((r) => r.action === 'async_exec');
    const interrupted = ctx.responder.state.requests.find((r) => r.action === 'interrupt_job');
    assert.equal(scheduled?.sessionId, interrupted?.sessionId);
    assert.equal(ctx.manager.get(1, ctx.view.id).view.status, 'ready');
    assert.equal(result.id, task.id);
    assert.ok(
      ctx.responder.state.requests.every((r) => !['reset', 'stop'].includes(String(r.command))),
    );
  } finally {
    await ctx.close();
  }
});

test('deep timeout and manual stop retain partial evidence; an unconfirmed stop remains unknown', async () => {
  for (const mode of ['no-call', 'running', 'unconfirmed', 'restarted'] as const) {
    const ctx = await setup();
    try {
      const input = await diagnostic(ctx);
      ctx.responder.state.deepFinish = false;
      ctx.responder.state.deepStart = mode !== 'no-call';
      ctx.responder.state.interrupt = mode !== 'unconfirmed';
      const task = ctx.arthas.start(1, {
        ...input,
        kind: 'deep',
        sampleIntervalMs: 100,
        duration: mode === 'no-call' ? 1 : 30,
      });
      if (mode !== 'no-call') {
        await until(() => Boolean(ctx.arthas.listTasks(1)[0].deep?.samples));
        if (mode === 'restarted') {
          ctx.responder.state.startedAt = '2026-10-30T23:59:59Z';
          await until(() => ctx.arthas.listTasks(1)[0].status === 'unknown');
        } else await ctx.arthas.stop(1, task.id);
      } else await until(() => ctx.arthas.listTasks(1)[0].status === 'stopped');
      const result = ctx.arthas.listTasks(1)[0];
      assert.equal(
        result.status,
        ['unconfirmed', 'restarted'].includes(mode) ? 'unknown' : 'stopped',
      );
      assert.equal(result.deep?.phase, 'partial');
      assert.equal(result.deep?.durationMs, undefined);
      assert.equal(Boolean(result.deep?.samples), mode !== 'no-call');
    } finally {
      await ctx.close();
    }
  }
});

test('wrong agent PID/version and unsafe search patterns are rejected', async () => {
  const ctx = await setup();
  try {
    ctx.responder.state.pid = 99;
    await assert.rejects(attach(ctx), /不匹配/);
    ctx.responder.state.pid = 7;
    ctx.responder.state.version = 'unexpected';
    await assert.rejects(attach(ctx), /不匹配/);
    ctx.responder.state.version = '4.0.5';
    const agent = await attach(ctx);
    await assert.rejects(ctx.arthas.search(1, agent.id, 'query;stop', 'com.example'), /请输入/);
    await assert.rejects(ctx.arthas.search(1, agent.id, 'query', '*'), /请输入/);
  } finally {
    await ctx.close();
  }
});

test('changed signature is rejected before scheduling and config removal invalidates agents', async () => {
  const ctx = await setup();
  try {
    const input = await diagnostic(ctx);
    ctx.responder.state.methods = false;
    ctx.arthas.start(1, input);
    await until(() => ctx.arthas.listTasks(1)[0].status === 'error');
    assert.ok(!ctx.responder.state.requests.some((r) => r.action === 'async_exec'));
    ctx.project.environments[0].services[0].instances = [];
    ctx.arthas.reconcile(ctx.project);
    assert.throws(() => ctx.arthas.getAgent(1, input.agentId), /失效/);
  } finally {
    await ctx.close();
  }
});

test('disconnect leaves an active diagnostic unknown', async () => {
  const ctx = await setup();
  ctx.responder.state.finish = false;
  try {
    const input = await diagnostic(ctx);
    ctx.arthas.start(1, input);
    await until(() => ctx.arthas.listTasks(1)[0].status === 'waiting');
    ctx.manager.disconnect(1, ctx.view.id);
    await until(() => ctx.arthas.listTasks(1)[0].status === 'unknown');
  } finally {
    await ctx.close();
  }
});

test('ClassLoader flags preserve monitor interval and command injection is rejected', async () => {
  const method = {
    className: 'com.example.CatalogService',
    methodName: 'query',
    classLoaderHash: 'abc123',
    parameters: [],
    returnType: 'void',
    descriptor: '()V',
  };
  const input: DiagnosticInput = {
    agentId: 'agent',
    method,
    kind: 'monitor',
    cost: 200,
    count: 5,
    duration: 60,
  };
  assert.equal(
    diagnosticCommand(input),
    'monitor -c 5 com.example.CatalogService query --classloader abc123',
  );
  assert.throws(() =>
    diagnosticCommand({ ...input, method: { ...method, classLoaderHash: 'abc;stop' } }),
  );
});

test('Arthas reuses a complete package, downloads a missing one once, then verifies the JVM again', async () => {
  const ctx = await setup(true);
  try {
    ctx.responder.state.packagePresent = false;
    await attach(ctx);
    assert.equal(ctx.responder.state.installs, 1);
    const stages = ctx.events
      .filter((e) => e.type === 'arthas-attach-progress')
      .map((e) => e.progress.stage);
    assert.deepEqual(stages, ['checking', 'installing', 'bootstrapping', 'verifying']);
    const commands = ctx.responder.state.commands;
    const install = commands.findIndex((c) => c.startsWith('set -e;'));
    assert.ok(commands[install + 1].startsWith('test "$(readlink'));
    await attach(ctx);
    assert.equal(ctx.responder.state.installs, 1);
  } finally {
    await ctx.close();
  }
});

test('Arthas installation failure never attaches and permits a later retry', async () => {
  const ctx = await setup();
  const execute = ctx.manager.execute.bind(ctx.manager);
  try {
    ctx.responder.state.packagePresent = false;
    let installTimeout = 0;
    ctx.manager.execute = (session, command, timeout) => {
      if (command.includes('--output')) {
        installTimeout = timeout ?? 0;
        return Promise.reject(new Error('Arthas包SHA-256校验失败，未安装，请重试'));
      }
      return execute(session, command, timeout);
    };
    await assert.rejects(attach(ctx), /SHA-256/);
    assert.equal(installTimeout, 150000);
    assert.equal(ctx.arthas.listAgents(1).length, 0);
    assert.ok(!ctx.responder.state.commands.some((c) => c.includes('--attach-only')));
    ctx.manager.execute = execute;
    await attach(ctx);
    assert.equal(ctx.responder.state.installs, 1);
  } finally {
    await ctx.close();
  }
});

test('Arthas does not attach after the container restarts or workspace closes during installation', async () => {
  for (const change of ['restart', 'close']) {
    const ctx = await setup();
    const execute = ctx.manager.execute.bind(ctx.manager);
    try {
      ctx.responder.state.packagePresent = false;
      ctx.manager.execute = async (session, command, timeout) => {
        const output = await execute(session, command, timeout);
        if (command.includes('--output')) {
          if (change === 'restart') ctx.responder.state.startedAt = '2026-10-29T02:00:00Z';
          else ctx.arthas.disposeOwner(1);
        }
        return output;
      };
      await assert.rejects(attach(ctx), /容器已重建|工作区已关闭/);
      assert.ok(!ctx.responder.state.commands.some((c) => c.includes('--attach-only')));
      assert.deepEqual(ctx.arthas.listAgents(1), []);
    } finally {
      await ctx.close();
    }
  }
});

test('an existing boot JAR uses the pinned official launcher cache without downloading the launcher again', async () => {
  const ctx = await setup(true);
  const execute = ctx.manager.execute.bind(ctx.manager);
  try {
    ctx.responder.state.packagePresent = false;
    ctx.responder.state.bootPresent = true;
    let attachTimeout = 0;
    ctx.manager.execute = (session, command, timeout) => {
      if (command.includes('--attach-only')) attachTimeout = timeout ?? 0;
      return execute(session, command, timeout);
    };
    await attach(ctx);
    assert.equal(ctx.responder.state.installs, 0);
    assert.equal(attachTimeout, 150000);
    const command = ctx.responder.state.commands.find((c) => c.includes('--attach-only'))!;
    assert.match(command, /--use-version 4\.0\.5 --repo-mirror center/);
    assert.match(command, /ARTHAS_LIB_DIR='\/opt\/arthas\/\.arthas\/lib'/);
    assert.match(command, /-Duser.home='\/opt\/arthas'/);
    assert.ok(!command.includes('--arthas-home'));
    assert.ok(!command.includes('unzip'));
  } finally {
    await ctx.close();
  }
});

test('an existing complete distribution retains the offline attach path and default command timeout', async () => {
  const ctx = await setup();
  const execute = ctx.manager.execute.bind(ctx.manager);
  try {
    let attachTimeout = 0;
    ctx.manager.execute = (session, command, timeout) => {
      if (command.includes('--attach-only')) attachTimeout = timeout ?? 0;
      return execute(session, command, timeout);
    };
    await attach(ctx);
    assert.equal(attachTimeout, 15000);
    const command = ctx.responder.state.commands.find((c) => c.includes('--attach-only'))!;
    assert.match(command, /--arthas-home '\/opt\/arthas'/);
    assert.ok(!command.includes('--use-version'));
    assert.equal(ctx.responder.state.installs, 0);
  } finally {
    await ctx.close();
  }
});

test('launcher preparation errors and changed targets never register a verified agent', async () => {
  for (const change of ['download-error', 'restart', 'close']) {
    const ctx = await setup();
    const execute = ctx.manager.execute.bind(ctx.manager);
    try {
      ctx.responder.state.packagePresent = false;
      ctx.responder.state.bootPresent = true;
      ctx.manager.execute = async (session, command, timeout) => {
        if (command.includes('--attach-only')) {
          if (change === 'download-error') throw new Error('官方启动器下载依赖失败');
          if (change === 'restart') ctx.responder.state.startedAt = '2026-10-29T02:00:00Z';
          if (change === 'close') ctx.arthas.disposeOwner(1);
        }
        return execute(session, command, timeout);
      };
      await assert.rejects(attach(ctx), /下载依赖失败|容器已重建|工作区已关闭/);
      assert.deepEqual(ctx.arthas.listAgents(1), []);
      assert.equal(ctx.responder.state.requests.length, 0);
    } finally {
      await ctx.close();
    }
  }
});

test('multi trace resolves concrete same-loader methods and all overloads, then revalidates before enhancing', async () => {
  const ctx = await setup(true);
  try {
    const agent = await attach(ctx);
    const root = {
      declaringClass: 'com.example.CatalogService',
      methodName: 'query',
      classLoaderHash: 'abc123',
      parameters: ['java.lang.String'],
      returnType: 'java.lang.String',
      descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
      modifier: 'public',
    };
    ctx.responder.state.scopeResults = [
      root,
      { ...root, parameters: [], descriptor: '()Ljava/lang/String;' },
      { ...root, declaringClass: 'com.example.Assembler', methodName: 'fill', modifier: 'private' },
      { ...root, methodName: '<init>', constructor: true },
      { ...root, methodName: 'abstractOnly', modifier: 'public abstract' },
      { ...root, methodName: 'nativeOnly', modifier: 'public native' },
      { ...root, classLoaderHash: 'def456' },
    ];
    const scope = await ctx.arthas.resolveTraceScope(1, {
      agentId: agent.id,
      classLoaderHash: 'abc123',
      classes: ['com.example.CatalogService', 'com.example.Assembler'],
      methods: ['query', 'fill'],
    });
    assert.equal(scope.length, 3);
    assert.ok(scope.every((method) => method.classLoaderHash === 'abc123'));
    const methods = await ctx.arthas.search(1, agent.id, 'com.example.CatalogService#query', '');
    const task = ctx.arthas.start(1, {
      agentId: agent.id,
      method: methods[0],
      kind: 'trace-multi',
      scope,
      cost: 200,
      count: 1,
      duration: 30,
    });
    await until(() => ctx.arthas.listTasks(1)[0].status === 'ended');
    assert.equal(ctx.arthas.listTasks(1)[0].scope?.length, 3);
    assert.ok(task.command.startsWith('trace -E '));
    assert.ok(!task.command.includes('#cost'));
    assert.ok(
      ctx.responder.state.requests.filter(
        (r) => r.action === 'exec' && String(r.command).startsWith('sm -d -E'),
      ).length >= 2,
    );
    await assert.rejects(
      ctx.arthas.resolveTraceScope(2, {
        agentId: agent.id,
        classLoaderHash: 'abc123',
        classes: ['com.example.CatalogService'],
        methods: ['query'],
      }),
      /不属于/,
    );
    await assert.rejects(
      ctx.arthas.resolveTraceScope(1, {
        agentId: agent.id,
        classLoaderHash: 'abc123',
        classes: ['com.example.CatalogService'],
        methods: ['nativeOnly'],
      }),
      /未找到可增强/,
    );
  } finally {
    await ctx.close();
  }
});

test('a partial or stale multi trace scope cannot start an enhancement session', async () => {
  const ctx = await setup();
  try {
    const agent = await attach(ctx);
    const methods = await ctx.arthas.search(1, agent.id, 'com.example.CatalogService#query', '');
    ctx.responder.state.scopeResults = methods.map((method) => ({
      ...method,
      declaringClass: method.className,
    }));
    const task = ctx.arthas.start(1, {
      agentId: agent.id,
      method: methods[0],
      kind: 'trace-multi',
      scope: [methods[0]],
      cost: 0,
      count: 1,
      duration: 30,
    });
    await until(() => ctx.arthas.listTasks(1)[0].status === 'error');
    assert.match(ctx.arthas.listTasks(1)[0].error!, /范围已变化|未核对的重载/);
    assert.ok(
      !ctx.responder.state.requests.some(
        (r) => r.action === 'init_session' || r.action === 'async_exec',
      ),
    );
    assert.ok(task.command.startsWith('trace -E'));
  } finally {
    await ctx.close();
  }
});
