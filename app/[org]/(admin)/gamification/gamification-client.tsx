"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Zap, Flame, Award, EyeOff, Trophy, Medal, Shield, Plus } from "lucide-react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { KpiCard, KpiStrip } from "@/components/admin/kpi-card";
import { TabStrip, type Tab } from "@/components/admin/tab-strip";
import { StatusPill } from "@/components/admin/role-pill";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";

export type GamificationSettings = {
  organization_id: string;
  enabled: boolean;
  leaderboard_enabled: boolean;
  allow_opt_out: boolean;
  allow_avatar_uploads: boolean;
  board_overall: boolean;
  board_most_active: boolean;
  board_highest_scorer: boolean;
  board_most_improved: boolean;
  board_longest_streak: boolean;
  board_team: boolean;
  leaderboard_team_leader_view: boolean;
  timezone: string;
  xp_course_completion: number;
  xp_perfect_score_bonus: number;
  xp_high_score_bonus: number;
  xp_daily_activity: number;
  xp_streak_7_bonus: number;
  xp_streak_30_bonus: number;
  daily_xp_cap: number;
  min_completion_seconds: number;
  level_thresholds: Array<{ level: number; name: string; xp: number }> | null;
};

export type BadgeRow = {
  id: string;
  organization_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  criteria_type: string;
  threshold: number | null;
  enabled: boolean;
  earned_count?: number;
};

const DEFAULT_LADDER = [
  { level: 1, name: "Starter", xp: 0 },
  { level: 2, name: "Explorer", xp: 100 },
  { level: 3, name: "Learner", xp: 300 },
  { level: 4, name: "Performer", xp: 700 },
  { level: 5, name: "Professional", xp: 1500 },
  { level: 6, name: "Expert", xp: 3000 },
  { level: 7, name: "Yodha", xp: 6000 },
  { level: 8, name: "Master Yodha", xp: 12000 },
];

const XP_RULE_LABELS: Array<{
  key: keyof GamificationSettings;
  label: string;
  hint: string;
}> = [
  { key: "xp_course_completion", label: "Course completed", hint: "First completion of each course — repeat attempts never re-award" },
  { key: "xp_perfect_score_bonus", label: "Perfect score bonus", hint: "Score of 100%" },
  { key: "xp_high_score_bonus", label: "High score bonus", hint: "Score of 90% or higher" },
  { key: "xp_daily_activity", label: "Daily activity", hint: "First learning activity of each day" },
  { key: "xp_streak_7_bonus", label: "7-day streak bonus", hint: "Awarded once per streak run" },
  { key: "xp_streak_30_bonus", label: "30-day streak bonus", hint: "Awarded once per streak run" },
  { key: "daily_xp_cap", label: "Daily XP cap", hint: "Maximum XP a learner can earn per day (0 = uncapped)" },
  { key: "min_completion_seconds", label: "Minimum completion seconds", hint: "Completions faster than this earn no XP when unscored (0 = off)" },
];

const CRITERIA_OPTIONS = [
  { value: "courses_completed", label: "Courses completed ≥" },
  { value: "streak_days", label: "Streak days ≥" },
  { value: "assessments_passed", label: "Assessments passed ≥" },
  { value: "perfect_score", label: "Perfect scores ≥" },
  { value: "completion_speed", label: "Completed within (minutes)" },
  { value: "manual", label: "Manually awarded" },
];

type TabKey = "xp" | "levels" | "badges" | "privacy";

