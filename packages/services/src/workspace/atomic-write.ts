import { randomBytes } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Names `writeFileAtomic` uses for its temporary files: `.<name>.<12 hex>.tmp`. */
const TEMP_NAME = /(?:^|\/)\.[^/]+\.[0-9a-f]{12}\.tmp$/;

/** True for this module's temporary files, which watchers must not report. */
export function isAtomicTemp(relative: string): boolean {
  return TEMP_NAME.test(relative);
}

/** Windows antivirus and indexers briefly lock files; renames are retried for this long. */
const RENAME_RETRIES = [20, 50, 100, 200, 400];

/**
 * Writes `bytes` to `target` atomically (ARCHITECTURE.md section 9.3): a temporary file in
 * the same folder, flushed to disk, then renamed over the target. A crash leaves either the
 * old file or the new one, never half of each. The original's permission bits are kept on
 * POSIX.
 */
export async function writeFileAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const mode = await stat(target).then(
    (existing) => existing.mode & 0o777,
    () => undefined,
  );
  const handle = await open(temp, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      const delay = RENAME_RETRIES[attempt];
      if (process.platform !== "win32" || delay === undefined) throw error;
      if (errno !== "EPERM" && errno !== "EBUSY" && errno !== "EACCES") throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
