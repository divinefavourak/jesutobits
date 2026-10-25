import { RuntimeEventBaseSchema, type RuntimeEventBase } from "@jesutobits/protocol";
import { nullLogger } from "@jesutobits/shared";
import { describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.js";

function setup(capacity?: number) {
  const sent: RuntimeEventBase[] = [];
  const bus = new EventBus({
    send: (event) => sent.push(event),
    log: nullLogger,
    now: () => new Date("2026-10-20T14:28:57.005Z"),
    ...(capacity !== undefined && { capacity }),
  });
  return { bus, sent };
}

describe("EventBus", () => {
  it("numbers events from 0, stamps them and sends them", () => {
    const { bus, sent } = setup();
    bus.emit("runtime.warning", { message: "first" });
    bus.emit("runtime.warning", { message: "second" }, { projectId: "prj_1" });

    expect(sent).toEqual([
      { seq: 0, ts: "2026-10-20T14:28:57.005Z", type: "runtime.warning", message: "first" },
      {
        seq: 1,
        ts: "2026-10-20T14:28:57.005Z",
        type: "runtime.warning",
        projectId: "prj_1",
        message: "second",
      },
    ]);
    for (const event of sent) expect(RuntimeEventBaseSchema.loose().parse(event)).toEqual(event);
  });

  it("refuses an invalid event without sending it or using a sequence number", () => {
    const { bus, sent } = setup();
    expect(() => bus.emit("runtime.warning", { message: 42 } as never)).toThrow(
      /Invalid runtime.warning event/,
    );
    bus.emit("runtime.warning", { message: "ok" });
    expect(sent.map((event) => event.seq)).toEqual([0]);
  });

  it("keeps the event and its number when sending fails", () => {
    const bus = new EventBus({
      send: () => {
        throw new Error("pipe closed");
      },
      log: nullLogger,
    });
    expect(bus.emit("runtime.warning", { message: "x" }).seq).toBe(0);
    expect(bus.replay(-1).events).toHaveLength(1);
  });

  it("replays events after a sequence number", () => {
    const { bus } = setup();
    for (let n = 0; n < 5; n++) bus.emit("runtime.warning", { message: `m${n}` });

    const replay = bus.replay(2);
    expect(replay.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(replay.complete).toBe(true);
    expect(replay.lastSeq).toBe(4);
    expect(bus.replay(4)).toEqual({ events: [], complete: true, lastSeq: 4 });
  });

  it("reports an incomplete replay once the buffer dropped events", () => {
    const { bus } = setup(3);
    for (let n = 0; n < 5; n++) bus.emit("runtime.warning", { message: `m${n}` });

    // Buffer holds 2, 3, 4.
    expect(bus.replay(1)).toMatchObject({ complete: true });
    const replay = bus.replay(0);
    expect(replay.complete).toBe(false);
    expect(replay.events.map((event) => event.seq)).toEqual([2, 3, 4]);
  });

  it("replays nothing, completely, before the first event", () => {
    const { bus } = setup();
    expect(bus.replay(-1)).toEqual({ events: [], complete: true, lastSeq: -1 });
  });
});
