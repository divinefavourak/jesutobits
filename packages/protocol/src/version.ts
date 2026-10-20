/**
 * Version of the Host <-> Runtime <-> Workbench protocol (ADR-0003, decision 6).
 * Bump the major on any breaking change; a major mismatch fails `runtime.initialize`.
 */
export const PROTOCOL_VERSION = "0.1.0";

export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

/** Returns the major version, or `undefined` if `value` is not semver. */
export function semverMajor(value: string): number | undefined {
  const match = SEMVER_PATTERN.exec(value);
  return match ? Number(match[1]) : undefined;
}

/** Two protocol versions are compatible when both are valid semver with the same major. */
export function isProtocolCompatible(a: string, b: string): boolean {
  const majorA = semverMajor(a);
  return majorA !== undefined && majorA === semverMajor(b);
}
