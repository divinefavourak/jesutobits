import {
  ErrorCodes,
  JesutobitsError,
  isFinalTurnState,
  type JesutobitsErrorData,
  type RuntimeEventBase,
  type Session,
  type TurnMode,
  type TurnState,
  type TurnSummary,
} from "@jesutobits/protocol";
import { newId } from "@jesutobits/shared";
import type { ChatMessage } from "../providers/types.js";
import type { Database } from "../storage/database.js";

/** What the model saw, with what the harness needs to elide it later (AGENT_HARNESS 4.4). */
export interface StoredMessage {
  id: string;
  turnId: string | null;
  seq: number;
  /** `summary` replaces everything before it when the context is built. */
  role: "user" | "assistant" | "tool" | "summary";
  message: ChatMessage;
  /** For tool results: which tool, and its one-line summary for the elision stub. */
  tool?: { name: string; summary: string };
  /** The model step that produced an assistant message or a tool result. */
  step?: number;
  createdAt: string;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  mode: TurnMode;
  modelId: string;
  retryOf: string | null;
  state: TurnState;
  startedAt: string;
  endedAt: string | null;
  summary: TurnSummary | null;
  error: JesutobitsErrorData | null;
}

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  provider_id: string;
  model_id: string;
  created_at: string;
  updated_at: string;
  archived: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

interface TurnRow {
  id: string;
  session_id: string;
  mode: TurnMode;
  model_id: string;
  retry_of: string | null;
  state: TurnState;
  started_at: string;
  ended_at: string | null;
  summary_json: string | null;
  error_json: string | null;
}

const SESSION_COLUMNS =
  "id, project_id, title, provider_id, model_id, created_at, updated_at, archived, cost_usd, input_tokens, output_tokens";
const TURN_COLUMNS =
  "id, session_id, mode, model_id, retry_of, state, started_at, ended_at, summary_json, error_json";

/** One page of `sessions.history` stays well under the 4 MiB message limit (ADR-0003). */
const MAX_HISTORY_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * Sessions, turns, messages and stored events in SQLite (DATA_AND_PERSISTENCE.md section 4).
 * Every query is scoped by project, so one project's session IDs mean nothing in another.
 */
