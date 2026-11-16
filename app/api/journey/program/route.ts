import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { CHECK_FAILED, isOrgAdminCaller, notAdminAnswer } from "@/lib/auth/api-admin";
import { DEFAULT_MILESTONES, freezeVersionDays, type DraftDayRow } from "@/lib/journey/journey";
import { MAX_DAY_NUMBER, type SaveEntry } from "@/lib/journey/editor-ops";
import { isSchemaMissing } from "@/lib/scoring/attempt-kind";
import { readDraftDays } from "@/lib/journey/draft-read";
import { resolveManyGroups } from "@/lib/org/groups";

/**
 *   POST   /api/journey/program { orgSlug }            create the default program
 *   POST   /api/journey/program { orgSlug, action: "publish", program_id, apply_to }
 *   POST   /api/journey/program { orgSlug, action: "dry_run", program_id }
 *   POST   /api/journey/program { orgSlug, action: "sync_audience", program_id }
 *   PATCH  /api/journey/program { orgSlug, ... }       update settings/milestones
 *   PUT    /api/journey/program { orgSlug, program_id, days: [...] } save the curriculum
 *   DELETE /api/journey/program { orgSlug, program_id, confirm_name }
 *
 * Admin-only: ctx() checks the caller's role in the organisation explicitly
 * (isOrgAdminCaller; a failed org or role read answers 503 "try again", never
 * 404 or 403) before anything else. The caller-bound client runs under RLS
 * (admins manage journey tables), so RLS is the final authority on every
 * write it makes. The two exceptions are the service-role calls of
 * journey_repin_enrollments (ADR 0024 step 47): the publish's re-pin with
 * apply_to=all and the publish dry run. Their authority is ctx()'s role
 * check and the program read scoped to the caller's organisation, both made
 * before the service client exists, and, for the re-pin, the function's own
 * check that the version is the program's current one.
 *
 * On a database without 0107 (decision A19) the curriculum save, every
 * publish (its version insert names day_ids) and the dry run fail with a 503
 * and write nothing; none falls back to the old upsert or to zeros.
 */

async function ctx(orgSlug: string | undefined) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (orgErr) return { error: CHECK_FAILED, status: 503 as const };
  if (!org) return { error: "Organization not found", status: 404 as const };
  const admin = await isOrgAdminCaller(supabase, org.id as string, user.id);
  if (!admin) {
    const refused = notAdminAnswer(admin);
    return { error: refused.error, status: refused.status };
  }
  return { supabase, org, userId: user.id };
}

type Ctx = Exclude<Awaited<ReturnType<typeof ctx>>, { error: string }>;

/** The POST actions; any other action is refused, never read as "create a journey". */
const POST_ACTIONS = ["publish", "dry_run", "sync_audience"];

/** The seven counts journey_repin_enrollments answers (0107 section 6f), in its order. */
const REPIN_COUNTS = [
  "repinned",
  "kept_on_version",
  "completed_now",
  "sent_back",
  "started_days_kept",
  "credits_now_history",
  "credited_by_rule_change",
] as const;

/** The A19 refusal: a database without 0107 cannot take this write. */
const NEEDS_UPDATE = "needs a database update that is not on this server yet";

/**
 * The program, scoped to the caller's organisation, and its draft days, read
 * on the caller's session for the publish and the dry run. The days are read
 * through readDraftDays (lib/journey/draft-read.ts), the journey admin
 * page's reader too: with their id and pass_required (P2-N8; the
 * narrower-select fallback without 0107, though the write that follows fails
 * there anyway); a removed day has no number and is never read. A failed
 * read answers 503, never "not found" or "no days".
 */
