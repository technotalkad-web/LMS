"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  PlayCircle,
  Award,
  Clock,
  List as ListIcon,
  RotateCcw,
} from "lucide-react";

export type CardStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "passed"
  | "failed";

export type GridCard = {
  course_id: string;
  title: string;
  description: string | null;
  source: "user" | "team" | "org";
  status: CardStatus;
  isRevised: boolean;
  dueAt: string | null;
  bestScore: number | null;
  /** Optional badge — e.g. "Learning path: Onboarding" when the card belongs to a path */
  pathName?: string | null;
  thumbnail_url?: string | null;
};

type Filter = "all" | "in_progress" | "not_started" | "completed";

const labels: Record<Filter, string> = {
  all: "All",
  in_progress: "In progress",
  not_started: "Not started",
  completed: "Completed",
};

export function DashboardGrid({
  cards,
  orgSlug,
}: {
  cards: GridCard[];
  orgSlug: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    let inProg = 0;
    let notStarted = 0;
    let done = 0;
    for (const c of cards) {
      if (c.status === "in_progress") inProg++;
      else if (c.status === "not_started") notStarted++;
      else if (c.status === "completed" || c.status === "passed") done++;
    }
    return { inProg, notStarted, done };
  }, [cards]);

  const filtered = useMemo(() => {
    if (filter === "all") return cards;
    if (filter === "in_progress")
      return cards.filter((c) => c.status === "in_progress");
    if (filter === "not_started")
      return cards.filter((c) => c.status === "not_started");
    return cards.filter(
      (c) => c.status === "completed" || c.status === "passed"
    );
  }, [cards, filter]);

  return (
    <section className="bg-paper border border-line rounded-2xl overflow-hidden">
      {/* Filter tabs */}
      <div className="border-b border-line overflow-x-auto">
        <div className="flex min-w-max">
          <Tab
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label={labels.all}
            count={cards.length}
          />
          <Tab
            active={filter === "in_progress"}
            onClick={() => setFilter("in_progress")}
            label={labels.in_progress}
            count={counts.inProg}
          />
          <Tab
            active={filter === "not_started"}
            onClick={() => setFilter("not_started")}
            label={labels.not_started}
            count={counts.notStarted}
          />
          <Tab
            active={filter === "completed"}
            onClick={() => setFilter("completed")}
            label={labels.completed}
            count={counts.done}
          />
        </div>
      </div>

      {/* Grid */}
      <div className="p-5 sm:p-6">
        {filtered.length === 0 ? (
          <div className="text-center py-10 text-muted text-sm">
            Nothing in this category yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map((c) => (
              <Card key={c.course_id} card={c} orgSlug={orgSlug} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Tab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap px-5 py-3.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
        active
          ? "border-indigo-600 text-indigo-600"
          : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {label}
      <span
        className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] rounded-full ${
          active ? "bg-indigo-100 text-indigo-700" : "bg-canvas text-muted"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function Card({ card, orgSlug }: { card: GridCard; orgSlug: string }) {
  const isCompleted =
    card.status === "completed" || card.status === "passed";
  const overdue =
    !isCompleted &&
    card.dueAt &&
    new Date(card.dueAt).getTime() < Date.now();

  const dueLabel = card.dueAt
    ? overdue
      ? `Overdue · ${new Date(card.dueAt).toISOString().slice(0, 10)}`
      : `Due ${new Date(card.dueAt).toISOString().slice(0, 10)}`
    : null;

  const statusPill = (() => {
    if (card.status === "passed")
      return { tone: "emerald", label: "Passed" };
    if (card.status === "completed")
      return { tone: "indigo", label: "Completed" };
    if (card.status === "in_progress")
      return { tone: "amber", label: "In progress" };
    if (card.status === "failed") return { tone: "red", label: "Failed" };
    return { tone: "slate", label: "Not started" };
  })();

  return (
    <div
      className={`bg-paper rounded-2xl overflow-hidden flex flex-col border ${
        overdue ? "border-red-200 ring-1 ring-red-100" : "border-line"
      } hover:shadow-md transition-shadow`}
    >
      {/* Top banner — portrait 3:4 so uploaded posters/thumbnails show without
          cropping (admins are told to upload 3:4 · 900×1200; see ThumbnailPicker). */}
      <div
        className={`relative aspect-[3/4] border-b border-line overflow-hidden ${
          card.thumbnail_url
            ? "bg-canvas"
            : card.pathName
              ? "bg-gradient-to-br from-indigo-600 to-indigo-800"
              : "bg-gradient-to-br from-slate-700 to-slate-900"
        }`}
      >
        {card.thumbnail_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.thumbnail_url}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {overdue && (
          <div className="absolute top-0 inset-x-0 bg-red-500 text-white text-[10px] font-bold tracking-wider uppercase py-1 text-center">
            Overdue
          </div>
        )}
        {card.pathName && (
          <span className="absolute top-3 left-3 inline-flex items-center gap-1 bg-white/15 backdrop-blur-sm text-white text-[10px] font-semibold px-2 py-1 rounded-md">
            <ListIcon className="w-3 h-3" />
            {card.pathName}
          </span>
        )}
        {card.isRevised && (
          <span className="absolute top-3 right-3 inline-flex items-center gap-1 bg-amber-400/95 text-amber-950 text-[10px] font-bold px-2 py-1 rounded-md">
            <RotateCcw className="w-3 h-3" /> Updated
          </span>
        )}
        <span
          className={`absolute bottom-3 left-3 inline-block text-[10px] font-bold px-2 py-1 rounded-md ${
            statusPill.tone === "emerald"
              ? "bg-emerald-100 text-emerald-800"
              : statusPill.tone === "indigo"
                ? "bg-indigo-100 text-indigo-800"
                : statusPill.tone === "amber"
                  ? "bg-amber-100 text-amber-900"
                  : statusPill.tone === "red"
                    ? "bg-red-100 text-red-800"
                    : "bg-white/95 text-slate-700"
          }`}
        >
          {statusPill.label}
        </span>
      </div>

      {/* Body */}
      <div className="p-5 flex-1 flex flex-col">
        <h3 className="font-semibold text-base leading-snug line-clamp-2 mb-2">
          {card.title}
        </h3>
        {card.description && (
          <p className="text-xs text-muted line-clamp-2 mb-3">
            {card.description}
          </p>
        )}

        <div className="mt-auto">
          {isCompleted ? (
            <div className="flex items-center justify-between bg-emerald-50 px-3 py-2 rounded-lg border border-emerald-100 mb-3 text-sm">
              <div className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                <Award className="w-4 h-4" />
                {card.status === "passed" ? "Passed" : "Completed"}
              </div>
              {card.bestScore !== null && (
                <span className="font-bold text-emerald-800">
                  {Math.round(card.bestScore * 100)}%
                </span>
              )}
            </div>
          ) : (
            <>
              <div className="flex justify-between text-[11px] mb-1 font-medium">
                <span className="text-muted">
                  {card.status === "in_progress"
                    ? "In progress"
                    : "Not started"}
                </span>
                {dueLabel && (
                  <span
                    className={
                      overdue
                        ? "text-red-700 font-semibold"
                        : "text-muted"
                    }
                  >
                    {dueLabel}
                  </span>
                )}
              </div>
              <div className="w-full bg-canvas rounded-full h-1.5 mb-4 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    overdue ? "bg-red-500" : "bg-indigo-600"
                  }`}
                  style={{
                    width:
                      card.status === "in_progress"
                        ? "50%"
                        : card.status === "not_started"
                          ? "0%"
                          : "100%",
                  }}
                />
              </div>
            </>
          )}

          <Link
            href={`/${orgSlug}/courses/${card.course_id}${
              isCompleted ? "" : "/launch"
            }`}
            className={`w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isCompleted
                ? "bg-canvas hover:bg-canvas/70 text-ink border border-line"
                : overdue
                  ? "bg-red-600 hover:bg-red-700 text-white shadow-sm"
                  : "bg-ink text-canvas hover:opacity-90 shadow-sm"
            }`}
          >
            {isCompleted ? (
              <>
                <Award className="w-4 h-4" /> View details
              </>
            ) : card.status === "in_progress" ? (
              <>
                <PlayCircle className="w-4 h-4" /> Resume
              </>
            ) : (
              <>
                <PlayCircle className="w-4 h-4" /> Start
              </>
            )}
          </Link>

          {card.source === "team" && (
            <div className="text-[10px] text-muted text-center mt-2 flex items-center justify-center gap-1">
              <Clock className="w-3 h-3" /> Assigned via team
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