export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
    /**
     * Masks secrets in what is stored (the SecretRegistry's `maskValue`): a key pasted into
     * a message must not reach the database (NFR-007, DATA_AND_PERSISTENCE.md section 4).
     */
    private readonly mask: (value: unknown) => unknown = (value) => value,
  ) {}

  // Sessions.

  create(
    projectId: string,
    init: { providerId: string; modelId: string; title?: string },
  ): Session {
    this.writable();
    const id = newId("ses");
    const at = this.now().toISOString();
    this.db.run(
      `INSERT INTO sessions (id, project_id, title, provider_id, model_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, init.title ?? "New session", init.providerId, init.modelId, at, at],
    );
    return this.require(projectId, id);
  }

  list(projectId: string, includeArchived: boolean): Session[] {
    return this.db
      .all<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE project_id = ? ${includeArchived ? "" : "AND archived = 0"}
         ORDER BY updated_at DESC, id DESC`,
        [projectId],
      )
      .map(toSession);
  }

  get(projectId: string, id: string): Session | undefined {
    const row = this.db.get<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ? AND project_id = ?`,
      [id, projectId],
    );
    return row && toSession(row);
  }

  require(projectId: string, id: string): Session {
    const session = this.get(projectId, id);
    if (!session) {
      throw new JesutobitsError(ErrorCodes.runtimeSessionNotFound, "That session does not exist", {
        details: { sessionId: id },
      });
    }
    return session;
  }

  update(
    projectId: string,
    id: string,
    patch: { title?: string; archived?: boolean; modelId?: string },
  ): Session {
    this.writable();
    this.require(projectId, id);
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number> = [this.now().toISOString()];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.archived !== undefined) {
      sets.push("archived = ?");
      values.push(patch.archived ? 1 : 0);
    }
    if (patch.modelId !== undefined) {
      sets.push("model_id = ?");
      values.push(patch.modelId);
    }
    this.db.run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
    return this.require(projectId, id);
  }

  /** Cascades to turns, messages, tool calls, permissions and events (migration 0002). */
  delete(projectId: string, id: string): void {
    this.writable();
    this.require(projectId, id);
    this.db.transaction(() => {
      // Checkpoint rows are keyed by turn, not by session: remove them with their turns.
      this.db.run(
        "DELETE FROM checkpoints WHERE owner_id IN (SELECT id FROM turns WHERE session_id = ?)",
        [id],
      );
      this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    });
  }

  addUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number; costUsd: number },
  ): void {
    if (this.db.readOnly) return;
    this.db.run(
      `UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?`,
      [usage.inputTokens, usage.outputTokens, usage.costUsd, this.now().toISOString(), id],
    );
  }

  // Turns.

  createTurn(init: {
    sessionId: string;
    mode: TurnMode;
    modelId: string;
    promptVersion: string;
    retryOf?: string;
  }): TurnRecord {
    this.writable();
    const id = newId("trn");
    const at = this.now().toISOString();
    this.db.run(
      `INSERT INTO turns (id, session_id, mode, model_id, retry_of, state, started_at, prompt_version)
       VALUES (?, ?, ?, ?, ?, 'understanding', ?, ?)`,
      [id, init.sessionId, init.mode, init.modelId, init.retryOf ?? null, at, init.promptVersion],
    );
    this.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [at, init.sessionId]);
    return this.requireTurn(id);
  }

  turn(id: string): TurnRecord | undefined {
    const row = this.db.get<TurnRow>(`SELECT ${TURN_COLUMNS} FROM turns WHERE id = ?`, [id]);
    return row && toTurn(row);
  }

  requireTurn(id: string): TurnRecord {
    const turn = this.turn(id);
    if (!turn) {
      throw new JesutobitsError(ErrorCodes.runtimeTurnNotFound, "That turn does not exist", {
        details: { turnId: id },
      });
    }
    return turn;
  }

  /** The session's project, for checking a turn belongs to the active project. */
  projectOfTurn(turnId: string): string | undefined {
    return this.db.get<{ project_id: string }>(
      "SELECT s.project_id FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?",
      [turnId],
    )?.project_id;
  }

  setTurnState(id: string, state: TurnState): void {
    if (this.db.readOnly) return;
    this.db.run("UPDATE turns SET state = ? WHERE id = ?", [state, id]);
  }

  finishTurn(
    id: string,
    end: {
      state: TurnState;
      reason: string;
      summary: TurnSummary;
      error?: JesutobitsErrorData;
    },
  ): void {
    if (this.db.readOnly) return;
    this.db.run(
      `UPDATE turns SET state = ?, ended_at = ?, end_reason = ?, summary_json = ?, error_json = ?,
         verification_label = ?, cost_usd = ? WHERE id = ?`,
      [
        end.state,
        this.now().toISOString(),
        end.reason,
        JSON.stringify(end.summary),
        end.error ? JSON.stringify(end.error) : null,
        end.summary.verification,
        end.summary.costUsd,
        id,
      ],
    );
  }

  /** The turn running in the session, if any (one at a time). */
  liveTurn(sessionId: string): TurnRecord | undefined {
    return this.db
      .all<TurnRow>(
        `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC`,
        [sessionId],
      )
      .map(toTurn)
      .find((turn) => !isFinalTurnState(turn.state));
  }

  /**
   * At startup: every turn still live belonged to the runtime that died (AGENT_HARNESS.md
   * section 3.2). They become `interrupted`, and pending approvals are withdrawn so they can
   * never be answered (SECURITY.md section 4.5). Returns them for their stored events.
   */
  interruptLiveTurns(): Array<{ turnId: string; sessionId: string; projectId: string }> {
    if (this.db.readOnly) return [];
    const live = this.db.all<{
      id: string;
      session_id: string;
      project_id: string;
      state: TurnState;
    }>(
      `SELECT t.id, t.session_id, s.project_id, t.state FROM turns t JOIN sessions s ON s.id = t.session_id
       WHERE t.ended_at IS NULL`,
    );
    const interrupted = live.filter((turn) => !isFinalTurnState(turn.state));
    const at = this.now().toISOString();
    this.db.transaction(() => {
      for (const turn of interrupted) {
        this.db.run(
          "UPDATE turns SET state = 'interrupted', ended_at = ?, end_reason = 'interrupted' WHERE id = ?",
          [at, turn.id],
        );
        this.db.run(
          "UPDATE permission_requests SET decision = 'withdrawn', decided_at = ? WHERE turn_id = ? AND decision IS NULL",
          [at, turn.id],
        );
      }
    });
    return interrupted.map((turn) => ({
      turnId: turn.id,
      sessionId: turn.session_id,
      projectId: turn.project_id,
    }));
  }

  // Messages (what the model sees).

  appendMessage(
    sessionId: string,
    entry: Omit<StoredMessage, "id" | "seq" | "createdAt">,
  ): StoredMessage {
    this.writable();
    const seq =
      (this.db.get<{ seq: number | null }>(
        "SELECT MAX(seq) AS seq FROM messages WHERE session_id = ?",
        [sessionId],
      )?.seq ?? -1) + 1;
    const id = newId("msg");
    const createdAt = this.now().toISOString();
    const content = {
      message: entry.message,
      ...(entry.tool && { tool: entry.tool }),
      ...(entry.step !== undefined && { step: entry.step }),
    };
    this.db.run(
      `INSERT INTO messages (id, session_id, turn_id, seq, role, content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, sessionId, entry.turnId, seq, entry.role, JSON.stringify(this.mask(content)), createdAt],
    );
    return { ...entry, id, seq, createdAt };
  }

  messages(sessionId: string): StoredMessage[] {
    return this.db
      .all<{
        id: string;
        turn_id: string | null;
        seq: number;
        role: StoredMessage["role"];
        content_json: string;
        created_at: string;
      }>(
        "SELECT id, turn_id, seq, role, content_json, created_at FROM messages WHERE session_id = ? ORDER BY seq",
        [sessionId],
      )
      .map((row) => {
        const content = JSON.parse(row.content_json) as Pick<
          StoredMessage,
          "message" | "tool" | "step"
        >;
        return {
          id: row.id,
          turnId: row.turn_id,
          seq: row.seq,
          role: row.role,
          message: content.message,
          ...(content.tool && { tool: content.tool }),
          ...(content.step !== undefined && { step: content.step }),
          createdAt: row.created_at,
        };
      });
  }

  // Stored events (what the Workbench shows; `sessions.history`).

  appendEvent(event: RuntimeEventBase & Record<string, unknown>): void {
    if (this.db.readOnly || !event.sessionId) return;
    this.db.run(
      "INSERT INTO events (session_id, turn_id, type, payload_json, ts) VALUES (?, ?, ?, ?, ?)",
      [
        event.sessionId,
        event.turnId ?? null,
        event.type,
        JSON.stringify(this.mask(event)),
        event.ts,
      ],
    );
  }

  history(
    sessionId: string,
    after: number | undefined,
    limit: number,
  ): { events: Array<RuntimeEventBase & Record<string, unknown>>; next: number | null } {
    const rows = this.db.all<{ id: number; payload_json: string }>(
      "SELECT id, payload_json FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?",
      [sessionId, after ?? 0, limit + 1],
    );
    const events: Array<RuntimeEventBase & Record<string, unknown>> = [];
    let bytes = 0;
    let lastId: number | undefined;
    for (const row of rows.slice(0, limit)) {
      bytes += row.payload_json.length;
      if (events.length > 0 && bytes > MAX_HISTORY_PAGE_BYTES) {
        return { events, next: lastId ?? null };
      }
      events.push(JSON.parse(row.payload_json) as RuntimeEventBase & Record<string, unknown>);
      lastId = row.id;
    }
    return { events, next: rows.length > limit && lastId !== undefined ? lastId : null };
  }

  private writable(): void {
    if (this.db.readOnly) {
      throw new JesutobitsError(
        ErrorCodes.storageReadOnly,
        "Jesutobits' database is read-only right now, so the conversation cannot be saved.",
        { userAction: "open_settings" },
      );
    }
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id as Session["id"],
    projectId: row.project_id,
    title: row.title,
    providerId: row.provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  };
}

function toTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    mode: row.mode,
    modelId: row.model_id,
    retryOf: row.retry_of,
    state: row.state,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary_json ? (JSON.parse(row.summary_json) as TurnSummary) : null,
    error: row.error_json ? (JSON.parse(row.error_json) as JesutobitsErrorData) : null,
  };
}
