import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const root = process.cwd();
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file.endsWith('.md'));

if (tracked.length === 0) {
  throw new Error('No tracked Markdown files. Stage the documentation before checking links.');
}

const failures = [];
let checked = 0;

for (const file of tracked) {
  const source = readFileSync(resolve(root, file), 'utf8');
  // These docs use inline links; external URLs and heading anchors are outside this check.
  const links = source.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g);
  for (const link of links) {
    const destination = link[1].trim().replace(/^<([^>]+)>$/, '$1');
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(destination)) continue;

    const rawPath = destination.split(/[?#]/, 1)[0];
    if (!rawPath) continue;
    const line = source.slice(0, link.index).split('\n').length;
    let target;
    try {
      target = resolve(dirname(resolve(root, file)), decodeURIComponent(rawPath));
    } catch {
      failures.push(`${file}:${line}: invalid URL encoding in ${destination}`);
      continue;
    }

    const fromRoot = relative(root, target);
    if (
      isAbsolute(rawPath) ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      failures.push(`${file}:${line}: link leaves repository: ${destination}`);
    } else if (!existsSync(target)) {
      failures.push(`${file}:${line}: missing target: ${destination}`);
    }
    checked += 1;
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${checked} relative file links across ${tracked.length} Markdown files.`);
}
