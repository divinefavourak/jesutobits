// VS Code's open folder is the Jesutobits project (ADR-0015). Workspace Trust is the trust
// decision (FR-006): the runtime's project trust follows it and is never asked separately.
// One project at a time: in a multi-root workspace, the first folder.
import { ProjectSchema, type Project } from "@jesutobits/protocol";

export type RuntimeCall = (method: string, params: unknown) => Promise<unknown>;

/** Opens `folder` as the active project (or closes it), with trust matching VS Code's. */
export async function syncProject(
  call: RuntimeCall,
  folder: string | undefined,
  trusted: boolean,
): Promise<Project | undefined> {
  if (folder === undefined) {
    await call("projects.close", {});
    return undefined;
  }
  const opened = ProjectSchema.parse(
    ((await call("projects.open", { path: folder })) as { project: unknown }).project,
  );
  const trust = trusted ? "trusted" : "restricted";
  if (opened.trust === trust) return opened;
  return ProjectSchema.parse(
    ((await call("projects.setTrust", { id: opened.id, trust })) as { project: unknown }).project,
  );
}
