import { z } from "zod";
import { defineMethod } from "./define.js";

const ProjectIdSchema = z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/, "Expected a prj_ ID");

export const ProjectKindSchema = z.enum(["project", "general"]);
/** `unknown` until the user decides; Restricted mode is enforced from Phase 3 (FR-006). */
export const ProjectTrustSchema = z.enum(["trusted", "restricted", "unknown"]);

/** A recent project (FR-004, DATA_AND_PERSISTENCE.md section 3). */
export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  /** Canonical path: links resolved, lower-case drive letter on Windows (FR-009). */
  path: z.string().min(1),
  name: z.string().min(1),
  kind: ProjectKindSchema,
  trust: ProjectTrustSchema,
  createdByJesutobits: z.boolean(),
  lastOpenedAt: z.iso.datetime().nullable(),
  /** The folder was not found the last time Jesutobits looked (Locate, Remove). */
  missing: z.boolean(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const projectsList = defineMethod({
  name: "projects.list",
  description: "Recent projects, most recently opened first, with missing folders marked.",
  callers: ["workbench"],
  params: z.object({}),
  result: z.object({ projects: z.array(ProjectSchema) }),
});

/**
 * Makes a folder the active project (FR-003, J-05). Opening writes nothing into the folder.
 * A folder Jesutobits has not seen before gets trust `unknown`, and the Workbench asks.
 */
export const projectsOpen = defineMethod({
  name: "projects.open",
  description: "Open a folder, or a recent project by ID, as the active project.",
  callers: ["workbench"],
  params: z.union([
    z.object({ path: z.string().min(1) }).strict(),
    z.object({ id: ProjectIdSchema }).strict(),
  ]),
  result: z.object({
    project: ProjectSchema,
    /** The trust prompt is needed (FR-006). */
    needsTrustDecision: z.boolean(),
  }),
});

/** Creates a project from a built-in template; Phase 1 has Empty and General workspace. */
export const projectsCreate = defineMethod({
  name: "projects.create",
  description: "Create a new project folder from a template and open it.",
  callers: ["workbench"],
  params: z.object({
    /** Usually the default workspace folder from settings (FR-002). */
    parentDir: z.string().min(1),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^<>:"/\\|?*]+$/, 'A folder name cannot contain < > : " / \\ | ? *'),
    template: z.enum(["empty", "general"]),
  }),
  result: z.object({ project: ProjectSchema }),
});

export const projectsClose = defineMethod({
  name: "projects.close",
  description: "Close the active project (back to the start screen).",
  callers: ["workbench"],
  params: z.object({}),
  result: z.object({}),
});

export const projectsSetTrust = defineMethod({
  name: "projects.setTrust",
  description: "Record the user's trust decision for a project (FR-006).",
  callers: ["workbench"],
  params: z.object({ id: ProjectIdSchema, trust: z.enum(["trusted", "restricted"]) }),
  result: z.object({ project: ProjectSchema }),
});

/** Forgets a recent project. Never touches the folder. */
export const projectsRemove = defineMethod({
  name: "projects.remove",
  description: "Remove a project from the recent list; the folder is left alone.",
  callers: ["workbench"],
  params: z.object({ id: ProjectIdSchema }),
  result: z.object({}),
});

/** Points a missing project at its new folder (FR-004 Locate), keeping its ID and settings. */
export const projectsLocate = defineMethod({
  name: "projects.locate",
  description: "Point a recent project at the folder it moved to.",
  callers: ["workbench"],
  params: z.object({ id: ProjectIdSchema, path: z.string().min(1) }),
  result: z.object({ project: ProjectSchema }),
});
