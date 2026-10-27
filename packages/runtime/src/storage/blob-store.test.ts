import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBlobStore, MemoryBlobStore, type BlobStore } from "./blob-store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jesutobits-blobs-"));
  dirs.push(dir);
  return dir;
}

describe.each([
  { name: "FileBlobStore", make: (): BlobStore => new FileBlobStore(tempDir()) },
  { name: "MemoryBlobStore", make: (): BlobStore => new MemoryBlobStore() },
])("$name", ({ make }) => {
  const a = Buffer.from("the first blob");
  const b = Buffer.from("the second blob");
  let store: BlobStore;

  beforeEach(() => {
    store = make();
  });

  it("puts bytes and returns their sha256 hex", () => {
    expect(store.put(a)).toEqual(createHash("sha256").update(a).digest("hex"));
  });

  it("returns the same hash for the same bytes put twice", () => {
    expect(store.put(a)).toEqual(store.put(Buffer.from(a)));
  });

  it("gets back an equal copy that is safe to mutate", () => {
    const hash = store.put(a);
    const copy = store.get(hash);
    expect(copy?.equals(a)).toBe(true);
    if (!copy) throw new Error("the blob cannot be read back");
    copy[0] = 0xff;
    expect(store.get(hash)?.equals(a)).toBe(true);
  });

  it("gets nothing for an unknown or malformed hash", () => {
    store.put(a);
    const unknown = createHash("sha256").update(b).digest("hex");
    expect(store.get(unknown)).toBeUndefined();
    expect(store.get(unknown.toUpperCase())).toBeUndefined();
    expect(store.get("not a hash at all")).toBeUndefined();
    expect(store.get("abcd")).toBeUndefined();
  });

  it("sweeps exactly the blobs that are not kept", () => {
    const kept = store.put(a);
    const gone = store.put(b);
    expect(store.sweep(new Set([kept]))).toEqual(1);
    expect(store.get(gone)).toBeUndefined();
    expect(store.get(kept)?.equals(a)).toBe(true);
    expect(store.sweep(new Set([kept]))).toEqual(0);
  });
});

describe("FileBlobStore layout", () => {
  const a = Buffer.from("the first blob");

  it("stores a blob at <dir>/<first two hex digits>/<hash>, without temp files left over", () => {
    const dir = tempDir();
    const store = new FileBlobStore(dir);
    const hash = store.put(a);

    const file = join(dir, hash.slice(0, 2), hash);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(a)).toBe(true);
    expect(readdirSync(dir, { recursive: true }).filter((name) => name.includes(".tmp"))).toEqual(
      [],
    );
  });

  it("sweeps nothing from a missing folder", () => {
    const store = new FileBlobStore(join(tempDir(), "never-created"));
    expect(store.sweep(new Set())).toEqual(0);
  });
});
