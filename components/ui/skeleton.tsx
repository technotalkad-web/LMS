/**
 * Loading-skeleton primitives. Used by route-level loading.tsx files (App
 * Router renders them via Suspense during server data fetches/navigation) to
 * give instant structural feedback instead of a blank screen. `animate-pulse`
 * is automatically disabled under prefers-reduced-motion (see globals.css).
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-line/60 ${className}`}
    />
  );
}

/** Page title + description placeholder. */
export function PageHeaderSkeleton({ action = false }: { action?: boolean }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      {action && <Skeleton className="h-10 w-32 rounded-xl" />}
    </div>
  );
}

/** Row of KPI tiles. */
export function KpiStripSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-line bg-paper p-4 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

/** Responsive card grid placeholder. */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-line bg-paper overflow-hidden">
          <Skeleton className="h-32 w-full rounded-none" />
          <div className="p-4 space-y-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Table placeholder. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-line bg-paper overflow-hidden">
      <Skeleton className="h-10 w-full rounded-none opacity-70" />
      <div className="divide-y divide-line">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-1/6 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
