import { forwardRef } from "react";

/**
 * Shared form-control primitives (Input / Textarea / Select) with a consistent,
 * token-based look + focus ring + invalid state. Replaces the ~20 hand-coded
 * variations of the same input classes across forms.
 */
const FIELD_BASE =
  "w-full rounded-lg bg-canvas text-ink placeholder:text-muted outline-none transition focus:border-ink focus:ring-2 focus:ring-ink/10";

function fieldClasses(invalid?: boolean, extra = "") {
  return `${FIELD_BASE} border ${invalid ? "border-red-400" : "border-line"} ${extra}`;
}

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", invalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={fieldClasses(invalid, `px-3 py-2.5 ${className}`)}
      {...props}
    />
  )
);
Input.displayName = "Input";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", invalid, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={fieldClasses(invalid, `px-3 py-2.5 ${className}`)}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = "", invalid, children, ...props }, ref) => (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={fieldClasses(invalid, `px-3 py-2.5 pr-8 ${className}`)}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";
