import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../src/main/storage/project-store';
import type { Project } from '../src/shared/models';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tracelogdock-store-'));
  const file = join(directory, 'projects.json');
  return { directory, file, store: new ProjectStore(file) };
}

test('concurrent project creation persists all projects and survives a fresh store', async () => {
  const { directory, file, store } = await fixture();
  try {
    const created = await Promise.all(
      ['Alpha', 'Beta', 'Gamma'].map((name) =>
        store.create({ name, description: '', environmentName: 'Staging' }),
      ),
    );
    assert.equal(new Set(created.map((p) => p.id)).size, 3);
    assert.deepEqual(
      (await new ProjectStore(file).list()).map((p) => p.name),
      ['Alpha', 'Beta', 'Gamma'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale window edits are rejected and the queue remains usable', async () => {
  const { directory, store } = await fixture();
  try {
    const project = await store.create({
      name: 'Alpha',
      description: '',
      environmentName: 'Staging',
    });
    const saved = await store.save({ ...project, name: 'Updated' });
    assert.equal(saved.revision, 1);
    await assert.rejects(store.save({ ...project, description: 'stale' }), /其他窗口更新/);
    const next = await store.save({ ...saved, description: 'current' });
    assert.equal(next.revision, 2);
    assert.equal((await store.list())[0].name, 'Updated');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid server references cannot be persisted and credentials are not part of the schema', async () => {
  const { directory, file, store } = await fixture();
  try {
    const project = await store.create({
      name: 'Alpha',
      description: '',
      environmentName: 'Staging',
    });
    const draft: Project = structuredClone(project);
    draft.environments[0].services.push({
      id: 'service',
      name: 'catalog',
      instances: [{ id: 'instance', serverId: 'missing', containerName: 'catalog-a' }],
    });
    assert.throws(() => store.save(draft), /不存在的服务器/);
    const server = {
      id: 'server',
      name: 'A',
      kind: 'ssh' as const,
      host: 'app.example.invalid',
      port: 22,
      username: 'operator',
      assetName: '',
      password: 'not-to-be-persisted',
    };
    draft.environments[0].servers.push(server);
    draft.environments[0].services[0].instances[0].serverId = 'server';
    await store.save(draft);
    assert.ok(!(await readFile(file, 'utf8')).includes('not-to-be-persisted'));
    const stored = (await store.list())[0];
    stored.environments[0].servers = [];
    assert.throws(() => store.save(stored), /不存在的服务器/);
    assert.equal((await store.list())[0].environments[0].servers.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt configuration is reported without overwriting the existing file', async () => {
  const { directory, file, store } = await fixture();
  try {
    const original = '{invalid-json';
    await writeFile(file, original);
    await assert.rejects(
      store.create({ name: 'Alpha', description: '', environmentName: 'Staging' }),
      /已有内容未被覆盖/,
    );
    assert.equal(await readFile(file, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('removing one project preserves other projects', async () => {
  const { directory, file, store } = await fixture();
  try {
    const a = await store.create({ name: 'Alpha', description: '', environmentName: 'Staging' });
    const b = await store.create({ name: 'Beta', description: '', environmentName: 'Production' });
    await store.remove(a.id);
    assert.deepEqual(
      (await new ProjectStore(file).list()).map((p) => p.id),
      [b.id],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
