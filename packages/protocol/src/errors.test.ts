import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  isJesutobitsErrorCode,
  JesutobitsError,
  JesutobitsErrorDataSchema,
} from "./errors.js";

describe("error codes", () => {
  it.each(["fs.outside_workspace", "provider.rate_limited", "rpc.parse_error", "ext.zip.slip"])(
    "accepts %s",
    (code) => {
      expect(isJesutobitsErrorCode(code)).toBe(true);
    },
  );

  it.each(["outside_workspace", "unknown.family", "fs.", "fs.Outside", "fs.outside-workspace"])(
    "rejects %s",
    (code) => {
      expect(isJesutobitsErrorCode(code)).toBe(false);
    },
  );

  it("defines only well-formed codes", () => {
    for (const code of Object.values(ErrorCodes)) expect(isJesutobitsErrorCode(code)).toBe(true);
  });
});

describe("JesutobitsError", () => {
  it("round-trips through its serialisable form", () => {
    const error = new JesutobitsError("fs.outside_workspace", "Path is outside the project", {
      userAction: "approve",
      details: { path: "../x" },
    });
    const data = JSON.parse(JSON.stringify(error)) as unknown;

    expect(JesutobitsErrorDataSchema.parse(data)).toEqual({
      code: "fs.outside_workspace",
      message: "Path is outside the project",
      retryable: false,
      userAction: "approve",
      details: { path: "../x" },
    });
    expect(JesutobitsError.fromData(JesutobitsErrorDataSchema.parse(data)).toData()).toEqual(data);
  });

  it("is an Error with a stable name", () => {
    const error = new JesutobitsError("rpc.internal", "boom", { retryable: true });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("JesutobitsError");
    expect(error.retryable).toBe(true);
  });
});
