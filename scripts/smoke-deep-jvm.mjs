import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { tsImport } from 'tsx/esm/api';
const { ArthasService } = await tsImport('../src/main/arthas/arthas-service.ts', import.meta.url);
const { deepEvidence } = await tsImport('../src/shared/deep.ts', import.meta.url);
const { collectRuntimeSource } = await tsImport(
  '../src/main/analysis/runtime-source.ts',
  import.meta.url,
);
const run = promisify(execFile);
const sourceHome = process.env.TRACELOGDOCK_ARTHAS_HOME;
if (!sourceHome)
  throw new Error(
    'Set TRACELOGDOCK_ARTHAS_HOME to the official extracted Arthas 4.0.5 distribution.',
  );
const java = process.env.TRACELOGDOCK_JAVA ?? 'java';
const javac = process.env.TRACELOGDOCK_JAVAC ?? join(dirname(java), 'javac');
const root = await mkdtemp(join(tmpdir(), 'tld-multi-trace-'));
let target;
let closed;
try {
  const source = join(root, 'Main.java');
  const classes = join(root, 'classes');
  await mkdir(classes);
  await writeFile(
    source,
    `package demo.deep;
import java.io.*;
public class Main {
  public static void main(String[] args) throws Exception {
    ExportController controller = new ExportControllerChild();
    System.out.println("READY");
    BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
    String line;
    while ((line = reader.readLine()) != null) {
      if ("noise".equals(line)) {
        new Assembler().assembleForExport();
        System.out.println("NOISE_FINISHED");
      } else {
        controller.exportAllOrderList();
        System.out.println("DONE");
      }
    }
  }
}
class ExportController {
  private final ExportService service = new ExportService();
  public void exportAllOrderList() throws Exception { service.exportAllOrderList(); }
}
class ExportControllerChild extends ExportController {
  public void exportAllOrderList() throws Exception { super.exportAllOrderList(); }
}
class ExportService {
  private final Assembler assembler = new Assembler();
  public void exportAllOrderList() throws Exception { assembler.assembleForExport(); }
}
class Assembler {
  public void assembleForExport() throws Exception { doAssemble(); }
  private void doAssemble() throws Exception { fillGoodsList(); fillPackages(); fillPlatformOrderType(); }
  private void fillGoodsList() throws Exception { DataAccess.goods(); }
  private void fillPackages() throws Exception { DataAccess.packages(); }
  private void fillPlatformOrderType() throws Exception { DataAccess.types(); }
}
class DataAccess {
  public static void goods() throws Exception { Thread.sleep(3100); }
  public static void packages() throws Exception { Thread.sleep(3200); }
  public static void types() throws Exception { Thread.sleep(3300); }
}
`,
  );
  await run(javac, ['-g', '-d', classes, source]);
  const distribution = join(root, 'arthas');
  await cp(resolve(sourceHome), distribution, { recursive: true });
  // This test creates and attaches only its own disposable JVM; it never selects an existing process.
  target = spawn(java, [`-Duser.home=${root}`, '-cp', classes, 'demo.deep.Main'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve) => target.once('close', resolve));
  let output = '';
  target.stdout.on('data', (data) => {
    output += data;
  });
  const until = async (predicate) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Multi trace JVM smoke timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await until(() => output.includes('READY'));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const session = { view: { id: 'multi-smoke' } };
  const sessions = {
    findReady: () => session,
    execute: async (_session, command, timeout = 15000) => {
      if (command.includes('printf present')) return 'present';
      const result = await run('/bin/sh', ['-c', command], { timeout, maxBuffer: 4 * 1024 * 1024 });
      return result.stdout;
    },
  };
  const service = new ArthasService(sessions, () => {});
  // Docker identity is a local adapter; all launcher/HTTP/method resolution/trace execution is real.
  service.verify = async () => session;
  service.exec = (_jvm, command) => command;
  const agent = await service.attach(1, {
    jvm: {
      projectId: 'local',
      environmentId: 'local',
      serviceId: 'local',
      instanceId: 'local',
      connectionId: 'multi-smoke',
      serverId: 'local',
      containerId: 'a'.repeat(64),
      containerName: 'local-only',
      startedAt: 'local',
      uid: String(process.getuid?.() ?? 0),
      startTicks: '1',
      java,
      pid: target.pid,
    },
    home: distribution,
    port,
  });
  const methods = await service.search(
    1,
    agent.id,
    'demo.deep.ExportController#exportAllOrderList',
    '',
  );
  const entry = methods[0];
  const task = service.start(1, {
    agentId: agent.id,
    method: entry,
    kind: 'deep',
    count: 1,
    sampleIntervalMs: 100,
    cost: 0,
    duration: 30,
  });
  await until(() => ['waiting', 'error', 'unknown'].includes(service.listTasks(1)[0].status));
  assert.equal(service.listTasks(1)[0].status, 'waiting');
  const enhancementsBefore = service
    .listTasks(1)[0]
    .results.find((r) => r.type === 'enhancer').effect;
  assert.equal(enhancementsBefore.classCount, 1);
  assert.equal(enhancementsBefore.methodCount, 1);
  target.stdin.write('go\n');
  await until(() => service.listTasks(1)[0].deep.samples > 0);
  assert.equal(
    output.includes('DONE'),
    false,
    'deep results appear while the only export is still running',
  );
  await until(() =>
    ['ended', 'error', 'unknown', 'stopped'].includes(service.listTasks(1)[0].status),
  );
  await service.tasks.get(task.id).run;
  const result = service.listTasks(1)[0];
  assert.equal(result.status, 'ended', result.error);
  assert.equal(result.deep.phase, 'complete');
  assert.ok(
    result.deep.durationMs > 9500 && result.deep.durationMs < 15000,
    'paired monotonic markers give real entry duration despite watch -b/-f cost',
  );
  const names = result.deep.paths.flatMap((path) => path.frames.map((f) => f.methodName));
  for (const name of [
    'assembleForExport',
    'doAssemble',
    'fillGoodsList',
    'fillPackages',
    'fillPlatformOrderType',
    'goods',
    'packages',
    'types',
  ])
    assert.ok(names.includes(name), name + ' found without specifying any downstream class');
  assert.ok(
    result.deep.paths.every(
      (path) => path.frames.at(-1).className === 'demo.deep.ExportController',
    ),
  );
  assert.ok(result.deep.paths.some((path) => path.frames.some((f) => f.lineNumber > 0)));
  assert.ok(result.deep.paths.every((path) => deepEvidence(path).label === '休眠/重试间隔线索'));
  assert.equal(output.split('DONE').length - 1, 1, 'only one entry execution is needed');
  const sources = await collectRuntimeSource(service, 1, result, AbortSignal.timeout(30000));
  assert.equal(sources.origin, 'arthas');
  for (const name of [
    'exportAllOrderList',
    'doAssemble',
    'fillGoodsList',
    'fillPackages',
    'fillPlatformOrderType',
    'goods',
    'packages',
    'types',
  ])
    assert.ok(
      sources.pieces.some((piece) => piece.method.endsWith('#' + name)),
      'real jad method ' + name,
    );
  assert.ok(
    sources.pieces.every((piece) => piece.kind === 'decompiled' && piece.match === 'runtime'),
  );
  assert.ok(sources.notes.some((note) => note.includes('Mapper XML')));
  console.log(
    'Real Arthas jad source collection passed:',
    sources.pieces.map((piece) => piece.method).join(', '),
  );
  const snapshots = service.listTasks(1);
  snapshots[0].deep.paths.length = 0;
  assert.ok(service.listTasks(1)[0].deep.paths.length > 0);
  console.log(
    'Real deep JVM smoke passed: one enhanced entry, one export, automatic private/downstream/leaf stacks, live progress, source lines, paired real duration, evidence labels, scoped automatic stop and immutable task snapshots.',
    JSON.stringify({
      samples: result.deep.samples,
      paths: result.deep.paths.length,
      durationMs: result.deep.durationMs,
    }),
  );
} finally {
  if (target && target.exitCode === null && target.signalCode === null) target.kill('SIGTERM');
  if (closed) await closed;
  await rm(root, { recursive: true, force: true });
}
