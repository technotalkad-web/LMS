import Link from "next/link";
import { Trophy, Zap, Medal, Flame, Target, EyeOff } from "lucide-react";

/** Payload of the get_my_gamification RPC (migration 0053). */
export type MyGamification = {
  ok: boolean;
  enabled: boolean;
  zero?: boolean;
  total_xp?: number;
  level?: number;
  level_name?: string | null;
  xp_to_next_level?: number | null;
  streak_days?: number;
  rank?: number | null;
  opted_out?: boolean;
  leaderboard_enabled?: boolean;
  xp_to_top10?: number | null;
  next_badge?: {
    name?: string;
    icon?: string;
    remaining?: number;
    unit?: string;
  } | null;
};

/**
 * Personal motivation strip: Rank | XP | Level | Streak | Avg Score plus one
 * deterministic "next goal" sentence. Pure server component — zero client JS.
 */
export function MotivationStrip({
  orgSlug,
  data,
  avgScore,
  scoreLabel = "XP",
  scoreDescription,
}: {
  orgSlug: string;
  data: MyGamification | null;
  avgScore: number | null;
  /** Org-named score (0066) — e.g. "Gyanank"; default "XP". */
  scoreLabel?: string;
  scoreDescription?: string;
}) {
  if (!data || !data.ok || !data.enabled) return null;

  const xp = data.total_xp ?? 0;
  const level = data.level ?? 1;
  const streak = data.streak_days ?? 0;
  const showRank = data.leaderboard_enabled !== false;

  // One clear next goal, in priority order.
  let nudge: string;
  if (data.zero || xp === 0) {
    nudge = `Complete your first course to start earning ${scoreLabel}.`;
  } else if (data.xp_to_top10 && data.xp_to_top10 > 0) {
    nudge = `You are only ${data.xp_to_top10.toLocaleString()} ${scoreLabel} away from the Top 10.`;
  } else if (
    data.next_badge?.remaining &&
    data.next_badge.remaining > 0 &&
    data.next_badge.name
  ) {
    // Units arrive plural ("days", "perfect scores"); singularize for 1.
    const unit = data.next_badge.unit ?? "steps";
    nudge = `${data.next_badge.remaining.toLocaleString()} more ${
      data.next_badge.remaining === 1 ? unit.replace(/s$/, "") : unit
    } to unlock ${data.next_badge.icon ?? ""} ${data.next_badge.name}.`;
  } else if (data.xp_to_next_level && data.xp_to_next_level > 0) {
    nudge = `${data.xp_to_next_level.toLocaleString()} ${scoreLabel} to your next level.`;
  } else {
    nudge = "You're at the top level — defend your streak.";
  }

  const cells: Array<{
    label: string;
    value: React.ReactNode;
    icon: React.ReactNode;
    href?: string;
  }> = [];
  if (showRank) {
    cells.push({
      label: "Rank",
      value: (
        <span className="inline-flex items-center gap-1.5">
          {data.rank ? `#${data.rank}` : "—"}
          {data.opted_out && (
            <span title="Visible only to you">
              <EyeOff className="w-3.5 h-3.5 text-muted" />
            </span>
          )}
        </span>
      ),
      icon: <Trophy className="w-4 h-4 text-indigo-600" />,
      href: `/${orgSlug}/leaderboard`,
    });
  }
  cells.push(
    {
      label: scoreLabel,
      value: (
        <span title={scoreDescription || undefined}>{xp.toLocaleString()}</span>
      ),
      icon: <Zap className="w-4 h-4 text-amber-500" />,
    },
    {
      label: "Level",
      value: (
        <span>
          {level}
          {data.level_name ? (
            <span className="text-muted font-normal text-xs ml-1.5">
              {data.level_name}
            </span>
          ) : null}
        </span>
      ),
      icon: <Medal className="w-4 h-4 text-emerald-600" />,
    },
    {
      label: "Streak",
      value: streak > 0 ? `${streak} ${streak === 1 ? "day" : "days"}` : "—",
      icon: <Flame className="w-4 h-4 text-orange-500" />,
    },
    {
      label: "Avg Score",
      value: avgScore !== null ? `${Math.round(avgScore * 100)}%` : "—",
      icon: <Target className="w-4 h-4 text-slate-500" />,
    }
  );

  return (
    <section className="bg-paper border border-line rounded-2xl shadow-sm overflow-hidden">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 divide-x divide-y sm:divide-y-0 divide-line">
        {cells.map((c) => {
          const inner = (
            <div className="px-4 py-3">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                {c.icon}
                {c.label}
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {c.value}
              </div>
            </div>
          );
          return c.href ? (
            <Link
              key={c.label}
              href={c.href}
              className="hover:bg-canvas/60 transition-colors"
            >
              {inner}
            </Link>
          ) : (
            <div key={c.label}>{inner}</div>
          );
        })}
      </div>
      <div className="px-4 py-2 border-t border-line bg-canvas/40 text-xs text-muted">
        🎯 {nudge}
      </div>
    </section>
  );
}
