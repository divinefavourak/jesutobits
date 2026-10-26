import { isFinalTurnState, type TurnMode } from "@jesutobits/protocol";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n";
import { useAgent, useUi, useWorkbench } from "../../state/workbench-context";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Markdown } from "../../ui/markdown/Markdown";
import { ApprovalCard, ResolvedApproval } from "./ApprovalCard";
import { PlanChecklist, QuestionCard, ToolRow, TurnSummaryCard } from "./TurnParts";
import { liveTurn, type TimelineItem, type TurnView } from "./timeline-reducer";

type Tab = "chat" | "timeline";

/**
 * The agent panel (UX_AND_INTERFACE.md section 6): sessions, Agent/Ask mode, the chat with
 * approvals and questions inline, the timeline, and the composer with Stop. Everything it
 * shows comes from runtime events through the agent store (invariant 6).
 */
export function AgentPanel() {
  const [tab, setTab] = useState<Tab>("chat");
  const hasKey = useAgent((state) => state.hasKey);
  const { agent, ui } = useWorkbench();
  const chatTabId = useId();
  const timelineTabId = useId();

  useEffect(() => {
    void agent.getState().checkKey();
  }, [agent]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentHeader />
      {hasKey === false && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-warning-subtle px-3 py-2">
          <span className="flex-1">{t("agent.key.missing")}</span>
          <Button onClick={() => ui.getState().openSettings("providers")}>
            {t("agent.key.add")}
          </Button>
        </div>
      )}
      <div
        role="tablist"
        aria-label={t("panel.agent")}
        className="flex gap-1 border-b border-border px-2"
      >
        {(["chat", "timeline"] as const).map((id) => (
          <button
            key={id}
            id={id === "chat" ? chatTabId : timelineTabId}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`px-2 py-1.5 ${tab === id ? "border-b-2 border-accent font-medium" : "text-text-muted"}`}
          >
            {t(`agent.tab.${id}`)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        aria-labelledby={tab === "chat" ? chatTabId : timelineTabId}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tab === "chat" ? <ChatView /> : <TimelineView />}
      </div>
      <Composer />
    </div>
  );
}

function AgentHeader() {
  const { agent } = useWorkbench();
  const sessions = useAgent((state) => state.sessions);
  const activeId = useAgent((state) => state.activeSessionId);
  const mode = useAgent((state) => state.mode);
  const busy = useAgent((state) => state.busy);
  const selectId = useId();
  const active = sessions?.find((session) => session.id === activeId);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
      <label htmlFor={selectId} className="sr-only">
        {t("agent.session.label")}
      </label>
      <select
        id={selectId}
        value={activeId ?? ""}
        onChange={(event) => void agent.getState().selectSession(event.target.value || null)}
        className="min-w-0 max-w-56 flex-1 rounded-md border border-border bg-surface px-1.5 py-1"
      >
        {!activeId && <option value="">{t("agent.session.none")}</option>}
        {(sessions ?? []).map((session) => (
          <option key={session.id} value={session.id}>
            {session.title}
          </option>
        ))}
      </select>
      <Button variant="ghost" disabled={busy} onClick={() => void agent.getState().newSession()}>
        {t("agent.session.new")}
      </Button>
      <ModeToggle mode={mode} onChange={(next) => agent.getState().setMode(next)} />
      {active && (
        <span className="text-xs text-text-muted" title={active.modelId}>
          {active.modelId} · {t("agent.session.cost", { cost: active.costUsd.toFixed(2) })}
        </span>
      )}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: TurnMode; onChange: (mode: TurnMode) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label={t("agent.mode.label")}
      className="flex rounded-md border border-border"
    >
      {(["agent", "ask"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          title={t(`agent.mode.${value}Hint`)}
          onClick={() => onChange(value)}
          className={`px-2 py-0.5 ${mode === value ? "bg-item-active font-medium" : "text-text-muted"}`}
        >
          {t(`agent.mode.${value}`)}
        </button>
      ))}
    </div>
  );
}

function ChatView() {
  const timeline = useAgent((state) => state.timeline);
  const loading = useAgent((state) => state.loadingHistory);
  const end = useRef<HTMLDivElement>(null);
  const items = timeline.turns.reduce((count, turn) => count + turn.items.length, 0);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items, timeline.turns.length]);

  if (loading) return <p className="m-0 p-4 text-text-muted">{t("agent.loading")}</p>;
  if (timeline.turns.length === 0)
    return <p className="m-0 p-4 text-text-muted">{t("agent.empty")}</p>;
  return (
    <div className="flex flex-col gap-3 p-3">
      {timeline.turns.map((turn) => (
        <TurnChat key={turn.turnId} turn={turn} />
      ))}
      <div ref={end} />
    </div>
  );
}

function TurnChat({ turn }: { turn: TurnView }) {
  return (
    <article className="flex flex-col gap-2">
      {turn.userText !== undefined ? (
        <div className="self-end max-w-[90%] rounded-md bg-accent-subtle px-3 py-2">
          <p className="m-0 text-xs text-text-muted">{t("agent.you")}</p>
          <p className="m-0 whitespace-pre-wrap">{turn.userText}</p>
        </div>
      ) : turn.retryOf ? (
        <p className="m-0 text-xs text-text-muted">{t("agent.retryOf")}</p>
      ) : null}
      {turn.plan && <PlanChecklist items={turn.plan} />}
      {turn.items.map((item, index) => (
        <ChatItem key={itemKey(item, index)} item={item} />
      ))}
      {!isFinalTurnState(turn.state) && <TurnStatus turn={turn} />}
      {isFinalTurnState(turn.state) && <TurnSummaryCard turn={turn} />}
    </article>
  );
}

