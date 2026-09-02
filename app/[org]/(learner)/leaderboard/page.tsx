import Link from "next/link";
import { Trophy, EyeOff, Clock } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { Avatar } from "@/components/ui/avatar";
import { LocalDateTime } from "@/components/ui/local-datetime";
import { Podium, type PodiumEntry } from "./_components/podium";
import { VerticalBoard } from "./_components/vertical-board";
import {
  effectiveBoardCopy,
  DEFAULT_LEADERBOARD_TITLE,
  type BoardCopy,
  type BoardCopyKey,
} from "@/lib/gamification/board-copy";

export const dynamic = "force-dynamic";

/**
 * Org leaderboard. SSR against the precomputed mv_leaderboard matview and,
 * for the Verticals board, live organization_members + mv_learner_metrics
 * (service-role reads: learners can't read peers' organization_members rows
 * under RLS — profile-page precedent). Tabs are URL-driven links
 * (?board=...), no client state.
 */

// Structural board config. Names + taglines are org-editable copy — see
// lib/gamification/board-copy.ts for defaults and the override merge.
const BOARDS = {
  overall: { rankCol: "rank_overall", metricLabel: "XP" },
  active: { rankCol: "rank_most_active", metricLabel: "active days (30d)" },
  scorer: { rankCol: "rank_highest_scorer", metricLabel: "avg score" },
  improved: { rankCol: "rank_most_improved", metricLabel: "XP gained (30d)" },
  streak: { rankCol: "rank_longest_streak", metricLabel: "days" },
  // Replaced the old Teams (avg-XP) board: City → Branch → Team Leader →
  // Members performance inside the viewer's business vertical. rankCol is
  // null on purpose — this board has no rank column and returns before the
  // generic mv_leaderboard query below.
  vertical: { rankCol: null, metricLabel: "" },
} as const;
type BoardKey = keyof typeof BOARDS;

type Row = {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  avatar_url: string | null;
  total_xp: number;
  current_level: number;
  current_streak_days: number;
  courses_completed: number;
  badges_count: number;
  xp_30d: number;
  xp_prev_30d: number;
  active_days_30d: number;
  avg_score: number | null;
  hidden: boolean;
  rank_overall: number | null;
  rank_most_active: number | null;
  rank_highest_scorer: number | null;
  rank_most_improved: number | null;
  rank_longest_streak: number | null;
  refreshed_at: string;
};

function displayName(r: Row): string {
  return (
    [r.first_name, r.last_name].filter(Boolean).join(" ").trim() ||
    (r.email ?? "").split("@")[0] ||
    "Learner"
  );
}

