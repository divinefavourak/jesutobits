// Approvals and policy (SECURITY.md sections 4 and 6.2): cautious presets ask, Restricted
// (untrusted) projects ask for writes, prohibited and outside paths are refused without a
// card, and secret files offer "Share with values hidden" (FR-055).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerStep,
  awaitTurnEnd,
  dispose,
  errorOf,
  indexOf,
  result,
  send,
  setupAgent,
  start,
  tempBase,
  toolStep,
  turnEvents,
  writeCassette,
} from "./agent-helpers.js";
import type { RuntimeHarness } from "./harness/runtime-harness.js";

let base: string;
let project: string;
let harness: RuntimeHarness | undefined;

const EDIT = {
  path: "src/a.ts",
  edits: [{ oldText: "a = 1", newText: "a = 2" }],
};

beforeEach(() => {
  base = tempBase("jesutobits-agent-approvals-");
  project = path.join(base, "my-app");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\r\n");
  writeFileSync(path.join(project, "package.json"), '{ "name": "my-app" }\n');
  writeFileSync(
    path.join(project, ".env"),
    "API_KEY=super-secret-env-value-123\r\nDB_PASSWORD=other-password-456\r\n",
  );
});

afterEach(async () => {
  harness?.kill();
  await harness?.exited;
  harness = undefined;
  dispose(base);
});

/** read a.ts, edit a.ts, answer: the edit asks under a cautious or Restricted policy. */
function editCassette(name: string, finalExpect?: Record<string, unknown>): string {
  return writeCassette(base, name, [
    toolStep("c1", "read_file", JSON.stringify({ path: "src/a.ts" }), "Reading it."),
    toolStep("c2", "edit_file", JSON.stringify(EDIT), undefined, {
      lastToolResultIncludes: "export const a = 1",
    }),
    answerStep("All right.", finalExpect),
  ]);
}

describe("approvals (SECURITY.md section 4.2, FR-055)", () => {
  it("asks under a cautious preset, shows the exact action and diff, and allows once", async () => {
    harness = start(
      editCassette("cautious-allow.jsonl", { lastToolResultIncludes: "Edited src/a.ts" }),
    );
    const { sessionId } = await setupAgent(harness, project);
    result<"permissions.setPolicy">(
      await harness.call("permissions.setPolicy", { preset: "cautious" }),
    );

    const turnId = await send(harness, sessionId, "please change a to 2");
    const asked = await harness.waitForEvent(
      (event) => event.type === "permission.requested" && event.turnId === turnId,
    );
    expect(asked.tool).toBe("edit_file");
    expect(asked.action).toEqual({ kind: "file", op: "write", paths: ["src/a.ts"] });
    expect(asked.risk).toContain("write");
    expect(asked.options).toEqual(["allow_once", "allow_session", "deny"]);
    expect(typeof asked.diff).toBe("string");
    expect(String(asked.diff)).toContain("a = 2");

    await harness.waitForEvent(
      (event) =>
        event.type === "turn.state_changed" &&
        event.turnId === turnId &&
        event.to === "awaiting_approval",
    );

    result<"permissions.respond">(
      await harness.call("permissions.respond", {
        permissionId: asked.permissionId as string,
        decision: "allow_once",
      }),
    );
    // Single use: the same card cannot be answered twice (SECURITY.md section 4.5).
    expect(
      errorOf(
        await harness.call("permissions.respond", {
          permissionId: asked.permissionId as string,
          decision: "allow_once",
        }),
      ).code,
    ).toBe("permission.not_pending");

    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "permission.resolved",
        permissionId: asked.permissionId as string,
        decision: "allow_once",
      }),
    );
    expect(readFileSync(path.join(project, "src", "a.ts"), "utf8")).toBe("export const a = 2;\r\n");
  });

  it("denies with a message, which the model receives and the file is left alone", async () => {
    harness = start(
      editCassette("cautious-deny.jsonl", {
        lastToolResultIncludes: "please keep the file as it is",
      }),
    );
    const { sessionId } = await setupAgent(harness, project);
    result<"permissions.setPolicy">(
      await harness.call("permissions.setPolicy", { preset: "cautious" }),
    );

    const turnId = await send(harness, sessionId, "please change a to 2");
    const asked = await harness.waitForEvent(
      (event) => event.type === "permission.requested" && event.turnId === turnId,
    );
    result<"permissions.respond">(
      await harness.call("permissions.respond", {
        permissionId: asked.permissionId as string,
        decision: "deny",
        message: "please keep the file as it is",
      }),
    );

    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    // The denial reached the model as a failed tool result (the cassette's expect held).
    const denial = turnEvents(harness, turnId).find(
      (event) => event.type === "tool.completed" && event.tool === "edit_file",
    );
    expect(denial?.ok).toBe(false);
    expect((denial?.error as { code?: string } | undefined)?.code).toBe("permission_denied");
    expect(readFileSync(path.join(project, "src", "a.ts"), "utf8")).toBe("export const a = 1;\r\n");
  });
});

