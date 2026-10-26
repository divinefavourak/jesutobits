import type { PlanItem } from "@jesutobits/protocol";
import { useId, useState } from "react";
import { t } from "../../i18n";
import { useWorkbench } from "../../state/workbench-context";
import { Badge, type BadgeTone } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import type { RevertOutcome } from "./agent-store";
import type { TimelineItem, TurnView } from "./timeline-reducer";

type QuestionItem = Extract<TimelineItem, { kind: "question" }>;
type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

/** `ask_user`, or a limit or loop question from the harness (FR-036, section 3.4). */
export function QuestionCard({ item }: { item: QuestionItem }) {
  const { agent } = useWorkbench();
  const [answer, setAnswer] = useState("");
  const [sent, setSent] = useState(false);
  const inputId = useId();
  const titleId = useId();
  const title =
    item.source === "agent"
      ? "question.agent"
      : item.source === "limit"
        ? "question.limit"
        : "question.loop";

  if (item.answer !== undefined) {
    return (
      <p className="m-0 text-text-muted">
        {item.question} ·{" "}
        {item.answer === null
          ? t("question.closed")
          : t("question.answered", { answer: item.answer })}
      </p>
    );
  }

  const send = (text: string) => {
    if (text.trim() === "") return;
    setSent(true);
    void agent
      .getState()
      .answer(item.questionId, text.trim())
      .finally(() => setSent(false));
  };

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-md border border-info bg-surface-raised p-3"
    >
      <h3 id={titleId} className="m-0 text-base font-semibold">
        {t(title)}
      </h3>
      <p className="m-0 mt-1 whitespace-pre-wrap">{item.question}</p>
      {item.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {item.options.map((option) => (
            <Button key={option} disabled={sent} onClick={() => send(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      {item.source === "agent" && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send(answer);
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {t("question.answer")}
          </label>
          <input
            id={inputId}
            value={answer}
            placeholder={t("question.answer")}
            onChange={(event) => setAnswer(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 py-1"
          />
          <Button type="submit" variant="primary" disabled={sent || answer.trim() === ""}>
            {t("question.send")}
          </Button>
        </form>
      )}
    </section>
  );
}

const PLAN_MARK: Record<PlanItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  done: "●",
  skipped: "–",
};

/** The agent-declared plan (FR-035), labelled as the agent's. */
export function PlanChecklist({ items }: { items: PlanItem[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="rounded-md border border-border p-2">
      <h3 id={headingId} className="m-0 text-sm font-semibold">
        {t("plan.title")} <span className="font-normal text-text-muted">· {t("plan.caption")}</span>
      </h3>
      <ol className="m-0 mt-1 list-none p-0">
        {items.map((item) => (
          <li key={item.id} className="flex gap-2">
            <span aria-hidden="true">{PLAN_MARK[item.status]}</span>
            <span
              className={
                item.status === "done" || item.status === "skipped" ? "text-text-muted" : ""
              }
            >
              {item.text}
            </span>
            <span className="sr-only">({t(`plan.status.${item.status}`)})</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const STATUS_TONE: Record<ToolItem["status"], BadgeTone> = {
  running: "info",
  ok: "neutral",
  failed: "danger",
  stopped: "warning",
};

/** One tool call. "Running" shows only while the runtime reports it running (invariant 6). */
export function ToolRow({ item, expandable = true }: { item: ToolItem; expandable?: boolean }) {
  const summary = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{item.summary}</span>
      {item.status !== "ok" && (
        <Badge tone={STATUS_TONE[item.status]}>{t(`tool.status.${item.status}`)}</Badge>
      )}
      {item.durationMs !== undefined && item.durationMs >= 1000 && (
        <span className="text-text-muted">
          {t("tool.seconds", { seconds: (item.durationMs / 1000).toFixed(1) })}
        </span>
      )}
    </span>
  );
  if (!expandable) return <div className="py-0.5">{summary}</div>;
  return (
    <details className="py-0.5">
      {/* The marker is drawn with CSS, so it stays on the row's line and out of its text. */}
      <summary className="flex cursor-pointer list-none items-center gap-1 before:text-text-muted before:content-['›'] [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      <div className="mt-1 flex flex-col gap-1 pl-4 text-xs">
        <p className="m-0 font-medium">{t("tool.input")}</p>
        <pre className="m-0 overflow-auto rounded-sm bg-surface-sunken p-1.5 font-mono">
          {JSON.stringify(item.inputPreview, null, 2)}
        </pre>
        {item.error && (
          <>
            <p className="m-0 font-medium">{t("tool.error")}</p>
            <p className="m-0 whitespace-pre-wrap text-danger">{item.error.message}</p>
          </>
        )}
        {item.outputPreview && (
          <>
            <p className="m-0 font-medium">{t("tool.output")}</p>
            <pre className="m-0 max-h-60 overflow-auto rounded-sm bg-surface-sunken p-1.5 font-mono">
              {item.outputPreview}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

const LABEL_TONE: Record<string, BadgeTone> = {
  verified: "success",
  partially_verified: "warning",
  unverified: "warning",
  failing: "danger",
  no_checks: "neutral",
};

/**
 * The harness-built summary (AGENT_HARNESS.md section 7.4, UX 6.5): what changed, the
 * verification label, cost, and Revert turn. Never "Done" for changed files without the
 * label beside it.
 */
export function TurnSummaryCard({ turn }: { turn: TurnView }) {
  const { agent } = useWorkbench();
  const [outcome, setOutcome] = useState<RevertOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const summary = turn.summary;
  if (!summary) {
    // Interrupted by a restart: no summary was built, but the work can be retried (FR-041).
    if (turn.state !== "interrupted") return null;
    return (
      <section
        aria-label={t("summary.title")}
        className="flex flex-col gap-1.5 rounded-md border border-warning p-2"
      >
        <p className="m-0">{t("summary.interrupted")}</p>
        <div>
          <Button onClick={() => void agent.getState().retry(turn.turnId)}>
            {t("agent.retry")}
          </Button>
        </div>
      </section>
    );
  }

  const revert = async (force: string[] = []) => {
    setBusy(true);
    const result = await agent.getState().revertTurn(turn.turnId, force);
    setBusy(false);
    if (result) setOutcome(result);
  };

  return (
    <section
      aria-label={t("summary.title")}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken p-2"
    >
      {turn.state === "failed" && turn.error && (
        <p role="alert" className="m-0 text-danger">
          {t("summary.failed", { message: turn.error.message })}
        </p>
      )}
      {turn.state === "cancelled" && (
        <p className="m-0 text-text-muted">{t("summary.cancelled")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {summary.files.length > 0
            ? t("summary.files", { count: summary.files.length })
            : t("summary.noFiles")}
        </span>
        {summary.verification && (
          <Badge tone={LABEL_TONE[summary.verification] ?? "neutral"}>
            {t(`summary.label.${summary.verification}`)}
          </Badge>
        )}
      </div>
      {summary.files.length > 0 && (
        <ul className="m-0 list-none p-0 font-mono text-xs">
          {summary.files.map((file) => (
            <li key={`${file.change}:${file.path}`}>
              {file.path} · {t(`summary.change.${file.change}`)}{" "}
              <span className="text-text-muted">
                (+{file.added} −{file.removed})
              </span>
            </li>
          ))}
        </ul>
      )}
      {summary.verification === "unverified" && (
        <p className="m-0 text-text-muted">{t("summary.unverifiedHint")}</p>
      )}
      {summary.hiddenSecrets > 0 && (
        <p className="m-0 text-text-muted">
          {t("summary.hiddenSecrets", { count: summary.hiddenSecrets })}
        </p>
      )}
      <p className="m-0 text-xs text-text-muted">
        {t("summary.usage", {
          steps: summary.steps,
          calls: summary.toolCalls,
          tokens: summary.inputTokens + summary.outputTokens,
          cost: summary.costUsd.toFixed(4),
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        {summary.files.length > 0 && (
          <Button disabled={busy} onClick={() => void revert()}>
            {t("summary.revert")}
          </Button>
        )}
        {(turn.state === "failed" || turn.state === "interrupted") && (
          <Button disabled={busy} onClick={() => void agent.getState().retry(turn.turnId)}>
            {t("agent.retry")}
          </Button>
        )}
      </div>
      {outcome && (
        <div role="status" className="flex flex-col gap-1">
          {outcome.restored.length > 0 && (
            <p className="m-0">{t("summary.reverted", { count: outcome.restored.length })}</p>
          )}
          {outcome.conflicts.length > 0 && (
            <>
              <p className="m-0">{t("summary.conflicts")}</p>
              <ul className="m-0 list-none p-0 font-mono text-xs">
                {outcome.conflicts.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void revert(outcome.conflicts)}
              >
                {t("summary.revertAnyway")}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
