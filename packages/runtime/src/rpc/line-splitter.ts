/**
 * Splits an NDJSON byte stream into lines (ADR-0003).
 *
 * Bytes are buffered until a newline and decoded once, so multi-byte UTF-8 characters split
 * across chunks survive. A line longer than `maxBytes` is dropped while it streams in, so an
 * oversized message never sits in memory; `onOversize` fires once per dropped line.
 */
export class LineSplitter {
  private parts: Buffer[] = [];
  private size = 0;
  private discarding = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversize: () => void,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        this.append(chunk.subarray(start));
        return;
      }
      this.append(chunk.subarray(start, newline));
      this.flush();
      start = newline + 1;
    }
  }

  /** Emits a final line that was not newline-terminated. */
  end(): void {
    if (!this.discarding && this.size > 0) this.flush();
    this.reset();
  }

  private append(part: Buffer): void {
    if (this.discarding || part.length === 0) return;
    if (this.size + part.length > this.maxBytes) {
      this.reset();
      this.discarding = true;
      this.onOversize();
      return;
    }
    this.parts.push(part);
    this.size += part.length;
  }

  private flush(): void {
    if (this.discarding) {
      this.reset();
      return;
    }
    let line = Buffer.concat(this.parts, this.size).toString("utf8");
    this.reset();
    if (line.endsWith("\r")) line = line.slice(0, -1);
    this.onLine(line);
  }

  private reset(): void {
    this.parts = [];
    this.size = 0;
    this.discarding = false;
  }
}
