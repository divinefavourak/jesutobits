import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "border border-border text-text-muted",
  success: "bg-success-subtle text-text",
  warning: "bg-warning-subtle text-text",
  danger: "bg-danger-subtle text-text",
  info: "bg-info-subtle text-text",
};

/** A short label. Colour is never the only signal: the text says what it means (NFR-011). */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-sm px-1.5 text-xs leading-5 ${TONES[tone]}`}>
      {children}
    </span>
  );
}
