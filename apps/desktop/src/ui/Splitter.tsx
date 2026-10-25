import { useRef, type KeyboardEvent, type PointerEvent } from "react";

/**
 * A focusable splitter (UX_AND_INTERFACE.md section 4.2, WAI-ARIA window splitter): drag it,
 * or focus it and use the arrow keys (Shift for bigger steps), Home and End. `value` is the
 * size of the area it resizes; `direction` is 1 when moving right or down grows that area.
 */
export function Splitter({
  label,
  orientation,
  value,
  min,
  max,
  direction,
  onResize,
}: {
  label: string;
  /** `vertical` separates left from right; `horizontal` separates top from bottom. */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onResize: (size: number) => void;
}) {
  const drag = useRef<{ start: number; size: number } | null>(null);
  const position = (event: PointerEvent) =>
    orientation === "vertical" ? event.clientX : event.clientY;

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16;
    const forward = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    const back = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    let next: number | undefined;
    if (event.key === forward) next = value + step * direction;
    else if (event.key === back) next = value - step * direction;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === undefined) return;
    event.preventDefault();
    onResize(next);
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { start: position(event), size: value };
      }}
      onPointerMove={(event) => {
        if (drag.current) {
          onResize(drag.current.size + (position(event) - drag.current.start) * direction);
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      className={`shrink-0 bg-border hover:bg-accent focus-visible:bg-accent ${
        orientation === "vertical" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"
      }`}
    />
  );
}
