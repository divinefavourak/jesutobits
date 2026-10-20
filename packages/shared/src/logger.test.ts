import { describe, expect, it } from "vitest";
import { isLevelEnabled, nullLogger, parseLogLevel } from "./logger.js";

describe("log levels", () => {
  it("parses known levels and falls back otherwise", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("trace")).toBe("trace");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("loud", "warn")).toBe("warn");
  });

  it("orders levels from error to trace", () => {
    expect(isLevelEnabled("error", "info")).toBe(true);
    expect(isLevelEnabled("info", "info")).toBe(true);
    expect(isLevelEnabled("debug", "info")).toBe(false);
    expect(isLevelEnabled("trace", "trace")).toBe(true);
  });

  it("has a logger that drops everything", () => {
    expect(() => nullLogger.child({ module: "x" }).error("x")).not.toThrow();
  });
});
