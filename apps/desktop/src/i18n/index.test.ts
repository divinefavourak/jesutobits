import { describe, expect, it } from "vitest";
import { t } from "./index";
import { en } from "./messages.en";

describe("t", () => {
  it("returns plain strings", () => {
    expect(t("runtime.restart")).toBe("Restart runtime");
  });

  it("fills parameters and formats numbers", () => {
    expect(t("projects.opened", { name: "habits", trust: "trusted" })).toBe(
      "Opened habits (trusted)",
    );
    expect(t("files.count", { count: 12345 })).toBe("12,345 files");
  });

  it("picks the plural form", () => {
    expect(t("files.count", { count: 1 })).toBe("1 file");
    expect(t("files.count", { count: 0 })).toBe("0 files");
  });

  it("leaves a missing parameter visible", () => {
    expect(t("projects.failed")).toBe("Failed: {reason}");
  });

  it("uses only known plural categories and no empty strings", () => {
    const categories = new Set(["zero", "one", "two", "few", "many", "other"]);
    for (const [key, value] of Object.entries(en)) {
      if (typeof value === "string") expect(value, key).not.toBe("");
      else {
        expect(
          Object.keys(value).every((c) => categories.has(c)),
          key,
        ).toBe(true);
        expect(value, key).toHaveProperty("other");
      }
    }
  });
});
