import { describe, expect, it } from "vitest";
import { SseParser, type SseEvent } from "./sse.js";

interface Recorded {
  events: SseEvent[];
  comments: string[];
}

function open(): { parser: SseParser; recorded: Recorded } {
  const recorded: Recorded = { events: [], comments: [] };
  const parser = new SseParser(
    (event) => recorded.events.push(event),
    (comment) => recorded.comments.push(comment),
  );
  return { parser, recorded };
}

/** Feeds the whole text at once, then ends the stream, as the adapter does. */
function parse(text: string): Recorded {
  const { parser, recorded } = open();
  parser.feed(text);
  parser.end();
  return recorded;
}

function parseByCharacter(text: string): Recorded {
  const { parser, recorded } = open();
  for (let index = 0; index < text.length; index += 1) parser.feed(text[index] ?? "");
  parser.end();
  return recorded;
}

describe("SseParser", () => {
  it("dispatches one event from one block", () => {
    expect(parse("data: hello\n\n")).toEqual({
      events: [{ event: undefined, data: "hello" }],
      comments: [],
    });
  });

  it("joins multi-line data with a line feed", () => {
    expect(parse("data: one\ndata: two\ndata: three\n\n").events).toEqual([
      { event: undefined, data: "one\ntwo\nthree" },
    ]);
  });

  it("reads the event name", () => {
    expect(parse("event: message\ndata: hello\n\n").events).toEqual([
      { event: "message", data: "hello" },
    ]);
    expect(parse("event: message\n\ndata: nameless\n\n").events).toEqual([
      { event: undefined, data: "nameless" },
    ]);
  });

  it("accepts a field without a space after the colon", () => {
    expect(parse("data:no space\n\n").events).toEqual([{ event: undefined, data: "no space" }]);
  });

  it("accepts a field with no colon", () => {
    expect(parse("data\n\n").events).toEqual([{ event: undefined, data: "" }]);
    // Only `data` dispatches; an empty `event` name alone is not an event.
    expect(parse("event\n\n").events).toEqual([]);
  });

  it("reports comments without dispatching an event", () => {
    expect(parse(": OPENROUTER PROCESSING\n\ndata: after\n\n")).toEqual({
      events: [{ event: undefined, data: "after" }],
      comments: ["OPENROUTER PROCESSING"],
    });
    expect(parse(":OPENROUTER PROCESSING\n\n").comments).toEqual(["OPENROUTER PROCESSING"]);
  });

  it("ends lines with LF, CRLF or CR", () => {
    const expected = [{ event: undefined, data: "a\nb\nc" }];
    expect(parse("data: a\ndata: b\ndata: c\n\n").events).toEqual(expected);
    expect(parse("data: a\r\ndata: b\r\ndata: c\r\n\r\n").events).toEqual(expected);
    expect(parse("data: a\rdata: b\rdata: c\r\r").events).toEqual(expected);
  });

  it("keeps a CRLF split across two chunks as one line", () => {
    const { parser, recorded } = open();
    parser.feed("data: a\r");
    parser.feed("\n\n");
    parser.end();
    expect(recorded.events).toEqual([{ event: undefined, data: "a" }]);
  });

  it("keeps a lone CR at a chunk boundary as a line end", () => {
    const { parser, recorded } = open();
    parser.feed("data: a\r");
    parser.feed("data: b\n\n");
    parser.end();
    expect(recorded.events).toEqual([{ event: undefined, data: "a\nb" }]);
  });

  it("gives the same events however the text is split", () => {
    // The parser takes strings, so a split inside a character never reaches it; splitting
    // between the two halves of an astral character still must not change anything.
    const text =
      ': OPENROUTER PROCESSING\n\nevent: message\ndata: {"text":"héllo 🙂"}\ndata: second line\n\ndata: tail\n\n';
    const whole = parse(text);
    expect(whole).toEqual({
      events: [
        { event: "message", data: '{"text":"héllo 🙂"}\nsecond line' },
        { event: undefined, data: "tail" },
      ],
      comments: ["OPENROUTER PROCESSING"],
    });
    expect(parseByCharacter(text)).toEqual(whole);
  });

  it("dispatches nothing for blank lines", () => {
    expect(parse("\n\n\n")).toEqual({ events: [], comments: [] });
    expect(parse("data: a\n\n\n\n").events).toEqual([{ event: undefined, data: "a" }]);
  });

  it("drops an unterminated event when the stream ends", () => {
    const { parser, recorded } = open();
    parser.feed("data: never dispatched");
    parser.end();
    expect(recorded.events).toEqual([]);

    // The parser is reusable after end().
    parser.feed("data: next\n\n");
    expect(recorded.events).toEqual([{ event: undefined, data: "next" }]);
  });

  it("drops an event whose blank line has not arrived", () => {
    expect(parse("data: unterminated\n").events).toEqual([]);
  });
});
