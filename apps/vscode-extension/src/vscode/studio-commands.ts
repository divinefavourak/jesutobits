// The Studio design's top-bar pieces as VS Code's own surfaces (ADR-0015): the permission
// level in the status bar, and New project in File > New File… and the Welcome page.
import { homedir } from "node:os";
import { join } from "node:path";
import type { PolicyPreset } from "@jesutobits/protocol";
import * as vscode from "vscode";
import { projectFolderName, projectNameProblem } from "../host/new-project.js";

const PRESETS: readonly { id: PolicyPreset; label: string; detail: string }[] = [
  { id: "cautious", label: "Cautious", detail: "Asks before every edit and command." },
  { id: "balanced", label: "Balanced", detail: "Makes small edits, asks before commands." },
  {
    id: "autonomous",
    label: "Autonomous",
    detail: "Works within your limits, still asks before risky steps.",
  },
];

const PRESET_KEY = "agent.defaultPolicyPreset";

/** The default permission level in the status bar; a click changes it. */
export function registerPresetStatus(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(
    "jesutobits.preset",
    vscode.StatusBarAlignment.Left,
    -1,
  );
  item.name = "Jesutobits Permission Level";
  item.command = "jesutobits.choosePolicyPreset";
  const show = () => {
    const current = vscode.workspace.getConfiguration("jesutobits").get<string>(PRESET_KEY);
    const preset = PRESETS.find((entry) => entry.id === current) ?? PRESETS[1]!;
    item.text = `$(shield) ${preset.label}`;
    item.tooltip = `How often the agent checks with you, for projects without a level of their own: ${preset.detail} Click to change.`;
    item.show();
  };
  show();
  context.subscriptions.push(
    item,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`jesutobits.${PRESET_KEY}`)) show();
    }),
    vscode.commands.registerCommand("jesutobits.choosePolicyPreset", choosePreset),
    vscode.commands.registerCommand("jesutobits.newProject", newProject),
  );
}

async function choosePreset(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("jesutobits");
  const current = settings.get<string>(PRESET_KEY);
  const picked = await vscode.window.showQuickPick(
    PRESETS.map((preset) => ({
      label: preset.label,
      ...(preset.id === current && { description: "current" }),
      detail: preset.detail,
      id: preset.id,
    })),
    { title: "How much should I check with you?", placeHolder: "Choose a permission level" },
  );
  if (picked) await settings.update(PRESET_KEY, picked.id, vscode.ConfigurationTarget.Global);
}

/** Names a new project, creates its folder and opens it (a user action, invariant 10). */
async function newProject(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Every great thing starts somewhere.",
    prompt: "Give your next idea a little name.",
    placeHolder: "My next big little idea",
    validateInput: (value) => projectNameProblem(value),
  });
  if (name === undefined) return;

  // Shown as Windows writes it (`Uri.fsPath` lowercases the drive letter).
  const suggestedPath = join(homedir(), "Documents", "Jesutobits Projects");
  const suggested = vscode.Uri.file(suggestedPath);
  const where = await vscode.window.showQuickPick(
    [
      { label: "$(folder) Jesutobits Projects", description: suggestedPath, uri: suggested },
      { label: "$(folder-opened) Choose another folder…", uri: undefined },
    ],
    { title: "Where should it live?" },
  );
  if (!where) return;
  let parent = where.uri;
  if (!parent) {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Create it here",
    });
    if (!chosen?.[0]) return;
    parent = chosen[0];
  }

  const folder = vscode.Uri.joinPath(parent, projectFolderName(name));
  if (await exists(folder)) {
    void vscode.window.showWarningMessage(
      `There is already a "${projectFolderName(name)}" in ${parent.fsPath}. Try another name.`,
    );
    return;
  }
  await vscode.workspace.fs.createDirectory(folder);
  await vscode.commands.executeCommand("vscode.openFolder", folder, {
    forceNewWindow: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
  });
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
