/**
 * Files that probably hold secrets (SECURITY.md section 6.2). Reading one is
 * `sensitive_read`, which asks under every preset. The match is on the file name, case
 * insensitive; `.npmrc` and `.yarnrc.yml` count only when they contain an auth token, which
 * `holdsAuthToken` checks once the content is known.
 */

const EXAMPLE_ENV = new Set([".env.example", ".env.sample", ".env.template"]);

const NAME_PATTERNS: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.keystore$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^id_ecdsa/,
  /^credentials\.json$/,
];

/** Config files that are secret only when they carry a token. */
const TOKEN_FILES = new Set([".npmrc", ".yarnrc.yml"]);

function baseName(relative: string): string {
  return (relative.split("/").pop() ?? relative).toLowerCase();
}

export function isSecretPatternFile(relative: string, content?: string): boolean {
  const name = baseName(relative);
  if (EXAMPLE_ENV.has(name)) return false;
  if (TOKEN_FILES.has(name)) return content === undefined ? true : holdsAuthToken(content);
  return NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** `_authToken`, `_auth` and `_password` in `.npmrc`; `npmAuthToken` in `.yarnrc.yml`. */
export function holdsAuthToken(content: string): boolean {
  return /(?:^|[\s:])(?:_authToken|_auth|_password|npmAuthToken|npmAuthIdent)\s*[=:]/m.test(
    content,
  );
}

/**
 * "Share with values hidden": keeps every key and the file's layout, but replaces values
 * with `***`. Lines that are not `key = value` or `key: value` (comments, sections) stay.
 * Private key blocks are hidden whole.
 */
export function hideValues(content: string): string {
  const withoutKeys = content.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "***",
  );
  return withoutKeys
    .split(/(\r?\n)/)
    .map((part) => {
      if (/^\r?\n$/.test(part) || /^\s*(?:#|;|\[|$)/.test(part)) return part;
      const match = /^(\s*(?:export\s+)?[^=:\s][^=:]*?\s*[=:]\s*)(.*)$/.exec(part);
      return match && match[2] !== "" ? `${match[1]}***` : part;
    })
    .join("");
}
