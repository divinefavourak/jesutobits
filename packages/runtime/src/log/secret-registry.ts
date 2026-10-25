/**
 * Masks secrets wherever runtime text may leave the process (SECURITY.md section 6.1): log
 * lines now, model requests in Phase 2. Two layers: exact values of known secrets,
 * replaced with `[REDACTED:<ref>]`, then common token shapes. The token patterns match the
 * Host's (`apps/desktop/src-tauri/src/logging/redact.rs`); both run the cases in
 * `fixtures/redaction/cases.json`.
 */

/** Shorter values would mask ordinary text everywhere they occur. */
const MIN_SECRET_LENGTH = 8;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // A block without its END line is masked to the end of the text.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[REDACTED:private-key]",
  ],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED:token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED:token]"],
];

export class SecretRegistry {
  /** Longest value first, so a secret containing another is masked whole. */
  private secrets: Array<{ reference: string; value: string }> = [];

  /**
   * Remembers a secret's value so every later mask replaces it. Returns false, and
   * remembers nothing, for values too short to mask safely.
   */
  register(reference: string, value: string): boolean {
    if (value.length < MIN_SECRET_LENGTH) return false;
    this.secrets = this.secrets.filter((secret) => secret.reference !== reference);
    this.secrets.push({ reference, value });
    this.secrets.sort((a, b) => b.value.length - a.value.length);
    return true;
  }

  mask(text: string): string {
    let masked = text;
    for (const { reference, value } of this.secrets) {
      if (masked.includes(value)) masked = masked.replaceAll(value, `[REDACTED:${reference}]`);
    }
    for (const [pattern, replacement] of PATTERNS) {
      masked = masked.replace(pattern, replacement);
    }
    return masked;
  }

  /** Masks every string inside a JSON-like value; other values are returned unchanged. */
  maskValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return this.mask(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.maskValue(item, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.maskValue(item, seen)]),
    );
  }
}
