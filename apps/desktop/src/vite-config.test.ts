import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("Workbench dev server (vite.config.ts)", () => {
  // Watching src-tauri/target (1,700 folders after cargo builds) blocked the dev server's
  // event loop for 20 to 45 s on every cold `pnpm dev`; the Tauri CLI watches the Host.
  it("does not watch the Host's sources or Cargo's target folder", () => {
    expect(config.server?.watch?.ignored).toContain("**/src-tauri/**");
  });
});
