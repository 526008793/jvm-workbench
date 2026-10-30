import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTHAS_BOOT_SHA256, packageInstall, packageProbe } from '../src/main/arthas/package';

test(
  'launcher installation needs neither unzip nor jar, verifies SHA-256 and preserves destination on failures',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tld-package-'));
    try {
      const bin = join(root, 'bin');
      const home = join(root, "destination with ' quotes");
      const launcher = join(root, 'fixture.jar');
      await mkdir(bin);
      await writeFile(launcher, 'synthetic boot jar');
      const hash = createHash('sha256')
        .update(await readFile(launcher))
        .digest('hex');
      await writeFile(
        join(bin, 'curl'),
        '#!/bin/sh\n[ "$FAIL_DOWNLOAD" = 1 ] && exit 22\nwhile [ "$1" != --output ]; do shift; done\ncp "$FIXTURE_BOOT" "$2"\n',
        { mode: 0o700 },
      );
      await writeFile(
        join(bin, 'java'),
        '#!/bin/sh\nprintf "arthas-boot version: %s\\n" "${BOOT_VERSION:-4.0.5}"\n',
        { mode: 0o700 },
      );
      // A constrained container PATH deliberately excludes both unzip and the JDK jar executable.
      for (const tool of ['mktemp', 'mkdir', 'cp', 'rm']) {
        const path = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], {
          encoding: 'utf8',
        }).trim();
        await symlink(path, join(bin, tool));
      }
      const checksum = spawnSync('/bin/sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' });
      if (checksum.status === 0) await symlink(checksum.stdout.trim(), join(bin, 'sha256sum'));
      else {
        const shasum = execFileSync('/bin/sh', ['-c', 'command -v shasum'], {
          encoding: 'utf8',
        }).trim();
        await writeFile(join(bin, 'sha256sum'), `#!/bin/sh\nexec '${shasum}' -a 256 "$@"\n`, {
          mode: 0o700,
        });
      }
      const env = { ...process.env, PATH: bin, FIXTURE_BOOT: launcher };
      const script = packageInstall(home, join(bin, 'java'))
        .replace(ARTHAS_BOOT_SHA256, hash)
        .replace('/tmp/tracelogdock-arthas.XXXXXX', `${root}/stage.XXXXXX`);
      const probe = () => execFileSync('/bin/sh', ['-c', packageProbe(home)], { encoding: 'utf8' });
      assert.equal(probe(), 'missing');
      execFileSync('/bin/sh', ['-c', script], { env });
      assert.equal(probe(), 'boot');
      assert.equal(await readFile(join(home, 'arthas-boot.jar'), 'utf8'), 'synthetic boot jar');
      await writeFile(join(home, 'keep.txt'), 'keep');
      for (const [failure, failureEnv, expected] of [
        [script.replace(hash, '0'.repeat(64)), env, /SHA-256/],
        [script, { ...env, FAIL_DOWNLOAD: '1' }, /下载失败/],
        [script, { ...env, BOOT_VERSION: '4.0.4' }, /版本不匹配/],
        [packageInstall(join(home, 'keep.txt', 'child'), join(bin, 'java')), env, /目录不可写/],
      ] as const) {
        const result = spawnSync('/bin/sh', ['-c', failure], { env: failureEnv, encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
        assert.equal(await readFile(join(home, 'keep.txt'), 'utf8'), 'keep');
        assert.equal(await readFile(join(home, 'arthas-boot.jar'), 'utf8'), 'synthetic boot jar');
        assert.ok(!(await readdir(root)).some((name) => name.startsWith('stage.')));
      }
      for (const jar of ['core', 'agent', 'spy', 'client'])
        await writeFile(join(home, `arthas-${jar}.jar`), jar);
      await mkdir(join(home, 'lib'));
      assert.equal(probe(), 'present');
      const pinned = spawnSync('/bin/sh', ['-c', script.replace(hash, ARTHAS_BOOT_SHA256)], {
        env,
        encoding: 'utf8',
      });
      assert.notEqual(pinned.status, 0);
      assert.match(pinned.stderr, /SHA-256/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
