import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_VERSION } from "./version.js";

describe("RUNTIME_VERSION", () => {
  it("is the extension's version, so the handshake reports what shipped", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../apps/vscode-extension/package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    expect(RUNTIME_VERSION).toBe(manifest.version);
  });
});
