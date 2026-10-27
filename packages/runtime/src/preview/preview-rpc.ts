import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import { applyClassEdit, parseLoc } from "@jesutobits/services";
import type { Projects } from "../projects/projects.js";
import type { RpcServer } from "../rpc/server.js";
import type { PreviewManager } from "./preview-manager.js";

/**
 * `preview.*` and `visual.setClasses` (ROADMAP Phases 4 and 5). Every one of them comes from
 * the user's own action in Jesutobits' UI; the preview's bridge cannot reach them (invariant 8).
 */
export function registerPreview(server: RpcServer, projects: Projects, previews: PreviewManager) {
  const active = () => {
    const context = projects.activeContext();
    if (!context) throw new JesutobitsError(ErrorCodes.fsNoProject, "No project is open");
    return context;
  };

  server.register("preview.start", async () => {
    const { project, workspace, index } = active();
    return previews.start({
      id: project.id,
      root: project.path,
      trusted: project.trust === "trusted",
      workspace,
      index,
    });
  });
  server.register("preview.stop", () => previews.stop());
  server.register("preview.get", () => previews.status(projects.activeProject?.id));

  server.register("visual.setClasses", async (params) => {
    const { workspace } = active();
    const { file, loc } = parseLoc(params.loc);
    const source = await workspace.readText(file);
    const edited = applyClassEdit(source.text, {
      typescript: /\.tsx$/.test(file),
      loc,
      edit: { remove: params.remove, add: params.add },
    });
    if (edited.code === source.text) return { path: source.path, changed: false };
    // Fails with fs.conflict if the file changed since it was read, so nothing is overwritten.
    await workspace.writeText(file, edited.code, { expectedHash: source.hash });
    return { path: source.path, changed: true };
  });
}
