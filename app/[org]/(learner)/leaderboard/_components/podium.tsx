import { Avatar } from "@/components/ui/avatar";

export type PodiumEntry = {
  rank: number;
  name: string;
  avatarUrl: string | null;
  designation: string | null;
  metricLabel: string;
  metricValue: string;
};

const TONES: Record<number, { ring: string; medal: string; label: string; height: string }> = {
  1: { ring: "ring-amber-400", medal: "🥇", label: "1st place", height: "pt-0" },
  2: { ring: "ring-slate-300", medal: "🥈", label: "2nd place", height: "pt-8" },
  3: { ring: "ring-amber-700", medal: "🥉", label: "3rd place", height: "pt-12" },
};

/** Classic 2–1–3 podium for the top three. Server component, no animation. */
export function Podium({ top3 }: { top3: PodiumEntry[] }) {
  if (top3.length < 3) return null;
  const byRank = new Map(top3.map((e) => [e.rank, e]));
  const order = [byRank.get(2), byRank.get(1), byRank.get(3)].filter(
    (e): e is PodiumEntry => !!e
  );

  return (
    <div className="grid grid-cols-3 items-end gap-3 sm:gap-6 max-w-2xl mx-auto">
      {order.map((e) => {
        const tone = TONES[e.rank];
        return (
          <div key={e.rank} className={`text-center ${tone.height}`}>
            <div className="relative inline-block">
              <Avatar
                name={e.name}
                avatarUrl={e.avatarUrl}
                size={e.rank === 1 ? "xl" : "lg"}
                className={`ring-4 ${tone.ring}`}
              />
              <span
                className="absolute -bottom-2 left-1/2 -translate-x-1/2 text-2xl"
                aria-hidden
              >
                {tone.medal}
              </span>
              <span className="sr-only">{tone.label}</span>
            </div>
            <div className="mt-4 font-semibold text-sm sm:text-base leading-tight truncate">
              {e.name}
            </div>
            {e.designation && (
              <div className="text-xs text-muted truncate">{e.designation}</div>
            )}
            <div className="mt-1 text-xs font-bold text-indigo-700 tabular-nums">
              {e.metricValue}
              <span className="text-muted font-medium"> {e.metricLabel}</span>
            </div>
            <div
              className={`mt-3 mx-auto rounded-t-xl bg-gradient-to-b from-indigo-100 to-indigo-50 border border-b-0 border-indigo-200 ${
                e.rank === 1 ? "h-16" : e.rank === 2 ? "h-10" : "h-7"
              } w-full max-w-[120px] flex items-start justify-center pt-1 text-indigo-300 font-bold`}
            >
              {e.rank}
            </div>
          </div>
        );
      })}
    </div>
  );
}