describe("Restricted mode (SECURITY.md section 4.2)", () => {
  it("asks for a write in an untrusted project whatever the preset", async () => {
    harness = start(editCassette("restricted.jsonl"));
    const { sessionId } = await setupAgent(harness, project, { trusted: false });
    expect(
      result<"permissions.getPolicy">(await harness.call("permissions.getPolicy", {})),
    ).toMatchObject({ restricted: true });

    const turnId = await send(harness, sessionId, "please change a to 2");
    const asked = await harness.waitForEvent(
      (event) => event.type === "permission.requested" && event.turnId === turnId,
    );
    expect(asked.tool).toBe("edit_file");
    expect(asked.risk).toContain("write");
    // The user denies it, so the turn can end without the file changing.
    result<"permissions.respond">(
      await harness.call("permissions.respond", {
        permissionId: asked.permissionId as string,
        decision: "deny",
      }),
    );
    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    expect(readFileSync(path.join(project, "src", "a.ts"), "utf8")).toBe("export const a = 1;\r\n");
  });
});

describe("prohibited and secret files (SECURITY.md sections 4.3 and 6.2)", () => {
  it("refuses a path outside the project with no approval card", async () => {
    writeFileSync(path.join(base, "secret.txt"), "the outside secret\n");
    const cassette = writeCassette(base, "outside.jsonl", [
      toolStep("c1", "read_file", JSON.stringify({ path: "../secret.txt" })),
      answerStep("Refused.", { lastToolResultIncludes: "Not allowed in this project" }),
      toolStep("c2", "read_file", JSON.stringify({ path: ".env" })),
      answerStep("Env read.", {
        lastToolResultIncludes: "API_KEY=***",
        noMessageIncludes: "super-secret-env-value-123",
      }),
    ]);
    harness = start(cassette);
    const { sessionId } = await setupAgent(harness, project);

    const refused = await send(harness, sessionId, "read the sibling secret");
    await awaitTurnEnd(harness, refused);
    const events = turnEvents(harness, refused);
    const read = events.find(
      (event) => event.type === "tool.completed" && event.tool === "read_file",
    );
    expect(read?.ok).toBe(false);
    expect((read?.error as { code?: string } | undefined)?.code).toBe("permission_denied");
    // Blocked without an approval card (SECURITY.md section 4.3).
    expect(indexOf(events, (event) => event.type === "permission.requested")).toBe(-1);

    // Reading ".env" offers "Share with values hidden" (SECURITY.md section 6.2).
    const second = await send(harness, sessionId, "read the env file but hide the values");
    const asked = await harness.waitForEvent(
      (event) => event.type === "permission.requested" && event.turnId === second,
    );
    expect(asked.risk).toContain("sensitive_read");
    expect(asked.options).toEqual(["allow_once", "allow_redacted", "deny"]);
    result<"permissions.respond">(
      await harness.call("permissions.respond", {
        permissionId: asked.permissionId as string,
        decision: "allow_redacted",
      }),
    );
    const end = await awaitTurnEnd(harness, second);
    expect(end.type).toBe("turn.completed");
    // The cassette's expect proves the model saw "API_KEY=***" and never the real value.
  });
});
