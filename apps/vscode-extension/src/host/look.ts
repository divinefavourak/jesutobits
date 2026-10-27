import type { Remix } from "@jesutobits/protocol";

/**
 * The theme picker's remix (Studio design, ThemePicker.tsx) as VS Code colour keys: each of
 * the four colours drives the parts of the workbench it stands for. Written to
 * `workbench.colorCustomizations` under the current theme's `[name]`, so it remixes that theme
 * only and leaves the user's own customizations alone.
 */
const KEYS: Record<keyof Remix, readonly string[]> = {
  accent: [
    "focusBorder",
    "button.background",
    "textLink.foreground",
    "textLink.activeForeground",
    "activityBar.activeBorder",
    "activityBarBadge.background",
    "badge.background",
    "progressBar.background",
    "panelTitle.activeBorder",
    "tab.activeBorderTop",
  ],
  canvas: [
    "editor.background",
    "editorGutter.background",
    "terminal.background",
    "breadcrumb.background",
    "tab.activeBackground",
  ],
  surfaces: [
    "sideBar.background",
    "activityBar.background",
    "panel.background",
    "titleBar.activeBackground",
    "statusBar.background",
    "editorGroupHeader.tabsBackground",
    "tab.inactiveBackground",
    "editorWidget.background",
    "input.background",
    "dropdown.background",
    "quickInput.background",
  ],
  text: ["foreground", "editor.foreground", "sideBar.foreground", "tab.activeForeground"],
};

/** The remixed keys, so the remix can be read back and removed without touching others. */
const ALL_KEYS = new Set(Object.values(KEYS).flat());

type Customizations = Record<string, unknown>;

export function remixColors(remix: Remix): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const [part, keys] of Object.entries(KEYS) as [keyof Remix, readonly string[]][]) {
    for (const key of keys) colors[key] = remix[part];
  }
  return colors;
}

/** `workbench.colorCustomizations` with the theme's remix set, or removed for `null`. */
export function withRemix(
  customizations: Customizations,
  theme: string,
  remix: Remix | null,
): Customizations {
  const scope = `[${theme}]`;
  const current = (customizations[scope] ?? {}) as Record<string, unknown>;
  const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !ALL_KEYS.has(key)));
  const next = remix ? { ...kept, ...remixColors(remix) } : kept;
  const result = { ...customizations };
  if (Object.keys(next).length > 0) result[scope] = next;
  else delete result[scope];
  return result;
}

/** The theme's remix, if all four colours are set as the picker writes them. */
export function readRemix(customizations: Customizations, theme: string): Remix | null {
  const scope = (customizations[`[${theme}]`] ?? {}) as Record<string, unknown>;
  const first = (part: keyof Remix) => scope[KEYS[part][0]!];
  const remix = {
    accent: first("accent"),
    canvas: first("canvas"),
    surfaces: first("surfaces"),
    text: first("text"),
  };
  return Object.values(remix).every(
    (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value),
  )
    ? (remix as Remix)
    : null;
}
