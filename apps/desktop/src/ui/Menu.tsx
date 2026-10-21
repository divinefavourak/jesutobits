import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

/**
 * A menu button (WAI-ARIA menu button pattern): Enter, Space or ArrowDown opens it with the
 * first item focused; arrows move, Esc closes it and focus returns to the button.
 */
export function Menu({
  label,
  items,
  children,
}: {
  /** The button's accessible name. */
  label: string;
  items: MenuItem[];
  /** The button's visible content, for example an icon. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!listRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const select = (item: MenuItem) => {
    setOpen(false);
    buttonRef.current?.focus();
    item.onSelect();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const entries = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => entries[(i + entries.length) % entries.length]?.focus();
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(entries.length - 1);
    else if (event.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex items-center justify-center rounded-sm p-1 text-text-muted hover:bg-item-hover hover:text-text"
      >
        {children}
      </button>
      {open && (
        <ul
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-20 m-0 mt-1 min-w-48 list-none rounded-md border border-border bg-surface-raised p-1 shadow-md"
        >
          {items.map((item) => (
            <li
              key={item.label}
              role="menuitem"
              tabIndex={-1}
              onClick={() => select(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select(item);
                }
              }}
              className="cursor-pointer whitespace-nowrap rounded-sm px-2 py-1 text-text hover:bg-item-hover focus:bg-item-active focus:outline-none"
            >
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
