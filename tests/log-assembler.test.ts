import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogAssembler, type LogMessage } from '../src/main/docker/log-assembler';

test('SQL continuation lines update one event across chunks and distinct Docker timestamps', () => {
  const snapshots: LogMessage[] = [];
  const messages = new Map<string, LogMessage>();
  const assembler = new LogAssembler((message) => {
    snapshots.push(message);
    messages.set(message.id, message);
  });
  const header =
    '2026-10-29T15:42:21.704+08:00  INFO 6 --- [mall-business] [nio-8087-exec-1] mapper :';
  const lines = [
    header,
    '================ SQL日志 ================',
    'SQL类型：SELECT',
    '',
    '执行时间：2ms',
    '完整SQL：SELECT shop_id FROM shop_base',
    '========================================',
  ];
  const input = lines
    .map((line, i) => `2026-10-29T07:42:21.${String(704000000 + i)}Z ${line}\r\n`)
    .join('');
  // One-byte-sized text fragments exercise boundaries inside timestamps, CRLF and headers.
  for (const character of input) assembler.write(character, 'stdout');
  assert.equal(messages.size, 1);
  const sql = [...messages.values()][0];
  assert.equal(sql.text, lines.join('\n'));
  assert.equal(sql.timestamp, '2026-10-29T07:42:21.704000000Z');
  assert.equal(snapshots[0].text, header, 'previously emitted snapshots must remain immutable');
  assembler.write(
    '2026-10-29T07:42:21.704999999Z 2026-10-29T15:42:21.704+08:00 INFO 6 --- next request\n',
    'stdout',
  );
  assert.equal(
    messages.size,
    2,
    'separate application headers remain separate even in the same millisecond',
  );
});

test('stack traces retain blank and trailing lines, isolate streams and keep the final record visible', () => {
  const messages = new Map<string, LogMessage>();
  const assembler = new LogAssembler((message) => messages.set(message.id, message));
  assembler.write(
    '\x1b[31m2026-10-29 15:43:00,123 [main] ERROR service - failed\x1b[0m\njava.lang.IllegalStateException: boom\n',
    'stderr',
  );
  assembler.write('an independent stdout line\nanother stdout line\n', 'stdout');
  assembler.write(
    '\tat com.example.Service.query(Service.java:7)\n\nCaused by: java.io.IOException: final line',
    'stderr',
  );
  assembler.finish();
  const rows = [...messages.values()];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].stream, 'stderr');
  assert.match(
    rows[0].text,
    /failed\x1b\[0m\njava.lang.IllegalStateException: boom\n\tat com.example.Service.query\(Service.java:7\)\n\nCaused by: java.io.IOException: final line$/,
  );
  assert.equal(rows[1].text, 'an independent stdout line');
  assert.equal(rows[2].text, 'another stdout line');
  assembler.finish();
  assert.equal(messages.size, 3, 'finishing twice must not duplicate the last line');
});

test('independent task assemblers never merge continuation lines between instances', () => {
  const a = new Map<string, LogMessage>();
  const b = new Map<string, LogMessage>();
  const first = new LogAssembler((message) => a.set(message.id, message));
  const second = new LogAssembler((message) => b.set(message.id, message));
  first.write('2026-10-29T15:00:00+08:00 INFO order\n', 'pty');
  second.write('2026-10-29T15:00:00+08:00 INFO goods\n', 'pty');
  first.write('order SQL\n', 'pty');
  second.write('goods SQL\n', 'pty');
  assert.equal(a.size, 1);
  assert.equal(b.size, 1);
  assert.equal([...a.values()][0].text, '2026-10-29T15:00:00+08:00 INFO order\norder SQL');
  assert.equal([...b.values()][0].text, '2026-10-29T15:00:00+08:00 INFO goods\ngoods SQL');
  assert.notEqual([...a.keys()][0], [...b.keys()][0]);
});

test('oversized and unfinished output is bounded without losing message characters', () => {
  const messages = new Map<string, LogMessage>();
  const assembler = new LogAssembler((message) => messages.set(message.id, message));
  const text = '2026-10-29T15:00:00+08:00 INFO ' + 'x'.repeat(150000);
  assembler.write(text, 'stdout');
  assembler.finish();
  const rows = [...messages.values()];
  assert.equal(rows.map((row) => row.text).join(''), text);
  assert.ok(rows.every((row) => row.text.length <= 65536));
});
