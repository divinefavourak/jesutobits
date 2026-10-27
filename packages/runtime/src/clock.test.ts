import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.js";

describe("FakeClock", () => {
  it("wakes sleepers in deadline order and only when time reaches them", async () => {
    const clock = new FakeClock(0);
    const woke: string[] = [];
    void clock.sleep(200).then(() => woke.push("b"));
    void clock.sleep(100).then(() => woke.push("a"));
    await clock.advance(99);
    expect(woke).toEqual([]);
    await clock.advance(1);
    expect(woke).toEqual(["a"]);
    expect(clock.now()).toBe(100);
    await clock.advance(500);
    expect(woke).toEqual(["a", "b"]);
    expect(clock.now()).toBe(600);
  });

  it("wakes a sleep started by a woken sleeper inside the same advance", async () => {
    const clock = new FakeClock(0);
    const woke: number[] = [];
    void clock.sleep(10).then(async () => {
      woke.push(clock.now());
      await clock.sleep(10);
      woke.push(clock.now());
    });
    await clock.advance(30);
    expect(woke).toEqual([10, 20]);
  });

  it("rejects at once when the signal aborts", async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    const sleeping = clock.sleep(1000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(sleeping).rejects.toThrow("stop");
    expect(clock.pending).toBe(0);
    await expect(clock.sleep(1, controller.signal)).rejects.toThrow("stop");
  });
});
