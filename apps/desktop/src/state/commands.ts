import type { MessageKey } from "../i18n";

/**
 * Something the user can do from the command palette, and often a shortcut (FR-079,
 * UX_AND_INTERFACE.md section 9). Shortcuts are written `Ctrl+Alt+B`, `Alt+1`, `F6`;
 * `Ctrl` means Cmd on macOS. Rebinding from `settings.json` arrives with the settings UI.
 */
export interface Command {
  id: string;
  title: MessageKey;
  keys?: string;
  /** Hidden from the palette and its shortcut ignored when false. */
  enabled?: () => boolean;
  run: () => void;
}

interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** `KeyboardEvent.code`, so Alt and keyboard layouts do not change what matches. */
  code: string;
}

export function parseKeys(keys: string): Chord {
  const parts = keys.split("+");
  const key = parts.at(-1) ?? "";
  const code = /^[A-Z]$/i.test(key)
    ? `Key${key.toUpperCase()}`
    : /^\d$/.test(key)
      ? `Digit${key}`
      : key === "`"
        ? "Backquote"
        : key === "."
          ? "Period"
          : key;
  return {
    ctrl: parts.includes("Ctrl"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    code,
  };
}

export function matchesKeys(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">,
  keys: string,
  mac = isMac(),
): boolean {
  const chord = parseKeys(keys);
  const ctrl = mac ? event.metaKey : event.ctrlKey;
  return (
    chord.code === event.code &&
    chord.ctrl === ctrl &&
    chord.alt === event.altKey &&
    chord.shift === event.shiftKey
  );
}

/** How a shortcut is shown: `Ctrl+B`, or `⌘B` style on macOS later. */
export function formatKeys(keys: string): string {
  return isMac() ? keys.replace("Ctrl+", "Cmd+") : keys;
}

/** The command a key press runs, if any. Disabled commands do not take the key. */
export function commandForKey(
  commands: readonly Command[],
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">,
): Command | undefined {
  return commands.find(
    (command) =>
      command.keys !== undefined &&
      matchesKeys(event, command.keys) &&
      (command.enabled?.() ?? true),
  );
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}
