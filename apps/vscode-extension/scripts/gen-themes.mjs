// Generates the Jesutobits colour themes (themes/*.json) from the Studio palettes in the
// Figma Make design "Jesutobits AI Coding Workspace" (src/themes.ts). Each palette is five
// colours; everything else is mixed from them the way the design does (muted text, raised
// surfaces, hairlines), so the whole IDE takes on the Studio look, not just Jesutobits' panels.
//
//   node scripts/gen-themes.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "themes");

/** The design's palettes, in its order; the first is the default. */
export const PALETTES = [
  {
    id: "lavender-dusk",
    name: "Lavender dusk",
    bg: "#17161c",
    panel: "#201e26",
    text: "#f2eff7",
    accent: "#c5b1f7",
    light: false,
  },
  {
    id: "matcha",
    name: "Matcha",
    bg: "#17201c",
    panel: "#202c25",
    text: "#edf4e9",
    accent: "#bad599",
    light: false,
  },
  {
    id: "ocean-after-hours",
    name: "Ocean after hours",
    bg: "#121d2a",
    panel: "#1c2939",
    text: "#ecf2fc",
    accent: "#91c9ee",
    light: false,
  },
  {
    id: "peach-tea",
    name: "Peach tea",
    bg: "#261c20",
    panel: "#32252b",
    text: "#fbefea",
    accent: "#efb69e",
    light: false,
  },
  {
    id: "daydream",
    name: "Daydream",
    bg: "#eeebf4",
    panel: "#faf8fd",
    text: "#332b40",
    accent: "#7652af",
    light: true,
  },
  {
    id: "paper-and-sage",
    name: "Paper & sage",
    bg: "#eeefe7",
    panel: "#fafbf5",
    text: "#303c2b",
    accent: "#537638",
    light: true,
  },
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (values) =>
  `#${values.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** `color-mix(in srgb, a share, b)`, as the design's themeStyle() uses. */
const mix = (a, share, b) => hex(rgb(a).map((v, i) => v * share + rgb(b)[i] * (1 - share)));
const alpha = (color, value) =>
  `${color}${Math.round(value * 255)
    .toString(16)
    .padStart(2, "0")}`;
const luminance = (color) =>
  rgb(color)
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Syntax colours that sit with the Studio palette: soft on dark, deeper on light. */
const SYNTAX = {
  dark: {
    keyword: "#c5b1f7",
    string: "#bad599",
    number: "#efb69e",
    func: "#91c9ee",
    type: "#e2ca95",
    comment: "#899b78",
    tag: "#e4b5be",
  },
  light: {
    keyword: "#7652af",
    string: "#537638",
    number: "#a65f3f",
    func: "#2f6f9f",
    type: "#8a6a1f",
    comment: "#7d8a6c",
    tag: "#a24d68",
  },
};

function theme(p) {
  const muted = mix(p.text, 0.65, p.panel);
  const raised = mix(p.text, 0.07, p.panel);
  const line = alpha(p.text, 0.1);
  const onAccent =
    contrast(p.accent, "#17161c") > contrast(p.accent, "#ffffff") ? "#17161c" : "#ffffff";
  const accentSoft = alpha(p.accent, p.light ? 0.14 : 0.16);
  const s = SYNTAX[p.light ? "light" : "dark"];
  return {
    $schema: "vscode://schemas/color-theme",
    name: p.name,
    type: p.light ? "light" : "dark",
    semanticHighlighting: true,
    colors: {
      foreground: p.text,
      descriptionForeground: muted,
      disabledForeground: mix(p.text, 0.4, p.panel),
      errorForeground: p.light ? "#b4434d" : "#f0a2a8",
      focusBorder: p.accent,
      "widget.border": line,
      "widget.shadow": p.light ? "#3322441a" : "#00000055",
      "selection.background": alpha(p.accent, 0.3),
      "textLink.foreground": p.accent,
      "textLink.activeForeground": mix(p.accent, 0.8, p.text),
      "button.background": p.accent,
      "button.foreground": onAccent,
      "button.hoverBackground": mix(p.accent, 0.85, p.text),
      "button.secondaryBackground": raised,
      "button.secondaryForeground": p.text,
      "button.secondaryHoverBackground": mix(p.text, 0.12, p.panel),
      "badge.background": p.accent,
      "badge.foreground": onAccent,
      "progressBar.background": p.accent,
      "input.background": raised,
      "input.foreground": p.text,
      "input.border": line,
      "input.placeholderForeground": muted,
      "inputOption.activeBorder": p.accent,
      "dropdown.background": raised,
      "dropdown.border": line,
      "checkbox.background": raised,
      "checkbox.border": line,
      "titleBar.activeBackground": p.bg,
      "titleBar.inactiveBackground": p.bg,
      "titleBar.activeForeground": p.text,
      "titleBar.border": line,
      "menu.background": p.panel,
      "menu.selectionBackground": accentSoft,
      "commandCenter.background": raised,
      "commandCenter.border": line,
      "activityBar.background": p.bg,
      "activityBar.foreground": p.accent,
      "activityBar.inactiveForeground": muted,
      "activityBar.activeBorder": p.accent,
      "activityBar.border": line,
      "activityBarBadge.background": p.accent,
      "activityBarBadge.foreground": onAccent,
      "sideBar.background": p.bg,
      "sideBar.foreground": p.text,
      "sideBar.border": line,
      "sideBarTitle.foreground": muted,
      "sideBarSectionHeader.background": p.bg,
      "sideBarSectionHeader.border": line,
      "list.activeSelectionBackground": accentSoft,
      "list.activeSelectionForeground": p.text,
      "list.inactiveSelectionBackground": alpha(p.accent, 0.1),
      "list.hoverBackground": raised,
      "list.focusOutline": p.accent,
      "list.highlightForeground": p.accent,
      "editor.background": p.panel,
      "editor.foreground": p.text,
      "editor.lineHighlightBackground": alpha(p.text, 0.04),
      "editor.selectionBackground": alpha(p.accent, 0.28),
      "editor.inactiveSelectionBackground": alpha(p.accent, 0.14),
      "editorCursor.foreground": p.accent,
      "editorLineNumber.foreground": mix(p.text, 0.35, p.panel),
      "editorLineNumber.activeForeground": p.text,
      "editorIndentGuide.background1": line,
      "editorWidget.background": p.panel,
      "editorWidget.border": line,
      "editorGroup.border": line,
      "editorGroupHeader.tabsBackground": p.bg,
      "editorGroupHeader.tabsBorder": line,
      "tab.activeBackground": p.panel,
      "tab.activeForeground": p.text,
      "tab.activeBorderTop": p.accent,
      "tab.inactiveBackground": p.bg,
      "tab.inactiveForeground": muted,
      "tab.border": line,
      "panel.background": p.bg,
      "panel.border": line,
      "panelTitle.activeForeground": p.text,
      "panelTitle.activeBorder": p.accent,
      "panelTitle.inactiveForeground": muted,
      "statusBar.background": p.bg,
      "statusBar.foreground": muted,
      "statusBar.border": line,
      "statusBar.noFolderBackground": p.bg,
      "statusBarItem.hoverBackground": raised,
      "statusBarItem.remoteBackground": p.accent,
      "statusBarItem.remoteForeground": onAccent,
      "terminal.background": p.panel,
      "terminal.foreground": p.text,
      "scrollbarSlider.background": alpha(p.text, 0.1),
      "scrollbarSlider.hoverBackground": alpha(p.text, 0.18),
      "scrollbarSlider.activeBackground": alpha(p.accent, 0.4),
      "notifications.background": p.panel,
      "notifications.border": line,
      "quickInput.background": p.panel,
      "quickInputList.focusBackground": accentSoft,
      "welcomePage.tileBackground": raised,
      "walkThrough.embeddedEditorBackground": raised,
      "gitDecoration.addedResourceForeground": s.string,
      "gitDecoration.modifiedResourceForeground": s.type,
      "gitDecoration.deletedResourceForeground": s.tag,
      "testing.iconPassed": s.string,
      "editorWarning.foreground": s.type,
      "editorInfo.foreground": s.func,
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: s.comment, fontStyle: "italic" },
      },
      {
        scope: ["keyword", "storage", "storage.type", "keyword.operator.new"],
        settings: { foreground: s.keyword },
      },
      {
        scope: ["string", "string.quoted", "markup.inline.raw"],
        settings: { foreground: s.string },
      },
      {
        scope: ["constant.numeric", "constant.language", "constant.character"],
        settings: { foreground: s.number },
      },
      {
        scope: ["entity.name.function", "support.function", "meta.function-call"],
        settings: { foreground: s.func },
      },
      {
        scope: ["entity.name.type", "support.type", "support.class", "entity.name.class"],
        settings: { foreground: s.type },
      },
      { scope: ["entity.name.tag", "support.class.component"], settings: { foreground: s.tag } },
      { scope: ["entity.other.attribute-name"], settings: { foreground: s.type } },
      { scope: ["variable", "meta.definition.variable"], settings: { foreground: p.text } },
      { scope: ["markup.heading"], settings: { foreground: s.keyword, fontStyle: "bold" } },
    ],
  };
}

mkdirSync(out, { recursive: true });
for (const palette of PALETTES) {
  const file = join(out, `${palette.id}.json`);
  // Formatted like the rest of the repository, so `prettier --check` passes after a regenerate.
  const options = (await prettier.resolveConfig(file)) ?? {};
  writeFileSync(
    file,
    await prettier.format(JSON.stringify(theme(palette)), { ...options, filepath: file }),
  );
  console.log(`wrote themes/${palette.id}.json`);
}
