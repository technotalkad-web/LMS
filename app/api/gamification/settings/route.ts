import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/gamification/settings
 *   body: { orgSlug, section: "xp_rules" | "levels" | "leaderboard", ... }
 *
 * Section payloads:
 *   xp_rules:    { rules: { xp_course_completion, xp_perfect_score_bonus,
 *                  xp_high_score_bonus, xp_daily_activity, xp_streak_7_bonus,
 *                  xp_streak_30_bonus, daily_xp_cap, min_completion_seconds } }
 *   levels:      { levels: [{ level, name, xp }, ...] }  (ascending, level 1 = 0)
 *   leaderboard: { enabled?, leaderboard_enabled?, allow_opt_out?,
 *                  allow_avatar_uploads?, board_*?, timezone? }
 *
 * Authorization is RLS: the upsert runs under the caller's session, and the
 * gamification_settings admin policy rejects non-admins.
 */

const XP_FIELDS = [
  "xp_course_completion",
  "xp_perfect_score_bonus",
  "xp_high_score_bonus",
  "xp_daily_activity",
  "xp_streak_7_bonus",
  "xp_streak_30_bonus",
  "daily_xp_cap",
  "min_completion_seconds",
] as const;

const BOOL_FIELDS = [
  "enabled",
  "leaderboard_enabled",
  "allow_opt_out",
  "allow_avatar_uploads",
  "board_overall",
  "board_most_active",
  "board_highest_scorer",
  "board_most_improved",
  "board_longest_streak",
  "board_team",
] as const;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    section?: string;
    rules?: Record<string, unknown>;
    levels?: Array<{ level?: number; name?: string; xp?: number }>;
    [k: string]: unknown;
  };
  if (!body.orgSlug || !body.section) {
    return NextResponse.json(
      { error: "orgSlug and section required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  };

  if (body.section === "xp_rules") {
    const rules = body.rules ?? {};
    for (const f of XP_FIELDS) {
      const v = rules[f];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100000) {
        return NextResponse.json(
          { error: `${f} must be a number between 0 and 100000` },
          { status: 400 }
        );
      }
      update[f] = Math.round(v);
    }
  } else if (body.section === "levels") {
    const levels = body.levels;
    if (!Array.isArray(levels) || levels.length < 2) {
      return NextResponse.json(
        { error: "levels must be an array of at least 2 rungs" },
        { status: 400 }
      );
    }
    let prev = -1;
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      if (
        typeof l?.xp !== "number" ||
        l.xp < 0 ||
        typeof l?.name !== "string" ||
        !l.name.trim()
      ) {
        return NextResponse.json(
          { error: `Level ${i + 1} needs a name and a non-negative XP threshold` },
          { status: 400 }
        );
      }
      if (i === 0 && l.xp !== 0) {
        return NextResponse.json(
          { error: "Level 1 must start at 0 XP" },
          { status: 400 }
        );
      }
      if (l.xp <= prev) {
        return NextResponse.json(
          { error: "XP thresholds must be strictly ascending" },
          { status: 400 }
        );
      }
      prev = l.xp;
    }
    update.level_thresholds = levels.map((l, i) => ({
      level: i + 1,
      name: l.name!.trim(),
      xp: Math.round(l.xp!),
    }));
  } else if (body.section === "leaderboard") {
    for (const f of BOOL_FIELDS) {
      const v = body[f];
      if (v === undefined) continue;
      if (typeof v !== "boolean") {
        return NextResponse.json(
          { error: `${f} must be a boolean` },
          { status: 400 }
        );
      }
      update[f] = v;
    }
    if (body.timezone !== undefined) {
      if (typeof body.timezone !== "string" || !body.timezone.trim()) {
        return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
      }
      update.timezone = body.timezone.trim();
    }
  } else {
    return NextResponse.json({ error: "Unknown section" }, { status: 400 });
  }

  const { error } = await supabase
    .from("gamification_settings")
    .upsert(
      { organization_id: org.id, ...update },
      { onConflict: "organization_id" }
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
