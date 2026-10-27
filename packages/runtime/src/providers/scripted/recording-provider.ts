import type { ModelInfo } from "@jesutobits/protocol";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../types.js";
import type { CassetteEvent, CassetteLine } from "./cassette.js";

export interface RecordingOptions {
  /** Receives each finished request as one cassette line (JSON, without a newline). */
  write(line: string): void;
  /** Masks secrets in the line before it is written (the SecretRegistry's `mask`). */
  mask(text: string): string;
}

/**
 * Wraps a real adapter and records every stream as a cassette line, for writing new
 * cassettes during development (TESTING_STRATEGY.md section 3.1). Requests are not
 * recorded; add `expect` by hand where a cassette should check what was sent.
 */
export class RecordingProvider implements ModelProvider {
  private step = 0;

  constructor(
    private readonly inner: ModelProvider,
    private readonly options: RecordingOptions,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return this.inner.listModels(signal);
  }

  testConnection(signal?: AbortSignal) {
    return this.inner.testConnection(signal);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const events: CassetteEvent[] = [];
    try {
      for await (const event of this.inner.stream(request, signal)) {
        events.push(event);
        yield event;
      }
    } finally {
      const line: CassetteLine = { step: this.step++, events };
      this.options.write(this.options.mask(JSON.stringify(line)));
    }
  }
}
