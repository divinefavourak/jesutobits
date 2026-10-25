import { DockLayout } from "./DockLayout";
import { TitleBar } from "./TitleBar";

/** The Workbench for the open project: title bar and dock layout. */
export function ProjectView() {
  return (
    <>
      <TitleBar />
      <DockLayout />
    </>
  );
}
