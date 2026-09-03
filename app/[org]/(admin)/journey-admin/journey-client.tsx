"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RotateCcw, Swords, X } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  computeJourneyState,
  effectiveJourneyCopy,
  effectiveMilestones,
  DEFAULT_JOURNEY_COPY,
  DEFAULT_MILESTONES,
  type JourneyCopy,
} from "@/lib/journey/journey";

export type ProgramRow = {
  id: string;
  name: string;
  icon: string;
  days_total: number;
  count_sundays: boolean;
  auto_enroll_new_users: boolean;
  milestones: unknown;
  copy: unknown;
  completion_title: string;
  is_active: boolean;
  current_version_id: string | null;
  // Phase 2 (0059) — undefined before the migration runs.
  nudge_enabled?: boolean;
  nudge_behind_days?: number;
  nudge_cooldown_days?: number;
  // Multi-journey (0063) — undefined before the migration runs.
  priority?: number;
  is_mandatory?: boolean;
  audience?: Record<string, string[]> | null;
  // Focused dashboard (0064).
  focus_enabled?: boolean;
  focus_pinned?: string[] | null;
  // Deadline + manager escalation (0065).
  deadline_days?: number | null;
  escalation_enabled?: boolean;
  escalation_after_days?: number;
};
export type ProgramSummary = { id: string; name: string; icon: string; priority: number };
export type FunnelRow = { day_number: number; learners: number };
export type DayRow = {
  day_number: number;
  course_id: string | null;
  mission_title: string | null;
};
export type EnrollmentRow = {
  id: string;
  user_id: string;
  start_date: string;
  status: "active" | "completed" | "reset";
  completed_at: string | null;
  created_at: string;
  completed_count: number;
  name: string;
  email: string;
  /** Pinned version — later publishes never move these. */
  version_number: number;
  days_total: number;
  count_sundays: boolean;
  course_days: number[];
};
export type MemberOption = { user_id: string; name: string; email: string };
export type CourseOption = { id: string; title: string };

