/**
 * Prefixed ULIDs (ARCHITECTURE.md section 6.5). Prefixes make logs readable and stop an ID
 * of one type being passed where another is expected.
 */
export const ID_PREFIXES = [
  "prj",
  "ses",
  "trn",
  "call",
  "perm",
  "proc",
  "prv",
  "sel",
  "chk",
  "ext",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];
export type Id<P extends IdPrefix> = `${P}_${string}`;

// Web Crypto is a global in Node and every browser. Declaring only what we use keeps this
// package free of both DOM and Node type libraries.
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

/** Crockford base32, as specified by ULID. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAX_TIME = 2 ** 48 - 1;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`ULID time must be an integer between 0 and ${MAX_TIME}`);
  }
  let out = "";
  for (let i = 0; i < TIME_LENGTH; i++) {
    out = ENCODING.charAt(ms % 32) + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom(): string {
  // 16 characters x 5 bits = 80 bits. A byte per character, masked to 5 bits, is uniform.
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
  let out = "";
  for (const byte of bytes) out += ENCODING.charAt(byte & 31);
  return out;
}

/** A 26-character ULID. `now` is injectable for tests. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function newId<P extends IdPrefix>(prefix: P, now?: number): Id<P> {
  return `${prefix}_${ulid(now)}`;
}

export function isId<P extends IdPrefix>(prefix: P, value: unknown): value is Id<P> {
  return (
    typeof value === "string" &&
    value.startsWith(`${prefix}_`) &&
    ULID_PATTERN.test(value.slice(prefix.length + 1))
  );
}

/** Milliseconds since the epoch encoded in an ID's ULID. */
export function idTimestamp(id: Id<IdPrefix>): number {
  const ulidPart = id.slice(id.indexOf("_") + 1, id.indexOf("_") + 1 + TIME_LENGTH);
  let ms = 0;
  for (const char of ulidPart) ms = ms * 32 + ENCODING.indexOf(char);
  return ms;
}
