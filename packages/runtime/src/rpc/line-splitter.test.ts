import { describe, expect, it, vi } from "vitest";
import { LineSplitter } from "./line-splitter.js";

function collect(maxBytes = 1024) {
  const lines: string[] = [];
  const onOversize = vi.fn();
  const splitter = new LineSplitter(maxBytes, (line) => lines.push(line), onOversize);
  return { lines, onOversize, splitter };
}

describe("LineSplitter", () => {
  it("splits on newlines across chunk boundaries", () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from('{"a":1}\n{"b"'));
    splitter.push(Buffer.from(":2}\n"));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("strips CRLF line endings", () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from("one\r\ntwo\r\n"));
    expect(lines).toEqual(["one", "two"]);
  });

  it("keeps a multi-byte character split across chunks intact", () => {
    const { lines, splitter } = collect();
    const bytes = Buffer.from("héllo ✓\n");
    splitter.push(bytes.subarray(0, 2));
    splitter.push(bytes.subarray(2, 9));
    splitter.push(bytes.subarray(9));
    expect(lines).toEqual(["héllo ✓"]);
  });

  it("drops an oversized line and recovers on the next one", () => {
    const { lines, onOversize, splitter } = collect(8);
    splitter.push(Buffer.from("12345"));
    splitter.push(Buffer.from("67890"));
    splitter.push(Buffer.from("more\nok\n"));
    expect(onOversize).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(["ok"]);
  });

  it("emits an unterminated final line on end", () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from("last"));
    splitter.end();
    expect(lines).toEqual(["last"]);
  });
});
