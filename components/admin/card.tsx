import type { ReactNode } from "react";

/**
 * Generic surface card used for both content cards and list-row cards.
 * Optional `interactive` adds a subtle hover lift + cursor pointer.
 */
export function Card({
  children,
  interactive,
  className,
}: {
  children: ReactNode;
  interactive?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`bg-paper border border-line rounded-xl ${
        interactive ? "transition-all hover:border-ink/30 hover:shadow-sm" : ""
      } ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

/**
 * Avatar that derives initials + a deterministic background color from
 * a string (typically an email). Use for any user-list rendering.
 */
export function Avatar({
  name,
  size = 40,
}: {
  name: string;
  size?: number;
}) {
  const initials = name
    .replace(/[^a-zA-Z0-9]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .filter(Boolean)
    .join("") || "?";

  // Cheap deterministic color: hash name to one of the palette buckets.
  const palette = [
    "bg-indigo-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-violet-500",
    "bg-sky-500",
    "bg-teal-500",
    "bg-fuchsia-500",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const bg = palette[h % palette.length];

  return (
    <div
      className={`shrink-0 rounded-full ${bg} text-white font-semibold flex items-center justify-center`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials}
    </div>
  );
}
