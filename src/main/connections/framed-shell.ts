import { randomBytes } from 'node:crypto';
import type { ClientChannel } from 'ssh2';

interface ActiveFrame {
  start: string;
  end: string;
  began: boolean;
  buffer: string;
  data: (text: string) => void;
  endJob: (code: number | null, error?: string) => void;
}

// JumpServer may offer only one interactive target shell. Frame markers distinguish actual shell output from menu/command echo.
export class FramedShell {
  private active?: ActiveFrame;
  constructor(private readonly channel: ClientChannel) {}
  get started(): boolean {
    return Boolean(this.active?.began);
  }
  get busy(): boolean {
    return Boolean(this.active);
  }

  feed(text: string): void {
    const active = this.active;
    if (!active) return;
    active.buffer += text;
    if (!active.began) {
      const start = active.buffer.indexOf(active.start);
      if (start < 0) {
        active.buffer = active.buffer.slice(-active.start.length);
        return;
      }
      active.began = true;
      active.buffer = active.buffer.slice(start + active.start.length).replace(/^\r?\n/, '');
    }
    const end = active.buffer.indexOf(active.end);
    if (end >= 0) {
      const suffix = active.buffer.slice(end + active.end.length);
      const match = /^(\d+)\x1f/.exec(suffix);
      if (!match) return;
      const output = active.buffer.slice(0, end);
      this.active = undefined;
      if (output) active.data(output);
      active.endJob(Number(match[1]));
      return;
    }
    // Keep a tail so a marker split across packets is never emitted as business output.
    let keep = 0;
    for (let length = 1; length <= Math.min(active.end.length, active.buffer.length); length += 1) {
      if (active.buffer.endsWith(active.end.slice(0, length))) keep = length;
    }
    const safe = active.buffer.length - keep;
    if (safe > 0) {
      active.data(active.buffer.slice(0, safe));
      active.buffer = active.buffer.slice(safe);
    }
  }

  start(
    command: string,
    onData: (text: string) => void,
    onEnd: (code: number | null, error?: string) => void,
  ): void {
    if (this.active)
      throw new Error('此JumpServer会话已有命令运行，请先停止日志或使用另一目标会话');
    const token = randomBytes(12).toString('hex');
    this.active = {
      start: `\x1eTLD_BEGIN_${token}\x1f`,
      end: `\x1eTLD_END_${token}:`,
      began: false,
      buffer: '',
      data: onData,
      endJob: onEnd,
    };
    // The complete marker is absent from command text, so echoed input cannot masquerade as executed output.
    try {
      this.channel.write(
        `printf '\\036TLD_BEGIN_%s\\037\\n' '${token}'; ${command}; __tld_code=$?; printf '\\036TLD_END_%s:%s\\037\\n' '${token}' "$__tld_code"\r`,
      );
    } catch (error) {
      this.active = undefined;
      throw error;
    }
  }

  fail(message: string): void {
    const active = this.active;
    this.active = undefined;
    active?.endJob(null, message);
  }
  interrupt(): void {
    this.channel.write('\x03');
  }
}
