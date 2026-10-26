import type { PermissionAction, PermissionDecision, RiskClass } from "@jesutobits/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { t } from "../../i18n";
import { useWorkbench } from "../../state/workbench-context";
import { Badge, type BadgeTone } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import type { TimelineItem } from "./timeline-reducer";

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

const RISK_TONE: Record<RiskClass, BadgeTone> = {
  read: "neutral",
  sensitive_read: "warning",
  write: "info",
  destructive: "danger",
  execute: "warning",
  network: "warning",
  vcs: "warning",
  external: "warning",
  outside_workspace: "danger",
};

/** The exact action in words (SECURITY.md principle 3): real paths, never the model's summary. */
export function describeAction(action: PermissionAction): string {
  switch (action.kind) {
    case "file": {
      if (action.op === "move") {
        return t("approval.action.move", {
          from: action.paths[0] ?? "",
          to: action.paths[1] ?? "",
        });
      }
      return t(`approval.action.${action.op}`, { paths: action.paths.join(", ") });
    }
    case "command":
      return t("approval.action.command", { command: action.argv.join(" ") });
    case "git":
      return t("approval.action.git", { paths: action.paths.join(", ") });
  }
}

/**
 * An approval card (FR-055, UX_AND_INTERFACE.md section 6.4). Focus lands on the card's
 * body, not on Allow, and no key approves by default: Enter does nothing until the user
 * focuses a button. Risks are named in words as well as colour.
 */
export function ApprovalCard({ item }: { item: PermissionItem }) {
  const { agent } = useWorkbench();
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    // Focus the body (never a button), but do not take it from someone typing (UX 10).
    const active = document.activeElement;
    const typing =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (typing) body.current?.scrollIntoView({ block: "nearest" });
    else body.current?.focus();
  }, []);

  const respond = (decision: PermissionDecision, text?: string) => {
    setSent(true);
    void agent
      .getState()
      .respond(item.permissionId, decision, text)
      .finally(() => setSent(false));
  };
  const offers = (decision: PermissionDecision) => item.options.includes(decision);

  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-action`}
      className="rounded-md border border-warning bg-surface-raised p-3"
    >
      <div
        ref={body}
        tabIndex={-1}
        className="flex flex-col gap-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 id={titleId} className="m-0 text-base font-semibold">
            {t("approval.title")}
          </h3>
          {[...new Set(item.risk)].map((risk) => (
            <Badge key={risk} tone={RISK_TONE[risk]}>
              {t(`approval.risk.${risk}`)}
            </Badge>
          ))}
        </div>
        <p id={`${titleId}-action`} className="m-0 break-all font-mono">
          {describeAction(item.action)}
        </p>
        {item.reasons.length > 0 && (
          <ul className="m-0 list-disc pl-5 text-text-muted">
            {item.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        {item.diff && (
          <details open>
            <summary className="cursor-pointer">{t("approval.changes")}</summary>
            <DiffView diff={item.diff} />
          </details>
        )}
        {item.agentExplanation && (
          <figure className="m-0">
            <figcaption className="text-text-muted">{t("approval.explanation")}</figcaption>
            <blockquote className="m-0 border-l-2 border-border pl-2 whitespace-pre-wrap">
              {item.agentExplanation}
            </blockquote>
          </figure>
        )}
        {item.sessionRule && offers("allow_session") && (
          <p className="m-0 text-text-muted">{t("approval.rule", { rule: item.sessionRule })}</p>
        )}
      </div>

      {denying ? (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor={messageId}>{t("approval.message")}</label>
          <textarea
            id={messageId}
            rows={2}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            className="rounded-md border border-border-strong bg-surface p-2"
          />
          <div className="flex gap-2">
            <Button variant="danger" disabled={sent} onClick={() => respond("deny", message)}>
              {t("approval.sendDenial")}
            </Button>
            <Button variant="ghost" onClick={() => setDenying(false)}>
              {t("approval.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {offers("allow_once") && (
            <Button disabled={sent} onClick={() => respond("allow_once")}>
              {t("approval.allowOnce")}
            </Button>
          )}
          {offers("allow_session") && (
            <Button disabled={sent} onClick={() => respond("allow_session")}>
              {t("approval.allowSession")}
            </Button>
          )}
          {offers("allow_redacted") && (
            <Button disabled={sent} onClick={() => respond("allow_redacted")}>
              {t("approval.allowRedacted")}
            </Button>
          )}
          <Button variant="danger" disabled={sent} onClick={() => respond("deny")}>
            {t("approval.deny")}
          </Button>
          <Button variant="ghost" disabled={sent} onClick={() => setDenying(true)}>
            {t("approval.denyWithMessage")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A unified diff, shown as text with added and removed lines marked (never as HTML). */
export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="m-0 mt-1 max-h-72 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-xs">
      {diff.split("\n").map((line, index) => {
        const tone =
          line.startsWith("+") && !line.startsWith("+++")
            ? "bg-diff-added"
            : line.startsWith("-") && !line.startsWith("---")
              ? "bg-diff-removed"
              : line.startsWith("@@")
                ? "text-text-muted"
                : "";
        return (
          <span key={index} className={`block ${tone}`}>
            {line === "" ? " " : line}
          </span>
        );
      })}
    </pre>
  );
}

/** A decided or withdrawn approval, as one line in the transcript. */
export function ResolvedApproval({ item }: { item: PermissionItem }) {
  if (item.decision === null) return null;
  return (
    <p className="m-0 text-text-muted">
      {describeAction(item.action)} · {t(`approval.resolved.${item.decision}`)}
    </p>
  );
}
