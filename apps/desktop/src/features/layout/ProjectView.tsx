import { TitleBar } from "./TitleBar";

/** The Workbench for the open project. Step 14 fills the body with the dock layout. */
export function ProjectView() {
  return (
    <>
      <TitleBar />
      <main className="flex-1 overflow-hidden" />
    </>
  );
}
