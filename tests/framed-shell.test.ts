import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ClientChannel } from 'ssh2';
import { FramedShell } from '../src/main/connections/framed-shell';
import { shellQuote } from '../src/shared/commands';

// A real controlling terminal is essential here: a fake SSH server that always prints an exit marker
// cannot reproduce how interactive shells discard the remaining command list when Ctrl+C is pressed.
const bridge = String.raw`
import os, pty, select, signal, sys, tempfile
config = tempfile.TemporaryDirectory(prefix="tld-shell-")
pid, master = pty.fork()
if pid == 0:
    os.environ['PS1'] = 'TLD_TEST_TARGET> '
    os.environ['PROMPT_COMMAND'] = ''
    os.environ['HISTFILE'] = '/dev/null'
    os.environ['PATH'] = '/usr/bin:/bin'
    os.environ['ZDOTDIR'] = config.name
    target = sys.argv[1]
    argv = [target, '-f', '-i'] if target.endswith('zsh') else [target, '--noprofile', '--norc', '-i']
    os.execv(target, argv)
try:
    while True:
        ready, _, _ = select.select([master, 0], [], [])
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data: break
            os.write(master, data)
finally:
    os.close(master)
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.waitpid(pid, 0)
    config.cleanup()
`;
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Real PTY fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const targetShell of ['/bin/bash', '/bin/zsh']) {
  test(
    `Ctrl+C over a real ${targetShell} PTY confirms termination and preserves the target for subsequent commands`,
    { skip: process.platform === 'win32' || !existsSync(targetShell), timeout: 15000 },
    async () => {
      const terminal = spawn('python3', ['-u', '-c', bridge, targetShell], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let transcript = '';
      let output = '';
      const shell = new FramedShell({
        write: (text: string) => terminal.stdin.write(text),
      } as unknown as ClientChannel);
      terminal.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        transcript += text;
        shell.feed(text);
      });
      const closed = new Promise<void>((resolve) => terminal.once('close', () => resolve()));
      try {
        await until(() => transcript.includes('TLD_TEST_TARGET>'));
        if (targetShell.endsWith('zsh')) {
          const beforeLegacy = transcript.length;
          terminal.stdin.write(
            "printf '\\036LEGACY_BEGIN\\037\\n'; sleep 30; printf '\\036LEGACY_END\\037\\n'\r",
          );
          await until(() => transcript.includes('\x1eLEGACY_BEGIN\x1f'));
          terminal.stdin.write('\x03');
          await until(() => transcript.slice(beforeLegacy).includes('TLD_TEST_TARGET>'));
          assert.ok(
            !transcript.includes('\x1eLEGACY_END\x1f'),
            'the legacy inline footer is discarded by a real interactive shell',
          );
        }

        for (let run = 0; run < 2; run += 1) {
          let code: number | null | undefined;
          output = '';
          // Signal only after the blocking child has initialized its signal handler. A parent
          // shell's printf can race the child's startup under parallel test load.
          shell.start(
            `python3 -u -c ${shellQuote("import time; print('fixture-live-stream', flush=True); time.sleep(30)")}`,
            (text) => {
              output += text;
            },
            (value) => {
              code = value;
            },
          );
          await until(() => output.includes('fixture-live-stream'));
          assert.equal(shell.started, true);
          shell.interrupt();
          await until(() => code !== undefined);
          assert.equal(code, 130);
          assert.equal(shell.busy, false);
          let nextCode: number | null | undefined;
          output = '';
          shell.start(
            `printf '%s\\n' ${shellQuote("target-still-ready's $(printf literal)")}`,
            (text) => {
              output += text;
            },
            (value) => {
              nextCode = value;
            },
          );
          await until(() => nextCode !== undefined);
          assert.equal(nextCode, 0);
          assert.match(output, /target-still-ready's \$\(printf literal\)/);
        }
      } finally {
        terminal.stdin.end();
        await closed;
      }
    },
  );
}
