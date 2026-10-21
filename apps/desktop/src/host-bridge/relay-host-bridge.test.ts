import type { RuntimeStatus } from "@jesutobits/protocol";
import { describe, expect, it, vi } from "vitest";
import { RelayHostBridge } from "./relay-host-bridge";

/** A fake relay: answers /rpc with `reply` and streams `lines` on /events. */
function fakeFetch(reply: unknown, lines: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect((init?.headers as Record<string, string>)["x-jesutobits-token"]).toBe("secret");
    if (url.endsWith("/events")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
        },
      });
      return new Response(body);
    }
    return Response.json(reply);
  }) as typeof fetch;
}

describe("RelayHostBridge", () => {
  it("returns validated results and throws relayed errors as JesutobitsErrors", async () => {
    const ok = new RelayHostBridge(
      "http://relay",
      "secret",
      fakeFetch({ result: { uptimeMs: 5 } }, []),
    );
    await expect(ok.rpc("runtime.ping", {})).resolves.toEqual({ uptimeMs: 5 });

    const failing = new RelayHostBridge(
      "http://relay",
      "secret",
      fakeFetch(
        {
          error: {
            code: -32000,
            message: "Open a project first",
            data: { code: "fs.no_project", message: "Open a project first", retryable: false },
          },
        },
        [],
      ),
    );
    await expect(failing.rpc("fs.listDir", { path: "" })).rejects.toMatchObject({
      code: "fs.no_project",
    });
  });

  it("passes on status updates and runtime events from the stream", async () => {
    const bridge = new RelayHostBridge(
      "http://relay",
      "secret",
      fakeFetch({}, [
        JSON.stringify({ kind: "status", status: "ready" }),
        JSON.stringify({
          kind: "event",
          event: { seq: 0, ts: "2026-10-21T08:00:00.000Z", type: "runtime.warning", message: "x" },
        }),
      ]),
    );
    const statuses: RuntimeStatus[] = [];
    const events: string[] = [];
    bridge.onRuntimeStatus((update) => statuses.push(update.status));
    bridge.onRuntimeEvent((event) => events.push(event.type));
    await vi.waitFor(() => expect(events).toEqual(["runtime.warning"]));
    expect(statuses).toContain("ready");
    bridge.close();
  });
});
