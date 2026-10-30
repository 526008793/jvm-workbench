import { generateKeyPairSync } from 'node:crypto';
import { Server, utils, type Connection, type ServerChannel } from 'ssh2';
import type { AddressInfo } from 'node:net';

export function generateFixtureKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}
export async function createSshFixture(
  options: {
    mfa?: boolean;
    mfaAfterPassword?: boolean;
    maxShellsPerConnection?: number;
    publicKey?: string;
    ignoreSignal?: boolean;
    interruptDelayMs?: number;
    port?: number;
    hostKey?: string;
    commandOutput?: (command: string) => string | undefined;
  } = {},
) {
  const logWriters = new Set<(text: string) => void>();
  const clients = new Set<Connection>();
  const commands: string[] = [];
  const inputs: string[] = [];
  const key = options.publicKey ? utils.parseKey(options.publicKey) : undefined;
  const parsedKey = key && !(key instanceof Error) ? key : undefined;
  const server = new Server({ hostKeys: [options.hostKey ?? generateFixtureKey()] }, (client) => {
    clients.add(client);
    client.on('error', () => undefined);
    client.on('close', () => clients.delete(client));
    let passwordAccepted = false;
    let openShells = 0;
    client.on('authentication', (context) => {
      if (context.username !== 'operator') {
        context.reject();
        return;
      }
      // JumpServer can advertise password first and offer keyboard-interactive only after partial success.
      if (options.mfaAfterPassword) {
        if (!passwordAccepted) {
          if (context.method === 'password' && context.password === 'fixture-password') {
            passwordAccepted = true;
            context.reject(['keyboard-interactive'], true);
          } else context.reject(['password', 'publickey']);
        } else if (context.method === 'keyboard-interactive') {
          context.prompt([{ prompt: 'OTP Code:', echo: false }], (answers) => {
            if (answers[0] === '123456') context.accept();
            else context.reject(['keyboard-interactive']);
          });
        } else context.reject(['keyboard-interactive']);
        return;
      }
      if (
        context.method === 'publickey' &&
        parsedKey &&
        context.key.data.equals(parsedKey.getPublicSSH())
      ) {
        if (
          !context.signature ||
          parsedKey.verify(context.blob!, context.signature, context.hashAlgo) === true
        )
          context.accept();
        else context.reject();
      } else if (
        context.method === 'password' &&
        context.password === 'fixture-password' &&
        !options.mfa
      )
        context.accept();
      else if (context.method === 'keyboard-interactive' && options.mfa)
        context.prompt([{ prompt: 'OTP Code:', echo: false }], (answers) => {
          if (answers[0] === '123456') context.accept();
          else context.reject();
        });
      else
        context.reject(
          options.mfa ? ['keyboard-interactive'] : options.publicKey ? ['publickey'] : ['password'],
        );
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        let active: ServerChannel | undefined;
        let token: string | undefined;
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('window-change', (acceptChange) => acceptChange?.());
        function output(command: string): string {
          const custom = options.commandOutput?.(command);
          if (custom !== undefined) return custom;
          if (command.includes('docker ps'))
            return (
              JSON.stringify({
                ID: 'a'.repeat(64),
                Names: 'catalog-a',
                Image: 'fixture/catalog:1',
                Status: 'Up 1 minute',
              }) + '\n'
            );
          if (command.includes('docker inspect'))
            return (
              JSON.stringify({
                id: 'a'.repeat(64),
                running: true,
                startedAt: '2026-10-29T01:00:00Z',
              }) + '\n'
            );
          if (command.includes('hostname')) return 'fixture-target\n';
          return 'fixture command\n';
        }
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          active = stream;
          commands.push(info.command);
          if (info.command.startsWith('docker logs')) {
            const message = Buffer.from('2026-10-29T01:00:01.000000000Z 你好 fixture-live-log\n');
            stream.write(message.subarray(0, 32));
            stream.write(message.subarray(32));
            stream.stderr.write('2026-10-29T01:00:02Z fixture-error-line\n');
            if (info.command.includes('--until ') && !info.command.includes('--follow ')) {
              stream.exit(0);
              stream.end();
              return;
            }
            const write = (text: string) => stream.write(text + '\n');
            logWriters.add(write);
            stream.on('close', () => logWriters.delete(write));
          } else {
            stream.write(output(info.command));
            stream.exit(0);
            stream.end();
          }
        });
        session.on('signal', (acceptSignal) => {
          acceptSignal?.();
          if (!options.ignoreSignal && active) {
            active.exit(130);
            active.end();
          }
        });
        session.on('shell', (acceptShell, rejectShell) => {
          if (
            options.maxShellsPerConnection !== undefined &&
            openShells >= options.maxShellsPerConnection
          ) {
            rejectShell();
            return;
          }
          const stream = acceptShell();
          openShells += 1;
          stream.once('close', () => {
            openShells -= 1;
          });
          let line = '';
          let selected = false;
          let writer: ((text: string) => void) | undefined;
          stream.on('close', () => {
            if (writer) logWriters.delete(writer);
          });
          stream.write('JumpServer fixture\r\nOpt> ');
          stream.on('data', (data: Buffer) => {
            for (const char of data.toString('utf8')) {
              if (char === '\x03') {
                inputs.push(char);
                if (options.ignoreSignal) continue;
                if (token) {
                  if (writer) logWriters.delete(writer);
                  const stoppedToken = token;
                  token = undefined;
                  const acknowledge = () => {
                    if (!stream.destroyed && !stream.writableEnded)
                      stream.write(`\x1eTLD_END_${stoppedToken}:130\x1f\r\n$ `);
                  };
                  if (options.interruptDelayMs) setTimeout(acknowledge, options.interruptDelayMs);
                  else acknowledge();
                }
                continue;
              }
              if (char !== '\r' && char !== '\n') {
                line += char;
                continue;
              }
              if (!line) continue;
              const command = line;
              line = '';
              inputs.push(command);
              stream.write(`${command}\r\n`);
              if (!selected) {
                if (command === '1') {
                  selected = true;
                  stream.write('fixture-target$ ');
                } else stream.write('1 | example-app-a\r\nOpt> ');
                continue;
              }
              const executed = command.startsWith('sh -c ')
                ? command.slice(7, -1).replaceAll(`'"'"'`, "'")
                : command;
              const marker = /'([a-f0-9]{24})'/.exec(executed)?.[1];
              if (marker) {
                commands.push(command);
                stream.write(`\x1eTLD_BEGIN_${marker}\x1f\r\n`);
                if (command.includes('docker logs')) {
                  token = marker;
                  writer = (text: string) => stream.write(text + '\n');
                  logWriters.add(writer);
                  stream.write('2026-10-29T01:00:01Z fixture-pty-live-log\n');
                } else {
                  stream.write(output(executed));
                  stream.write(`\x1eTLD_END_${marker}:0\x1f\r\n$ `);
                }
              } else stream.write('fixture-target$ ');
            }
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  return {
    emitLog: (text: string) => {
      for (const write of logWriters) write(text);
    },
    port: (server.address() as AddressInfo).port,
    commands,
    inputs,
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
