import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { constants } from 'node:os';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { Server } from '../../shared/models';
import type {
  Challenge,
  ChallengeAnswer,
  ConnectionView,
  RemoteEvent,
  RemoteTarget,
} from '../../shared/remote';
import { connectionBinding, gatewayBinding } from '../../shared/commands';
import { KnownHosts } from '../storage/known-hosts';
import { FramedShell } from './framed-shell';

export class RemoteCommandUncertainError extends Error {}
export interface StreamJob {
  stop(): Promise<boolean>;
}
export interface Session {
  owner: number;
  server: Server;
  view: ConnectionView;
  client: Client;
  shell?: ClientChannel;
  framed?: FramedShell;
  seq: number;
  transcript: string;
  pending?: { challenge: Challenge; finish: (answer: ChallengeAnswer) => Promise<void> | void };
}
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly trust: KnownHosts,
    private readonly emit: (owner: number, event: RemoteEvent) => void,
  ) {}
  list(owner: number): ConnectionView[] {
    return [...this.sessions.values()].filter((s) => s.owner === owner).map((s) => ({ ...s.view }));
  }
  get(owner: number, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new Error('连接不属于当前工作区');
    return session;
  }
  findReady(owner: number, target: RemoteTarget): Session {
    const session = [...this.sessions.values()].find(
      (s) =>
        s.owner === owner &&
        s.view.projectId === target.projectId &&
        s.view.environmentId === target.environmentId &&
        s.view.serverId === target.serverId &&
        s.view.status === 'ready',
    );
    if (!session) throw new Error('请先连接此服务器；JumpServer需在终端完成选机并确认目标');
    return session;
  }
  private state(session: Session, status: ConnectionView['status'], error?: string): void {
    const changed = session.view.status !== status || session.view.error !== error;
    session.view.status = status;
    session.view.error = error;
    if (changed)
      console.info('[ssh] connection state', {
        connectionId: session.view.id,
        serverId: session.server.id,
        status,
      });
    this.emit(session.owner, { type: 'connection', connection: { ...session.view } });
  }
  private output(session: Session, data: string): void {
    session.seq += 1;
    session.transcript = (session.transcript + data).slice(-131072);
    this.emit(session.owner, {
      type: 'terminal',
      connectionId: session.view.id,
      seq: session.seq,
      data,
    });
  }
  private challenge(
    session: Session,
    input: Omit<Challenge, 'id' | 'connectionId'>,
    finish: (answer: ChallengeAnswer) => Promise<void> | void,
  ): void {
    const challenge: Challenge = { ...input, id: randomUUID(), connectionId: session.view.id };
    session.pending = { challenge, finish };
    this.emit(session.owner, { type: 'challenge', challenge });
  }
  async answer(owner: number, input: ChallengeAnswer): Promise<void> {
    const session = this.get(owner, input.connectionId);
    const pending = session.pending;
    if (!pending || pending.challenge.id !== input.challengeId) throw new Error('认证请求已失效');
    if (
      pending.challenge.kind === 'keyboard' &&
      input.answers.length !== pending.challenge.prompts.length
    )
      throw new Error('认证响应数量不匹配');
    session.pending = undefined;
    await pending.finish(input);
  }

  connect(
    owner: number,
    target: RemoteTarget,
    server: Server,
    auth: { password?: string; privateKey?: Buffer; passphrase?: string },
    reuseConnectionId?: string,
  ): ConnectionView {
    for (const current of this.sessions.values()) {
      if (
        current.owner === owner &&
        current.view.environmentId === target.environmentId &&
        current.view.serverId === target.serverId &&
        !['closed', 'error'].includes(current.view.status)
      )
        throw new Error('此服务器已有连接，请先断开后重新连接');
    }
    for (const [id, previous] of this.sessions)
      if (
        previous.owner === owner &&
        previous.view.environmentId === target.environmentId &&
        previous.view.serverId === target.serverId &&
        ['closed', 'error'].includes(previous.view.status)
      ) {
        this.disconnect(owner, id);
        this.sessions.delete(id);
      }
    let client: Client;
    if (reuseConnectionId) {
      const source = this.get(owner, reuseConnectionId);
      if (
        server.kind !== 'jumpserver' ||
        source.server.kind !== 'jumpserver' ||
        source.view.projectId !== target.projectId ||
        source.view.environmentId !== target.environmentId ||
        gatewayBinding(source.server) !== gatewayBinding(server) ||
        !['ready', 'awaiting-target'].includes(source.view.status) ||
        source.pending
      )
        throw new Error('已登录会话不匹配或已失效，请重新连接堡垒机');
      client = source.client;
    } else client = new Client();
    const session: Session = {
      owner,
      server: structuredClone(server),
      client,
      view: { ...target, id: randomUUID(), kind: server.kind, status: 'connecting' },
      seq: 0,
      transcript: '',
    };
    this.sessions.set(session.view.id, session);
    if (reuseConnectionId) {
      this.state(session, 'awaiting-target');
      this.openShell(session, true);
      console.info('[ssh] gateway login reused', {
        connectionId: session.view.id,
        sourceId: reuseConnectionId,
        serverId: server.id,
      });
      return { ...session.view };
    }
    client.on('error', (error: NodeJS.ErrnoException) => {
      // macOS local-network permission is separate from SSH authentication; Terminal-launched tests can be exempt.
      const message =
        process.platform === 'darwin' && error.code === 'EHOSTUNREACH'
          ? `尚未进入密码认证：无法连接目标网络。请在“系统设置 → 隐私与安全性 → 本地网络”中允许TraceLogDock访问，并检查内网/VPN路由。原始错误：${error.message}`
          : error.message;
      for (const current of this.sessions.values()) {
        if (current.client !== client) continue;
        if (!['closed', 'error'].includes(current.view.status)) {
          this.state(current, 'error', message);
          console.warn('[ssh] connection failed', {
            connectionId: current.view.id,
            serverId: current.server.id,
            code: error.code,
          });
        }
        current.framed?.fail('SSH连接发生错误');
      }
    });
    client.on('close', () => {
      // A transport failure affects every target PTY; closing one target below never destroys a sibling's transport.
      for (const current of this.sessions.values()) {
        if (current.client !== client) continue;
        current.pending = undefined;
        current.framed?.fail('SSH连接已关闭，远端命令状态需要重新核对');
        if (current.view.status !== 'error') this.state(current, 'closed');
      }
    });
    client.on('keyboard-interactive', (name, instructions, _language, prompts, finish) => {
      this.state(session, 'authenticating');
      this.challenge(
        session,
        {
          kind: 'keyboard',
          title: name || 'SSH交互认证',
          instruction: instructions,
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: Boolean(p.echo) })),
        },
        (answer) => finish(answer.answers),
      );
    });
    client.on('ready', () => {
      this.state(session, server.kind === 'jumpserver' ? 'awaiting-target' : 'ready');
      this.openShell(session, false);
    });
    const config: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      ...auth,
      tryKeyboard: true,
      readyTimeout: 120000,
      keepaliveInterval: 20000,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        void this.trust
          .lookup(server.host, server.port)
          .then((known) => {
            if (['closed', 'error'].includes(session.view.status)) {
              verify(false);
              return;
            }
            if (known === fingerprint) {
              this.state(session, 'authenticating');
              verify(true);
              return;
            }
            if (known) {
              this.state(
                session,
                'error',
                `SSH主机身份与已记录指纹不一致，拒绝连接。当前指纹：${fingerprint}`,
              );
              verify(false);
              return;
            }
            this.state(session, 'verifying-host');
            this.challenge(
              session,
              {
                kind: 'host',
                title: '确认SSH主机身份',
                instruction: `${server.host}:${server.port}`,
                fingerprint,
                prompts: [],
              },
              async (answer) => {
                if (!answer.acceptHost) {
                  verify(false);
                  this.disconnect(owner, session.view.id);
                  return;
                }
                try {
                  await this.trust.remember(server.host, server.port, fingerprint);
                  if (['closed', 'error'].includes(session.view.status)) {
                    verify(false);
                    return;
                  }
                  this.state(session, 'authenticating');
                  verify(true);
                } catch (error) {
                  this.state(session, 'error', (error as Error).message);
                  verify(false);
                }
              },
            );
          })
          .catch((error: Error) => {
            this.state(session, 'error', error.message);
            verify(false);
          });
      },
    };
    this.emit(owner, { type: 'connection', connection: { ...session.view } });
    try {
      client.connect(config);
    } catch (error) {
      this.state(session, 'error', (error as Error).message);
      client.destroy();
    }
    console.info('[ssh] connection requested', {
      connectionId: session.view.id,
      serverId: server.id,
      owner,
    });
    return { ...session.view };
  }

  disconnect(owner: number, id: string): void {
    const session = this.get(owner, id);
    session.pending = undefined;
    this.state(session, 'closed');
    session.framed?.fail('连接已断开，远端命令状态未知');
    session.shell?.close();
    session.shell = undefined;
    session.view.terminalReady = false;
    // Release only this target. The authenticated connection stays alive while any sibling target uses it.
    if (
      ![...this.sessions.values()].some(
        (s) =>
          s.client === session.client &&
          s !== session &&
          !['closed', 'error'].includes(s.view.status),
      )
    )
      session.client.destroy();
  }
  disposeOwner(owner: number): void {
    for (const [id, session] of this.sessions)
      if (session.owner === owner) {
        this.disconnect(owner, id);
        this.sessions.delete(id);
      }
  }
  reconcile(projectId: string, servers: { environmentId: string; server: Server }[]): void {
    for (const session of this.sessions.values()) {
      if (session.view.projectId !== projectId || ['closed', 'error'].includes(session.view.status))
        continue;
      const current = servers.find(
        (s) => s.environmentId === session.view.environmentId && s.server.id === session.server.id,
      );
      if (!current || connectionBinding(current.server) !== connectionBinding(session.server))
        this.disconnect(session.owner, session.view.id);
    }
  }
  snapshot(owner: number, id: string): { seq: number; data: string } {
    const s = this.get(owner, id);
    return { seq: s.seq, data: s.transcript };
  }
  input(owner: number, id: string, data: string): void {
    const session = this.get(owner, id);
    if (!session.shell || ['closed', 'error'].includes(session.view.status))
      throw new Error('终端尚未就绪');
    if (session.framed?.busy) throw new Error('此终端正用于Docker操作，请先停止日志任务');
    // Manual input may navigate out of a selected target. Require re-confirmation before another automatic Docker command.
    if (session.server.kind === 'jumpserver' && session.view.status === 'ready')
      this.state(session, 'awaiting-target');
    session.shell.write(data);
  }
  resize(owner: number, id: string, cols: number, rows: number): void {
    this.get(owner, id).shell?.setWindow(rows, cols, 0, 0);
  }

  async confirmTarget(owner: number, id: string): Promise<ConnectionView> {
    const session = this.get(owner, id);
    if (session.server.kind !== 'jumpserver') return { ...session.view };
    if (!session.shell || !session.framed) throw new Error('请等待终端打开并完成资产选机');
    const hostname = (await this.runFramed(session, 'hostname'))
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .trim();
    if (!hostname || /[\r\n]/.test(hostname))
      throw new Error('未获取到明确的目标主机名，请检查终端选机状态');
    session.view.hostname = hostname;
    this.state(session, 'ready');
    return { ...session.view };
  }

  private runFramed(session: Session, command: string, timeout = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        if (session.framed?.started) session.framed.interrupt();
        session.framed?.fail('目标shell没有按时完成命令，请在终端检查并重新确认目标');
        this.state(session, 'awaiting-target');
      }, timeout);
      try {
        session.framed!.start(
          command,
          (text) => {
            output += text;
          },
          (code, error) => {
            clearTimeout(timer);
            if (code === 0) resolve(output.trim());
            else reject(new Error(error || output.trim() || `远程命令失败：${code}`));
          },
        );
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  execute(session: Session, command: string, timeout = 15000): Promise<string> {
    if (session.view.status !== 'ready') return Promise.reject(new Error('目标服务器尚未就绪'));
    if (session.server.kind === 'jumpserver') return this.runFramed(session, command, timeout);
    return new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      let code: number | undefined;
      let expired = false;
      const decoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const timer = setTimeout(() => {
        expired = true;
        channel?.close();
        reject(new Error('远程命令超时'));
      }, timeout);
      let channel: ClientChannel | undefined;
      session.client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        if (expired) {
          stream.close();
          return;
        }
        channel = stream;
        stream.on('data', (data: Buffer) => {
          output += decoder.write(data);
        });
        stream.stderr.on('data', (data: Buffer) => {
          errors += stderrDecoder.write(data);
        });
        stream.on('exit', (value: number | null, signal?: string) => {
          code =
            typeof value === 'number'
              ? value
              : signal
                ? 128 +
                  (constants.signals[
                    ('SIG' + signal.replace(/^SIG/, '')) as keyof typeof constants.signals
                  ] ?? 0)
                : undefined;
        });
        stream.on('error', (failure: Error) => {
          clearTimeout(timer);
          reject(failure);
        });
        stream.on('close', () => {
          clearTimeout(timer);
          output += decoder.end();
          errors += stderrDecoder.end();
          if (code === 0) resolve(output.trim());
          else reject(new Error(errors.trim() || `远程命令未成功结束：${code ?? '状态未知'}`));
        });
      });
    });
  }

  stream(
    session: Session,
    command: string,
    onData: (text: string, source: 'stdout' | 'stderr' | 'pty') => void,
    onEnd: (code: number | null, error?: string) => void,
  ): Promise<StreamJob> {
    if (session.view.status !== 'ready') return Promise.reject(new Error('目标服务器尚未就绪'));
    if (session.server.kind === 'jumpserver') {
      return new Promise((resolve, reject) => {
        let ended = false;
        let exitCode: number | null = null;
        let complete: (() => void) | undefined;
        try {
          session.framed!.start(
            command,
            (data) => onData(data, 'pty'),
            (code, error) => {
              ended = true;
              exitCode = code;
              onEnd(code, error);
              complete?.();
            },
          );
          resolve({
            stop: async () => {
              if (ended) return exitCode !== null;
              session.framed!.interrupt();
              await new Promise<void>((done) => {
                // JumpServer relays the remote PTY exit; give its confirmation time to return.
                const timer = setTimeout(done, 5000);
                complete = () => {
                  clearTimeout(timer);
                  done();
                };
                timer.unref();
              });
              if (ended) return exitCode !== null;
              session.framed!.fail('未确认远端日志命令结束，请在终端核对');
              this.state(session, 'awaiting-target');
              return false;
            },
          });
        } catch (error) {
          reject(error);
        }
      });
    }
    return new Promise((resolve, reject) => {
      let expired = false;
      const openingTimer = setTimeout(() => {
        expired = true;
        reject(new RemoteCommandUncertainError('日志通道启动超时，远端状态未知'));
      }, 15000);
      session.client.exec(command, (error, stream) => {
        clearTimeout(openingTimer);
        if (error) {
          reject(error);
          return;
        }
        if (expired) {
          stream.close();
          return;
        }
        let ended = false;
        let exitCode: number | null = null;
        let complete: (() => void) | undefined;
        const out = new StringDecoder('utf8');
        const err = new StringDecoder('utf8');
        stream.on('data', (data: Buffer) => onData(out.write(data), 'stdout'));
        stream.stderr.on('data', (data: Buffer) => onData(err.write(data), 'stderr'));
        stream.on('exit', (code: number | null, signal?: string) => {
          exitCode =
            typeof code === 'number'
              ? code
              : signal
                ? 128 +
                  (constants.signals[
                    ('SIG' + signal.replace(/^SIG/, '')) as keyof typeof constants.signals
                  ] ?? 0)
                : null;
        });
        stream.on('error', (failure: Error) => onEnd(null, failure.message));
        stream.on('close', () => {
          ended = true;
          const tail = out.end();
          const errors = err.end();
          if (tail) onData(tail, 'stdout');
          if (errors) onData(errors, 'stderr');
          onEnd(exitCode, exitCode === null ? '连接中断，远端日志任务状态未知' : undefined);
          complete?.();
        });
        resolve({
          stop: async () => {
            if (ended) return exitCode !== null;
            try {
              stream.signal('INT');
            } catch {
              stream.close();
              return false;
            }
            await new Promise<void>((done) => {
              complete = done;
              const timer = setTimeout(done, 1500);
              timer.unref();
            });
            if (ended) return exitCode !== null;
            stream.close();
            return false;
          },
        });
      });
    });
  }

  private openShell(session: Session, reused: boolean): void {
    session.client.shell({ term: 'xterm-256color', cols: 100, rows: 28 }, (error, shell) => {
      if (error) {
        const message = reused
          ? `堡垒机未能复用登录打开新目标终端，可能限制并发通道；已有目标连接保持不变。${error.message}`
          : `无法打开终端：${error.message}`;
        this.output(session, `\r\n${message}\r\n`);
        if (session.server.kind === 'jumpserver') {
          this.state(session, 'error', message);
          if (
            ![...this.sessions.values()].some(
              (s) =>
                s.client === session.client &&
                s !== session &&
                !['closed', 'error'].includes(s.view.status),
            )
          )
            session.client.end();
        }
        return;
      }
      if (['closed', 'error'].includes(session.view.status)) {
        shell.close();
        return;
      }
      session.shell = shell;
      session.view.terminalReady = true;
      session.framed = new FramedShell(shell);
      const decoder = new StringDecoder('utf8');
      shell.on('data', (data: Buffer) => {
        const text = decoder.write(data);
        session.framed?.feed(text);
        this.output(session, text);
      });
      shell.stderr.on('data', (data: Buffer) => this.output(session, data.toString('utf8')));
      shell.on('close', () => {
        session.framed?.fail('目标终端已关闭，命令状态未知');
        session.shell = undefined;
        session.view.terminalReady = false;
        if (
          session.server.kind === 'jumpserver' &&
          !['closed', 'error'].includes(session.view.status)
        )
          this.state(session, 'error', '目标终端已关闭，请重新连接');
      });
      this.emit(session.owner, { type: 'connection', connection: { ...session.view } });
    });
  }
}
