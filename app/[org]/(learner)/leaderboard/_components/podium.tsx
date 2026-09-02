import { Avatar } from "@/components/ui/avatar";
import {
  chipTextColor,
  confettiPieces,
  effectivePodiumStyle,
} from "@/lib/gamification/podium-style";
import { PodiumAnimation } from "./podium-animation";

export type PodiumEntry = {
  rank: number;
  name: string;
  avatarUrl: string | null;
  designation: string | null;
  metricLabel: string;
  metricValue: string;
};

const PEDESTALS: Record<number, string> = {
  1: "h-24 sm:h-28",
  2: "h-16 sm:h-20",
  3: "h-12 sm:h-14",
};
const PLACE_LABELS: Record<number, string> = {
  1: "1st place",
  2: "2nd place",
  3: "3rd place",
};

/**
 * Celebration podium for the top three: 2–1–3 pedestals with a continuous,
 * subtle CSS-only confetti fall. Fully org-customizable (0061): background
 * gradient, confetti colors/density/speed and per-rank avatar frames come
 * from gamification_settings.podium_style (Admin → Gamification →
 * Leaderboard & privacy → Podium style); null = the classic indigo look.
 * Server component — deterministic confetti, no JS, and the animation is
 * disabled entirely under prefers-reduced-motion.
 */
export function Podium({ top3, style }: { top3: PodiumEntry[]; style?: unknown }) {
  if (top3.length < 3) return null;
  const ps = effectivePodiumStyle(style);
  const confetti = ps.confetti_enabled ? confettiPieces(ps) : [];
  const byRank = new Map(top3.map((e) => [e.rank, e]));
  const order = [byRank.get(2), byRank.get(1), byRank.get(3)].filter(
    (e): e is PodiumEntry => !!e
  );

  return (
    <section
      aria-label="Top 3"
      className="relative overflow-hidden rounded-3xl px-4 sm:px-8 pt-8 sm:pt-10 shadow-lg"
      style={{
        background: `linear-gradient(to bottom, ${ps.bg_from}, ${ps.bg_via}, ${ps.bg_to})`,
      }}
    >
      <style>{`
        @keyframes podium-confetti-fall {
          0% { transform: translateY(-30px) rotate(0deg); }
          100% { transform: translateY(560px) rotate(660deg); }
        }
        .podium-confetti {
          position: absolute;
          top: 0;
          opacity: 0.55;
          animation-name: podium-confetti-fall;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          will-change: transform;
        }
        @media (prefers-reduced-motion: reduce) {
          .podium-confetti { display: none; }
        }
      `}</style>

      {/* Confetti field (decorative) */}
      {confetti.length > 0 && (
        <div aria-hidden className="absolute inset-0 pointer-events-none">
          {confetti.map((c, i) => (
            <span
              key={i}
              className="podium-confetti"
              style={{
                left: `${c.left}%`,
                width: c.size,
                height: c.round ? c.size : c.size * 1.8,
                background: c.color,
                borderRadius: c.round ? "9999px" : "1px",
                animationDelay: `${c.delay}s`,
                animationDuration: `${c.duration}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* Optional org-uploaded animation overlay (Lottie / SVG / GIF) */}
      {ps.animation_url && <PodiumAnimation url={ps.animation_url} />}

      {/* Soft glow behind the champion */}
      <div
        aria-hidden
        className="absolute left-1/2 top-6 -translate-x-1/2 w-56 h-56 rounded-full bg-white/15 blur-3xl pointer-events-none"
      />

      <div className="relative grid grid-cols-3 items-end gap-3 sm:gap-8 max-w-2xl mx-auto">
        {order.map((e) => {
          const frame = ps.frames[e.rank - 1];
          const first = e.rank === 1;
          return (
            <div key={e.rank} className="text-center min-w-0">
              <div className="relative inline-block">
                {frame.topper && (
                  <span
                    aria-hidden
                    className="absolute -top-7 left-1/2 -translate-x-1/2 text-2xl drop-shadow"
                  >
                    {frame.topper}
                  </span>
                )}
                <Avatar
                  name={e.name}
                  avatarUrl={e.avatarUrl}
                  size={first ? "xl" : "lg"}
                  className="ring-4 shadow-xl"
                  style={{ "--tw-ring-color": frame.ring } as React.CSSProperties}
                />
                <span
                  className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-extrabold tracking-wide shadow"
                  style={{ background: frame.chip, color: chipTextColor(frame.chip) }}
                  aria-hidden
                >
                  {frame.label}
                </span>
                <span className="sr-only">{PLACE_LABELS[e.rank]}</span>
              </div>

              <div className="mt-4 font-semibold text-white text-sm sm:text-base leading-tight truncate">
                {e.name}
              </div>
              {e.designation && (
                <div className="text-[11px] text-white/60 truncate">
                  {e.designation}
                </div>
              )}
              <div className="mt-1 text-sm font-bold text-white tabular-nums">
                {e.metricValue}
                <span className="text-white/60 font-medium text-xs">
                  {" "}
                  {e.metricLabel}
                </span>
              </div>

              <div
                className={`mt-3 mx-auto w-full max-w-[130px] rounded-t-2xl bg-white/10 backdrop-blur-sm border border-b-0 border-white/20 ${PEDESTALS[e.rank]} flex items-start justify-center pt-2`}
              >
                <span className="text-white/40 font-extrabold text-xl">
                  {e.rank}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
