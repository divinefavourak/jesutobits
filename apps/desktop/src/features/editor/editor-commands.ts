import type { Command } from "../../state/commands";
import type { Workbench } from "../../state/workbench-context";

/** File commands (UX_AND_INTERFACE.md section 9). */
export function editorCommands({ editor }: Pick<Workbench, "editor">): Command[] {
  const activeReady = () => {
    const { active, files } = editor.getState();
    return active !== null && files[active]?.status === "ready";
  };
  return [
    {
      id: "file.save",
      title: "command.file.save",
      keys: "Ctrl+S",
      enabled: activeReady,
      run: () => {
        const { active } = editor.getState();
        if (active) void editor.getState().save(active);
      },
    },
    {
      id: "file.saveAll",
      title: "command.file.saveAll",
      keys: "Ctrl+Alt+S",
      enabled: () => editor.getState().unsaved().length > 0,
      run: () => void editor.getState().saveAll(),
    },
    {
      id: "file.close",
      title: "command.file.close",
      enabled: () => editor.getState().active !== null,
      run: () => {
        const { active } = editor.getState();
        if (active) editor.getState().requestClose(active);
      },
    },
  ];
}
