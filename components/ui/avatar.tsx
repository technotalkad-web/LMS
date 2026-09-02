/**
 * Shared learner avatar: photo when one exists, otherwise the initials disc
 * (deterministic gradient, first letter of the display name — extracted from
 * the profile page so podium / leaderboard rows / profile all match).
 */

const SIZES = {
  sm: "h-8 w-8 text-sm",
  md: "h-10 w-10 text-base",
  lg: "h-16 w-16 text-2xl",
  xl: "h-24 w-24 text-4xl",
} as const;

export function Avatar({
  name,
  avatarUrl,
  size = "md",
  className = "",
  style,
}: {
  name: string;
  avatarUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
  /** Inline overrides (e.g. a custom --tw-ring-color for podium frames). */
  style?: React.CSSProperties;
}) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        style={style}
        className={`${SIZES[size]} rounded-full object-cover object-center bg-canvas shrink-0 ${className}`}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={style}
      className={`${SIZES[size]} rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 text-white flex items-center justify-center font-semibold shrink-0 ${className}`}
    >
      {initial}
    </div>
  );
}
