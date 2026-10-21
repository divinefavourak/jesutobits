import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
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
  const menuId = useId();

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
        <MenuList
          id={menuId}
          label={label}
          items={items}
          className="absolute right-0 top-full mt-1"
          ignore={buttonRef}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) buttonRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/**
 * A context menu at a point (right-click, Shift+F10 or the Menu key). The caller decides
 * where focus goes when it closes.
 */
export function ContextMenu({
  label,
  items,
  at,
  onClose,
}: {
  label: string;
  items: MenuItem[];
  at: { x: number; y: number };
  onClose: () => void;
}) {
  return (
    <MenuList
      label={label}
      items={items}
      className="fixed"
      style={{ left: at.x, top: at.y }}
      onClose={onClose}
    />
  );
}

/** The open list: first item focused, arrows, Home, End, Esc, Tab, click outside. */
function MenuList({
  id,
  label,
  items,
  className,
  style,
  ignore,
  onClose,
}: {
  id?: string;
  label: string;
  items: MenuItem[];
  className: string;
  style?: CSSProperties;
  /** A click here does not close the menu (its own button toggles it). */
  ignore?: RefObject<HTMLElement | null>;
  /** `refocus` is true when the user closed it with Esc or by choosing an item. */
  onClose: (refocus: boolean) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // The latest onClose, without re-running the open effect (which moves focus) per render.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")
      ?.focus();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!listRef.current?.contains(target) && !ignore?.current?.contains(target)) {
        closeRef.current(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [ignore]);

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    onClose(true);
    item.onSelect();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const entries = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => entries[(i + entries.length) % entries.length]?.focus();
    if (event.key === "Tab") {
      onClose(false);
      return;
    }
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(entries.length - 1);
    else if (event.key === "Escape") onClose(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <ul
      ref={listRef}
      id={id}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={style}
      className={`z-20 m-0 min-w-48 list-none rounded-md border border-border bg-surface-raised p-1 shadow-md ${className}`}
    >
      {items.map((item) => (
        <li
          key={item.label}
          role="menuitem"
          tabIndex={-1}
          aria-disabled={item.disabled || undefined}
          onClick={() => select(item)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              select(item);
            }
          }}
          className="cursor-pointer whitespace-nowrap rounded-sm px-2 py-1 text-text hover:bg-item-hover focus:bg-item-active focus:outline-none aria-disabled:cursor-not-allowed aria-disabled:text-text-subtle"
        >
          {item.label}
        </li>
      ))}
    </ul>
  );
}
