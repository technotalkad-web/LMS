import { Avatar } from "@/components/ui/avatar";

export type PodiumEntry = {
  rank: number;
  name: string;
  avatarUrl: string | null;
  designation: string | null;
  metricLabel: string;
  metricValue: string;
};

const TONES: Record<
  number,
  { ring: string; chip: string; chipText: string; label: string; pedestal: string }
> = {
  1: {
    ring: "ring-amber-300",
    chip: "bg-amber-300 text-amber-950",
    chipText: "1st",
    label: "1st place",
    pedestal: "h-24 sm:h-28",
  },
  2: {
    ring: "ring-slate-200",
    chip: "bg-slate-200 text-slate-800",
    chipText: "2nd",
    label: "2nd place",
    pedestal: "h-16 sm:h-20",
  },
  3: {
    ring: "ring-orange-300",
    chip: "bg-orange-300 text-orange-950",
    chipText: "3rd",
    label: "3rd place",
    pedestal: "h-12 sm:h-14",
  },
};

/**
 * Fixed confetti field — deterministic (server component, no randomness) so
 * SSR output is stable. Values hand-scattered for an even, organic spread.
 * left/size in %, px; delay/duration in s. Negative delays desynchronize the
 * loops so the fall is continuous from the first paint.
 */
const CONFETTI: Array<{
  left: number;
  size: number;
  delay: number;
  duration: number;
  color: string;
  round?: boolean;
}> = [
  { left: 3, size: 7, delay: -2.1, duration: 8.5, color: "#fcd34d" },
  { left: 9, size: 5, delay: -6.4, duration: 10.2, color: "#f9a8d4", round: true },
  { left: 15, size: 6, delay: -0.8, duration: 9.1, color: "#ffffff" },
  { left: 21, size: 8, delay: -4.9, duration: 11.4, color: "#5eead4" },
  { left: 27, size: 5, delay: -8.2, duration: 8.8, color: "#c7d2fe", round: true },
  { left: 33, size: 7, delay: -3.3, duration: 10.7, color: "#fcd34d" },
  { left: 39, size: 5, delay: -7.1, duration: 9.6, color: "#ffffff", round: true },
  { left: 45, size: 6, delay: -1.6, duration: 11.9, color: "#f9a8d4" },
  { left: 51, size: 8, delay: -5.7, duration: 8.3, color: "#5eead4", round: true },
  { left: 57, size: 5, delay: -9.4, duration: 10.5, color: "#fcd34d" },
  { left: 63, size: 6, delay: -2.8, duration: 9.9, color: "#c7d2fe" },
  { left: 69, size: 7, delay: -6.9, duration: 8.9, color: "#ffffff", round: true },
  { left: 75, size: 5, delay: -0.4, duration: 11.1, color: "#f9a8d4" },
  { left: 81, size: 8, delay: -4.2, duration: 9.4, color: "#fcd34d", round: true },
  { left: 87, size: 5, delay: -7.8, duration: 10.8, color: "#5eead4" },
  { left: 93, size: 6, delay: -3.7, duration: 9.2, color: "#ffffff" },
  { left: 97, size: 5, delay: -8.9, duration: 11.6, color: "#c7d2fe", round: true },
  { left: 12, size: 6, delay: -5.2, duration: 12.3, color: "#5eead4" },
  { left: 48, size: 5, delay: -10.1, duration: 10.0, color: "#ffffff" },
  { left: 84, size: 6, delay: -1.2, duration: 12.0, color: "#f9a8d4" },
];

/**
 * Celebration podium for the top three: 2–1–3 pedestals on an indigo
 * gradient with a continuous, subtle CSS-only confetti fall. Server
 * component — the animation is pure CSS (no JS), disabled entirely under
 * prefers-reduced-motion. The gradient is a deliberate fixed look shared
 * by light and dark themes.
 */
export function Podium({ top3 }: { top3: PodiumEntry[] }) {
  if (top3.length < 3) return null;
  const byRank = new Map(top3.map((e) => [e.rank, e]));
  const order = [byRank.get(2), byRank.get(1), byRank.get(3)].filter(
    (e): e is PodiumEntry => !!e
  );

  return (
    <section
      aria-label="Top 3"
      className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-indigo-500 via-indigo-700 to-indigo-950 px-4 sm:px-8 pt-8 sm:pt-10 shadow-lg"
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
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        {CONFETTI.map((c, i) => (
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

      {/* Soft glow behind the champion */}
      <div
        aria-hidden
        className="absolute left-1/2 top-6 -translate-x-1/2 w-56 h-56 rounded-full bg-white/15 blur-3xl pointer-events-none"
      />

      <div className="relative grid grid-cols-3 items-end gap-3 sm:gap-8 max-w-2xl mx-auto">
        {order.map((e) => {
          const tone = TONES[e.rank];
          const first = e.rank === 1;
          return (
            <div key={e.rank} className="text-center min-w-0">
              <div className="relative inline-block">
                {first && (
                  <span
                    aria-hidden
                    className="absolute -top-7 left-1/2 -translate-x-1/2 text-2xl drop-shadow"
                  >
                    👑
                  </span>
                )}
                <Avatar
                  name={e.name}
                  avatarUrl={e.avatarUrl}
                  size={first ? "xl" : "lg"}
                  className={`ring-4 ${tone.ring} shadow-xl`}
                />
                <span
                  className={`absolute -bottom-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-extrabold tracking-wide shadow ${tone.chip}`}
                  aria-hidden
                >
                  {tone.chipText}
                </span>
                <span className="sr-only">{tone.label}</span>
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
                className={`mt-3 mx-auto w-full max-w-[130px] rounded-t-2xl bg-white/10 backdrop-blur-sm border border-b-0 border-white/20 ${tone.pedestal} flex items-start justify-center pt-2`}
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
