import { en, type Messages } from "./messages.en";

export type MessageKey = keyof Messages;
type Params = Record<string, string | number>;

const LOCALE = "en";
const plurals = new Intl.PluralRules(LOCALE);
const numbers = new Intl.NumberFormat(LOCALE);

/**
 * Looks up a UI string (NFR-020: every visible string comes from here). Numbers are
 * formatted for the locale. A missing parameter stays visible as `{name}`, so it is noticed.
 */
export function t(key: MessageKey, params: Params = {}): string {
  const message: string | Partial<Record<Intl.LDMLPluralRule, string>> = en[key];
  let text: string;
  if (typeof message === "string") {
    text = message;
  } else {
    const count = Number(params.count ?? 0);
    text = message[plurals.select(count)] ?? message.other ?? "";
  }
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    if (value === undefined) return placeholder;
    return typeof value === "number" ? numbers.format(value) : value;
  });
}

const dateTimes = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });

/** A date and time for the locale, for example "21 Oct 2026, 14:05". */
export function formatDateTime(date: Date | string): string {
  return dateTimes.format(typeof date === "string" ? new Date(date) : date);
}
