import {
  ErrorCodes,
  JesutobitsError,
  PolicyPresetSchema,
  type PolicyPreset,
  type Project,
} from "@jesutobits/protocol";
import { newId } from "@jesutobits/shared";
import type { Database } from "../storage/database.js";

interface ProjectRow {
  id: string;
  canonical_path: string;
  display_name: string;
  kind: Project["kind"];
  created_by_jesutobits: number;
  trust: Project["trust"];
  last_opened_at: string | null;
  missing: number;
}

const COLUMNS =
  "id, canonical_path, display_name, kind, created_by_jesutobits, trust, last_opened_at, missing";

export interface NewProject {
  path: string;
  name: string;
  kind: Project["kind"];
  trust: Project["trust"];
  createdByJesutobits: boolean;
}

/** The `projects` table (DATA_AND_PERSISTENCE.md section 4): recent projects and trust. */
export class ProjectStore {
  constructor(private readonly db: Database) {}

  /** Most recently opened first; never-opened projects last. */
  list(): Project[] {
    return this.db
      .all<ProjectRow>(
        `SELECT ${COLUMNS} FROM projects ORDER BY last_opened_at IS NULL, last_opened_at DESC`,
      )
      .map(toProject);
  }

  get(id: string): Project | undefined {
    const row = this.db.get<ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE id = ?`, [id]);
    return row && toProject(row);
  }

  /** `path` must be canonical (FR-009). */
  findByPath(path: string): Project | undefined {
    const row = this.db.get<ProjectRow>(
      `SELECT ${COLUMNS} FROM projects WHERE canonical_path = ?`,
      [path],
    );
    return row && toProject(row);
  }

  require(id: string): Project {
    const project = this.get(id);
    if (!project) {
      throw new JesutobitsError(ErrorCodes.fsNotFound, "That project is not in the recent list", {
        details: { projectId: id },
      });
    }
    return project;
  }

  insert(project: NewProject): Project {
    this.writable();
    const id = newId("prj");
    this.db.run(
      `INSERT INTO projects (id, canonical_path, display_name, kind, created_by_jesutobits, trust)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        project.path,
        project.name,
        project.kind,
        project.createdByJesutobits ? 1 : 0,
        project.trust,
      ],
    );
    return this.require(id);
  }

  markOpened(id: string, at: Date): Project {
    this.writable();
    this.db.run("UPDATE projects SET last_opened_at = ?, missing = 0 WHERE id = ?", [
      at.toISOString(),
      id,
    ]);
    return this.require(id);
  }

  setTrust(id: string, trust: Project["trust"]): Project {
    this.writable();
    this.require(id);
    this.db.run("UPDATE projects SET trust = ? WHERE id = ?", [trust, id]);
    return this.require(id);
  }

  setMissing(id: string, missing: boolean): void {
    if (this.db.readOnly) return; // A display hint; not worth failing a read over.
    this.db.run("UPDATE projects SET missing = ? WHERE id = ?", [missing ? 1 : 0, id]);
  }

  relocate(id: string, path: string, name: string): Project {
    this.writable();
    this.db.run(
      "UPDATE projects SET canonical_path = ?, display_name = ?, missing = 0 WHERE id = ?",
      [path, name, id],
    );
    return this.require(id);
  }

  /** The project's policy preset (SECURITY.md section 4.2); `balanced` if unreadable. */
  policyPreset(id: string): PolicyPreset {
    const row = this.db.get<{ policy_preset: string }>(
      "SELECT policy_preset FROM projects WHERE id = ?",
      [id],
    );
    const parsed = PolicyPresetSchema.safeParse(row?.policy_preset);
    return parsed.success ? parsed.data : "balanced";
  }

  setPolicyPreset(id: string, preset: PolicyPreset): void {
    this.writable();
    this.require(id);
    this.db.run("UPDATE projects SET policy_preset = ? WHERE id = ?", [preset, id]);
  }

  remove(id: string): void {
    this.writable();
    this.db.run("DELETE FROM projects WHERE id = ?", [id]);
  }

  private writable(): void {
    if (this.db.readOnly) {
      throw new JesutobitsError(
        ErrorCodes.storageReadOnly,
        "Jesutobits' database is read-only right now, so this change cannot be saved.",
        { userAction: "open_settings" },
      );
    }
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    path: row.canonical_path,
    name: row.display_name,
    kind: row.kind,
    trust: row.trust,
    createdByJesutobits: row.created_by_jesutobits === 1,
    lastOpenedAt: row.last_opened_at,
    missing: row.missing === 1,
  };
}