async function readDraft(
  c: Ctx,
  programId: string,
  what: string
): Promise<{ ok: true; prog: Record<string, unknown>; rows: DraftDayRow[] } | { ok: false; res: NextResponse }> {
  const { data: prog, error: pErr } = await c.supabase
    .from("journey_programs")
    .select("*")
    .eq("id", programId)
    .eq("organization_id", c.org.id)
    .maybeSingle();
  if (pErr) {
    return { ok: false, res: NextResponse.json({ error: `Could not load the journey. ${what}; try again.` }, { status: 503 }) };
  }
  if (!prog) return { ok: false, res: NextResponse.json({ error: "Program not found" }, { status: 404 }) };
  const draft = await readDraftDays(c.supabase, programId);
  if (draft.error) {
    return { ok: false, res: NextResponse.json({ error: `Could not load the curriculum. ${what}; try again.` }, { status: 503 }) };
  }
  return { ok: true, prog: prog as Record<string, unknown>, rows: draft.data };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    action?: string;
    program_id?: string;
    /** "new" (default): version applies to new enrollments only.
     *  "all": ALSO re-pin the ACTIVE enrollments to the new version through
     *  journey_repin_enrollments (ADR 0024 step 47): credits stay with their
     *  day by identity, so nobody repeats a day they completed. */
    apply_to?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (body.action !== undefined && body.action !== null && !POST_ACTIONS.includes(body.action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  // ---- Dry run of a publish to all (ADR 0024 step 47, P2-8 item 5) ----
  // What "Publish & update everyone" would do to the active enrolments,
  // computed by journey_repin_enrollments on the would-be version: the saved
  // draft frozen by the same helper the publish uses (freezeVersionDays), so
  // the counts compare each enrolment with what the publish will pin, not
  // with the current version. It changes nothing: the function's dry-run
  // form computes every count on one snapshot and writes nothing, and this
  // branch makes no other write. Service role only; the program read above
  // the call is scoped to the caller's organisation.
  if (body.action === "dry_run") {
    if (!body.program_id) {
      return NextResponse.json({ error: "program_id required" }, { status: 400 });
    }
    const draft = await readDraft(c, body.program_id, "Nothing was published");
    if (!draft.ok) return draft.res;
    const daysTotal = draft.prog.days_total as number;
    const frozen = freezeVersionDays(draft.rows, daysTotal);
    if (!frozen.days.some((d) => d.course_id)) {
      return NextResponse.json(
        { error: "Add at least one day with a module before publishing" },
        { status: 400 }
      );
    }
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data: dry, error: dErr } = await svc.rpc("journey_repin_enrollments", {
      p_program_id: body.program_id,
      p_version_id: null,
      p_draft: { days: frozen.days, day_ids: frozen.day_ids, days_total: daysTotal },
      p_dry_run: true,
    });
    if (dErr && dErr.code === "PGRST202") {
      // A database without 0107 (A19): no counts, never zeros (zeros would
      // tell the admin nobody is affected).
      console.warn(JSON.stringify({ event: "journey_dry_run_unavailable", program_id: body.program_id }));
      return NextResponse.json(
        { error: `Working out the effect on current learners ${NEEDS_UPDATE}. Nothing was published.` },
        { status: 503 }
      );
    }
    const counts = dry as Record<string, unknown> | null;
    if (
      dErr ||
      !counts ||
      typeof counts !== "object" ||
      counts.dry_run !== true ||
      REPIN_COUNTS.some((k) => !Number.isInteger(counts[k]))
    ) {
      console.error(JSON.stringify({ event: "journey_dry_run_failed", program_id: body.program_id, code: dErr?.code ?? null }));
      return NextResponse.json(
        { error: "Could not work out the effect on current learners. Nothing was published." },
        { status: 400 }
      );
    }
    return NextResponse.json({
      ok: true,
      dry_run: true,
      ...Object.fromEntries(REPIN_COUNTS.map((k) => [k, counts[k]])),
    });
  }

  // ---- Publish: freeze the current draft into an immutable version ----
  // New enrollments pin this version; runs already in flight keep theirs
  // unless apply_to === "all" (admin's explicit force-update).
  if (body.action === "publish") {
    if (!body.program_id) {
      return NextResponse.json({ error: "program_id required" }, { status: 400 });
    }
    const draft = await readDraft(c, body.program_id, "Nothing was published");
    if (!draft.ok) return draft.res;
    const prog = draft.prog;
    // The one freeze (ADR 0024 steps 47 and 92): the saved rows numbered 1
    // to days_total, each day's id in day_ids (rest days included), and a
    // day's pass_required key kept when the row holds one (P2-N8). The map
    // is the editor's, so the version is marked 'editor' (step 94's gate
    // then keeps nobody on an older version by slot).
    const frozen = freezeVersionDays(draft.rows, prog.days_total as number);
    const days = frozen.days;
    if (!days.some((d) => d.course_id)) {
      return NextResponse.json(
        { error: "Add at least one day with a module before publishing" },
        { status: 400 }
      );
    }
    const { data: last, error: lErr } = await c.supabase
      .from("journey_versions")
      .select("version_number")
      .eq("program_id", body.program_id)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lErr) {
      return NextResponse.json({ error: "Could not read the journey's versions. Nothing was published; try again." }, { status: 503 });
    }
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
        unlock_mode: prog.unlock_mode ?? "calendar",
        milestones: prog.milestones,
        copy: prog.copy,
        completion_title: prog.completion_title,
        days,
        day_ids: frozen.day_ids,
        day_ids_source: "editor",
        published_by: c.userId,
      })
      .select("id, version_number")
      .single();
    if (vErr && isSchemaMissing(vErr)) {
      // A database without 0107 (A19): the version names day_ids.
      console.warn(JSON.stringify({ event: "journey_publish_unavailable", program_id: body.program_id, code: vErr.code ?? null }));
      return NextResponse.json({ error: `Publishing ${NEEDS_UPDATE}. Nothing was published.` }, { status: 503 });
    }
    if (vErr) return NextResponse.json({ error: vErr.message }, { status: 400 });
    const { error: uErr } = await c.supabase
      .from("journey_programs")
      .update({ current_version_id: version.id, updated_at: new Date().toISOString() })
      .eq("id", body.program_id);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 400 });

    // ---- Optional force-update: move ACTIVE learners onto the new version.
    // ADR 0024 step 47: one call of journey_repin_enrollments (0107) names
    // the version just made current and, in one transaction, re-pins the
    // program's active enrolments (step 94's gate keeps some on their
    // version), writes the credits a relaxed rule earns and completes every
    // enrolment whose required days are all credited by day id, badge
    // included. Completed and reset enrolments are never selected. No
    // attempt or credit row is updated or deleted, and no email is sent
    // (decision A20). Service role only. The version insert, the pointer
    // update and this call stay three requests: if the call fails after the
    // pointer moved, the version stands for new enrolments. The admin's
    // retry ("Publish again with apply to all") publishes once more, a new
    // version of the same draft, and this call re-pins to that one. That is
    // safe because the function selects active enrolments only and inserts
    // credits without updating or deleting any credit or attempt; it is not
    // the same call repeated.
    if (body.apply_to === "all") {
      const svc = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      );
      const { data: repin, error: rErr } = await svc.rpc("journey_repin_enrollments", {
        p_program_id: body.program_id,
        p_version_id: version.id,
        p_draft: null,
        p_dry_run: false,
      });
      if (rErr && rErr.code === "PGRST202") {
        // A database without 0107 (decision A19): the function is missing,
        // so this publish completes and re-pins nobody. It stands for new
        // enrolments; nothing else is written.
        console.warn(JSON.stringify({ event: "journey_repin_unavailable", program_id: body.program_id, version_id: version.id }));
        return NextResponse.json({
          ok: true,
          version_number: version.version_number,
          repinned: 0,
          completed_now: 0,
        });
      }
      const counts = repin as Record<string, unknown> | null;
      if (rErr || !counts || typeof counts !== "object" || typeof counts.completed_now !== "number") {
        console.error(JSON.stringify({ event: "journey_repin_failed", program_id: body.program_id, version_id: version.id, code: rErr?.code ?? null }));
        return NextResponse.json(
          {
            error: `Published v${version.version_number} for new enrollments, but moving the active learners failed. Publish again with "apply to all" to retry.`,
            version_number: version.version_number,
          },
          { status: 400 }
        );
      }
      // The function's counts, as it answers them (step 47).
      const { dry_run: _dryRun, ...repinCounts } = counts;
      void _dryRun;
      return NextResponse.json({
        ok: true,
        version_number: version.version_number,
        ...repinCounts,
      });
    }

    return NextResponse.json({
      ok: true,
      version_number: version.version_number,
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
    const departments = arr("departments");
    const teamIds = arr("team_ids");
    const groupIds = arr("group_ids");

    const memQ = (cols: string) => c.supabase.from("organization_members").select(cols).eq("organization_id", c.org.id).eq("status", "active");
    let memRes = await memQ("user_id, designation, job_role, city, business_vertical, branch, department");
    if (memRes.error && /department/.test(memRes.error.message)) memRes = await memQ("user_id, designation, job_role, city, business_vertical, branch"); // pre-0096
    const memRows = memRes.data as unknown;
    let candidates = ((memRows ?? []) as Array<{
      user_id: string;
      designation: string | null;
      job_role: string | null;
      city: string | null;
      business_vertical: string | null;
      branch: string | null;
      department?: string | null;
    }>).filter(
      (m) =>
        (designations.length === 0 || designations.includes(m.designation ?? "")) &&
        (jobRoles.length === 0 || jobRoles.includes(m.job_role ?? "")) &&
        (cities.length === 0 || cities.includes(m.city ?? "")) &&
        (verticals.length === 0 || verticals.includes(m.business_vertical ?? "")) &&
        (branches.length === 0 || branches.includes(m.branch ?? "")) &&
        (departments.length === 0 || departments.includes(m.department ?? ""))
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

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    program_id?: string;
    confirm_name?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (!body.program_id) {
    return NextResponse.json({ error: "program_id required" }, { status: 400 });
  }

  // Org-scope + existence check on the caller's own client (RLS-backed).
  const { data: prog } = await c.supabase
    .from("journey_programs")
    .select("id, name")
    .eq("id", body.program_id)
    .eq("organization_id", c.org.id)
    .maybeSingle();
  if (!prog) {
    return NextResponse.json({ error: "Journey not found" }, { status: 404 });
  }

  // Server-side re-check of the typed confirmation — the UI already requires
  // it, but the destructive path must not trust the client. Case-insensitive,
  // whitespace-trimmed exact match on the journey's name.
  const typed = String(body.confirm_name ?? "").trim().toLowerCase();
  if (!typed || typed !== String(prog.name).trim().toLowerCase()) {
    return NextResponse.json(
      { error: "Confirmation name does not match the journey name" },
      { status: 400 }
    );
  }

  // Cascade removes days, versions, enrollments and day-progress. Learners'
  // course attempts, scores and XP survive (attempts reference enrollments
  // with on-delete-set-null) — only the journey structure and its tracking go.
  const { error } = await c.supabase
    .from("journey_programs")
    .delete()
    .eq("id", prog.id)
    .eq("organization_id", c.org.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, deleted: prog.id });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    program_id?: string;
    name?: string;
    icon?: string;
    days_total?: number;
    count_sundays?: boolean;
    unlock_mode?: string;
    reminder_hour?: number;
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
    // Either an emoji (≤8 chars) or an uploaded logo URL (icon-upload kind).
    const isUrl = /^https?:\/\//.test(i) && i.length <= 500;
    if (!i || (!isUrl && i.length > 8)) {
      return NextResponse.json({ error: "Invalid icon" }, { status: 400 });
    }
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
        // Department under the vertical (0096); the trigger evaluates it in SQL too.
        "departments",
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
  if (body.unlock_mode !== undefined) {
    if (body.unlock_mode !== "calendar" && body.unlock_mode !== "progress") {
      return NextResponse.json(
        { error: "unlock_mode must be 'calendar' or 'progress'" },
        { status: 400 }
      );
    }
    update.unlock_mode = body.unlock_mode;
  }
  if (body.reminder_hour !== undefined) {
    const h = Math.round(Number(body.reminder_hour));
    if (!Number.isFinite(h) || h < 0 || h > 23) {
      return NextResponse.json({ error: "reminder_hour must be 0–23" }, { status: 400 });
    }
    update.reminder_hour = h;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The refusal for a save sent by a page built before P2-8 (an entry without
 * its id or its pass_required key): the old editor sends neither, and a
 * missing pass_required would reset the day's rule (P2-N8).
 */
const STALE_EDITOR =
  "The curriculum editor has changed since this page was loaded. Nothing was saved; reload the page and make your changes again.";

/** A code the database gives (a SQLSTATE: five digits or capital letters) or PostgREST gives (PGRST and three digits). */
const DB_CODE = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/;

/**
 * The curriculum save's entries, checked and normalised before any call
 * (ADR 0024 step 92, P2-8 item 3): each an object in the full shape
 * journey_save_days reads (a key left out reads null there), so the route
 * requires every key rather than letting one default. A removed entry is
 * sent as { id, removed: true } with the rest null. The refusals that the
 * function would raise for the common mistakes (an id twice, two days on one
 * number, a new day removed) answer 400 here without a call.
 */
function parseSaveEntries(raw: unknown[]): { ok: true; entries: SaveEntry[] } | { ok: false; error: string } {
  const entries: SaveEntry[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, error: "Each day must be an object" };
    const e = d as Record<string, unknown>;
    if (!("id" in e) || !("pass_required" in e)) return { ok: false, error: STALE_EDITOR };
    const id = e.id;
    if (id !== null && (typeof id !== "string" || !UUID_RE.test(id))) return { ok: false, error: "Invalid day id" };
    const removed = e.removed === undefined ? false : e.removed;
    if (typeof removed !== "boolean") return { ok: false, error: "removed must be true or false" };
    if (removed) {
      if (id === null) return { ok: false, error: "A day that was never saved cannot be removed" };
      entries.push({ id: id.toLowerCase(), day_number: null, course_id: null, mission_title: null, pass_required: null, removed: true });
      continue;
    }
    if (!("day_number" in e) || !("course_id" in e) || !("mission_title" in e)) {
      return { ok: false, error: "Each day needs id, day_number, course_id, mission_title and pass_required" };
    }
    const n = e.day_number;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_DAY_NUMBER) {
      return { ok: false, error: `Invalid day_number ${String(n)}` };
    }
    const courseId = e.course_id;
    if (courseId !== null && (typeof courseId !== "string" || !UUID_RE.test(courseId))) {
      return { ok: false, error: `Invalid module on day ${n}` };
    }
    const rule = e.pass_required;
    if (rule !== null && typeof rule !== "boolean") return { ok: false, error: `Invalid pass rule on day ${n}` };
    const title = typeof e.mission_title === "string" && e.mission_title.trim() ? e.mission_title.trim().slice(0, 120) : null;
    entries.push({
      id: id === null ? null : id.toLowerCase(),
      day_number: n,
      course_id: courseId === null ? null : courseId.toLowerCase(),
      mission_title: title,
      pass_required: rule,
      removed: false,
    });
  }
  const named = entries.filter((e) => e.id !== null).map((e) => e.id as string);
  if (new Set(named).size !== named.length) return { ok: false, error: "A day is named twice in the save" };
  const numbers = entries.filter((e) => !e.removed).map((e) => e.day_number as number);
  const twice = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (twice !== undefined) return { ok: false, error: `Two days of the save are numbered ${twice}` };
  return { ok: true, entries };
}

/** A journey_days row as the save's read-back reads it. */
type SavedDay = { id: string; day_number: number; course_id: string | null; mission_title: string | null; pass_required: boolean | null };

/**
 * PUT: the curriculum save by day identity (ADR 0024 step 92, P2-8 item 3),
 * an A19 write. One call of journey_save_days on the admin's own session
 * (security invoker, so the admin write policy of journey_days decides);
 * no fallback to the old upsert on (program, day number). Then one read of
 * the program's active days (its own abort signal), and the answer is built
 * from that read: "saved" is said only when every sent day is there as sent
 * and no removed day is still active, and the rows (with the ids of the new
 * ones) go back to the editor, which rebuilds itself from them (P2-N7 rule
 * (1)). The route deletes nothing.
 */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    program_id?: unknown;
    days?: unknown;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const programId = body.program_id;
  if (typeof programId !== "string" || !UUID_RE.test(programId) || !Array.isArray(body.days)) {
    return NextResponse.json({ error: "program_id and days[] required" }, { status: 400 });
  }
  if (body.days.length === 0) {
    return NextResponse.json({ error: "Nothing to save" }, { status: 400 });
  }
  // Every active day once (at most 365) and each removed saved day once.
  if (body.days.length > 2 * MAX_DAY_NUMBER) {
    return NextResponse.json({ error: "too many days" }, { status: 400 });
  }
  const parsed = parseSaveEntries(body.days);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const entries = parsed.entries;

  // The program within the caller's organisation (journey_save_days reads
  // the program in any organisation the session belongs to, and the module
  // check below is against this one).
  const { data: prog, error: pErr } = await c.supabase
    .from("journey_programs")
    .select("id")
    .eq("id", programId)
    .eq("organization_id", c.org.id)
    .maybeSingle();
  if (pErr) {
    return NextResponse.json({ error: "Could not load the journey. Nothing was saved; try again." }, { status: 503 });
  }
  if (!prog) return NextResponse.json({ error: "Journey not found" }, { status: 404 });

  // Every referenced module must belong to THIS org — otherwise a crafted
  // payload could schedule (and thereby entitle learners to) another
  // tenant's course.
  const wantedCourseIds = Array.from(
    new Set(entries.map((d) => d.course_id).filter((x): x is string => !!x))
  );
  if (wantedCourseIds.length > 0) {
    const { data: courseRows, error: cErr } = await c.supabase
      .from("courses")
      .select("id")
      .eq("organization_id", c.org.id)
      .in("id", wantedCourseIds);
    if (cErr) {
      return NextResponse.json({ error: "Could not check the modules. Nothing was saved; try again." }, { status: 503 });
    }
    const own = new Set(((courseRows ?? []) as Array<{ id: string }>).map((r) => r.id.toLowerCase()));
    if (wantedCourseIds.some((id) => !own.has(id))) {
      return NextResponse.json(
        { error: "One or more modules don't belong to this organization" },
        { status: 400 }
      );
    }
  }

  const { data: answer, error } = await c.supabase.rpc("journey_save_days", {
    p_program_id: programId,
    p_days: entries,
  });
  if (error) {
    // An error without a database code (DB_CODE) is not the database's
    // answer: the request failed on the way or a gateway answered in the
    // database's place (the client library gives such an error an empty
    // code or none; a gateway's JSON may carry a code of its own). The call
    // may have committed, so this is never "nothing was saved": the editor
    // reloads before its next save (ADR 0024 P2-8 note, items 8 and 10).
    const code = typeof error.code === "string" && DB_CODE.test(error.code) ? error.code : null;
    if (code === null) {
      console.error(JSON.stringify({ event: "journey_save_unconfirmed", program_id: programId }));
      return NextResponse.json(
        { error: "The save may have gone through, but its answer did not arrive. Reload the page to see what was saved before editing again.", saved_unconfirmed: true, reload: true },
        { status: 503 }
      );
    }
    // An error with a code is a refusal PostgREST or the database raised:
    // the one transaction rolled back, so the save wrote nothing.
    if (code === "PGRST202") {
      console.warn(JSON.stringify({ event: "journey_save_unavailable", program_id: programId }));
      return NextResponse.json({ error: `Saving the curriculum ${NEEDS_UPDATE}. Nothing was saved.` }, { status: 503 });
    }
    console.error(JSON.stringify({ event: "journey_save_refused", program_id: programId, code }));
    if (code === "22023") {
      return NextResponse.json(
        { error: "The curriculum has changed since this page was loaded (another tab or admin saved it). Nothing was saved; reload the page and make your changes again.", code, reload: true },
        { status: 409 }
      );
    }
    if (code === "23505") {
      return NextResponse.json(
        { error: "A day's number is taken by a day this page does not show (the curriculum changed since it was loaded). Nothing was saved; reload the page.", code, reload: true },
        { status: 409 }
      );
    }
    if (code === "23514" || code === "22P02") {
      return NextResponse.json({ error: "A day's number or id is not valid. Nothing was saved.", code }, { status: 400 });
    }
    if (code === "42501") return NextResponse.json({ error: "Forbidden", code }, { status: 403 });
    return NextResponse.json({ error: "Could not save the curriculum. Nothing was saved; try again.", code }, { status: 500 });
  }
  const counts = answer as Record<string, unknown> | null;
  if (
    !counts ||
    typeof counts !== "object" ||
    ["saved", "renumbered", "removed", "inserted"].some((k) => !Number.isInteger(counts[k])) ||
    counts.saved !== entries.length
  ) {
    console.error(JSON.stringify({ event: "journey_save_unexpected", program_id: programId }));
    return NextResponse.json(
      { error: "The save gave an answer this page does not expect. Reload the page to see what was saved before editing again.", reload: true },
      { status: 500 }
    );
  }

  // The read-back: what the database now holds (a second read of this table
  // in the request carries its own abort signal, so it is never answered
  // from the first; ADR 0024's fetch memoization risk).
  const { data: back, error: bErr } = await c.supabase
    .from("journey_days")
    .select("id, day_number, course_id, mission_title, pass_required")
    .eq("program_id", programId)
    .not("day_number", "is", null)
    .order("day_number", { ascending: true })
    .abortSignal(new AbortController().signal);
  if (bErr) {
    return NextResponse.json(
      { error: "The curriculum was saved, but it could not be loaded again. Reload the page before editing it again.", saved_unconfirmed: true, reload: true },
      { status: 503 }
    );
  }
  const rows = (back ?? []) as SavedDay[];
  const lc = (x: string | null) => (x === null ? null : x.toLowerCase());
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const byNumber = new Map(rows.map((r) => [r.day_number, r]));
  const sentIds = new Set(entries.filter((e) => e.id !== null).map((e) => e.id as string));
  const asSent = (r: SavedDay | undefined, e: SaveEntry) =>
    !!r &&
    r.day_number === e.day_number &&
    lc(r.course_id) === e.course_id &&
    (r.mission_title ?? null) === e.mission_title &&
    (r.pass_required ?? null) === e.pass_required;
  let saved = 0;
  let inserted = 0;
  let removed = 0;
  let mismatch = 0;
  for (const e of entries) {
    if (e.removed) {
      if (byId.has(e.id as string)) mismatch++;
      else removed++;
    } else if (e.id !== null) {
      if (asSent(byId.get(e.id), e)) saved++;
      else mismatch++;
    } else {
      const r = byNumber.get(e.day_number as number);
      if (r && !sentIds.has(r.id.toLowerCase()) && asSent(r, e)) {
        saved++;
        inserted++;
      } else {
        mismatch++;
      }
    }
  }
  if (mismatch > 0) {
    console.error(JSON.stringify({ event: "journey_save_mismatch", program_id: programId, mismatched: mismatch }));
    return NextResponse.json(
      { error: "The curriculum did not come back as it was sent. Reload the page to see it as saved before editing again.", reload: true },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    saved,
    inserted,
    removed,
    renumbered: counts.renumbered,
    days: rows,
  });
}
