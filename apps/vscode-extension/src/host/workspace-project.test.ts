import { join } from "node:path";
import type { Project } from "@jesutobits/protocol";
import { describe, expect, it } from "vitest";
import { syncProject, type RuntimeCall } from "./workspace-project.js";

const ID = `prj_${"0123456789ABCDEFGHJKMNPQRSTVWXYZ".slice(0, 26)}`;
const FOLDER = join("/", "work", "demo");

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: ID,
    path: FOLDER,
    name: "demo",
    kind: "project",
    trust: "unknown",
    createdByJesutobits: false,
    lastOpenedAt: null,
    missing: false,
    ...overrides,
  };
}

function fakeRuntime(opened: Project) {
  const calls: Array<[string, unknown]> = [];
  const call: RuntimeCall = async (method, params) => {
    calls.push([method, params]);
    if (method === "projects.open") {
      return { project: opened, needsTrustDecision: opened.trust === "unknown" };
    }
    if (method === "projects.setTrust") {
      const { trust } = params as { id: string; trust: "trusted" | "restricted" };
      return { project: { ...opened, trust } };
    }
    if (method === "projects.close") return {};
    throw new Error(`the test did not expect ${method}`);
  };
  return { calls, call };
}

describe("syncProject", () => {
  it("closes the project when no folder is open", async () => {
    const { calls, call } = fakeRuntime(project());

    expect(await syncProject(call, undefined, true)).toBeUndefined();

    expect(calls).toEqual([["projects.close", {}]]);
  });

  it("opens the folder and leaves its trust alone when VS Code agrees", async () => {
    const opened = project({ trust: "trusted" });
    const { calls, call } = fakeRuntime(opened);

    expect(await syncProject(call, FOLDER, true)).toEqual(opened);

    expect(calls).toEqual([["projects.open", { path: FOLDER }]]);
  });

  it("trusts a new project when VS Code trusts the folder", async () => {
    const { calls, call } = fakeRuntime(project({ trust: "unknown" }));

    const synced = await syncProject(call, FOLDER, true);

    expect(synced?.trust).toBe("trusted");
    expect(calls).toEqual([
      ["projects.open", { path: FOLDER }],
      ["projects.setTrust", { id: ID, trust: "trusted" }],
    ]);
  });

  it("restricts a project when VS Code does not trust the folder", async () => {
    const { calls, call } = fakeRuntime(project({ trust: "trusted" }));

    const synced = await syncProject(call, FOLDER, false);

    expect(synced?.trust).toBe("restricted");
    expect(calls).toEqual([
      ["projects.open", { path: FOLDER }],
      ["projects.setTrust", { id: ID, trust: "restricted" }],
    ]);
  });
});
