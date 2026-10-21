import type { MethodResult } from "@jesutobits/protocol";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useWorkbench } from "../../state/workbench-context";
import { Highlighted, Palette } from "../../ui/Palette";

type QuickOpenResult = MethodResult<"fs.quickOpen">;
type Match = QuickOpenResult["results"][number];

/** Waits this long after a keystroke before asking the runtime, so typing stays smooth. */
const QUERY_DELAY_MS = 40;

/**
 * Quick open (`Ctrl+P`, UX_AND_INTERFACE.md section 5.3): fuzzy file names from the runtime's
 * index, recently shown files first (FR-074). Enter opens the file in a tab that stays.
 */
export function QuickOpen() {
  const { bridge, editor, ui } = useWorkbench();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<QuickOpenResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    const timer = setTimeout(
      () => {
        bridge.rpc("fs.quickOpen", { query, limit: 50, recent: editor.getState().recent }).then(
          (result) => {
            if (request !== latest.current) return;
            setAnswer(result);
            setFailure(null);
          },
          (error: unknown) => {
            if (request !== latest.current) return;
            setFailure(error instanceof Error ? error.message : String(error));
          },
        );
      },
      query === "" ? 0 : QUERY_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [query, bridge, editor]);

  const status = failure
    ? t("quickOpen.failed", { reason: failure })
    : answer?.indexing
      ? t("quickOpen.indexing")
      : answer && !answer.complete
        ? t("quickOpen.incomplete")
        : null;

  return (
    <Palette<Match>
      label={t("quickOpen.label")}
      placeholder={t("quickOpen.placeholder")}
      query={query}
      onQuery={setQuery}
      items={answer?.results ?? NONE}
      itemKey={(match) => match.path}
      renderItem={(match) => <FileMatch match={match} />}
      onPick={(match) => {
        ui.getState().hide();
        void editor.getState().open(match.path);
      }}
      onClose={() => ui.getState().hide()}
      status={status}
      empty={answer ? t("quickOpen.empty") : t("quickOpen.searching")}
    />
  );
}

const NONE: Match[] = [];

/** The file name with its matched letters, then its folder. */
function FileMatch({ match }: { match: Match }) {
  const slash = match.path.lastIndexOf("/");
  const name = match.path.slice(slash + 1);
  const folder = slash === -1 ? "" : match.path.slice(0, slash);
  return (
    <>
      <span className="shrink-0 text-text">
        <Highlighted text={name} positions={match.positions} offset={slash + 1} />
      </span>
      {folder && (
        <span className="min-w-0 truncate text-xs text-text-muted">
          <Highlighted text={folder} positions={match.positions} />
        </span>
      )}
    </>
  );
}
