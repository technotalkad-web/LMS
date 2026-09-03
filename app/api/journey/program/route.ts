import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { DEFAULT_MILESTONES } from "@/lib/journey/journey";
import { resolveManyGroups } from "@/lib/org/groups";

/**
 *   POST  /api/journey/program { orgSlug }            create the default program
 *   PATCH /api/journey/program { orgSlug, ... }       update settings/milestones
 *   PUT   /api/journey/program { orgSlug, days: [...] } bulk-upsert curriculum
 *
 * Admin-only; the caller-bound client runs under RLS (admins manage journey
 * tables), so RLS is the final authority on every write.
 */

async function ctx(orgSlug: string | undefined) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 as const };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (mem?.role as string) ?? "";
  if (!["super_owner", "owner", "admin"].includes(role)) {
    return { error: "Forbidden", status: 403 as const };
  }
  return { supabase, org, userId: user.id };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    action?: string;
    program_id?: string;
    /** "new" (default): version applies to new enrollments only.
     *  "all": ALSO re-pin every ACTIVE enrollment to the new version —
     *  progress is preserved (completed-mission count carries over; the
     *  learner continues at the new curriculum's next mission). */
    apply_to?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });

  // ---- Publish: freeze the current draft into an immutable version ----
  // New enrollments pin this version; runs already in flight keep theirs
  // unless apply_to === "all" (admin's explicit force-update).
  if (body.action === "publish") {
    if (!body.program_id) {
      return NextResponse.json({ error: "program_id required" }, { status: 400 });
    }
    const { data: prog } = await c.supabase
      .from("journey_programs")
      .select("*")
      .eq("id", body.program_id)
      .eq("organization_id", c.org.id)
      .maybeSingle();
    if (!prog) return NextResponse.json({ error: "Program not found" }, { status: 404 });
    const { data: dayRows } = await c.supabase
      .from("journey_days")
      .select("day_number, course_id, mission_title")
      .eq("program_id", body.program_id)
      .order("day_number", { ascending: true });
    const days = ((dayRows ?? []) as Array<{
      day_number: number;
      course_id: string | null;
      mission_title: string | null;
    }>)
      .filter((d) => d.day_number <= (prog.days_total as number))
      .map((d) => ({
        day: d.day_number,
        course_id: d.course_id,
        mission_title: d.mission_title,
      }));
    if (!days.some((d) => d.course_id)) {
      return NextResponse.json(
        { error: "Add at least one day with a module before publishing" },
        { status: 400 }
      );
    }
    const { data: last } = await c.supabase
      .from("journey_versions")
      .select("version_number")
      .eq("program_id", body.program_id)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = ((last as { version_number?: number } | null)?.version_number ?? 0) + 1;
    const { data: version, error: vErr } = await c.supabase
      .from("journey_versions")
      .insert({
        program_id: body.program_id,
        organization_id: c.org.id,
        version_number: nextVersion,
        name: prog.name,
        icon: prog.icon,
        days_total: prog.days_total,
        count_sundays: prog.count_sundays,
        milestones: prog.milestones,
        copy: prog.copy,
        completion_title: prog.completion_title,
        days,
        published_by: c.userId,
      })
      .select("id, version_number")
      .single();
    if (vErr) return NextResponse.json({ error: vErr.message }, { status: 400 });
    const { error: uErr } = await c.supabase
      .from("journey_programs")
      .update({ current_version_id: version.id, updated_at: new Date().toISOString() })
      .eq("id", body.program_id);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 400 });

    // ---- Optional force-update: move ACTIVE learners onto the new version.
    // Progress rows stay untouched — completed-mission COUNT carries over,
    // so each learner resumes at the new curriculum's next mission. If a
    // learner has already completed as many missions as the new curriculum
    // holds, they're marked complete (badge included) rather than stranded.
    let migrated = 0;
    let completedNow = 0;
    if (body.apply_to === "all") {
      const { data: activeEnrs, error: aErr } = await c.supabase
        .from("journey_enrollments")
        .update({ version_id: version.id })
        .eq("program_id", body.program_id)
        .eq("status", "active")
        .select("id, user_id");
      if (aErr) return NextResponse.json({ error: aErr.message }, { status: 400 });
      const enrs = (activeEnrs ?? []) as Array<{ id: string; user_id: string }>;
      migrated = enrs.length;

      const missionCount = days.filter((d) => d.course_id).length;
      if (enrs.length > 0 && missionCount > 0) {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        for (const enr of enrs) {
          const { count } = await svc
            .from("journey_day_progress")
            .select("id", { count: "exact", head: true })
            .eq("enrollment_id", enr.id);
          if ((count ?? 0) >= missionCount) {
            await svc
              .from("journey_enrollments")
              .update({ status: "completed", completed_at: new Date().toISOString() })
              .eq("id", enr.id);
            // Permanent badge — duplicate-insert errors mean "already has it".
            await svc.from("user_badges").insert({
              organization_id: c.org.id,
              user_id: enr.user_id,
              badge_slug: "yoddha",
              metadata: { source: "journey_force_update", version: version.version_number },
            });
            completedNow++;
          }
        }
      }
    }

    return NextResponse.json({
      ok: true,
      version_number: version.version_number,
      ...(body.apply_to === "all" ? { migrated, completed_now: completedNow } : {}),
    });
  }

  // ---- Sync audience: enroll every matching member not yet on the journey.
  // Covers team-based audiences (which the insert trigger can't see) and
  // members who predate the journey or an audience change.
  if (body.action === "sync_audience") {
    if (!body.program_id) {
      return NextResponse.json({ error: "program_id required" }, { status: 400 });
    }
    const { data: prog } = await c.supabase
      .from("journey_programs")
      .select("id, current_version_id, audience, is_active")
      .eq("id", body.program_id)
      .eq("organization_id", c.org.id)
      .maybeSingle();
    if (!prog) return NextResponse.json({ error: "Program not found" }, { status: 404 });
    if (!prog.current_version_id) {
      return NextResponse.json(
        { error: "Publish the journey first — enrollments pin a published version" },
        { status: 400 }
      );
    }
    const aud = (prog.audience ?? {}) as Record<string, unknown>;
    const arr = (k: string): string[] =>
      Array.isArray(aud[k]) ? (aud[k] as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const designations = arr("designations");
    const jobRoles = arr("job_roles");
    const cities = arr("cities");
    const verticals = arr("verticals");
    const branches = arr("branches");
    const teamIds = arr("team_ids");
    const groupIds = arr("group_ids");

    const { data: memRows } = await c.supabase
      .from("organization_members")
      .select("user_id, designation, job_role, city, business_vertical, branch")
      .eq("organization_id", c.org.id)
      .eq("status", "active");
    let candidates = ((memRows ?? []) as Array<{
      user_id: string;
      designation: string | null;
      job_role: string | null;
      city: string | null;
      business_vertical: string | null;
      branch: string | null;
    }>).filter(
      (m) =>
        (designations.length === 0 || designations.includes(m.designation ?? "")) &&
        (jobRoles.length === 0 || jobRoles.includes(m.job_role ?? "")) &&
        (cities.length === 0 || cities.includes(m.city ?? "")) &&
        (verticals.length === 0 || verticals.includes(m.business_vertical ?? "")) &&
        (branches.length === 0 || branches.includes(m.branch ?? ""))
    );
    if (teamIds.length > 0) {
      const { data: tmRows } = await c.supabase
        .from("team_members")
        .select("user_id")
        .in("team_id", teamIds);
      const inTeams = new Set(((tmRows ?? []) as Array<{ user_id: string }>).map((t) => t.user_id));
      candidates = candidates.filter((m) => inTeams.has(m.user_id));
    }
    if (groupIds.length > 0) {
      // Custom Groups (0067): admin RLS lets this run on the caller's client.
      const inGroups = await resolveManyGroups(c.supabase, c.org.id, groupIds);
      candidates = candidates.filter((m) => inGroups.has(m.user_id));
    }

    const { data: enrRows } = await c.supabase
      .from("journey_enrollments")
      .select("user_id")
      .eq("program_id", prog.id)
      .in("status", ["active", "completed"]);
    const already = new Set(((enrRows ?? []) as Array<{ user_id: string }>).map((e) => e.user_id));
    const toEnroll = candidates.filter((m) => !already.has(m.user_id));

    const startDate = new Date().toISOString().slice(0, 10);
    let enrolled = 0;
    for (let i = 0; i < toEnroll.length; i += 150) {
      const batch = toEnroll.slice(i, i + 150).map((m) => ({
        program_id: prog.id,
        version_id: prog.current_version_id,
        organization_id: c.org.id,
        user_id: m.user_id,
        start_date: startDate,
        enrolled_by: c.userId,
      }));
      const { error: iErr } = await c.supabase.from("journey_enrollments").insert(batch);
      if (iErr) return NextResponse.json({ error: iErr.message }, { status: 400 });
      enrolled += batch.length;
    }
    return NextResponse.json({
      ok: true,
      enrolled,
      matched: candidates.length,
      already_enrolled: already.size,
    });
  }

  // ---- Create a journey (draft only; publish before enrolling) ----
  // No name → legacy behavior: return the first existing program, or create
  // the default one. A NAME creates an additional journey (multi-journey,
  // 0063) — uniqueness per org enforced by the DB.
  const newName = typeof (body as { name?: unknown }).name === "string"
    ? ((body as { name?: string }).name ?? "").trim()
    : "";
  if (!newName) {
    const { data: existing } = await c.supabase
      .from("journey_programs")
      .select("id")
      .eq("organization_id", c.org.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existing) return NextResponse.json({ ok: true, program_id: existing.id });
  } else if (newName.length > 80) {
    return NextResponse.json({ error: "Name too long (max 80)" }, { status: 400 });
  }

  const { data: created, error } = await c.supabase
    .from("journey_programs")
    .insert({
      organization_id: c.org.id,
      created_by: c.userId,
      ...(newName ? { name: newName } : {}),
    })
    .select("id")
    .single();
  if (error) {
    return NextResponse.json(
      {
        error: /duplicate|unique/i.test(error.message)
          ? "A journey with that name already exists"
          : error.message,
      },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, program_id: created.id });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    program_id?: string;
    name?: string;
    icon?: string;
    days_total?: number;
    count_sundays?: boolean;
    is_active?: boolean;
    auto_enroll_new_users?: boolean;
    nudge_enabled?: boolean;
    nudge_behind_days?: number;
    nudge_cooldown_days?: number;
    completion_title?: string;
    copy?: Record<string, unknown> | null;
    milestones?: Array<{ day?: number; icon?: string; name?: string; message?: string }> | null;
    priority?: number;
    is_mandatory?: boolean;
    audience?: Record<string, unknown> | null;
    focus_enabled?: boolean;
    focus_pinned?: string[] | null;
    deadline_days?: number | null;
    escalation_enabled?: boolean;
    escalation_after_days?: number;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (!body.program_id) {
    return NextResponse.json({ error: "program_id required" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (!n || n.length > 80) return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    update.name = n;
  }
  if (body.icon !== undefined) {
    const i = String(body.icon).trim();
    if (!i || i.length > 8) return NextResponse.json({ error: "Invalid icon" }, { status: 400 });
    update.icon = i;
  }
  if (body.days_total !== undefined) {
    const d = Math.round(Number(body.days_total));
    if (!Number.isFinite(d) || d < 1 || d > 365) {
      return NextResponse.json({ error: "days_total must be 1–365" }, { status: 400 });
    }
    update.days_total = d;
  }
  if (body.priority !== undefined) {
    const p = Math.round(Number(body.priority));
    if (!Number.isFinite(p) || p < 1 || p > 999) {
      return NextResponse.json({ error: "priority must be 1–999 (1 = highest)" }, { status: 400 });
    }
    update.priority = p;
  }
  if (body.audience !== undefined) {
    if (body.audience === null) {
      update.audience = null; // everyone
    } else if (typeof body.audience !== "object" || Array.isArray(body.audience)) {
      return NextResponse.json({ error: "audience must be an object" }, { status: 400 });
    } else {
      const cleaned: Record<string, string[]> = {};
      for (const key of [
        "designations",
        "job_roles",
        "cities",
        "verticals",
        "branches",
        "team_ids",
        // Custom Groups (0067, G3): member must be in ANY listed group (the
        // groups union), AND-ed with the field rules above. The auto-enroll
        // trigger can't evaluate group rules in SQL — like team_ids, groups
        // apply via "Sync audience now".
        "group_ids",
      ] as const) {
        const raw = (body.audience as Record<string, unknown>)[key];
        if (raw === undefined) continue;
        if (!Array.isArray(raw) || raw.length > 200 || raw.some((v) => typeof v !== "string")) {
          return NextResponse.json(
            { error: `audience.${key} must be an array of strings (max 200)` },
            { status: 400 }
          );
        }
        const vals = (raw as string[]).map((v) => v.trim()).filter(Boolean);
        if (vals.length > 0) cleaned[key] = vals;
      }
      update.audience = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
  }
  if (body.focus_pinned !== undefined) {
    if (body.focus_pinned === null) {
      update.focus_pinned = null;
    } else {
      if (
        !Array.isArray(body.focus_pinned) ||
        body.focus_pinned.length > 20 ||
        body.focus_pinned.some((v) => typeof v !== "string")
      ) {
        return NextResponse.json(
          { error: "focus_pinned must be an array of course ids (max 20)" },
          { status: 400 }
        );
      }
      // Pinned courses must belong to THIS org (same guard as the
      // curriculum PUT — never let a payload reference another tenant's).
      const ids = Array.from(new Set(body.focus_pinned));
      if (ids.length > 0) {
        const { data: courseRows } = await c.supabase
          .from("courses")
          .select("id")
          .eq("organization_id", c.org.id)
          .in("id", ids);
        if ((courseRows ?? []).length !== ids.length) {
          return NextResponse.json(
            { error: "One or more pinned courses don't belong to this organization" },
            { status: 400 }
          );
        }
      }
      update.focus_pinned = ids.length > 0 ? ids : null;
    }
  }
  for (const flag of [
    "count_sundays",
    "is_active",
    "auto_enroll_new_users",
    "nudge_enabled",
    "is_mandatory",
    "focus_enabled",
    "escalation_enabled",
  ] as const) {
    if (body[flag] !== undefined) {
      if (typeof body[flag] !== "boolean") {
        return NextResponse.json({ error: `${flag} must be boolean` }, { status: 400 });
      }
      update[flag] = body[flag];
    }
  }
  for (const num of [
    "nudge_behind_days",
    "nudge_cooldown_days",
    "escalation_after_days",
  ] as const) {
    if (body[num] !== undefined) {
      const n = Math.round(Number(body[num]));
      if (!Number.isFinite(n) || n < 1 || n > 30) {
        return NextResponse.json({ error: `${num} must be 1–30` }, { status: 400 });
      }
      update[num] = n;
    }
  }
  if (body.deadline_days !== undefined) {
    if (body.deadline_days === null) {
      update.deadline_days = null;
    } else {
      const d = Math.round(Number(body.deadline_days));
      if (!Number.isFinite(d) || d < 1 || d > 730) {
        return NextResponse.json(
          { error: "deadline_days must be 1–730 (or empty for none)" },
          { status: 400 }
        );
      }
      update.deadline_days = d;
    }
  }
  if (body.completion_title !== undefined) {
    const t = String(body.completion_title).trim();
    if (!t || t.length > 40) return NextResponse.json({ error: "Invalid completion title" }, { status: 400 });
    update.completion_title = t;
  }
  if (body.copy !== undefined) {
    if (body.copy === null) {
      update.copy = null;
    } else if (typeof body.copy !== "object" || Array.isArray(body.copy)) {
      return NextResponse.json({ error: "copy must be an object" }, { status: 400 });
    } else {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.copy)) {
        if (typeof v !== "string") continue;
        const t = v.trim();
        if (t) cleaned[k.slice(0, 40)] = t.slice(0, 300);
      }
      update.copy = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
  }
  if (body.milestones !== undefined) {
    if (body.milestones === null) {
      update.milestones = null; // reset to defaults
    } else {
      if (!Array.isArray(body.milestones) || body.milestones.length > 20) {
        return NextResponse.json({ error: "milestones must be an array (max 20)" }, { status: 400 });
      }
      const cleaned = body.milestones
        .map((m) => ({
          day: Math.round(Number(m.day)),
          icon: String(m.icon ?? "⭐").trim().slice(0, 8) || "⭐",
          name: String(m.name ?? "").trim().slice(0, 60),
          message: String(m.message ?? "").trim().slice(0, 200),
        }))
        .filter((m) => Number.isFinite(m.day) && m.day >= 1 && m.day <= 365 && m.name);
      update.milestones = cleaned.length > 0 ? cleaned : null;
    }
  }

  const { error } = await c.supabase
    .from("journey_programs")
    .update(update)
    .eq("id", body.program_id)
    .eq("organization_id", c.org.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, defaults: DEFAULT_MILESTONES });
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    program_id?: string;
    days?: Array<{ day_number?: number; course_id?: string | null; mission_title?: string | null }>;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (!body.program_id || !Array.isArray(body.days)) {
    return NextResponse.json({ error: "program_id and days[] required" }, { status: 400 });
  }
  if (body.days.length > 365) {
    return NextResponse.json({ error: "too many days" }, { status: 400 });
  }

  // Every referenced module must belong to THIS org — otherwise a crafted
  // payload could schedule (and thereby entitle learners to) another
  // tenant's course.
  const wantedCourseIds = Array.from(
    new Set(body.days.map((d) => d.course_id).filter((x): x is string => !!x))
  );
  const ownCourseIds = new Set<string>();
  if (wantedCourseIds.length > 0) {
    const { data: courseRows } = await c.supabase
      .from("courses")
      .select("id")
      .eq("organization_id", c.org.id)
      .in("id", wantedCourseIds);
    for (const row of (courseRows ?? []) as Array<{ id: string }>) {
      ownCourseIds.add(row.id);
    }
    const foreign = wantedCourseIds.filter((id) => !ownCourseIds.has(id));
    if (foreign.length > 0) {
      return NextResponse.json(
        { error: "One or more modules don't belong to this organization" },
        { status: 400 }
      );
    }
  }

  const rows = [];
  for (const d of body.days) {
    const n = Math.round(Number(d.day_number));
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      return NextResponse.json({ error: `Invalid day_number ${d.day_number}` }, { status: 400 });
    }
    rows.push({
      program_id: body.program_id,
      organization_id: c.org.id,
      day_number: n,
      course_id: d.course_id || null,
      mission_title:
        typeof d.mission_title === "string" && d.mission_title.trim()
          ? d.mission_title.trim().slice(0, 120)
          : null,
    });
  }
  const { error } = await c.supabase
    .from("journey_days")
    .upsert(rows, { onConflict: "program_id,day_number" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, saved: rows.length });
}
