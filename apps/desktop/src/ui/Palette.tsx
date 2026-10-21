import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * A searchable list in a modal dialog: quick open and the command palette (UX_AND_INTERFACE.md
 * section 9). WAI-ARIA combobox with a listbox: typing filters, Up and Down move, Page Up and
 * Page Down jump, Enter picks, Esc closes and focus returns to where it was.
 */
export function Palette<T>({
  label,
  placeholder,
  query,
  onQuery,
  items,
  itemKey,
  renderItem,
  onPick,
  onClose,
  status,
  empty,
}: {
  /** The dialog's and the list's accessible name. */
  label: string;
  placeholder: string;
  query: string;
  onQuery: (query: string) => void;
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  onPick: (item: T) => void;
  onClose: () => void;
  /** A line under the list, for example "Still indexing". */
  status?: string | null;
  /** Shown instead of the list when there is nothing to pick. */
  empty: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const [itemsForActive, setItemsForActive] = useState(items);
  const prefix = useId();
  const optionId = (index: number) => `${prefix}-option-${index}`;

  // A new list starts at its first item.
  if (itemsForActive !== items) {
    setItemsForActive(items);
    setActive(0);
  }

  // Open on mount; on unmount close it first (before React removes it) and put focus back,
  // since a dialog removed while open does not return focus by itself.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId only depends on the stable prefix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const move = (to: number) => {
    if (items.length === 0) return;
    setActive(Math.min(items.length - 1, Math.max(0, to)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const page = 8;
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "PageDown") move(active + page);
    else if (event.key === "PageUp") move(active - page);
    else if (event.key === "Enter") {
      const item = items[active];
      if (item !== undefined) onPick(item);
    } else return;
    event.preventDefault();
  };

  const listId = `${prefix}-list`;
  return (
    <dialog
      ref={dialogRef}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself) closes it.
        if (event.target === dialogRef.current) onClose();
      }}
      className="mx-auto mb-auto mt-[12vh] w-[min(40rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-surface-raised p-0 text-text shadow-lg backdrop:bg-canvas/50"
    >
      <input
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={items.length > 0 ? optionId(active) : undefined}
        placeholder={placeholder}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
        className="w-full border-0 border-b border-border bg-surface px-3 py-2 text-text outline-none placeholder:text-text-muted"
      />
      {items.length === 0 ? (
        <p className="m-0 px-3 py-3 text-text-muted">{empty}</p>
      ) : (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          className="m-0 max-h-[50vh] list-none overflow-y-auto p-1"
        >
          {items.map((item, index) => (
            <li
              key={itemKey(item)}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              onMouseMove={() => setActive(index)}
              onClick={() => onPick(item)}
              className={`flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 ${
                index === active ? "bg-item-active" : ""
              }`}
            >
              {renderItem(item)}
            </li>
          ))}
        </ul>
      )}
      {status && (
        <p role="status" className="m-0 border-t border-border px-3 py-1 text-xs text-text-muted">
          {status}
        </p>
      )}
    </dialog>
  );
}

/** Text with the characters at `positions` emphasised: bold and underlined, readable text colour. */
export function Highlighted({
  text,
  positions,
  offset = 0,
}: {
  text: string;
  /** Indexes into the full string this text is a slice of. */
  positions: readonly number[];
  offset?: number;
}) {
  const marked = new Set(positions.map((position) => position - offset));
  const parts: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (run === "") return;
    parts.push(
      runMarked ? (
        <b key={key} className="font-bold text-text underline decoration-accent decoration-2">
          {run}
        </b>
      ) : (
        run
      ),
    );
    run = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush(i);
      runMarked = isMarked;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}
