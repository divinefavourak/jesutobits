import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-text-on-accent hover:bg-accent-hover",
  secondary: "border border-border-strong bg-surface-raised text-text hover:bg-item-hover",
  ghost: "text-text hover:bg-item-hover",
  danger: "text-danger hover:bg-danger-subtle",
};

/** A button styled only with theme tokens (EXTENSION_SYSTEM.md section 4.1). */
export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
