import { describe, expect, it } from "vitest";
import { errorFromHttp, parseRetryAfter, providerFailure } from "./errors.js";

describe("errorFromHttp", () => {
  it.each([
    [400, "invalid_request", false],
    [401, "auth", false],
    [402, "insufficient_credits", false],
    [403, "content_filter", false],
    [404, "invalid_request", false],
    [408, "timeout", true],
    [413, "context_length", false],
    [429, "rate_limited", true],
    [500, "provider_unavailable", true],
    [502, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [504, "timeout", true],
    [418, "unknown", false],
  ] as const)("%i is %s", (status, category, retryable) => {
    expect(errorFromHttp(status)).toMatchObject({ category, retryable, httpStatus: status });
  });

  it("recognises an over-long prompt whatever the status", () => {
    const error = errorFromHttp(400, {
      message: "This endpoint's maximum context length is 8192 tokens",
    });
    expect(error.category).toBe("context_length");
  });

  it("keeps Retry-After and the provider's error type", () => {
    expect(errorFromHttp(429, { retryAfterMs: 2000, providerErrorType: "x" })).toMatchObject({
      retryAfterMs: 2000,
      providerErrorType: "x",
    });
  });
});

describe("providerFailure", () => {
  it("gives plain guidance and the action the user can take (FR-025)", () => {
    const credits = providerFailure(errorFromHttp(402, { message: "Insufficient credits" }));
    expect(credits).toMatchObject({
      code: "provider.insufficient_credits",
      userAction: "check_credits",
      details: { category: "insufficient_credits", providerMessage: "Insufficient credits" },
    });
    expect(credits.message).toMatch(/OpenRouter credits/);
    expect(providerFailure(errorFromHttp(401)).userAction).toBe("open_settings");
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-22T10:00:00Z");
    expect(parseRetryAfter("2", now)).toBe(2000);
    expect(parseRetryAfter("Thu, 22 Oct 2026 10:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });
});
