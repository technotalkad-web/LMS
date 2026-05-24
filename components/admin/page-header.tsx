import type { ReactNode } from "react";

/**
 * Standard admin page header. Title + supporting copy on the left,
 * primary action on the right. Responsive: stacks on mobile.
 */
export function AdminPageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-6 sm:mb-8">
      <div className="min-w-0">
        <h1 className="serif text-3xl sm:text-4xl tracking-tight text-ink leading-none">
          {title}
        </h1>
        {description && (
          <p className="text-muted text-sm mt-2 max-w-2xl">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
