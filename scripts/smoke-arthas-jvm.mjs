import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { tsImport } from 'tsx/esm/api';
const { ArthasService } = await tsImport('../src/main/arthas/arthas-service.ts', import.meta.url);
const run = promisify(execFile);
const distribution = process.env.TRACELOGDOCK_ARTHAS_HOME;
if (!distribution)
  throw new Error(
    'Set TRACELOGDOCK_ARTHAS_HOME to an extracted official Arthas 4.0.5 distribution.',
  );
const java = process.env.TRACELOGDOCK_JAVA ?? 'java';
const root = await mkdtemp(join(tmpdir(), 'tld-jvm-smoke-'));
try {
  const cache = join(root, '.arthas/lib/4.0.5/arthas');
  await mkdir(cache, { recursive: true });
  await cp(resolve(distribution), cache, { recursive: true });
  await cp(join(cache, 'arthas-boot.jar'), join(root, 'arthas-boot.jar'));
  const env = { ...process.env, ARTHAS_LIB_DIR: join(root, '.arthas/lib') };
  for (const mode of ['boot', 'distribution']) {
    // Own the target process: this smoke test never selects or attaches another local JVM.
    const target = spawn(java, [`-Duser.home=${root}`, '-jar', join(cache, 'math-game.jar')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise((resolve) => target.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Temporary JVM did not start')), 10000);
        target.stdout.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
        target.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        target.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Temporary JVM exited: ${code}`));
        });
      });
      const listener = createServer();
      await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const port = listener.address().port;
      await new Promise((resolve) => listener.close(resolve));
      const base = [`-Duser.home=${root}`, '-jar', join(cache, 'arthas-boot.jar')];
      const location =
        mode === 'boot'
          ? ['--use-version', '4.0.5', '--repo-mirror', 'center']
          : ['--arthas-home', cache];
      const args = [...base, ...location, '--attach-only', '--target-ip', '127.0.0.1'];
      if (mode === 'boot') {
        await assert.rejects(
          run(
            java,
            [...args, '--telnet-port', '-1', '--http-port', String(port), String(target.pid)],
            { env, timeout: 30000 },
          ),
          (error) => /port out of range:-1/.test(error.stdout + error.stderr),
        );
      }
      // Capture the production service's generated command while running a real launcher/JVM.
      // Container discovery/identity is supplied here; real Docker remains a separate integration check.
      let command;
      const session = { view: { id: 'local-smoke' } };
      const sessions = {
        execute: async (_session, value) => {
          if (value.includes('printf present')) return mode === 'boot' ? 'boot' : 'present';
          if (value.includes('--attach-only')) {
            command = value;
            const { stdout } = await run('/bin/sh', ['-c', value], { env, timeout: 45000 });
            return stdout;
          }
          return (await run('/bin/sh', ['-c', value], { env, timeout: 10000 })).stdout;
        },
      };
      const service = new ArthasService(sessions, () => {});
      service.verify = async () => session;
      service.exec = (_jvm, value) => value;
      const agent = await service.attach(1, {
        jvm: {
          projectId: 'local',
          environmentId: 'local',
          serviceId: 'local',
          instanceId: 'local',
          connectionId: 'local-smoke',
          serverId: 'local',
          containerId: 'a'.repeat(64),
          containerName: 'local-test-only',
          startedAt: 'local-test',
          uid: String(process.getuid?.() ?? 0),
          startTicks: '1',
          java,
          pid: target.pid,
        },
        home: mode === 'boot' ? root : cache,
        port,
      });
      assert.equal(agent.version, '4.0.5');
      assert.equal(agent.jvm.pid, target.pid);
      assert.match(command, /--telnet-port 0/);
      assert.ok(!command.includes('--telnet-port -1'));
      console.log(`Real JVM ${mode} attach passed HTTP version/session and PID verification.`);
    } finally {
      if (target.exitCode === null && target.signalCode === null) target.kill('SIGTERM');
      await closed;
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
