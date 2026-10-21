import { fuzzyFilter } from "@jesutobits/shared";
import { useMemo, useState } from "react";
import { t } from "../../i18n";
import { formatKeys, type Command } from "../../state/commands";
import { useWorkbench } from "../../state/workbench-context";
import { Highlighted, Palette } from "../../ui/Palette";

type Entry = { command: Command; title: string; positions: number[] };

/**
 * The command palette (`Ctrl+K`, FR-079, UX_AND_INTERFACE.md section 9): every command that
 * can run now, with its shortcut. Picking one closes the palette first, so the command acts
 * where the user was.
 */
export function CommandPalette({ commands }: { commands: readonly Command[] }) {
  const { ui } = useWorkbench();
  const [query, setQuery] = useState("");
  // What is enabled is decided once, when the palette opens.
  const available = useMemo(
    () =>
      commands
        .filter((command) => command.id !== "workbench.commandPalette")
        .filter((command) => command.enabled?.() ?? true)
        .map((command) => ({ command, title: t(command.title) })),
    [commands],
  );
  const entries = useMemo<Entry[]>(
    () =>
      fuzzyFilter(query, available, (entry) => entry.title, 100).map(({ item, positions }) => ({
        ...item,
        positions,
      })),
    [query, available],
  );

  return (
    <Palette<Entry>
      label={t("palette.label")}
      placeholder={t("palette.placeholder")}
      query={query}
      onQuery={setQuery}
      items={entries}
      itemKey={(entry) => entry.command.id}
      renderItem={(entry) => (
        <>
          <span className="min-w-0 flex-1 truncate">
            <Highlighted text={entry.title} positions={entry.positions} />
          </span>
          {entry.command.keys && (
            <kbd className="shrink-0 rounded-sm border border-border px-1 font-mono text-xs text-text-muted">
              {formatKeys(entry.command.keys)}
            </kbd>
          )}
        </>
      )}
      onPick={(entry) => {
        ui.getState().hide();
        // After the palette is gone and focus is back.
        requestAnimationFrame(() => void entry.command.run());
      }}
      onClose={() => ui.getState().hide()}
      empty={t("palette.empty")}
    />
  );
}