export function GamificationClient({
  orgSlug,
  settings,
  badges,
  kpis,
}: {
  orgSlug: string;
  settings: GamificationSettings | null;
  badges: BadgeRow[];
  kpis: { xp30d: number; activeStreaks: number; badges30d: number; optOuts: number };
}) {
  const [tab, setTab] = useState<TabKey>("xp");
  const tabs: Tab<TabKey>[] = [
    { key: "xp", label: "XP rules", icon: <Zap className="w-4 h-4" /> },
    { key: "levels", label: "Levels", icon: <Medal className="w-4 h-4" /> },
    { key: "badges", label: "Badges", icon: <Award className="w-4 h-4" />, count: badges.length },
    { key: "privacy", label: "Leaderboard & privacy", icon: <Shield className="w-4 h-4" /> },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Gamification"
        description="XP, levels, badges and leaderboard controls. Changes apply to future activity — past XP is never recalculated."
      />
      <KpiStrip>
        <KpiCard label="XP awarded (30d)" value={kpis.xp30d.toLocaleString()} icon={<Zap className="w-5 h-5" />} accent="text-amber-500" />
        <KpiCard label="Active streaks" value={kpis.activeStreaks} icon={<Flame className="w-5 h-5" />} accent="text-orange-500" />
        <KpiCard label="Badges earned (30d)" value={kpis.badges30d} icon={<Award className="w-5 h-5" />} accent="text-emerald-600" />
        <KpiCard label="Leaderboard opt-outs" value={kpis.optOuts} icon={<EyeOff className="w-5 h-5" />} accent="text-slate-500" />
        <KpiCard label="Leaderboards" value={settings?.leaderboard_enabled === false ? "Off" : "On"} icon={<Trophy className="w-5 h-5" />} accent="text-indigo-600" />
      </KpiStrip>

      <TabStrip<TabKey> tabs={tabs} active={tab} onChange={setTab} />

      {tab === "xp" && <XpRulesTab orgSlug={orgSlug} settings={settings} />}
      {tab === "levels" && <LevelsTab orgSlug={orgSlug} settings={settings} />}
      {tab === "badges" && <BadgesTab orgSlug={orgSlug} badges={badges} />}
      {tab === "privacy" && <PrivacyTab orgSlug={orgSlug} settings={settings} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-line rounded-2xl bg-paper p-6 space-y-4">
      <div>
        <h2 className="serif text-2xl">{title}</h2>
        {description && <p className="text-xs text-muted mt-1">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function SaveRow({
  busy,
  error,
  saved,
  onSave,
}: {
  busy: boolean;
  error: string | null;
  saved: boolean;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-3 pt-2">
      {error && <p className="text-sm text-red-700">{error}</p>}
      {saved && <p className="text-sm text-emerald-700">Saved.</p>}
      <button
        type="button"
        onClick={onSave}
        disabled={busy}
        className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function useSectionSave() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/gamification/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Save failed");
      return false;
    }
    setSaved(true);
    router.refresh();
    return true;
  }
  return { busy, error, saved, save };
}

function XpRulesTab({
  orgSlug,
  settings,
}: {
  orgSlug: string;
  settings: GamificationSettings | null;
}) {
  const [values, setValues] = useState<Record<string, number>>(() => {
    const v: Record<string, number> = {};
    for (const r of XP_RULE_LABELS) {
      v[r.key] = (settings?.[r.key] as number | undefined) ?? 0;
    }
    return v;
  });
  const { busy, error, saved, save } = useSectionSave();

  return (
    <SectionCard
      title="XP rules"
      description="Points awarded per learning event. Applies to future activity only."
    >
      <div className="divide-y divide-line">
        {XP_RULE_LABELS.map((r) => (
          <div key={r.key} className="py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{r.label}</div>
              <div className="text-xs text-muted">{r.hint}</div>
            </div>
            <input
              type="number"
              min={0}
              value={values[r.key]}
              onChange={(e) =>
                setValues((s) => ({ ...s, [r.key]: Number(e.target.value) }))
              }
              className="w-28 px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm text-right tabular-nums"
            />
          </div>
        ))}
      </div>
      <SaveRow
        busy={busy}
        error={error}
        saved={saved}
        onSave={() => save({ orgSlug, section: "xp_rules", rules: values })}
      />
    </SectionCard>
  );
}

function LevelsTab({
  orgSlug,
  settings,
}: {
  orgSlug: string;
  settings: GamificationSettings | null;
}) {
  const [levels, setLevels] = useState(
    () => settings?.level_thresholds ?? DEFAULT_LADDER
  );
  const { busy, error, saved, save } = useSectionSave();

  function set(i: number, field: "name" | "xp", value: string) {
    setLevels((ls) =>
      ls.map((l, idx) =>
        idx === i
          ? { ...l, [field]: field === "xp" ? Number(value) : value }
          : l
      )
    );
  }

  return (
    <SectionCard
      title="Levels"
      description="The XP ladder learners climb. Thresholds must be ascending; level 1 always starts at 0."
    >
      <div className="space-y-2">
        {levels.map((l, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="w-16 text-sm text-muted tabular-nums shrink-0">
              Level {i + 1}
            </span>
            <input
              type="text"
              value={l.name}
              onChange={(e) => set(i, "name", e.target.value)}
              className="flex-1 px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
            />
            <input
              type="number"
              min={0}
              value={l.xp}
              disabled={i === 0}
              onChange={(e) => set(i, "xp", e.target.value)}
              className="w-28 px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm text-right tabular-nums disabled:opacity-50"
            />
            {i === levels.length - 1 && levels.length > 2 && (
              <button
                type="button"
                onClick={() => setLevels((ls) => ls.slice(0, -1))}
                className="text-xs px-2 py-1 border border-line rounded hover:border-red-500 hover:text-red-700"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          setLevels((ls) => [
            ...ls,
            {
              level: ls.length + 1,
              name: `Level ${ls.length + 1}`,
              xp: (ls[ls.length - 1]?.xp ?? 0) * 2 || 100,
            },
          ])
        }
        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-line rounded-lg hover:border-ink"
      >
        <Plus className="w-3.5 h-3.5" /> Add level
      </button>
      <SaveRow
        busy={busy}
        error={error}
        saved={saved}
        onSave={() => save({ orgSlug, section: "levels", levels })}
      />
    </SectionCard>
  );
}

function BadgesTab({ orgSlug, badges }: { orgSlug: string; badges: BadgeRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    description: "",
    icon: "🏅",
    criteria_type: "courses_completed",
    threshold: 5,
  });
  const [busy, setBusy] = useState(false);

  async function createBadge() {
    if (!draft.name.trim()) return;
    setBusy(true);
    const res = await fetch("/api/gamification/badges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        ...draft,
        threshold: draft.criteria_type === "manual" ? null : draft.threshold,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(j.error ?? "Failed to create badge");
      return;
    }
    toast.success("Badge created");
    setShowForm(false);
    setDraft({ name: "", description: "", icon: "🏅", criteria_type: "courses_completed", threshold: 5 });
    router.refresh();
  }

  async function toggleEnabled(b: BadgeRow) {
    if (b.organization_id === null) {
      toast.info("Built-in badges are overridden by creating an org badge with the same name.");
      return;
    }
    const res = await fetch(`/api/gamification/badges/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, enabled: !b.enabled }),
    });
    if (!res.ok) {
      toast.error("Failed to update badge");
      return;
    }
    router.refresh();
  }

  async function removeBadge(b: BadgeRow) {
    if (!(await confirm(`Delete badge "${b.name}"? If anyone has earned it, it will be deactivated instead.`))) return;
    const res = await fetch(`/api/gamification/badges/${b.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug }),
    });
    if (!res.ok) {
      toast.error("Failed to delete badge");
      return;
    }
    const j = (await res.json().catch(() => ({}))) as { deactivated?: boolean };
    toast.success(j.deactivated ? "Badge deactivated (already earned by learners)" : "Badge deleted");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-4 h-4" /> New badge
        </button>
      </div>

      {showForm && (
        <SectionCard title="New badge">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className="px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
            />
            <input
              type="text"
              placeholder="Emoji (e.g. 🏅)"
              value={draft.icon}
              onChange={(e) => setDraft((d) => ({ ...d, icon: e.target.value }))}
              className="px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              className="sm:col-span-2 px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
            />
            <select
              value={draft.criteria_type}
              onChange={(e) => setDraft((d) => ({ ...d, criteria_type: e.target.value }))}
              className="px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
            >
              {CRITERIA_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {draft.criteria_type !== "manual" && (
              <input
                type="number"
                min={1}
                value={draft.threshold}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, threshold: Number(e.target.value) }))
                }
                className="px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm text-right tabular-nums"
              />
            )}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={createBadge}
              disabled={busy || !draft.name.trim()}
              className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              Create badge
            </button>
          </div>
        </SectionCard>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {badges.map((b) => (
          <article key={b.id} className="border border-line rounded-xl bg-paper p-4 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-2xl">{b.icon ?? "🏅"}</span>
                <div className="min-w-0">
                  <div className="font-semibold truncate">{b.name}</div>
                  <div className="text-[11px] text-muted">
                    {b.organization_id === null ? "Built-in" : "Custom"} ·{" "}
                    {b.earned_count ?? 0} earned
                  </div>
                </div>
              </div>
              <StatusPill tone={b.enabled ? "active" : "neutral"}>
                {b.enabled ? "Active" : "Off"}
              </StatusPill>
            </div>
            {b.description && (
              <p className="text-xs text-muted leading-relaxed">{b.description}</p>
            )}
            <div className="text-[11px] text-muted">
              {CRITERIA_OPTIONS.find((c) => c.value === b.criteria_type)?.label ??
                b.criteria_type}
              {b.threshold !== null ? ` ${b.threshold}` : ""}
            </div>
            {b.organization_id !== null && (
              <div className="flex gap-2 mt-auto pt-2">
                <button
                  type="button"
                  onClick={() => toggleEnabled(b)}
                  className="text-xs px-2.5 py-1 border border-line rounded hover:border-ink"
                >
                  {b.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  onClick={() => removeBadge(b)}
                  className="text-xs px-2.5 py-1 border border-line rounded hover:border-red-500 hover:text-red-700"
                >
                  Delete
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function PrivacyTab({
  orgSlug,
  settings,
}: {
  orgSlug: string;
  settings: GamificationSettings | null;
}) {
  const [form, setForm] = useState({
    enabled: settings?.enabled !== false,
    leaderboard_enabled: settings?.leaderboard_enabled !== false,
    allow_opt_out: settings?.allow_opt_out !== false,
    allow_avatar_uploads: settings?.allow_avatar_uploads !== false,
    board_overall: settings?.board_overall !== false,
    board_most_active: settings?.board_most_active !== false,
    board_highest_scorer: settings?.board_highest_scorer !== false,
    board_most_improved: settings?.board_most_improved !== false,
    board_longest_streak: settings?.board_longest_streak !== false,
    board_team: settings?.board_team !== false,
    leaderboard_team_leader_view: settings?.leaderboard_team_leader_view !== false,
  });
  const { busy, error, saved, save } = useSectionSave();

  const Toggle = ({
    field,
    label,
    hint,
  }: {
    field: keyof typeof form;
    label: string;
    hint?: string;
  }) => (
    <label className="flex items-start justify-between gap-4 py-2.5 cursor-pointer">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted mt-0.5">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={form[field]}
        onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.checked }))}
        className="mt-1 h-4 w-4 accent-indigo-600 shrink-0"
      />
    </label>
  );

  return (
    <SectionCard
      title="Leaderboard & privacy"
      description="Learners are visible by default and can hide themselves unless you disable opt-out."
    >
      <div className="divide-y divide-line">
        <Toggle field="enabled" label="Gamification engine" hint="Master switch — turns off XP, streaks, badges and boards entirely" />
        <Toggle field="leaderboard_enabled" label="Leaderboards" hint="Hides the leaderboard page and nav for all learners" />
        <Toggle field="allow_opt_out" label="Allow learners to opt out" hint="When off, stored opt-outs are ignored (not erased)" />
        <Toggle field="allow_avatar_uploads" label="Allow photo uploads" hint="Learners can add a profile photo shown on boards and the podium" />
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mt-2 mb-1">
          Boards
        </div>
        <div className="divide-y divide-line">
          <Toggle field="board_overall" label="Overall" />
          <Toggle field="board_most_active" label="Most Active" />
          <Toggle field="board_highest_scorer" label="Highest Scorer" />
          <Toggle field="board_most_improved" label="Most Improved" />
          <Toggle field="board_longest_streak" label="Longest Streak" />
          <Toggle field="board_team" label="Verticals" hint="City → Branch → Team Leader → Members performance inside each business vertical" />
          <Toggle
            field="leaderboard_team_leader_view"
            label="Team leaders see member details"
            hint="On the Verticals board, a team leader can expand member-level performance for their own reports"
          />
        </div>
      </div>
      <SaveRow
        busy={busy}
        error={error}
        saved={saved}
        onSave={() => save({ orgSlug, section: "leaderboard", ...form })}
      />
    </SectionCard>
  );
}