function metricFor(board: BoardKey, r: Row): string {
  switch (board) {
    case "overall":
      return r.total_xp.toLocaleString();
    case "active":
      return String(r.active_days_30d);
    case "scorer":
      return r.avg_score !== null ? `${Math.round(r.avg_score * 100)}%` : "—";
    case "improved":
      return (r.xp_30d - r.xp_prev_30d).toLocaleString();
    case "streak":
      return String(r.current_streak_days);
    default:
      return "";
  }
}

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{ board?: string; v?: string }>;
}) {
  const { org: orgSlug } = await params;
  const sp = (await searchParams) ?? {};
  // Old bookmarks: ?board=team was the tab the Verticals board replaced.
  const requested = sp.board === "team" ? "vertical" : sp.board;
  const board: BoardKey = (
    Object.keys(BOARDS) as BoardKey[]
  ).includes(requested as BoardKey)
    ? (requested as BoardKey)
    : "overall";

  const { user, org, role } = await requireOrgAccess(orgSlug);

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // select("*") on purpose: naming 0056's new columns here would error the
  // whole query on a database that hasn't run that migration yet, turning
  // every leaderboard off between code deploy and migration. Missing
  // columns simply come back undefined and default on.
  const { data: gsRow } = await svc
    .from("gamification_settings")
    .select("*")
    .eq("organization_id", org.id)
    .maybeSingle();
  const gs = gsRow as Record<string, boolean> | null;

  if (!gs || gs.enabled === false || gs.leaderboard_enabled === false) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <Trophy className="w-10 h-10 mx-auto text-muted opacity-50" />
        <h1 className="mt-4 text-2xl font-semibold">Leaderboards are off</h1>
        <p className="text-muted text-sm mt-2">
          Leaderboards are turned off for your organization.
        </p>
      </div>
    );
  }

  // Org-editable copy (0057): board names/taglines + page title, defaulted.
  const gsx = gsRow as Record<string, unknown> | null;
  const copy = effectiveBoardCopy(gsx?.board_labels);
  const pageTitle =
    (typeof gsx?.leaderboard_title === "string" && gsx.leaderboard_title.trim()) ||
    DEFAULT_LEADERBOARD_TITLE;

  const boardEnabled: Record<BoardKey, boolean> = {
    overall: gs.board_overall !== false,
    active: gs.board_most_active !== false,
    scorer: gs.board_highest_scorer !== false,
    improved: gs.board_most_improved !== false,
    streak: gs.board_longest_streak !== false,
    // The verticals board reuses the old Teams-board toggle.
    vertical: gs.board_team !== false,
  };
  const visibleBoards = (Object.keys(BOARDS) as BoardKey[]).filter(
    (k) => boardEnabled[k]
  );
  const activeBoard = boardEnabled[board] ? board : (visibleBoards[0] ?? "overall");

  // ---- Verticals board: City → Branch → Team Leader → Members ----
  if (activeBoard === "vertical") {
    const { data: fresh } = await svc
      .from("mv_learner_metrics")
      .select("refreshed_at")
      .eq("organization_id", org.id)
      .limit(1)
      .maybeSingle();
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Header
          orgSlug={orgSlug}
          title={pageTitle}
          refreshedAt={(fresh as { refreshed_at?: string } | null)?.refreshed_at ?? null}
        />
        <BoardTabs orgSlug={orgSlug} active="vertical" visible={visibleBoards} labels={copy} />
        <p className="text-sm text-muted -mt-3">{copy.vertical.tagline}</p>
        <VerticalBoard
          orgId={org.id as string}
          orgSlug={orgSlug}
          viewerId={user.id}
          isAdminViewer={canManage(role)}
          leaderViewEnabled={gs.leaderboard_team_leader_view !== false}
          allowOptOut={gs.allow_opt_out !== false}
          requestedVertical={sp.v}
        />
      </div>
    );
  }

  // ---- Individual boards (vertical returned above; rankCol is non-null) ----
  const rankCol = BOARDS[activeBoard].rankCol as string;
  const { data: rowsRaw } = await svc
    .from("mv_leaderboard")
    .select("*")
    .eq("organization_id", org.id)
    .not(rankCol, "is", null)
    .order(rankCol, { ascending: true })
    .limit(50);
  const rows = (rowsRaw ?? []) as Row[];

  const { data: mineRaw } = await svc
    .from("mv_leaderboard")
    .select("*")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const mine = (mineRaw as Row | null) ?? null;

  // Identity hydration: designation/city/team names in batched queries.
  const userIds = Array.from(
    new Set([...rows.map((r) => r.user_id), ...(mine ? [mine.user_id] : [])])
  );

  // Freshness overlay: mv_leaderboard snapshots name/avatar and lags up to
  // 15 minutes behind, so a just-uploaded photo (or renamed profile) looked
  // broken on the podium. Ranks/XP may lag — identity must not.
  const { data: profRows } = userIds.length
    ? await svc
        .from("profiles")
        .select("id, first_name, last_name, avatar_url")
        .in("id", userIds)
    : { data: [] };
  const profById = new Map(
    ((profRows ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      avatar_url: string | null;
    }>).map((p) => [p.id, p])
  );
  for (const r of [...rows, ...(mine ? [mine] : [])]) {
    const p = profById.get(r.user_id);
    if (p) {
      r.first_name = p.first_name;
      r.last_name = p.last_name;
      r.avatar_url = p.avatar_url;
    }
  }

  const { data: memRows } = userIds.length
    ? await svc
        .from("organization_members")
        .select("user_id, designation, city")
        .eq("organization_id", org.id)
        .in("user_id", userIds)
    : { data: [] };
  const memById = new Map(
    ((memRows ?? []) as Array<{ user_id: string; designation: string | null; city: string | null }>).map(
      (m) => [m.user_id, m]
    )
  );
  const { data: tmRows } = userIds.length
    ? await svc
        .from("team_members")
        .select("user_id, teams!inner(name, organization_id)")
        .in("user_id", userIds)
    : { data: [] };
  const teamByUser = new Map<string, string>();
  for (const t of (tmRows ?? []) as Array<{
    user_id: string;
    teams: { name: string; organization_id: string } | Array<{ name: string; organization_id: string }>;
  }>) {
    const team = Array.isArray(t.teams) ? t.teams[0] : t.teams;
    if (team?.organization_id === org.id && !teamByUser.has(t.user_id)) {
      teamByUser.set(t.user_id, team.name);
    }
  }

  // Suppress columns that would render entirely empty (HR fields are often
  // NULL until the tenant's HR sync runs — a column of dashes looks broken).
  const showDesignation = rows.some((r) => memById.get(r.user_id)?.designation);
  const showCity = rows.some((r) => memById.get(r.user_id)?.city);
  const showTeam = rows.some((r) => teamByUser.has(r.user_id));

  const rankOf = (r: Row) => r[rankCol as keyof Row] as number | null;
  const top3: PodiumEntry[] = rows
    .filter((r) => (rankOf(r) ?? 99) <= 3)
    .slice(0, 3)
    .map((r) => ({
      rank: rankOf(r)!,
      name: displayName(r),
      avatarUrl: r.avatar_url,
      designation: memById.get(r.user_id)?.designation ?? null,
      metricLabel: BOARDS[activeBoard].metricLabel,
      metricValue: metricFor(activeBoard, r),
    }));
  const tableRows = rows.filter((r) => (rankOf(r) ?? 99) > 3);
  const mineInTop = mine ? rows.some((r) => r.user_id === mine.user_id) : false;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Header orgSlug={orgSlug} title={pageTitle} refreshedAt={rows[0]?.refreshed_at ?? null} />
      <BoardTabs orgSlug={orgSlug} active={activeBoard} visible={visibleBoards} labels={copy} />
      <p className="text-sm text-muted -mt-3">{copy[activeBoard].tagline}</p>

      {mine?.hidden && (
        <div className="border border-line bg-canvas/60 rounded-xl px-4 py-2.5 text-xs text-muted flex items-center gap-2">
          <EyeOff className="w-3.5 h-3.5 shrink-0" />
          <span>
            You&apos;ve hidden yourself from leaderboards — others can&apos;t see
            you.{" "}
            <Link href={`/${orgSlug}/profile`} className="underline underline-offset-4 hover:text-ink">
              Change in profile
            </Link>
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyBoard />
      ) : (
        <>
          {top3.length === 3 && <Podium top3={top3} style={gsx?.podium_style} />}

          <div className="bg-paper border border-line rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted border-b border-line">
                  <th className="px-4 py-3 w-14">Rank</th>
                  <th className="px-4 py-3">Learner</th>
                  {showDesignation && (
                    <th className="px-4 py-3 hidden sm:table-cell">Designation</th>
                  )}
                  {showTeam && <th className="px-4 py-3 hidden md:table-cell">Team</th>}
                  {showCity && <th className="px-4 py-3 hidden md:table-cell">City</th>}
                  <th className="px-4 py-3 text-right">
                    {BOARDS[activeBoard].metricLabel}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(top3.length === 3 ? tableRows : rows).map((r) => (
                  <LeaderRow
                    key={r.user_id}
                    r={r}
                    rank={rankOf(r)!}
                    metric={metricFor(activeBoard, r)}
                    isMe={r.user_id === user.id}
                    designation={showDesignation ? memById.get(r.user_id)?.designation ?? null : undefined}
                    team={showTeam ? teamByUser.get(r.user_id) ?? null : undefined}
                    city={showCity ? memById.get(r.user_id)?.city ?? null : undefined}
                  />
                ))}
                {mine && !mineInTop && rankOf(mine) !== null && (
                  <LeaderRow
                    r={mine}
                    rank={rankOf(mine)!}
                    metric={metricFor(activeBoard, mine)}
                    isMe
                    separated
                    designation={showDesignation ? memById.get(mine.user_id)?.designation ?? null : undefined}
                    team={showTeam ? teamByUser.get(mine.user_id) ?? null : undefined}
                    city={showCity ? memById.get(mine.user_id)?.city ?? null : undefined}
                  />
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Header({
  orgSlug,
  title,
  refreshedAt,
}: {
  orgSlug: string;
  title: string;
  refreshedAt: string | null;
}) {
  void orgSlug;
  return (
    <header>
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="text-muted mt-1 text-sm flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5" />
        {refreshedAt ? (
          <>
            Updated <LocalDateTime iso={refreshedAt} />
          </>
        ) : (
          "Rankings update every 15 minutes."
        )}
      </p>
    </header>
  );
}

function BoardTabs({
  orgSlug,
  active,
  visible,
  labels,
}: {
  orgSlug: string;
  active: BoardKey;
  visible: BoardKey[];
  labels: Record<BoardCopyKey, BoardCopy>;
}) {
  return (
    <div className="border-b border-line overflow-x-auto">
      <div className="flex min-w-max gap-1">
        {visible.map((k) => (
          <Link
            key={k}
            href={`/${orgSlug}/leaderboard?board=${k}`}
            className={`whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              active === k
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {labels[k].name}
          </Link>
        ))}
      </div>
    </div>
  );
}

function LeaderRow({
  r,
  rank,
  metric,
  isMe,
  separated,
  designation,
  team,
  city,
}: {
  r: Row;
  rank: number;
  metric: string;
  isMe?: boolean;
  separated?: boolean;
  designation?: string | null;
  team?: string | null;
  city?: string | null;
}) {
  return (
    <tr
      className={`${isMe ? "bg-indigo-50/50" : ""} ${
        separated ? "border-t-4 border-line" : ""
      }`}
    >
      <td className="px-4 py-3 font-semibold tabular-nums">#{rank}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={displayName(r)} avatarUrl={r.avatar_url} size="sm" />
          <div className="min-w-0">
            <div className="font-medium truncate">
              {displayName(r)}
              {isMe && <span className="text-indigo-600 text-xs ml-1.5">(you)</span>}
            </div>
            {(designation || city) && (
              <div className="text-[11px] text-muted truncate sm:hidden">
                {[designation, city].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        </div>
      </td>
      {designation !== undefined && (
        <td className="px-4 py-3 text-muted hidden sm:table-cell">
          {designation ?? "—"}
        </td>
      )}
      {team !== undefined && (
        <td className="px-4 py-3 text-muted hidden md:table-cell">{team ?? "—"}</td>
      )}
      {city !== undefined && (
        <td className="px-4 py-3 text-muted hidden md:table-cell">{city ?? "—"}</td>
      )}
      <td className="px-4 py-3 text-right font-semibold tabular-nums">{metric}</td>
    </tr>
  );
}

function EmptyBoard() {
  return (
    <div className="bg-paper border border-line rounded-2xl text-center py-14 px-6">
      <Trophy className="w-10 h-10 mx-auto text-muted opacity-40" />
      <h2 className="mt-4 font-semibold">No rankings yet</h2>
      <p className="text-muted text-sm mt-1">
        Rankings appear as soon as learners start completing courses and earning
        XP.
      </p>
    </div>
  );
}
