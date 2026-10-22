import { describe, expect, it } from "vitest";
import {
  FINAL_TURN_STATES,
  isFinalTurnState,
  SessionIdSchema,
  TurnStateSchema,
  TurnSummarySchema,
} from "./agent.js";

describe("agent schemas", () => {
  it("accept prefixed ULIDs and reject other prefixes", () => {
    expect(SessionIdSchema.safeParse("ses_01JAB2C3D4E5F6G7H8J9K0M1N2").success).toBe(true);
    expect(SessionIdSchema.safeParse("trn_01JAB2C3D4E5F6G7H8J9K0M1N2").success).toBe(false);
    // Crockford base32 has no I, L, O or U.
    expect(SessionIdSchema.safeParse("ses_01JAB2C3D4E5F6G7H8J9K0M1NU").success).toBe(false);
    expect(SessionIdSchema.safeParse("ses_short").success).toBe(false);
  });

  it("treats exactly the four end states as final", () => {
    const final = TurnStateSchema.options.filter(isFinalTurnState);
    expect(final).toEqual([...FINAL_TURN_STATES]);
    expect(final).toEqual(["completed", "cancelled", "failed", "interrupted"]);
  });

  it("allow a summary without a label only as null", () => {
    const summary = {
      files: [],
      steps: 1,
      toolCalls: 0,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0,
      verification: null,
      hiddenSecrets: 0,
    };
    expect(TurnSummarySchema.safeParse(summary).success).toBe(true);
    expect(TurnSummarySchema.safeParse({ ...summary, verification: "done" }).success).toBe(false);
  });
});
