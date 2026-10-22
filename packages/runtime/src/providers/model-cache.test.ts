import type { ModelInfo } from "@jesutobits/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../clock.js";
import { createLogger } from "../log/logger.js";
import { SecretRegistry } from "../log/secret-registry.js";
import { type Storage, openStorage } from "../storage/storage.js";
import { MODEL_CACHE_TTL_MS, ModelCache } from "./model-cache.js";

/** Writes nothing: the cache's behaviour is what these tests read. */
const log = createLogger({
  write: () => undefined,
  level: "error",
  secrets: new SecretRegistry(),
});

const opened: Storage[] = [];

/** An in-memory database with a clock that only moves when a test moves it. */
function setup(): { clock: FakeClock; storage: Storage; cache: ModelCache } {
  const clock = new FakeClock();
  const storage = openStorage({ dir: undefined, log });
  opened.push(storage);
  return { clock, storage, cache: new ModelCache(storage.db, clock) };
}

afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
});

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    displayName: id,
    contextWindow: 128_000,
    capabilities: {
      tools: true,
      toolChoice: true,
      parallelToolCalls: false,
      vision: false,
      structuredOutputs: false,
      reasoning: false,
    },
    source: "provider",
    ...extra,
  };
}

const ids = (models: ModelInfo[] | undefined): string[] => (models ?? []).map((entry) => entry.id);

describe("ModelCache", () => {
  it("returns nothing for a provider it has never seen", () => {
    const { cache } = setup();
    expect(cache.get("openrouter")).toBeUndefined();
  });

  it("returns a stored list with the time it was fetched", () => {
    const { cache, clock } = setup();
    const models = [model("b/model"), model("a/model")];

    expect(cache.put("openrouter", models)).toEqual({
      models,
      fetchedAt: new Date(clock.now()).toISOString(),
    });
    // Read back in model id order, which is how the rows are queried.
    expect(cache.get("openrouter")).toEqual({
      models: [model("a/model"), model("b/model")],
      fetchedAt: "2026-10-22T10:00:00.000Z",
    });
  });

  it("forgets a list once it is older than 24 hours", async () => {
    const { cache, clock } = setup();
    cache.put("openrouter", [model("a/model")]);

    await clock.advance(MODEL_CACHE_TTL_MS);
    expect(ids(cache.get("openrouter")?.models)).toEqual(["a/model"]);

    await clock.advance(1);
    expect(cache.get("openrouter")).toBeUndefined();
  });

  it("replaces the previous list on a second put", () => {
    const { cache } = setup();
    cache.put("openrouter", [model("a/model"), model("b/model")]);
    cache.put("openrouter", [model("b/model")]);

    expect(ids(cache.get("openrouter")?.models)).toEqual(["b/model"]);
  });

  it("keeps each provider's list separate", () => {
    const { cache } = setup();
    cache.put("openrouter", [model("a/model")]);
    cache.put("other", [model("z/model")]);

    expect(ids(cache.get("openrouter")?.models)).toEqual(["a/model"]);
    expect(ids(cache.get("other")?.models)).toEqual(["z/model"]);
    expect(cache.get("third")).toBeUndefined();
  });

  it("skips a row whose info_json no longer validates", () => {
    const { cache, storage, clock } = setup();
    cache.put("openrouter", [model("a/model")]);
    const fetchedAt = new Date(clock.now()).toISOString();
    // A row written before the schema required contextWindow and capabilities,
    // and one that is not JSON at all.
    storage.db.run(
      "INSERT INTO model_cache (provider_id, model_id, info_json, fetched_at) VALUES (?, ?, ?, ?)",
      [
        "openrouter",
        "legacy/model",
        JSON.stringify({ id: "legacy/model", displayName: "Legacy" }),
        fetchedAt,
      ],
    );
    storage.db.run(
      "INSERT INTO model_cache (provider_id, model_id, info_json, fetched_at) VALUES (?, ?, ?, ?)",
      ["openrouter", "unreadable/model", "{not json", fetchedAt],
    );

    expect(ids(cache.get("openrouter")?.models)).toEqual(["a/model"]);
  });

  it("returns an empty list when every row is unusable", () => {
    const { cache, storage, clock } = setup();
    storage.db.run(
      "INSERT INTO model_cache (provider_id, model_id, info_json, fetched_at) VALUES (?, ?, ?, ?)",
      [
        "openrouter",
        "legacy/model",
        JSON.stringify({ id: "legacy/model" }),
        new Date(clock.now()).toISOString(),
      ],
    );

    expect(cache.get("openrouter")).toEqual({
      models: [],
      fetchedAt: new Date(clock.now()).toISOString(),
    });
  });
});
