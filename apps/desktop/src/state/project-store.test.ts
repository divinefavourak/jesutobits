import { ErrorCodes, JesutobitsError, type Project } from "@jesutobits/protocol";
import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../host-bridge";
import { createProjectStore, type ProjectDetection } from "./project-store";

const project = (overrides: Partial<Project> = {}): Project => ({
  id: "prj_01JABCDEFGHJKMNPQRSTVWXYZ0",
  path: "c:\\work\\habits",
  name: "habits",
  kind: "project",
  trust: "unknown",
  createdByJesutobits: false,
  lastOpenedAt: "2026-10-21T10:00:00.000Z",
  missing: false,
  ...overrides,
});

const detection: ProjectDetection = {
  packageManager: null,
  scripts: {},
  previewStrategy: "none",
  framework: null,
  styling: null,
  visualEditing: { level: "unavailable", reason: "There is no package.json in this folder." },
};

/** A mock whose runtime has one project and records the calls it gets. */
function setup() {
  const bridge = new MockHostBridge();
  const calls: Array<{ method: string; params: unknown }> = [];
  let current = project();
  let folderExists = true;
  bridge.handle("projects.list", () => ({ projects: [current] }));
  bridge.handle("projects.open", (params) => {
    calls.push({ method: "projects.open", params });
    if (!folderExists) throw new JesutobitsError(ErrorCodes.fsNotFound, "The folder was not found");
    return { project: current, needsTrustDecision: current.trust === "unknown" };
  });
  bridge.handle("projects.detect", () => detection);
  bridge.handle("projects.setTrust", (params) => {
    current = { ...current, trust: params.trust };
    return { project: current };
  });
  bridge.handle("projects.close", () => {
    calls.push({ method: "projects.close", params: {} });
    return {};
  });
  const store = createProjectStore(bridge);
  return { bridge, store, calls, removeFolder: () => (folderExists = false) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("project store", () => {
  it("lists recent projects once the runtime is ready", async () => {
    const { store } = setup();
    await settle();
    expect(store.getState().recent?.map((p) => p.name)).toEqual(["habits"]);
  });

  it("opens a folder, asks for trust and loads what kind of project it is (J-05)", async () => {
    const { store } = setup();
    await store.getState().openFolder("C:\\work\\habits");
    await settle();

    const state = store.getState();
    expect(state.active?.name).toBe("habits");
    expect(state.needsTrustDecision).toBe(true);
    expect(state.generation).toBe(1);
    expect(state.detection?.visualEditing.level).toBe("unavailable");
    expect(state.busy).toBe(false);
  });

  it("stores the trust decision and closes the prompt (FR-006)", async () => {
    const { store } = setup();
    await store.getState().openFolder("C:\\work\\habits");
    await store.getState().setTrust("restricted");

    expect(store.getState().active?.trust).toBe("restricted");
    expect(store.getState().needsTrustDecision).toBe(false);
  });

  it("records a failed action in words and stays usable", async () => {
    const { store, removeFolder } = setup();
    removeFolder();
    await store.getState().openFolder("C:\\work\\habits");

    expect(store.getState().active).toBeNull();
    expect(store.getState().error).toEqual({
      action: "open",
      message: "The folder was not found",
    });
    expect(store.getState().busy).toBe(false);
  });

  it("closes the project and goes back to the recent list", async () => {
    const { store, calls } = setup();
    await store.getState().openFolder("C:\\work\\habits");
    await store.getState().close();

    expect(store.getState().active).toBeNull();
    expect(calls.at(-1)?.method).toBe("projects.close");
  });

  it("reopens the project by ID when a restarted runtime is ready", async () => {
    const { bridge, store, calls } = setup();
    await store.getState().openFolder("C:\\work\\habits");
    await store.getState().setTrust("trusted");

    bridge.setStatus({ status: "restarting" });
    bridge.setStatus({ status: "ready" });
    await settle();

    expect(calls.at(-1)).toEqual({
      method: "projects.open",
      params: { id: "prj_01JABCDEFGHJKMNPQRSTVWXYZ0" },
    });
    expect(store.getState().active?.trust).toBe("trusted");
    expect(store.getState().generation).toBe(2);
  });

  it("goes back to the start screen when the folder is gone after a restart", async () => {
    const { bridge, store, removeFolder } = setup();
    await store.getState().openFolder("C:\\work\\habits");
    removeFolder();

    bridge.setStatus({ status: "failed", detail: "crashed" });
    bridge.setStatus({ status: "starting" });
    bridge.setStatus({ status: "ready" });
    await settle();

    expect(store.getState().active).toBeNull();
    expect(store.getState().error?.action).toBe("open");
  });

  it("does not reopen when a slow runtime recovers (same process)", async () => {
    const { bridge, store, calls } = setup();
    await store.getState().openFolder("C:\\work\\habits");
    const opens = calls.length;

    bridge.setStatus({ status: "degraded" });
    bridge.setStatus({ status: "ready" });
    await settle();

    expect(calls.length).toBe(opens);
    expect(store.getState().generation).toBe(1);
  });
});
