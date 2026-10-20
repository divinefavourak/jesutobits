import type { ReactNode } from "react";

export function Button({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
