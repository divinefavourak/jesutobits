import { useEffect } from "react";
import { commandForKey, type Command } from "./commands";

/**
 * Runs a command when its shortcut is pressed anywhere in the window. Listens in the capture
 * phase so an editor cannot swallow Workbench shortcuts. While a modal dialog is open, only
 * the dialog handles keys.
 */
export function useKeybindings(commands: readonly Command[]): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const command = commandForKey(commands, event);
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void command.run();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [commands]);
}
