import { describe, expect, it } from "vitest";
import { commandForKey, matchesKeys, parseKeys, type Command } from "./commands";

const key = (
  code: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) => ({
  code,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  metaKey: mods.meta ?? false,
});

describe("shortcuts", () => {
  it("parses letters, digits and named keys into key codes", () => {
    expect(parseKeys("Ctrl+Alt+B")).toEqual({ ctrl: true, alt: true, shift: false, code: "KeyB" });
    expect(parseKeys("Alt+1")).toEqual({ ctrl: false, alt: true, shift: false, code: "Digit1" });
    expect(parseKeys("Shift+F6")).toEqual({ ctrl: false, alt: false, shift: true, code: "F6" });
    expect(parseKeys("Ctrl+`").code).toBe("Backquote");
  });

  it("matches modifiers exactly", () => {
    expect(matchesKeys(key("KeyB", { ctrl: true }), "Ctrl+B", false)).toBe(true);
    expect(matchesKeys(key("KeyB", { ctrl: true, alt: true }), "Ctrl+B", false)).toBe(false);
    expect(matchesKeys(key("KeyB", { ctrl: true, alt: true }), "Ctrl+Alt+B", false)).toBe(true);
    expect(matchesKeys(key("KeyB"), "Ctrl+B", false)).toBe(false);
  });

  it("reads Ctrl as Cmd on macOS", () => {
    expect(matchesKeys(key("KeyB", { meta: true }), "Ctrl+B", true)).toBe(true);
    expect(matchesKeys(key("KeyB", { ctrl: true }), "Ctrl+B", true)).toBe(false);
  });

  it("skips disabled commands", () => {
    let enabled = false;
    const commands: Command[] = [
      { id: "a", title: "layout.reset", keys: "F6", enabled: () => enabled, run: () => undefined },
    ];
    expect(commandForKey(commands, key("F6"))).toBeUndefined();
    enabled = true;
    expect(commandForKey(commands, key("F6"))?.id).toBe("a");
  });
});
