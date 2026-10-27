import { isFinalTurnState, type TurnMode } from "@jesutobits/protocol";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n";
import { useAgent, useUi, useWorkbench } from "../../state/workbench-context";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Markdown } from "../../ui/markdown/Markdown";
import { Buddy, Glyph, JMark } from "../../ui/Studio";
import { Companion } from "../companion/Companion";
import { LearningCentre } from "../learn/LearningCentre";
import { ThemePicker } from "../look/ThemePicker";
import { OPENROUTER_REF } from "./agent-store";
import { ApprovalCard, ResolvedApproval } from "./ApprovalCard";
import { PlanChecklist, QuestionCard, ToolRow, TurnSummaryCard } from "./TurnParts";
import { liveTurn, type TimelineItem, type TurnView } from "./timeline-reducer";

type Tab = "chat" | "timeline" | "learn";

/**
 * The agent panel (UX_AND_INTERFACE.md section 6): sessions, Agent/Ask mode, the chat with
 * approvals and questions inline, the timeline, and the composer with Stop. Everything it
 * shows comes from runtime events through the agent store (invariant 6).
 */
export function AgentPanel() {
  const [tab, setTab] = useState<Tab>("chat");
  const [lookOpen, setLookOpen] = useState(false);
  const hasKey = useAgent((state) => state.hasKey);
  // The Activity tab counts the session's real steps (tool calls), as its timeline lists them.
  const steps = useAgent((state) =>
    state.timeline.turns.reduce(
      (sum, turn) => sum + turn.items.filter((item) => item.kind === "tool").length,
      0,
    ),
  );
  const { agent, bridge, ui } = useWorkbench();
  const tabIds = { chat: useId(), timeline: useId(), learn: useId() };
  const closeLook = useCallback(() => setLookOpen(false), []);
  useEffect(() => bridge.onOpenLook(() => setLookOpen(true)), [bridge]);

  useEffect(() => {
    void agent.getState().checkKey();
  }, [agent]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas font-ui">
      <header className="flex items-center gap-1 px-4 pt-3.5 pb-2">
        <div className="flex-1">
          <Companion />
        </div>
        <button
          type="button"
          title={t("look.open")}
          aria-label={t("look.open")}
          aria-haspopup="dialog"
          onClick={() => setLookOpen(true)}
          className="rounded-md p-1.5 text-text-muted hover:bg-item-hover hover:text-text"
        >
          <Glyph name="palette" size={17} />
        </button>
        <button
          type="button"
          title={t("agent.session.new")}
          aria-label={t("agent.session.new")}
          onClick={() => void agent.getState().newSession()}
          className="rounded-md p-1.5 text-text-muted hover:bg-item-hover hover:text-text"
        >
          <Glyph name="plus" size={17} />
        </button>
      </header>
      <AgentHeader />
      {hasKey === false && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-warning-subtle px-3 py-2">
          <span className="flex-1">{t("agent.key.missing")}</span>
          <Button onClick={() => void bridge.secrets.prompt(OPENROUTER_REF).catch(() => undefined)}>
            {t("agent.key.add")}
          </Button>
        </div>
      )}
      <div
        role="tablist"
        aria-label={t("panel.agent")}
        className="flex gap-6 border-b border-border px-4"
      >
        {(["chat", "timeline", "learn"] as const).map((id) => (
          <button
            key={id}
            id={tabIds[id]}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 pt-1 pb-2.5 ${tab === id ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text"}`}
          >
            {id === "chat" && <Glyph name="chat" size={13} />}
            {id === "learn" && <Glyph name="book" size={13} />}
            {t(`agent.tab.${id}`)}
            {id === "timeline" && steps > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="rounded-full bg-accent-subtle px-1.5 text-[11px] text-accent"
                >
                  {steps}
                </span>
                <span className="sr-only">{t("agent.tab.steps", { count: steps })}</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-labelledby={tabIds[tab]} className="min-h-0 flex-1 overflow-y-auto">
        {tab === "chat" && <ChatView />}
        {tab === "timeline" && <TimelineView />}
        {tab === "learn" && (
          <LearningCentre
            onAsk={(text) => {
              ui.getState().compose(text);
              setTab("chat");
            }}
          />
        )}
      </div>
      <Composer />
      {lookOpen && <ThemePicker onClose={closeLook} />}
    </div>
  );
}

function AgentHeader() {
  const { agent } = useWorkbench();
  const sessions = useAgent((state) => state.sessions);
  const activeId = useAgent((state) => state.activeSessionId);
  const mode = useAgent((state) => state.mode);
  const selectId = useId();
  const active = sessions?.find((session) => session.id === activeId);

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5">
      <label htmlFor={selectId} className="sr-only">
        {t("agent.session.label")}
      </label>
      <select
        id={selectId}
        value={activeId ?? ""}
        onChange={(event) => void agent.getState().selectSession(event.target.value || null)}
        className="w-40 min-w-32 max-w-56 flex-1 truncate rounded-md border border-border bg-surface-raised px-2 py-1"
      >
        {!activeId && <option value="">{t("agent.session.none")}</option>}
        {(sessions ?? []).map((session) => (
          <option key={session.id} value={session.id}>
            {session.title}
          </option>
        ))}
      </select>
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
    return (
      <div className="studio-in px-5 pt-7 pb-6 text-center">
        <Buddy />
        <h2 className="m-0 font-display text-[21px] leading-tight font-medium tracking-tight">
          {t("studio.emptyTitle")}
        </h2>
        <p className="mx-auto mt-2.5 mb-0 max-w-60 leading-relaxed text-text-muted">
          {t("studio.emptyBody")}
        </p>
        <p className="mx-auto mt-4 mb-0 max-w-64 text-xs text-text-subtle">{t("agent.empty")}</p>
      </div>
    );
  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      {timeline.turns.map((turn) => (
        <TurnChat key={turn.turnId} turn={turn} />
      ))}
      <div ref={end} />
    </div>
  );
}

function TurnChat({ turn }: { turn: TurnView }) {
  return (
    <article className="studio-in flex flex-col gap-2.5">
      {turn.userText !== undefined ? (
        <div className="self-end max-w-[90%] rounded-[13px_13px_3px_13px] border border-accent-subtle bg-accent-subtle px-3.5 py-2.5 leading-relaxed">
          <p className="sr-only">{t("agent.you")}</p>
          <p className="m-0 whitespace-pre-wrap">{turn.userText}</p>
        </div>
      ) : turn.retryOf ? (
        <p className="m-0 text-xs text-text-muted">{t("agent.retryOf")}</p>
      ) : null}
      <p className="m-0 flex items-center gap-1.5 text-xs">
        <JMark size={17} />
        <strong className="font-medium">Jesutobits</strong>
        <span className="text-text-muted">· {t("studio.speakerRole")}</span>
      </p>
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
    <div className="studio-in flex flex-col gap-2 p-4">
      <div>
        <h2 className="m-0 font-display text-lg font-medium">{t("timeline.heading")}</h2>
        <p className="m-0 text-text-muted">{t("timeline.subheading")}</p>
      </div>
      <div role="radiogroup" aria-label={t("timeline.filter")} className="flex gap-1.5">
        {(["all", "changes", "errors"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={filter === value}
            onClick={() => setFilter(value)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === value ? "border-accent bg-accent-subtle text-text" : "border-border text-text-muted hover:text-text"}`}
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
/** VS Code setting the "Open settings" fix opens on (apps/vscode-extension/package.json). */
const MODEL_SETTING = "jesutobits.providers.openrouter.defaultModel";

function Composer() {
  const { agent, ui, bridge } = useWorkbench();
  const live = useAgent((state) => liveTurn(state.timeline));
  const busy = useAgent((state) => state.busy);
  const error = useAgent((state) => state.error);
  const errorFix = useAgent((state) => state.errorFix);
  const composerRequest = useUi((state) => state.focusComposerRequest);
  const text = useUi((state) => state.draft);
  const setText = (value: string) => ui.getState().setDraft(value);
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
    <div className="flex flex-col gap-2 px-4 pt-3">
      {error && (
        <p role="alert" className="m-0 flex items-start gap-2 text-danger">
          <span className="flex-1">{error}</span>
          {errorFix === "model" && (
            <Button variant="secondary" onClick={() => void bridge.openSettings(MODEL_SETTING)}>
              {t("agent.error.openSettings")}
            </Button>
          )}
          {errorFix === "key" && (
            <Button
              variant="secondary"
              onClick={() =>
                void bridge.secrets.prompt(OPENROUTER_REF).then(async (stored) => {
                  await agent.getState().checkKey();
                  if (stored) agent.getState().dismissError();
                })
              }
            >
              {t("agent.error.addKey")}
            </Button>
          )}
          <Button variant="ghost" onClick={() => agent.getState().dismissError()}>
            {t("errors.dismiss")}
          </Button>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {(["explain", "look"] as const).map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => ui.getState().compose(t(`studio.chip.${chip}Prompt`))}
            className="flex items-center gap-1 rounded-full border border-accent-subtle px-2.5 py-1 text-xs text-text-muted hover:-translate-y-0.5 hover:bg-accent-subtle hover:text-text motion-reduce:hover:translate-y-0"
          >
            <Glyph name={chip === "explain" ? "book" : "sun"} size={12} />
            {t(`studio.chip.${chip}`)}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-border-strong bg-surface-raised p-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-subtle">
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
          className="w-full resize-none border-0 bg-transparent p-0 leading-relaxed outline-none placeholder:text-text-subtle"
        />
        <div className="mt-1.5 flex items-center gap-2">
          {live ? (
            <Badge tone="info">{t(`agent.state.${live.state}`)}</Badge>
          ) : (
            <span className="text-xs text-text-subtle">{t("studio.sendHint")}</span>
          )}
          <span className="flex-1" />
          {live ? (
            <Button variant="danger" onClick={() => void agent.getState().stop()}>
              {t("agent.stop")}
            </Button>
          ) : (
            <button
              type="button"
              aria-label={t("agent.send")}
              title={t("agent.send")}
              disabled={busy || text.trim() === ""}
              onClick={() => void send()}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Glyph name="arrow" size={16} />
            </button>
          )}
        </div>
      </div>
      <p className="m-0 flex items-center justify-center gap-1 pb-2.5 text-[11px] text-text-subtle">
        <Glyph name="shield" size={11} />
        {t("studio.composeHint")}
      </p>
    </div>
  );
}
