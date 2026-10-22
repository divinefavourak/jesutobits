import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_VERSION } from "./version.js";

describe("RUNTIME_VERSION", () => {
  it("is the app's version (tauri.conf.json), so the handshake reports what shipped", () => {
    const config = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    expect(RUNTIME_VERSION).toBe(config.version);
  });
});
