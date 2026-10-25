import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A modal dialog on the native `<dialog>` element, which traps focus, makes the rest of the
 * page inert and returns focus to where it was when it closes (NFR-011). Esc calls
 * `onCancel`; without one, Esc does nothing and the user must pick a button. `focusSelf`
 * focuses the dialog instead of its first button, so Enter does nothing until the user
 * chooses (decisions such as trust or approval, UX_AND_INTERFACE.md section 6.4).
 */
export function Dialog({
  open,
  title,
  description,
  onCancel,
  focusSelf = false,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onCancel?: () => void;
  focusSelf?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      if (focusSelf) dialog.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, focusSelf]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      tabIndex={focusSelf ? -1 : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onCancel?.();
      }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface-raised p-6 text-text shadow-lg backdrop:bg-canvas/70"
    >
      {open && (
        <>
          <h2 id={titleId} className="mb-2 text-lg font-semibold">
            {title}
          </h2>
          {description && (
            <div id={descriptionId} className="mb-4 flex flex-col gap-2 text-text-muted">
              {description}
            </div>
          )}
          {children}
        </>
      )}
    </dialog>
  );
}
