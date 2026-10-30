import { randomUUID } from 'node:crypto';
import type { LogRow } from '../../shared/remote';

export type LogMessage = Pick<LogRow, 'id' | 'text' | 'stream' | 'receivedAt' | 'timestamp'>;

const dockerTimestamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) /;
const javaHeader =
  /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?\s+(?:\[[^\]\r\n]*\]\s+)?(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/;
// Keep the existing long-text display bound; split oversized records without dropping their content.
const maxText = 65536;

export class LogAssembler {
  private readonly buffers = new Map<LogRow['stream'], string>();
  private readonly active = new Map<LogRow['stream'], LogMessage>();

  constructor(private readonly emit: (message: LogMessage) => void) {}

  write(text: string, stream: LogRow['stream']): void {
    let pending = (this.buffers.get(stream) ?? '') + text;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      this.line(pending.slice(0, newline).replace(/\r$/, ''), stream);
      pending = pending.slice(newline + 1);
    }
    while (pending.length > maxText) {
      this.line(pending.slice(0, maxText), stream);
      pending = pending.slice(maxText);
    }
    this.buffers.set(stream, pending);
  }

  finish(): void {
    for (const [stream, text] of this.buffers) if (text) this.line(text.replace(/\r$/, ''), stream);
    this.buffers.clear();
    this.active.clear();
  }

  private line(raw: string, stream: LogRow['stream']): void {
    // Do not strip a business timestamp when a PTY line already starts with a Java log header.
    const plain = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const prefix = javaHeader.test(plain) ? undefined : dockerTimestamp.exec(raw);
    const text = prefix ? raw.slice(prefix[0].length) : raw;
    // ANSI colors affect header detection only; retain the original business text.
    const header = javaHeader.test(prefix ? plain.slice(prefix[0].length) : plain);
    const previous = header ? undefined : this.active.get(stream);
    if (!text && !previous) return;
    if (previous && previous.text.length + 1 + text.length <= maxText) {
      const message = { ...previous, text: `${previous.text}\n${text}` };
      this.active.set(stream, message);
      this.emit(message);
      return;
    }
    // A Java header starts an event; subsequent lines stay together regardless of Docker timestamps
    // or network batching. Unrecognized standalone output remains individually visible.
    for (let offset = 0; offset < text.length; offset += maxText) {
      const message: LogMessage = {
        id: randomUUID(),
        text: text.slice(offset, offset + maxText),
        stream,
        timestamp: previous?.timestamp ?? prefix?.[1],
        receivedAt: previous?.receivedAt ?? Date.now(),
      };
      if (header || previous) this.active.set(stream, message);
      this.emit(message);
    }
  }
}
