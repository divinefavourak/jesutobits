import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Content-addressed storage for checkpoint pre-images (ADR-0012, DATA_AND_PERSISTENCE.md
 * section 6.3): each blob is named by the SHA-256 of its bytes and written before the index
 * row that refers to it, so a row never points at a missing blob.
 */
export interface BlobStore {
  /** Stores the bytes (once) and returns their hash. */
  put(bytes: Uint8Array): string;
  get(hash: string): Buffer | undefined;
  /** Removes every blob not in `keep`; returns how many went. */
  sweep(keep: ReadonlySet<string>): number;
}

const HASH = /^[0-9a-f]{64}$/;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `<data dir>/checkpoints/<first two hex digits>/<hash>`. */
export class FileBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  put(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    const target = this.path(hash);
    if (existsSync(target)) return hash;
    const folder = join(this.dir, hash.slice(0, 2));
    mkdirSync(folder, { recursive: true });
    // Temp then rename: a crash never leaves a blob whose name lies about its content.
    const temp = join(folder, `.${hash}.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(temp, bytes, { flush: true });
    renameSync(temp, target);
    return hash;
  }

  get(hash: string): Buffer | undefined {
    if (!HASH.test(hash)) return undefined;
    try {
      return readFileSync(this.path(hash));
    } catch {
      return undefined;
    }
  }

  sweep(keep: ReadonlySet<string>): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const folder of readdirSync(this.dir)) {
      if (!/^[0-9a-f]{2}$/.test(folder)) continue;
      for (const name of readdirSync(join(this.dir, folder))) {
        if (keep.has(name)) continue;
        rmSync(join(this.dir, folder, name), { force: true });
        removed++;
      }
    }
    return removed;
  }

  private path(hash: string): string {
    return join(this.dir, hash.slice(0, 2), hash);
  }
}

/** For runs without a data dir (tests, `--data-dir` absent): blobs live in memory. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();

  put(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    if (!this.blobs.has(hash)) this.blobs.set(hash, Buffer.from(bytes));
    return hash;
  }

  get(hash: string): Buffer | undefined {
    const blob = this.blobs.get(hash);
    return blob && Buffer.from(blob);
  }

  sweep(keep: ReadonlySet<string>): number {
    let removed = 0;
    for (const hash of [...this.blobs.keys()]) {
      if (!keep.has(hash)) {
        this.blobs.delete(hash);
        removed++;
      }
    }
    return removed;
  }
}
