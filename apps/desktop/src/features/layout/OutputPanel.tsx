import { formatDateTime, t } from "../../i18n";
import { useOutput, useWorkbench } from "../../state/workbench-context";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";

/** Runtime warnings and background errors, newest last (UX_AND_INTERFACE.md section 5.6). */
export function OutputPanel() {
  const { output } = useWorkbench();
  const entries = useOutput((state) => state.entries);
  if (entries.length === 0) {
    return <p className="m-0 p-4 text-text-muted">{t("output.empty")}</p>;
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex justify-end border-b border-border px-2 py-1">
        <Button variant="ghost" onClick={() => output.getState().clear()}>
          {t("output.clear")}
        </Button>
      </div>
      <ol className="m-0 flex-1 list-none overflow-auto p-2 font-mono text-xs">
        {entries.map((entry) => (
          <li key={entry.seq} className="flex items-baseline gap-2 py-0.5">
            <span className="shrink-0 text-text-muted">{formatDateTime(entry.ts)}</span>
            <Badge tone={entry.level === "error" ? "danger" : "warning"}>
              {t(`output.level.${entry.level}`)}
            </Badge>
            <span className="text-text">{entry.message}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
