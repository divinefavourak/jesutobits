import { describe, expect, it } from "vitest";
import { idTimestamp, isId, newId, ulid } from "./ids.js";

describe("ulid", () => {
  it("encodes the timestamp in the first 10 characters", () => {
    expect(ulid(0).slice(0, 10)).toBe("0000000000");
    expect(ulid(1_469_918_176_385).slice(0, 10)).toBe("01ARYZ6S41");
  });

  it("produces 26 Crockford base32 characters", () => {
    for (let i = 0; i < 100; i++) expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts by time", () => {
    expect(ulid(1000) < ulid(2000)).toBe(true);
  });

  it("rejects times outside the 48-bit range", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
  });
});

describe("prefixed ids", () => {
  it("round-trips prefix and timestamp", () => {
    const id = newId("ses", 1_700_000_000_000);
    expect(id.startsWith("ses_")).toBe(true);
    expect(isId("ses", id)).toBe(true);
    expect(idTimestamp(id)).toBe(1_700_000_000_000);
  });

  it("does not accept an id of another type", () => {
    const id = newId("prj");
    expect(isId("ses", id)).toBe(false);
    expect(isId("prj", `${id}x`)).toBe(false);
    expect(isId("prj", 42)).toBe(false);
  });
});
