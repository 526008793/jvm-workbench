import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildDiagnosticCommand, buildLogCommand, shellQuote } from '../src/shared/commands';

test('Docker log ranges preserve their distinct meanings', () => {
  assert.equal(
    buildLogCommand('catalog', 'new', 100, ''),
    "docker logs --follow --tail 0 --timestamps -- 'catalog'",
  );
  assert.match(buildLogCommand('catalog', 'recent', 50, ''), /--tail 50/);
  assert.match(buildLogCommand('catalog', 'since', 50, '10m'), /--since '10m'/);
  assert.throws(() => buildLogCommand('catalog', 'recent', -1, ''), /非负整数/);
  assert.throws(() => buildLogCommand('catalog\nother-command', 'new', 0, ''), /换行/);
});

test(
  'shell quoting preserves spaces, quotes and command substitutions literally',
  { skip: process.platform === 'win32' },
  () => {
    const input = "catalog's $(printf injected); value";
    const result = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(input)}`], {
      encoding: 'utf8',
    });
    assert.equal(result, input);
  },
);

test('diagnostic templates preserve event and monitor-period semantics', () => {
  const args = ['com.example.CatalogService', 'query', 200, 5] as const;
  assert.equal(
    buildDiagnosticCommand('trace', ...args),
    "trace com.example.CatalogService query '#cost > 200' -n 5",
  );
  assert.match(buildDiagnosticCommand('watch', ...args), /-s -x 2 -n 5$/);
  assert.match(buildDiagnosticCommand('exception', ...args), /-e -x 2 -n 5$/);
  assert.equal(
    buildDiagnosticCommand('monitor', ...args),
    'monitor -c 5 com.example.CatalogService query',
  );
  assert.throws(
    () => buildDiagnosticCommand('trace', 'com.example.Foo;stop', 'query', 0, 5),
    /类名/,
  );
});
