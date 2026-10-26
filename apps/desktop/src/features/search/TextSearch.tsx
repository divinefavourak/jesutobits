import type { MethodResult } from "@jesutobits/protocol";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useWorkbench } from "../../state/workbench-context";
import { Palette } from "../../ui/Palette";

type SearchResult = MethodResult<"fs.search">;
type Match = SearchResult["matches"][number];

/** Waits this long after a keystroke before searching, so typing stays smooth. */
const QUERY_DELAY_MS = 200;
const LIMIT = 500;

/**
 * Search in project (`Ctrl+Shift+F`, UX_AND_INTERFACE.md section 5.3, FR-074): file contents
 * through the runtime's ripgrep, ignored files skipped. Enter opens the file at the match.
 * A query wrapped in slashes (`/a+b/`) is a regular expression.
 */
export function TextSearch() {
  const { bridge, editor, ui } = useWorkbench();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<SearchResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    const regex = /^\/(.+)\/$/.exec(query);
    const text = regex?.[1] ?? query;
    if (text.trim() === "") return;
    const timer = setTimeout(() => {
      bridge
        .rpc("fs.search", {
          query: text,
          isRegex: regex !== null,
          caseSensitive: false,
          limit: LIMIT,
        })
        .then(
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
    }, QUERY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, bridge]);

  const searched = query.trim() !== "";
  const matches = searched ? (answer?.matches ?? NONE) : NONE;
  const status = failure
    ? t("search.failed", { reason: failure })
    : searched && answer?.truncated
      ? t("search.truncated", { count: LIMIT })
      : null;

  return (
    <Palette<Match>
      label={t("search.label")}
      placeholder={t("search.placeholder")}
      query={query}
      onQuery={setQuery}
      items={matches}
      itemKey={(match) => `${match.path}:${match.line}:${match.column}`}
      renderItem={(match) => (
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">
            {match.text.trim()}
          </span>
          <span className="shrink-0 text-xs text-text-muted">
            {match.path}:{match.line}
          </span>
        </>
      )}
      onPick={(match) => {
        ui.getState().hide();
        void editor.getState().reveal(match.path, { line: match.line, column: match.column });
      }}
      onClose={() => ui.getState().hide()}
      status={status}
      empty={searched ? (answer ? t("search.empty") : t("search.searching")) : t("search.hint")}
    />
  );
}

const NONE: Match[] = [];
