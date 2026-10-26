import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { z } from "zod";
import type { PlanItem } from "@jesutobits/protocol";
import { nullLogger } from "@jesutobits/shared";
import {
  FileIndex,
  WorkspaceService,
  searchText as servicesSearchText,
} from "@jesutobits/services";
import { Checkpoints } from "../src/checkpoints/checkpoints.js";
import type { ProhibitedPlaces } from "../src/permissions/prohibited.js";
import { MemoryBlobStore } from "../src/storage/blob-store.js";
import { openStorage, type Storage } from "../src/storage/storage.js";
import type {
  ReadTracker,
  RiskAssessment,
  ToolContext,
  ToolResult,
} from "../src/tools/common/types.js";

/** Fixed harness IDs, as the PermissionBroker's and ToolRunner's tests use them. */
export const PROJECT_ID = "prj_1";
export const SESSION_ID = "ses_1";
export const TURN_ID = "trn_1";
const NOW = "2026-10-22T00:00:00.000Z";

/** What a caller needs to run one tool: no registry required. */
export interface SingleTool<I> {
  readonly input: z.ZodType<I>;
  execute(input: I, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult>;
}

/** What a caller needs to classify one tool. */
export interface ClassifiableTool<I> {
  readonly input: z.ZodType<I>;
  classify(input: I, ctx: ToolContext): Promise<RiskAssessment>;
}

export interface ToolTestProjectOptions {
  /** Overrides the default redact hook, which hides nothing. */
  redact?: ToolContext["redact"];
  /** Also inserts the session and turn rows the PermissionBroker and ToolRunner need. */
  withTurn?: boolean;
  /** Creates fixture files before the workspace and its index are opened. */
  seed?: (paths: { root: string }) => void;
}

export interface Question {
  id: string;
  question: string;
  options: string[];
}

export interface ToolTestProject {
  /** The canonical temp folder holding everything. */
  base: string;
  /** The project root, `base/project`. */
  root: string;
  /** A folder next to the project, for paths that leave it. */
  outside: string;
  /** A stand-in app-data dir; `ctx.prohibited.appDirs` names it (SECURITY.md section 4.3). */
  appDir: string;
  workspace: WorkspaceService;
  index: FileIndex;
  storage: Storage;
  /** The real turn checkpoints the tools write through (ADR-0012). */
  checkpoints: Checkpoints;
  ctx: ToolContext;
  /** What `setPlan` received, per call. */
  plans: PlanItem[][];
  /** What `askUser` received, with the ID each call returned. */
  questions: Question[];
  /** Parses with `tool.input` and executes against this project's context. */
  run<I>(tool: SingleTool<I>, input: unknown): Promise<ToolResult>;
  /** Writes a file on disk (folders created), before or after the tools run. */
  write(relative: string, content: string | Buffer): void;
  /** A file's exact bytes, for line-ending and BOM assertions. */
  readBytes(relative: string): Buffer;
  /** Rebuilds and awaits the quick-open index after tests create files. */
  refreshIndex(): Promise<void>;
  dispose(): void;
}

/** What the harness's ToolRunner does before executing: validate, then run. */
export async function runTool<I>(
  tool: SingleTool<I>,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = tool.input.parse(input);
  return tool.execute(parsed, ctx, new AbortController().signal);
}

/** Parses an input with a tool's schema, so `classify` sees what the runner gives it. */
export async function classifyInput<I>(
  tool: ClassifiableTool<I>,
  input: unknown,
  ctx: ToolContext,
): Promise<RiskAssessment> {
  const parsed = tool.input.parse(input);
  return tool.classify(parsed, ctx);
}

/**
 * A real `ToolContext` over a real temp project (AGENT_HARNESS.md section 5.1): the real
 * WorkspaceService and file index, an in-memory read tracker, real checkpoints over the
 * in-memory storage, and text search through the services' JS fallback.
 */
export async function openToolTestProject(
  options: ToolTestProjectOptions = {},
): Promise<ToolTestProject> {
  // Canonical, so CI runners' 8.3 temp paths (RUNNER~1) match what WorkspaceService resolves
  // (compare checkpoints.test.ts).
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "jesutobits-tools-")));
  const root = path.join(base, "project");
  const appDir = path.join(base, "app-data");
  const outside = path.join(base, "outside");
  for (const directory of [root, appDir, outside]) mkdirSync(directory);
  options.seed?.({ root });

  const workspace = await WorkspaceService.open({ root, log: nullLogger });
  const storage = openStorage({ dir: undefined, log: nullLogger });
  // The checkpoints table demands a project row (compare checkpoints.test.ts).
  storage.db.run(
    "INSERT INTO projects (id, canonical_path, display_name, kind, trust) VALUES (?, ?, 'p', 'project', 'trusted')",
    [PROJECT_ID, root],
  );
  if (options.withTurn === true) {
    storage.db.run(
      `INSERT INTO sessions (id, project_id, title, provider_id, model_id, created_at, updated_at)
       VALUES (?, ?, 'A session', 'scripted', 'm', ?, ?)`,
      [SESSION_ID, PROJECT_ID, NOW, NOW],
    );
    storage.db.run(
      `INSERT INTO turns (id, session_id, mode, model_id, state, started_at, prompt_version)
       VALUES (?, ?, 'agent', 'm', 'thinking', ?, 'v')`,
      [TURN_ID, SESSION_ID, NOW],
    );
  }
  const checkpoints = new Checkpoints(storage.db, new MemoryBlobStore());

  const index = FileIndex.build(workspace, nullLogger);
  await index.ready;

  const readsMap = new Map<string, string>();
  const reads: ReadTracker = {
    get: (relative) => readsMap.get(relative),
    set: (relative, hash) => readsMap.set(relative, hash),
    forget: (relative) => {
      readsMap.delete(relative);
    },
  };

  const plans: PlanItem[][] = [];
  const questions: Question[] = [];
  const prohibited: ProhibitedPlaces = { appDirs: [appDir], home: undefined };
  const ctx: ToolContext = {
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    callId: "call_1",
    workspace,
    prohibited,
    files: index,
    reads,
    checkpoints: {
      before: async (input) => checkpoints.before(workspace, PROJECT_ID, TURN_ID, input),
      after: (relative, after) => checkpoints.after(TURN_ID, relative, after),
    },
    redactValues: false,
    redact: options.redact ?? ((text) => ({ text, hidden: 0 })),
    setPlan: (items) => {
      plans.push(items);
    },
    askUser: (question, askedOptions) => {
      const questionId = `q_${questions.length + 1}`;
      questions.push({ id: questionId, question, options: [...askedOptions] });
      return questionId;
    },
    searchText: async (query, signal) => {
      const outcome = await servicesSearchText(
        {
          query: query.query,
          isRegex: query.isRegex,
          caseSensitive: query.caseSensitive,
          limit: query.limit,
          ...(query.glob !== undefined && { glob: query.glob }),
        },
        { workspace, ripgrep: undefined, files: () => index.list(), signal },
      );
      return { matches: outcome.matches, truncated: outcome.truncated };
    },
  };

  return {
    base,
    root,
    outside,
    appDir,
    workspace,
    index,
    storage,
    checkpoints,
    ctx,
    plans,
    questions,
    run: (tool, input) => runTool(tool, input, ctx),
    write: (relative, content) => {
      const target = path.join(root, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
    readBytes: (relative) => readFileSync(path.join(root, ...relative.split("/"))),
    refreshIndex: async () => {
      index.rebuild();
      await index.ready;
    },
    dispose: () => {
      storage.close();
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