function ChatItem({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "message":
      if (item.text === "" && item.reasoning === "") return null;
      return (
        <div className="max-w-full">
          {item.reasoning !== "" && (
            <details className="mb-1 text-text-muted">
              <summary className="cursor-pointer">{t("agent.reasoning")}</summary>
              <p className="m-0 whitespace-pre-wrap text-xs">{item.reasoning}</p>
            </details>
          )}
          {item.text !== "" && <Markdown text={item.text} />}
        </div>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "permission":
      return item.decision === null ? (
        <ApprovalCard item={item} />
      ) : (
        <ResolvedApproval item={item} />
      );
    case "question":
      return <QuestionCard item={item} />;
    case "model_error":
      return (
        <p className="m-0 text-danger">
          {t("timeline.modelError", { message: item.error.message })}
          {item.retryInMs !== undefined &&
            ` · ${t("timeline.retrying", { seconds: Math.ceil(item.retryInMs / 1000) })}`}
        </p>
      );
    case "compaction":
      return <p className="m-0 text-text-muted">{t("timeline.compaction")}</p>;
    case "warning":
      return <p className="m-0 text-text-muted">{item.message}</p>;
  }
}

/** The live turn's state in words, with Pause/Resume. Text only for real states. */
function TurnStatus({ turn }: { turn: TurnView }) {
  const { agent } = useWorkbench();
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-text-muted">
      <span className="flex-1">{t(`agent.state.${turn.state}`)}</span>
      {turn.state === "paused" ? (
        <Button variant="ghost" onClick={() => void agent.getState().resume()}>
          {t("agent.resume")}
        </Button>
      ) : (
        <Button variant="ghost" onClick={() => void agent.getState().pause()}>
          {t("agent.pause")}
        </Button>
      )}
    </div>
  );
}

type Filter = "all" | "changes" | "errors";

/** Every activity, one row each (UX_AND_INTERFACE.md section 6.3). */
function TimelineView() {
  const timeline = useAgent((state) => state.timeline);
  const [filter, setFilter] = useState<Filter>("all");
  const rows = timeline.turns.flatMap((turn) =>
    turn.items
      .filter((item) => {
        if (filter === "changes") return item.kind === "tool" && (item.diff?.length ?? 0) > 0;
        if (filter === "errors") {
          return (item.kind === "tool" && item.status === "failed") || item.kind === "model_error";
        }
        return item.kind !== "message";
      })
      .map((item, index) => ({ turn, item, key: `${turn.turnId}:${itemKey(item, index)}` })),
  );

  return (
    <div className="flex flex-col gap-1 p-2">
      <div role="radiogroup" aria-label={t("timeline.filter")} className="flex gap-1">
        {(["all", "changes", "errors"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={filter === value}
            onClick={() => setFilter(value)}
            className={`rounded-sm px-2 py-0.5 ${filter === value ? "bg-item-active font-medium" : "text-text-muted"}`}
          >
            {t(`timeline.filter.${value}`)}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="m-0 p-2 text-text-muted">{t("timeline.empty")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map(({ item, key }) => (
            <li key={key} className="border-b border-border py-1">
              <TimelineRow item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "tool":
      return <ToolRow item={item} />;
    case "permission":
      return (
        <p className="m-0">
          {t("approval.title")} ·{" "}
          {item.decision === null
            ? t("agent.state.awaiting_approval")
            : t(`approval.resolved.${item.decision}`)}
        </p>
      );
    case "question":
      return <p className="m-0">{item.question}</p>;
    default:
      return <ChatItem item={item} />;
  }
}

function itemKey(item: TimelineItem, index: number): string {
  switch (item.kind) {
    case "message":
      return `m${item.step}`;
    case "tool":
      return item.callId;
    case "permission":
      return item.permissionId;
    case "question":
      return item.questionId;
    default:
      return `${item.kind}${index}`;
  }
}

/** Ctrl+Enter sends (UX 9); while a turn runs, Send becomes Stop. */
function Composer() {
  const { agent } = useWorkbench();
  const live = useAgent((state) => liveTurn(state.timeline));
  const busy = useAgent((state) => state.busy);
  const error = useAgent((state) => state.error);
  const composerRequest = useUi((state) => state.focusComposerRequest);
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (composerRequest) input.current?.focus();
  }, [composerRequest]);

  const send = async () => {
    if (await agent.getState().send(text)) setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!live) void send();
    }
  };

  return (
    <div className="flex flex-col gap-1 border-t border-border p-2">
      {error && (
        <p role="alert" className="m-0 flex items-start gap-2 text-danger">
          <span className="flex-1">{error}</span>
          <Button variant="ghost" onClick={() => agent.getState().dismissError()}>
            {t("errors.dismiss")}
          </Button>
        </p>
      )}
      <label htmlFor={inputId} className="sr-only">
        {t("agent.composer.label")}
      </label>
      <textarea
        id={inputId}
        ref={input}
        rows={3}
        value={text}
        placeholder={t("agent.composer.placeholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="resize-none rounded-md border border-border-strong bg-surface p-2"
      />
      <div className="flex items-center gap-2">
        {live && <Badge tone="info">{t(`agent.state.${live.state}`)}</Badge>}
        <span className="flex-1" />
        {live ? (
          <Button variant="danger" onClick={() => void agent.getState().stop()}>
            {t("agent.stop")}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || text.trim() === ""}
            onClick={() => void send()}
          >
            {t("agent.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
