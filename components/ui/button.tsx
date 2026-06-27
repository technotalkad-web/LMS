import { forwardRef } from "react";

/**
 * Shared button primitive. Encapsulates the design-token button styles that
 * were previously hand-coded on every page, so variants stay consistent.
 *
 *   <Button>Save</Button>
 *   <Button variant="secondary" size="sm">Cancel</Button>
 *   <Button variant="danger">Delete</Button>
 */
type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition disabled:opacity-60 disabled:pointer-events-none";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-canvas hover:opacity-90",
  secondary: "border border-line bg-paper text-ink hover:border-ink",
  ghost: "text-muted hover:text-ink hover:bg-canvas",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

const SIZES: Record<Size, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-4 py-2.5",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  )
);
Button.displayName = "Button";
