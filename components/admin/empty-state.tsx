import type { ReactNode } from "react";

/**
 * Centered empty-state block. Drop it inside any list card when there's
 * nothing to show. Optional CTA in the action slot.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      {icon && (
        <div className="w-12 h-12 rounded-full bg-canvas border border-line flex items-center justify-center text-muted mb-3">
          {icon}
        </div>
      )}
      <p className="serif text-xl text-ink">{title}</p>
      {description && (
        <p className="text-sm text-muted mt-1 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
