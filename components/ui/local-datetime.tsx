"use client";

import { useEffect, useState } from "react";

/**
 * Renders a timestamp in the viewer's local timezone without hydration
 * mismatches: the server (UTC on Workers) emits a deterministic UTC label,
 * then the browser swaps in the local rendering after mount.
 *
 * Usable as a leaf from server components: <LocalDateTime iso={row.release_at} />
 */
export function LocalDateTime({ iso, prefix = "" }: { iso: string; prefix?: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    setLabel(
      new Date(iso).toLocaleString([], {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    );
  }, [iso]);

  const utc = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  return (
    <span suppressHydrationWarning>
      {prefix}
      {label ?? utc}
    </span>
  );
}
