/**
 * A server-sent events parser (the WHATWG "event stream" format), fed text chunks as they
 * arrive. ADR-0005 planned `eventsource-parser`; the npm registry was unreachable when this
 * was written, and the format is small enough to own.
 *
 * - Lines end with LF, CRLF or CR, and may be split across chunks anywhere.
 * - A blank line dispatches the event built so far; `data` lines join with LF.
 * - A line starting with `:` is a comment, reported through `onComment`.
 * - `event` sets the event's name; `id` and `retry` are ignored (no reconnection here).
 */
export interface SseEvent {
  event: string | undefined;
  data: string;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event: string | undefined;
  private hasData = false;
  /** A chunk ended with CR, so a LF at the start of the next one ends the same line. */
  private pendingCr = false;

  constructor(
    private readonly onEvent: (event: SseEvent) => void,
    private readonly onComment: (comment: string) => void = () => undefined,
  ) {}

  feed(chunk: string): void {
    let text = chunk;
    if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.pendingCr = false;
    this.buffer += text;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A trailing CR may be the first half of CRLF; decide when more text arrives.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) {
        this.pendingCr = true;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
    }
  }

  /** The stream ended: an event without its blank line is dropped, as the format says. */
  end(): void {
    this.buffer = "";
    this.reset();
  }

  private line(line: string): void {
    if (line === "") {
      if (this.hasData) this.onEvent({ event: this.event, data: this.data.join("\n") });
      this.reset();
      return;
    }
    if (line.startsWith(":")) {
      this.onComment(line.slice(1).trimStart());
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.data.push(value);
      this.hasData = true;
    } else if (field === "event") {
      this.event = value;
    }
  }

  private reset(): void {
    this.data = [];
    this.event = undefined;
    this.hasData = false;
  }
}