const TABS = [
  { key: "curriculum", label: "Curriculum" },
  { key: "enrollments", label: "Enrollments" },
  { key: "reports", label: "Reports" },
  { key: "settings", label: "Settings & milestones" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function JourneyAdminClient({
  orgSlug,
  programs = [],
  program,
  currentVersion,
  days,
  enrollments,
  members,
  courses,
  funnel,
  today,
  audienceOptions = {},
  teams = [],
  orgGroups = [],
}: {
  orgSlug: string;
  programs?: ProgramSummary[];
  program: ProgramRow | null;
  currentVersion: { version_number: number; published_at: string } | null;
  days: DayRow[];
  enrollments: EnrollmentRow[];
  members: MemberOption[];
  courses: CourseOption[];
  funnel: FunnelRow[];
  today: string;
  audienceOptions?: Record<string, string[]>;
  teams?: Array<{ id: string; name: string }>;
  orgGroups?: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirmPublish = useConfirm();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [tab, setTab] = useState<TabKey>("curriculum");

  async function publish(applyTo: "new" | "all") {
    if (!program) return;
    const ok = await confirmPublish(
      applyTo === "all"
        ? {
            title: "Publish and update current learners?",
            message:
              "Publishing freezes the last SAVED draft as a new version (save unsaved edits first). EVERY active learner is then moved onto it immediately. Nobody's progress is reset: completed missions stay counted and each learner simply continues at the new curriculum's next mission. Anyone who has already completed as many missions as the new curriculum holds is marked complete and gets the badge.",
            confirmText: "Publish & update everyone",
            destructive: true,
          }
        : {
            title: "Publish this journey?",
            message:
              "Publishing freezes the last SAVED draft as a new version. Unsaved edits in the Curriculum or Settings tabs are NOT included — save them first. New enrollments use the new version; everyone already on the journey keeps theirs.",
            confirmText: "Publish",
          }
    );
    if (!ok) return;
    setPublishing(true);
    try {
      const res = await fetch("/api/journey/program", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          action: "publish",
          program_id: program.id,
          apply_to: applyTo,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        version_number?: number;
        migrated?: number;
        completed_now?: number;
      };
      if (!res.ok) {
        toast.error(j.error ?? "Publish failed");
        return;
      }
      toast.success(
        applyTo === "all"
          ? `Published v${j.version_number} — ${j.migrated ?? 0} active learner${(j.migrated ?? 0) === 1 ? "" : "s"} updated${(j.completed_now ?? 0) > 0 ? `, ${j.completed_now} completed by the new curriculum` : ""}, progress preserved`
          : `Published v${j.version_number} — new enrollments use it; runs in flight keep their version`
      );
      router.refresh();
    } catch {
      toast.error("Publish failed — check your connection and try again");
    } finally {
      setPublishing(false);
    }
  }

  async function createProgram(name?: string) {
    setCreating(true);
    try {
      const res = await fetch("/api/journey/program", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, ...(name ? { name } : {}) }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        program_id?: string;
      };
      if (!res.ok) {
        toast.error(j.error ?? "Could not create the journey");
        return;
      }
      toast.success("Journey created");
      setNewName(null);
      if (j.program_id) {
        router.push(`/${orgSlug}/journey-admin?program=${j.program_id}`);
      }
      router.refresh();
    } catch {
      toast.error("Could not create the journey — check your connection");
    } finally {
      setCreating(false);
    }
  }

  // Journey switcher + inline "new journey" creator (multi-journey, 0063).
  const switcher = (
    <div className="flex flex-wrap items-center gap-2">
      {programs.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => router.push(`/${orgSlug}/journey-admin?program=${p.id}`)}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
            p.id === program?.id
              ? "bg-indigo-600 text-white border-indigo-600"
              : "border-line hover:border-ink"
          }`}
          title={`Priority rank ${p.priority}`}
        >
          {p.icon} {p.name}
        </button>
      ))}
      {newName === null ? (
        <button
          type="button"
          onClick={() => setNewName("")}
          className="px-3 py-1.5 rounded-full text-xs font-semibold border border-dashed border-line text-muted hover:border-ink hover:text-ink"
        >
          + New journey
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Sales Advisor Journey"
            maxLength={80}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) void createProgram(newName.trim());
              if (e.key === "Escape") setNewName(null);
            }}
            className="px-3 py-1.5 border border-line rounded-full text-xs outline-none focus:border-ink w-56"
          />
          <button
            type="button"
            disabled={creating || !newName.trim()}
            onClick={() => createProgram(newName.trim())}
            className="px-3 py-1.5 bg-indigo-600 text-white rounded-full text-xs font-semibold disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            onClick={() => setNewName(null)}
            aria-label="Cancel"
            className="text-muted hover:text-ink"
          >
            <X className="w-4 h-4" />
          </button>
        </span>
      )}
    </div>
  );

  if (!program) {
    return (
      <div className="max-w-2xl">
        <h1 className="serif text-5xl mb-2">Yoddha Journey</h1>
        <p className="text-muted text-sm mb-8 max-w-xl">
          A 90-day mandatory onboarding journey: one mission per working day
          (Mon–Sat), catch-up allowed, no leaderboard points — capability and
          consistency before competition.
        </p>
        <div className="border border-line rounded-2xl bg-paper p-8 text-center">
          <Swords className="w-10 h-10 mx-auto text-indigo-600 mb-3" />
          <h2 className="text-xl font-semibold">Create the 90-Day Yoddha Journey</h2>
          <p className="text-muted text-sm mt-1 mb-5 max-w-md mx-auto">
            Sets up the program with the default milestones. You then assign a
            module to each day and enroll your first learners.
          </p>
          <button
            type="button"
            onClick={() => createProgram()}
            disabled={creating}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> {creating ? "Creating…" : "Create journey"}
          </button>
        </div>
      </div>
    );
  }

  // Only days inside the current journey length count (shrinking days_total
  // leaves harmless stale rows beyond it that publish also ignores).
  const filledDays = days.filter(
    (d) => d.course_id && d.day_number <= program.days_total
  ).length;

  return (
    <div className="max-w-4xl space-y-6">
      {switcher}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="serif text-5xl mb-1">
            {program.icon} {program.name}
          </h1>
          <p className="text-muted text-sm">
            {filledDays}/{program.days_total} days have a module ·{" "}
            {enrollments.filter((e) => e.status === "active").length} active ·{" "}
            {enrollments.filter((e) => e.status === "completed").length}{" "}
            {program.completion_title}s
            {!program.is_active && (
              <span className="ml-2 text-[11px] font-bold uppercase bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                Paused
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          <div className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={() => publish("new")}
              disabled={publishing}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              {publishing
                ? "Publishing…"
                : currentVersion
                  ? "Publish changes"
                  : "Publish v1"}
            </button>
            {currentVersion && (
              <button
                type="button"
                onClick={() => publish("all")}
                disabled={publishing}
                className="px-4 py-2.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50 rounded-lg text-sm font-semibold disabled:opacity-50"
                title="Also move every active learner onto the new version — progress preserved"
              >
                Publish &amp; update everyone
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted mt-1 max-w-md ml-auto">
            {currentVersion
              ? `v${currentVersion.version_number} live · Name, icon, milestones & messages apply to everyone on Save. Curriculum & schedule need a publish: "Publish changes" = new enrollments only · "update everyone" = current learners too, progress kept.`
              : "Not published yet — publish before enrolling anyone"}
          </p>
        </div>
      </header>

      <div className="border-b border-line flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tabs stay MOUNTED (hidden, not unmounted) so switching tabs never
          discards unsaved curriculum/settings edits. Keyed by program so
          switching JOURNEYS remounts them with the right journey's state. */}
      <div hidden={tab !== "curriculum"}>
        <CurriculumTab key={program.id} orgSlug={orgSlug} program={program} days={days} courses={courses} />
      </div>
      <div hidden={tab !== "enrollments"}>
        <EnrollmentsTab
          key={program.id}
          orgSlug={orgSlug}
          program={program}
          enrollments={enrollments}
          members={members}
          today={today}
        />
      </div>
      <div hidden={tab !== "reports"}>
        <ReportsTab
          program={program}
          enrollments={enrollments}
          funnel={funnel}
          today={today}
        />
      </div>
      <div hidden={tab !== "settings"}>
        <SettingsTab
          key={program.id}
          orgSlug={orgSlug}
          program={program}
          audienceOptions={audienceOptions}
          teams={teams}
          courses={courses}
          orgGroups={orgGroups}
        />
      </div>
    </div>
  );
}

/* ---------------- Curriculum ---------------- */

function CurriculumTab({
  orgSlug,
  program,
  days,
  courses,
}: {
  orgSlug: string;
  program: ProgramRow;
  days: DayRow[];
  courses: CourseOption[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<DayRow[]>(() => {
    const byDay = new Map(days.map((d) => [d.day_number, d]));
    return Array.from({ length: program.days_total }, (_, i) => {
      const n = i + 1;
      return byDay.get(n) ?? { day_number: n, course_id: null, mission_title: null };
    });
  });
  const [busy, setBusy] = useState(false);
  const gaps = rows.filter((r) => !r.course_id).length;

  const set = (n: number, patch: Partial<DayRow>) =>
    setRows((rs) => rs.map((r) => (r.day_number === n ? { ...r, ...patch } : r)));

  // Reorder: swap a day's content (module + mission title) with a neighbor.
  const swap = (n: number, dir: -1 | 1) =>
    setRows((rs) => {
      const a = rs.find((r) => r.day_number === n);
      const b = rs.find((r) => r.day_number === n + dir);
      if (!a || !b) return rs;
      return rs.map((r) =>
        r.day_number === n
          ? { ...r, course_id: b.course_id, mission_title: b.mission_title }
          : r.day_number === n + dir
            ? { ...r, course_id: a.course_id, mission_title: a.mission_title }
            : r
      );
    });

  async function saveAll() {
    setBusy(true);
    try {
      const res = await fetch("/api/journey/program", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, program_id: program.id, days: rows }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(j.error ?? "Save failed");
        return;
      }
      toast.success("Curriculum saved — publish to roll it out to new enrollments");
      router.refresh();
    } catch {
      toast.error("Save failed — check your connection and try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Assign one module per day. The same module may repeat; days without a
          module show learners &ldquo;mission being prepared&rdquo; and don&apos;t
          block completion.
          {gaps > 0 && (
            <span className="text-amber-700 font-medium"> {gaps} day{gaps === 1 ? "" : "s"} still empty.</span>
          )}
        </p>
        <button
          type="button"
          onClick={saveAll}
          disabled={busy}
          className="px-5 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save curriculum"}
        </button>
      </div>

      <div className="border border-line rounded-2xl bg-paper divide-y divide-line max-h-[560px] overflow-y-auto">
        {rows.map((r) => (
          <div
            key={r.day_number}
            className="grid grid-cols-[96px_1fr] sm:grid-cols-[96px_1fr_1fr] gap-2 items-center px-3 py-2"
          >
            <span className="text-xs font-bold text-muted inline-flex items-center gap-1">
              Day {r.day_number}
              <span className="inline-flex flex-col leading-none">
                <button
                  type="button"
                  onClick={() => swap(r.day_number, -1)}
                  disabled={r.day_number === 1}
                  title="Move this module one day earlier"
                  className="text-muted hover:text-ink disabled:opacity-30 text-[10px]"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => swap(r.day_number, 1)}
                  disabled={r.day_number === rows.length}
                  title="Move this module one day later"
                  className="text-muted hover:text-ink disabled:opacity-30 text-[10px]"
                >
                  ▼
                </button>
              </span>
            </span>
            <select
              value={r.course_id ?? ""}
              onChange={(e) => set(r.day_number, { course_id: e.target.value || null })}
              className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink min-w-0"
            >
              <option value="">— no module —</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={r.mission_title ?? ""}
              onChange={(e) => set(r.day_number, { mission_title: e.target.value || null })}
              placeholder="Mission title (optional — defaults to module name)"
              maxLength={120}
              className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink min-w-0 col-span-2 sm:col-span-1"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Enrollments ---------------- */

function EnrollmentsTab({
  orgSlug,
  program,
  enrollments,
  members,
  today,
}: {
  orgSlug: string;
  program: ProgramRow;
  enrollments: EnrollmentRow[];
  members: MemberOption[];
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState(today);
  const [busy, setBusy] = useState(false);

  const activeIds = useMemo(
    () => new Set(enrollments.filter((e) => e.status === "active").map((e) => e.user_id)),
    [enrollments]
  );
  const pool = useMemo(
    () =>
      members
        .filter((m) => !activeIds.has(m.user_id))
        .filter(
          (m) =>
            !q.trim() ||
            m.name.toLowerCase().includes(q.toLowerCase()) ||
            m.email.toLowerCase().includes(q.toLowerCase())
        )
        .slice(0, 50),
    [members, activeIds, q]
  );

  async function enroll() {
    setBusy(true);
    try {
      const res = await fetch("/api/journey/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          program_id: program.id,
          user_ids: [...selected],
          start_date: startDate,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        enrolled?: number;
        skipped_active?: number;
        skipped_not_member?: number;
      };
      if (!res.ok) {
        toast.error(j.error ?? "Enrollment failed");
        return;
      }
      const enrolled = j.enrolled ?? 0;
      const skipped = (j.skipped_active ?? 0) + (j.skipped_not_member ?? 0);
      const skippedNote = skipped > 0 ? ` (${skipped} skipped: already enrolled or not an active member)` : "";
      if (enrolled > 0) {
        toast.success(`${enrolled} learner${enrolled === 1 ? "" : "s"} enrolled${skippedNote}`);
      } else {
        toast.error(`Nobody was enrolled${skippedNote || " — refresh and try again"}`);
      }
      setSelected(new Set());
      router.refresh();
    } catch {
      toast.error("Enrollment failed — check your connection and try again");
    } finally {
      setBusy(false);
    }
  }

  async function reset(e: EnrollmentRow) {
    const ok = await confirm({
      title: "Reset this journey?",
      message: `${e.name}'s current run will be deactivated (progress is kept for records). You can re-enroll them with a fresh start date afterwards.`,
      confirmText: "Reset journey",
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await fetch("/api/journey/enrollments", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, enrollment_id: e.id, action: "reset" }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(j.error ?? "Reset failed");
        return;
      }
      toast.success("Journey reset");
      router.refresh();
    } catch {
      toast.error("Reset failed — check your connection and try again");
    }
  }

  return (
    <div className="space-y-6">
      {/* Enroll */}
      <section className="border border-line rounded-2xl bg-paper p-4 sm:p-5 space-y-3">
        <h3 className="text-sm font-semibold">Enroll learners</h3>
        {!program.current_version_id && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Publish the journey first — every enrollment pins the published
            version so later edits never disturb runs in flight.
          </p>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or email…"
            className="flex-1 min-w-[200px] px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
          <label className="text-xs text-muted inline-flex items-center gap-2">
            Start date
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-sm"
            />
          </label>
          <button
            type="button"
            onClick={enroll}
            disabled={busy || selected.size === 0 || !program.current_version_id}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Enrolling…" : `Enroll ${selected.size || ""}`}
          </button>
        </div>
        <div className="max-h-52 overflow-y-auto divide-y divide-line border border-line rounded-lg">
          {pool.length === 0 ? (
            <p className="text-xs text-muted p-3">No matching un-enrolled members.</p>
          ) : (
            pool.map((m) => (
              <label key={m.user_id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-canvas/60">
                <input
                  type="checkbox"
                  checked={selected.has(m.user_id)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(m.user_id);
                      else n.delete(m.user_id);
                      return n;
                    })
                  }
                  className="h-4 w-4 accent-indigo-600"
                />
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-muted truncate">{m.email}</span>
              </label>
            ))
          )}
        </div>
      </section>

      {/* Roster */}
      <section className="border border-line rounded-2xl bg-paper overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted border-b border-line">
              <th className="px-4 py-3">Learner</th>
              <th className="px-4 py-3">Start</th>
              <th className="px-4 py-3">Progress</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {enrollments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted text-sm">
                  Nobody is on the journey yet — enroll your first learners above.
                </td>
              </tr>
            )}
            {enrollments.map((e) => {
              // Each run is measured against its PINNED version's rules.
              const st = computeJourneyState({
                startDate: e.start_date,
                today,
                completedCount: e.completed_count,
                daysTotal: e.days_total,
                countSundays: e.count_sundays === true,
                courseDays: e.course_days,
              });
              return (
                <tr key={e.id}>
                  <td className="px-4 py-3">
                    <span className="font-medium">{e.name}</span>
                    <span className="block text-[11px] text-muted truncate">
                      {e.email}
                      {e.version_number > 0 && ` · v${e.version_number}`}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted">{e.start_date}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {e.completed_count}/{e.days_total}
                    {e.status === "active" && st.behindDays > 0 && (
                      <span className="ml-2 text-[11px] text-amber-700 font-semibold">
                        {st.behindDays} behind
                      </span>
                    )}
                    {e.status === "active" && st.behindDays === 0 && st.allowedDay > 0 && (
                      <span className="ml-2 text-[11px] text-emerald-700">on track</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                        e.status === "completed"
                          ? "bg-amber-100 text-amber-800"
                          : e.status === "active"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-canvas text-muted border border-line"
                      }`}
                    >
                      {e.status === "completed" ? `👑 ${program.completion_title}` : e.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {e.status !== "reset" && (
                      <button
                        type="button"
                        onClick={() => reset(e)}
                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1 border border-line rounded hover:border-red-500 hover:text-red-700"
                      >
                        <RotateCcw className="w-3 h-3" /> Reset
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* ---------------- Reports: cohorts, funnel, overdue ---------------- */

function ReportsTab({
  program,
  enrollments,
  funnel,
  today,
}: {
  program: ProgramRow;
  enrollments: EnrollmentRow[];
  funnel: FunnelRow[];
  today: string;
}) {
  // Per-enrollment state against each run's PINNED version rules.
  const rows = useMemo(
    () =>
      enrollments
        .filter((e) => e.status !== "reset")
        .map((e) => ({
          ...e,
          state: computeJourneyState({
            startDate: e.start_date,
            today,
            completedCount: e.completed_count,
            daysTotal: e.days_total,
            countSundays: e.count_sundays === true,
            courseDays: e.course_days,
          }),
        })),
    [enrollments, today]
  );
  const active = rows.filter((r) => r.status === "active");
  const completed = rows.filter((r) => r.status === "completed");
  const behind = active.filter((r) => r.state.behindDays > 0);
  const completionRate = rows.length
    ? Math.round((completed.length / rows.length) * 100)
    : 0;
  const avgPct = active.length
    ? Math.round(active.reduce((s, r) => s + r.state.pct, 0) / active.length)
    : 0;

  // Cohorts = enrollments grouped by start date (a batch enrolled together).
  const cohorts = useMemo(() => {
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      const bucket = map.get(r.start_date);
      if (bucket) bucket.push(r);
      else map.set(r.start_date, [r]);
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([start, list]) => ({
        start,
        total: list.length,
        completed: list.filter((r) => r.status === "completed").length,
        behind: list.filter((r) => r.status === "active" && r.state.behindDays > 0)
          .length,
        avgPct: Math.round(list.reduce((s, r) => s + r.state.pct, 0) / list.length),
      }));
  }, [rows]);

  const overdue = [...behind].sort((a, b) => b.state.behindDays - a.state.behindDays);
  const maxFunnel = Math.max(1, ...funnel.map((f) => f.learners));

  return (
    <div className="space-y-6">
      {/* Summary */}
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          ["Enrolled", String(rows.length)],
          ["Active", String(active.length)],
          [`${program.completion_title}s`, String(completed.length)],
          ["Completion rate", `${completionRate}%`],
          ["Avg progress (active)", `${avgPct}%`],
        ].map(([l, v]) => (
          <div key={l} className="bg-paper border border-line rounded-2xl px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-muted font-bold">{l}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{v}</p>
          </div>
        ))}
      </section>

      {/* Overdue / behind */}
      <section className="border border-line rounded-2xl bg-paper overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-line flex items-center justify-between">
          <h3 className="text-sm font-semibold">Behind schedule</h3>
          <span className="text-xs text-muted">
            {behind.length} of {active.length} active learner{active.length === 1 ? "" : "s"}
          </span>
        </div>
        {overdue.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted text-center">
            Everyone is on track. 🎉
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted border-b border-line">
                <th className="px-4 py-2.5">Learner</th>
                <th className="px-4 py-2.5">Day</th>
                <th className="px-4 py-2.5">Behind</th>
                <th className="px-4 py-2.5">Version / started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {overdue.slice(0, 15).map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{r.name}</span>
                    <span className="block text-[11px] text-muted truncate">{r.email}</span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {r.state.currentDay}/{r.days_total}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-amber-800 bg-amber-100 text-[11px] font-bold px-2 py-0.5 rounded-full">
                      {r.state.behindDays} day{r.state.behindDays === 1 ? "" : "s"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    v{r.version_number} · started {r.start_date}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Day funnel */}
      <section className="border border-line rounded-2xl bg-paper p-4 sm:p-5">
        <h3 className="text-sm font-semibold mb-1">Day-by-day completion funnel</h3>
        <p className="text-xs text-muted mb-3">
          How many learners have completed each day — where the bars shrink is
          where the journey loses people.
        </p>
        {funnel.length === 0 ? (
          <p className="text-sm text-muted py-4 text-center">No completions yet.</p>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
            {funnel.map((f) => (
              <div key={f.day_number} className="flex items-center gap-2 text-xs">
                <span className="w-12 shrink-0 text-muted tabular-nums">Day {f.day_number}</span>
                <div className="flex-1 h-4 bg-canvas rounded overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded"
                    style={{ width: `${Math.round((f.learners / maxFunnel) * 100)}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right tabular-nums font-semibold">
                  {f.learners}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Cohorts */}
      <section className="border border-line rounded-2xl bg-paper overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-line">
          <h3 className="text-sm font-semibold">Cohorts (by start date)</h3>
        </div>
        {cohorts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted text-center">No enrollments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted border-b border-line">
                <th className="px-4 py-2.5">Started</th>
                <th className="px-4 py-2.5 text-right">Learners</th>
                <th className="px-4 py-2.5 text-right">{program.completion_title}s</th>
                <th className="px-4 py-2.5 text-right">Behind</th>
                <th className="px-4 py-2.5 text-right">Avg progress</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {cohorts.map((c) => (
                <tr key={c.start}>
                  <td className="px-4 py-2.5 tabular-nums">{c.start}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.total}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700 font-semibold">
                    {c.completed}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">
                    {c.behind}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
                    {c.avgPct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* ---------------- Settings, rules, milestones & copy ---------------- */

const COPY_LABELS: Record<keyof JourneyCopy, string> = {
  mission_label: "Mission card label",
  mission_subtitle: "Mission card subtitle",
  cta_start: "Start button text",
  cta_resume: "Resume button text",
  on_track_note: "On-track note",
  revise_hint: "Revision hint (day grid)",
  locked_message: "Locked-mission message",
  preparing_title: "Empty-day title",
  preparing_body: "Empty-day body",
  not_started_title: "Before-start title",
  not_started_body: "Before-start body",
  empty_title: "Not-enrolled title",
  empty_body: "Not-enrolled body",
  paused_title: "Paused title",
  paused_body: "Paused body",
  footer_note: "Path footer note",
  banner_line: "Dashboard banner line",
  completion_line: "Completion celebration line",
};

/** One audience dimension: collapsible checkbox list. Module-level so React
 *  keeps input identity across renders. */
function AudienceDim({
  label,
  options,
  selected,
  onChange,
  emptyLabel = "all",
}: {
  label: string;
  options: Array<{ value: string; display: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
  emptyLabel?: string;
}) {
  if (options.length === 0) return null;
  return (
    <details className="border border-line rounded-lg">
      <summary className="px-3 py-2 text-xs font-medium cursor-pointer select-none flex items-center justify-between">
        <span>{label}</span>
        <span className={selected.length > 0 ? "text-indigo-700 font-bold" : "text-muted"}>
          {selected.length > 0 ? `${selected.length} selected` : emptyLabel}
        </span>
      </summary>
      <div className="px-3 pb-2 max-h-44 overflow-y-auto space-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, o.value]
                    : selected.filter((v) => v !== o.value)
                )
              }
              className="h-3.5 w-3.5 accent-indigo-600"
            />
            <span className="truncate">{o.display}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function SettingsTab({
  orgSlug,
  program,
  audienceOptions = {},
  teams = [],
  courses = [],
  orgGroups = [],
}: {
  orgSlug: string;
  program: ProgramRow;
  audienceOptions?: Record<string, string[]>;
  teams?: Array<{ id: string; name: string }>;
  courses?: CourseOption[];
  orgGroups?: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(program.name);
  const [icon, setIcon] = useState(program.icon);
  const [daysTotal, setDaysTotal] = useState(program.days_total);
  const [countSundays, setCountSundays] = useState(program.count_sundays === true);
  const [isActive, setIsActive] = useState(program.is_active !== false);
  const [completionTitle, setCompletionTitle] = useState(program.completion_title);
  const [autoEnroll, setAutoEnroll] = useState(program.auto_enroll_new_users === true);
  const [nudgeEnabled, setNudgeEnabled] = useState(program.nudge_enabled !== false);
  const [nudgeBehind, setNudgeBehind] = useState(program.nudge_behind_days ?? 2);
  const [nudgeCooldown, setNudgeCooldown] = useState(program.nudge_cooldown_days ?? 3);
  const [milestones, setMilestones] = useState(() =>
    effectiveMilestones(program.milestones, program.days_total)
  );
  const [copyText, setCopyText] = useState<JourneyCopy>(() =>
    effectiveJourneyCopy(program.copy)
  );
  const [busy, setBusy] = useState(false);
  // Multi-journey (0063): priority rank, mandatory flag, audience rules.
  const [priority, setPriority] = useState(program.priority ?? 100);
  const [isMandatory, setIsMandatory] = useState(program.is_mandatory !== false);
  const [audience, setAudience] = useState<Record<string, string[]>>(() => {
    const a = (program.audience ?? {}) as Record<string, string[]>;
    return {
      designations: a.designations ?? [],
      job_roles: a.job_roles ?? [],
      cities: a.cities ?? [],
      verticals: a.verticals ?? [],
      branches: a.branches ?? [],
      team_ids: a.team_ids ?? [],
      group_ids: a.group_ids ?? [],
    };
  });
  const [syncBusy, setSyncBusy] = useState(false);
  // Focused dashboard (0064).
  const [focusEnabled, setFocusEnabled] = useState(program.focus_enabled === true);
  const [focusPinned, setFocusPinned] = useState<string[]>(
    Array.isArray(program.focus_pinned) ? program.focus_pinned : []
  );
  // Deadline + manager escalation (0065).
  const [deadlineDays, setDeadlineDays] = useState<number | "">(
    typeof program.deadline_days === "number" ? program.deadline_days : ""
  );
  const [escalationEnabled, setEscalationEnabled] = useState(
    program.escalation_enabled === true
  );
  const [escalateAfter, setEscalateAfter] = useState(
    program.escalation_after_days ?? 3
  );
  const audDim = (k: string) => (next: string[]) =>
    setAudience((a) => ({ ...a, [k]: next }));
  const audienceEmpty = Object.values(audience).every((v) => v.length === 0);

  async function syncAudience() {
    setSyncBusy(true);
    try {
      const res = await fetch("/api/journey/program", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, action: "sync_audience", program_id: program.id }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        enrolled?: number;
        matched?: number;
      };
      if (!res.ok) {
        toast.error(j.error ?? "Sync failed");
        return;
      }
      toast.success(
        `${j.enrolled ?? 0} member${(j.enrolled ?? 0) === 1 ? "" : "s"} enrolled (${j.matched ?? 0} match the audience)`
      );
      router.refresh();
    } catch {
      toast.error("Sync failed — check your connection");
    } finally {
      setSyncBusy(false);
    }
  }

  const setMs = (i: number, patch: Partial<(typeof milestones)[number]>) =>
    setMilestones((ms) => ms.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));

  async function save() {
    setBusy(true);
    try {
      // Only send copy keys that differ from defaults, so untouched strings
      // keep tracking future default improvements.
      const copyOverrides: Record<string, string> = {};
      for (const k of Object.keys(DEFAULT_JOURNEY_COPY) as Array<keyof JourneyCopy>) {
        if (copyText[k].trim() && copyText[k].trim() !== DEFAULT_JOURNEY_COPY[k]) {
          copyOverrides[k] = copyText[k].trim();
        }
      }
      const res = await fetch("/api/journey/program", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          program_id: program.id,
          name,
          icon,
          days_total: daysTotal,
          count_sundays: countSundays,
          is_active: isActive,
          completion_title: completionTitle,
          auto_enroll_new_users: autoEnroll,
          nudge_enabled: nudgeEnabled,
          nudge_behind_days: nudgeBehind,
          nudge_cooldown_days: nudgeCooldown,
          priority,
          is_mandatory: isMandatory,
          focus_enabled: focusEnabled,
          focus_pinned: focusPinned.length > 0 ? focusPinned : null,
          deadline_days: deadlineDays === "" ? null : deadlineDays,
          escalation_enabled: escalationEnabled,
          escalation_after_days: escalateAfter,
          audience: audienceEmpty
            ? null
            : Object.fromEntries(
                Object.entries(audience).filter(([, v]) => v.length > 0)
              ),
          // Clamp to the journey length: a day past the end would be saved
          // yet invisible, then silently dropped by the next save.
          milestones: [...milestones]
            .map((m) => ({ ...m, day: Math.min(daysTotal, m.day) }))
            .sort((a, b) => a.day - b.day),
          copy: Object.keys(copyOverrides).length > 0 ? copyOverrides : null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(j.error ?? "Save failed");
        return;
      }
      toast.success("Saved — remember to Publish so new enrollments pick it up");
      router.refresh();
    } catch {
      toast.error("Save failed — check your connection and try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="border border-line rounded-2xl bg-paper p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-muted mb-1">Journey name</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
        </label>
        <div className="grid grid-cols-[80px_1fr] gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-muted mb-1">Icon</span>
            <input
              type="text"
              value={icon}
              maxLength={8}
              onChange={(e) => setIcon(e.target.value)}
              className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm text-center"
            />
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-muted mb-1">
              Completion title
            </span>
            <input
              type="text"
              value={completionTitle}
              maxLength={40}
              onChange={(e) => setCompletionTitle(e.target.value)}
              className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
            />
          </label>
        </div>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-muted mb-1">
            Journey length (days)
          </span>
          <input
            type="number"
            min={1}
            max={365}
            value={daysTotal}
            onChange={(e) =>
              setDaysTotal(Math.max(1, Math.min(365, Number(e.target.value) || 1)))
            }
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm tabular-nums"
          />
        </label>
        <div className="space-y-2">
          <ToggleRow
            label="Count Sundays"
            hint="Off = working days Mon–Sat; Sundays don't advance the drip"
            checked={countSundays}
            onChange={setCountSundays}
          />
          <ToggleRow
            label="Journey enabled"
            hint="Off pauses everyone: missions can't launch, progress is preserved"
            checked={isActive}
            onChange={setIsActive}
          />
          <ToggleRow
            label="Auto-enroll new members"
            hint="New users matching the audience below start automatically (needs a published version)"
            checked={autoEnroll}
            onChange={setAutoEnroll}
          />
        </div>
      </section>

      {/* Audience & priority (multi-journey, 0063) */}
      <section className="border border-line rounded-2xl bg-paper p-4 sm:p-5 space-y-3">
        <h3 className="text-sm font-semibold">Audience &amp; priority</h3>
        <p className="text-xs text-muted">
          Who this journey is for, driven by the profile database. Leave a
          filter empty to not restrict by it; leave everything empty and the
          journey targets all active members. Filters combine with AND.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-muted mb-1">
              Priority rank (1 = highest)
            </span>
            <input
              type="number"
              min={1}
              max={999}
              value={priority}
              onChange={(e) =>
                setPriority(Math.max(1, Math.min(999, Number(e.target.value) || 100)))
              }
              className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm tabular-nums"
            />
            <span className="block text-[11px] text-muted mt-1">
              When a learner holds several journeys, the best rank leads their
              journey page and dashboard banner.
            </span>
          </label>
          <div>
            <ToggleRow
              label="Mandatory journey"
              hint="Drives the focused dashboard and manager escalations (later phases)"
              checked={isMandatory}
              onChange={setIsMandatory}
            />
          </div>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <AudienceDim
            label="Designations"
            options={(audienceOptions.designation ?? []).map((v) => ({ value: v, display: v }))}
            selected={audience.designations}
            onChange={audDim("designations")}
          />
          <AudienceDim
            label="Job roles"
            options={(audienceOptions.job_role ?? []).map((v) => ({ value: v, display: v }))}
            selected={audience.job_roles}
            onChange={audDim("job_roles")}
          />
          <AudienceDim
            label="Cities"
            options={(audienceOptions.city ?? []).map((v) => ({ value: v, display: v }))}
            selected={audience.cities}
            onChange={audDim("cities")}
          />
          <AudienceDim
            label="Business verticals"
            options={(audienceOptions.business_vertical ?? []).map((v) => ({ value: v, display: v }))}
            selected={audience.verticals}
            onChange={audDim("verticals")}
          />
          <AudienceDim
            label="Branches"
            options={(audienceOptions.branch ?? []).map((v) => ({ value: v, display: v }))}
            selected={audience.branches}
            onChange={audDim("branches")}
          />
          <AudienceDim
            label="Teams"
            options={teams.map((t) => ({ value: t.id, display: t.name }))}
            selected={audience.team_ids}
            onChange={audDim("team_ids")}
          />
          <AudienceDim
            label="Custom groups"
            options={orgGroups.map((g) => ({ value: g.id, display: g.name }))}
            selected={audience.group_ids}
            onChange={audDim("group_ids")}
          />
        </div>
        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-[11px] text-muted">
            Save first, then Sync to enroll every matching member who isn&apos;t
            on the journey yet. New members auto-enroll on creation when the
            toggle above is on.
          </p>
          <button
            type="button"
            onClick={syncAudience}
            disabled={syncBusy}
            className="px-3.5 py-2 border border-indigo-300 text-indigo-700 hover:bg-indigo-50 rounded-lg text-xs font-semibold disabled:opacity-50 shrink-0"
          >
            {syncBusy ? "Syncing…" : "Sync audience now"}
          </button>
        </div>
      </section>

      {/* Focused dashboard (0064) */}
      <section className="border border-line rounded-2xl bg-paper p-4 sm:p-5 space-y-3">
        <h3 className="text-sm font-semibold">Focused dashboard</h3>
        <p className="text-xs text-muted">
          While this journey is active and mandatory, enrolled learners&apos;
          dashboards lead with the journey (plus any courses you pin below)
          and collapse everything else into an &ldquo;Other assigned
          learning&rdquo; section — nothing is hidden, deadlines stay
          reachable. The dashboard restores itself on completion.
        </p>
        <ToggleRow
          label="Enable focus mode"
          hint="Applies only to this journey's enrolled learners, only while it's active"
          checked={focusEnabled}
          onChange={setFocusEnabled}
        />
        {focusEnabled && (
          <div className="max-w-md">
            <AudienceDim
              label="Pinned courses (stay visible alongside the journey)"
              options={courses.map((cs) => ({ value: cs.id, display: cs.title }))}
              selected={focusPinned}
              onChange={(next) => setFocusPinned(next.slice(0, 20))}
              emptyLabel="none"
            />
          </div>
        )}
      </section>

      <section className="border border-line rounded-2xl bg-paper p-4 sm:p-5 space-y-3">
        <h3 className="text-sm font-semibold">Behind-schedule nudges</h3>
        <p className="text-xs text-muted">
          A daily email (09:30 IST) to learners who fall behind, sent through
          your org&apos;s branded pipeline. The wording is editable like any
          other template under Broadcast → Templates → &ldquo;journey_nudge&rdquo;.
        </p>
        <ToggleRow
          label="Send nudge emails"
          hint="Off = no automated reminders; the Reports tab still shows who's behind"
          checked={nudgeEnabled}
          onChange={setNudgeEnabled}
        />
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-muted mb-1">
              Nudge when behind by (days)
            </span>
            <input
              type="number"
              min={1}
              max={30}
              value={nudgeBehind}
              onChange={(e) =>
                setNudgeBehind(Math.max(1, Math.min(30, Number(e.target.value) || 1)))
              }
              className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm tabular-nums"
            />
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-muted mb-1">
              Days between nudges
            </span>
            <input
              type="number"
              min={1}
              max={30}
              value={nudgeCooldown}
              onChange={(e) =>
                setNudgeCooldown(Math.max(1, Math.min(30, Number(e.target.value) || 1)))
              }
              className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm tabular-nums"
            />
          </label>
        </div>

        {/* Deadline + manager escalation (0065) */}
        <div className="border-t border-line pt-3 space-y-3">
          <h4 className="text-sm font-semibold">Deadline &amp; manager escalation</h4>
          <p className="text-xs text-muted">
            Early reminders go to the learner only. Once someone stays behind
            past the threshold — or misses the deadline — their L1 manager
            (from the profile&apos;s Line Manager mapping) is copied with a
            manager-worded email (&ldquo;journey_escalation&rdquo; template).
            Everything stops automatically on completion.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-muted mb-1">
                Deadline (days from start; empty = none)
              </span>
              <input
                type="number"
                min={1}
                max={730}
                value={deadlineDays}
                onChange={(e) =>
                  setDeadlineDays(
                    e.target.value === ""
                      ? ""
                      : Math.max(1, Math.min(730, Number(e.target.value) || 1))
                  )
                }
                placeholder="e.g. 45"
                className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm tabular-nums"
              />
              <span className="block text-[11px] text-muted mt-1">
                Counted like the drip (working days). Missing it always
                escalates.
              </span>
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-muted mb-1">
                Escalate when behind by (days)
              </span>
              <input
                type="number"
                min={1}
                max={30}
                value={escalateAfter}
                onChange={(e) =>
                  setEscalateAfter(Math.max(1, Math.min(30, Number(e.target.value) || 1)))
                }
                className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm tabular-nums"
              />
            </label>
          </div>
          <ToggleRow
            label="Escalate to L1 managers"
            hint="Copies the learner's Line Manager once the threshold or deadline is crossed; same cadence as the learner nudges"
            checked={escalationEnabled}
            onChange={setEscalationEnabled}
          />
        </div>
      </section>

      <section className="border border-line rounded-2xl bg-paper p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Milestones</h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                setMilestones((ms) => [
                  ...ms,
                  {
                    day: Math.min(daysTotal, (ms[ms.length - 1]?.day ?? 0) + 10),
                    icon: "⭐",
                    name: "New milestone",
                    message: "",
                  },
                ])
              }
              className="text-xs border border-line rounded-lg px-2.5 py-1.5 hover:border-ink inline-flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
            <button
              type="button"
              onClick={() =>
                setMilestones(DEFAULT_MILESTONES.filter((m) => m.day <= daysTotal))
              }
              className="text-xs border border-line rounded-lg px-2.5 py-1.5 hover:border-ink"
            >
              Reset to defaults
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {milestones.map((m, i) => (
            <div
              key={i}
              className="grid grid-cols-[70px_56px_1fr_32px] sm:grid-cols-[70px_56px_200px_1fr_32px] gap-2 items-center"
            >
              <input
                type="number"
                min={1}
                max={daysTotal}
                value={m.day}
                onChange={(e) => setMs(i, { day: Math.max(1, Number(e.target.value) || 1) })}
                aria-label="Milestone day"
                className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-sm tabular-nums"
              />
              <input
                type="text"
                value={m.icon}
                maxLength={8}
                onChange={(e) => setMs(i, { icon: e.target.value })}
                aria-label="Milestone icon"
                className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-sm text-center"
              />
              <input
                type="text"
                value={m.name}
                maxLength={60}
                onChange={(e) => setMs(i, { name: e.target.value })}
                aria-label="Milestone name"
                className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-sm col-span-2 sm:col-span-1"
              />
              <input
                type="text"
                value={m.message}
                maxLength={200}
                onChange={(e) => setMs(i, { message: e.target.value })}
                aria-label="Milestone message"
                placeholder="Message shown when reached"
                className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-sm col-span-3 sm:col-span-1"
              />
              <button
                type="button"
                onClick={() => setMilestones((ms) => ms.filter((_, idx) => idx !== i))}
                title="Remove milestone"
                aria-label="Remove milestone"
                className="justify-self-end text-muted hover:text-red-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="border border-line rounded-2xl bg-paper p-4 sm:p-5">
        <h3 className="text-sm font-semibold mb-1">Journey copy</h3>
        <p className="text-xs text-muted mb-3">
          Every learner-facing sentence is editable. Leaving a field matching
          the default keeps it on the default.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(Object.keys(DEFAULT_JOURNEY_COPY) as Array<keyof JourneyCopy>).map((k) => (
            <label key={k} className="block">
              <span className="block text-[11px] uppercase tracking-wide text-muted mb-1">
                {COPY_LABELS[k]}
              </span>
              <input
                type="text"
                value={copyText[k]}
                maxLength={300}
                onChange={(e) => setCopyText((c) => ({ ...c, [k]: e.target.value }))}
                placeholder={DEFAULT_JOURNEY_COPY[k]}
                className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
              />
            </label>
          ))}
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="px-5 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted mt-0.5">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-indigo-600 shrink-0"
      />
    </label>
  );
}

