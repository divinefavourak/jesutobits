import { ModelInfoSchema, type ModelInfo } from "@jesutobits/protocol";
import type { Clock } from "../clock.js";
import type { Database } from "../storage/database.js";

/** DATA_AND_PERSISTENCE.md section 9. */
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Row {
  info_json: string;
  fetched_at: string;
}

export interface CachedModels {
  models: ModelInfo[];
  fetchedAt: string;
}

/**
 * The provider's model list in SQLite (`model_cache`), kept for 24 hours (ADR-0005).
 * Rows that no longer validate are skipped, so a schema change only costs a refetch.
 */
export class ModelCache {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** The cached list, or undefined when there is none or it is older than the TTL. */
  get(providerId: string): CachedModels | undefined {
    const rows = this.db.all<Row>(
      "SELECT info_json, fetched_at FROM model_cache WHERE provider_id = ? ORDER BY model_id",
      [providerId],
    );
    const first = rows[0];
    if (!first) return undefined;
    if (this.clock.now() - Date.parse(first.fetched_at) > MODEL_CACHE_TTL_MS) return undefined;
    const models = rows.flatMap((row) => {
      try {
        const parsed = ModelInfoSchema.safeParse(JSON.parse(row.info_json));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
    return { models, fetchedAt: first.fetched_at };
  }

  /** Replaces the provider's list. A read-only database keeps the old one, silently. */
  put(providerId: string, models: readonly ModelInfo[]): CachedModels {
    const fetchedAt = new Date(this.clock.now()).toISOString();
    if (!this.db.readOnly) {
      this.db.transaction(() => {
        this.db.run("DELETE FROM model_cache WHERE provider_id = ?", [providerId]);
        for (const model of models) {
          this.db.run(
            "INSERT INTO model_cache (provider_id, model_id, info_json, fetched_at) VALUES (?, ?, ?, ?)",
            [providerId, model.id, JSON.stringify(model), fetchedAt],
          );
        }
      });
    }
    return { models: [...models], fetchedAt };
  }
}
