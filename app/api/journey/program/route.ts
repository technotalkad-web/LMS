import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_MILESTONES } from "@/lib/journey/journey";

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
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });

  // ---- Publish: freeze the current draft into an immutable version ----
  // New enrollments pin this version; runs already in flight keep theirs.
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
    return NextResponse.json({ ok: true, version_number: version.version_number });
  }

  // ---- Create the program (draft only; publish before enrolling) ----
  const { data: existing } = await c.supabase
    .from("journey_programs")
    .select("id")
    .eq("organization_id", c.org.id)
    .maybeSingle();
  if (existing) return NextResponse.json({ ok: true, program_id: existing.id });

  const { data: created, error } = await c.supabase
    .from("journey_programs")
    .insert({ organization_id: c.org.id, created_by: c.userId })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
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
  for (const flag of [
    "count_sundays",
    "is_active",
    "auto_enroll_new_users",
    "nudge_enabled",
  ] as const) {
    if (body[flag] !== undefined) {
      if (typeof body[flag] !== "boolean") {
        return NextResponse.json({ error: `${flag} must be boolean` }, { status: 400 });
      }
      update[flag] = body[flag];
    }
  }
  for (const num of ["nudge_behind_days", "nudge_cooldown_days"] as const) {
    if (body[num] !== undefined) {
      const n = Math.round(Number(body[num]));
      if (!Number.isFinite(n) || n < 1 || n > 30) {
        return NextResponse.json({ error: `${num} must be 1–30` }, { status: 400 });
      }
      update[num] = n;
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
