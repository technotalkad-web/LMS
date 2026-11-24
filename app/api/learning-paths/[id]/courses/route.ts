import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOrgAdminCaller, notAdminAnswer } from "@/lib/auth/api-admin";
import { countingMemberIds } from "@/lib/auth/org-membership";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmailsStrict } from "@/lib/users/emails";
import { RECIPIENTS_UNREADABLE, mailCounts, sendMany, type MailOutcome } from "@/lib/notifications/send";
import { ADMIN_REQUEST_OWN_CALLS, countCalls, openRun, recordRecipientsUnreadable, requestBudget, spendCalls } from "@/lib/notifications/smtp-state";
import { originFromRequest } from "@/lib/http/origin";
import { assignedRecipientsStrict } from "@/lib/org/groups";

/**
 *   POST   /api/learning-paths/{id}/courses   body: { courseId }
 *   DELETE /api/learning-paths/{id}/courses?courseId=...
 *   PUT    /api/learning-paths/{id}/courses   body: { orderedCourseIds: string[] }
 *   PATCH  /api/learning-paths/{id}/courses   body: { courseId, releaseAt }
 *
 * POST appends the course at the next step_number. It checks the caller's
 * role in the path's org explicitly (admins only; a failed role read answers
 * 503) before the insert and the service-role notify_update pass.
 * PUT resets the entire step ordering.
 * PATCH sets/clears a step's scheduled release (releaseAt: ISO string or null);
 * steps are addressed by (path_id, course_id) — the table has no surrogate id.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: pathId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    courseId?: string;
    releaseAt?: string | null;
  };
  if (!body.courseId) {
    return NextResponse.json({ error: "courseId required" }, { status: 400 });
  }
  let releaseAt: string | null = null;
  if (body.releaseAt !== undefined && body.releaseAt !== null) {
    if (typeof body.releaseAt !== "string" || Number.isNaN(new Date(body.releaseAt).getTime())) {
      return NextResponse.json(
        { error: "releaseAt must be an ISO datetime or null" },
        { status: 400 }
      );
    }
    releaseAt = new Date(body.releaseAt).toISOString();
  }

  // Caller-RLS write, same trust model as PUT: only the path org's admins can
  // update learning_path_courses rows.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("learning_path_courses")
    .update({ release_at: releaseAt })
    .eq("path_id", pathId)
    .eq("course_id", body.courseId)
    .select("course_id");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Step not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, release_at: releaseAt });
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: pathId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    courseId?: string;
    notify_update?: boolean;
  };
  const courseId = body.courseId;
  if (!courseId) {
    return NextResponse.json({ error: "courseId required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Tenant guard: the course must belong to the SAME org as the path. RLS lets
  // a path's admin write learning_path_courses but doesn't check the course's
  // org, so without this an admin could inject another tenant's course as a
  // step. (Reading courses is RLS-scoped to org members, so a foreign course
  // resolves to null and is rejected.)
  const { data: path } = await supabase
    .from("learning_paths")
    .select("organization_id")
    .eq("id", pathId)
    .maybeSingle();
  if (!path) return NextResponse.json({ error: "Path not found" }, { status: 404 });
  const pathOrgId = (path as { organization_id: string }).organization_id;
  const admin = await isOrgAdminCaller(supabase, pathOrgId, user.id);
  if (!admin) {
    const refused = notAdminAnswer(admin);
    return NextResponse.json({ error: refused.error }, { status: refused.status });
  }
  const { data: course } = await supabase
    .from("courses")
    .select("id")
    .eq("id", courseId)
    .eq("organization_id", pathOrgId)
    .maybeSingle();
  if (!course) {
    return NextResponse.json(
      { error: "Course not found in this organization" },
      { status: 404 }
    );
  }

  // Find the next step number.
  const { data: existing } = await supabase
    .from("learning_path_courses")
    .select("step_number")
    .eq("path_id", pathId)
    .order("step_number", { ascending: false })
    .limit(1);
  const nextStep = ((existing?.[0]?.step_number as number | undefined) ?? 0) + 1;

  const { error } = await supabase
    .from("learning_path_courses")
    .insert({ path_id: pathId, course_id: courseId, step_number: nextStep });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Fire asset_update emails for everyone assigned to this path. Path
  // completion is computed live from course attempts, so previously-
  // completed learners are now "incomplete" against the new structure; we
  // give them a heads-up so they know to come back for the new content.
  let email: MailOutcome | null = null;
  if (body.notify_update) {
    email = await (async (): Promise<MailOutcome | null> => {
      const orgId: string = pathOrgId;
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const budget = requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
        spendCalls(budget, 1);
        const { data: pathRow, error: pathErr } = await svc
          .from("learning_paths")
          .select(
            "name, organization_id, organizations(name, slug)"
          )
          .eq("id", pathId)
          .maybeSingle();
        const p = pathRow as
          | {
              name?: string;
              organization_id?: string;
              organizations?:
                | { name?: string; slug?: string }
                | { name?: string; slug?: string }[];
            }
          | null;
        // The path was read earlier in this request, so a failed or empty
        // read here is a read that failed, never "nobody to mail" (ADR 0029,
        // note of 2026-11-20, part 3): the step stays added, nobody is
        // emailed, the skip is recorded and the answer says so.
        if (pathErr || !p?.organization_id) {
          await recordRecipientsUnreadable("learning-paths/[id]/courses", orgId);
          return RECIPIENTS_UNREADABLE;
        }
        const orgInfo = Array.isArray(p.organizations)
          ? p.organizations[0]
          : p.organizations;

        // ADR 0030 rule 10: the organisation mails only members that count
        // (active, in an organisation that is not deleted). One read of them
        // for this request: it is the org-wide audience and the filter on
        // every other one. A failed read of the recipients mails nobody.
        const counting = await countingMemberIds(svc, p.organization_id, undefined, countCalls(budget));
        if (counting === "unreadable") {
          await recordRecipientsUnreadable("learning-paths/[id]/courses", p.organization_id);
          return RECIPIENTS_UNREADABLE;
        }
        const recipients = await assignedRecipientsStrict(
          svc,
          p.organization_id,
          { table: "learning_path_assignments", column: "path_id", id: pathId },
          counting,
          countCalls(budget)
        );
        if (recipients === "unreadable") {
          await recordRecipientsUnreadable("learning-paths/[id]/courses", p.organization_id);
          return RECIPIENTS_UNREADABLE;
        }
        if (recipients.size === 0) return mailCounts([]);

        spendCalls(budget, Math.ceil(recipients.size / 150));
        const emailById = await resolveEmailsStrict(svc, recipients);
        if (emailById === "unreadable") {
          await recordRecipientsUnreadable("learning-paths/[id]/courses", p.organization_id);
          return RECIPIENTS_UNREADABLE;
        }

        const portalBase = await originFromRequest();
        const directLink = portalBase && orgInfo?.slug
          ? `${portalBase}/${orgInfo.slug}/dashboard`
          : "";

        const people = [...recipients].flatMap((uid) => {
          const address = emailById.get(uid);
          return address ? [{ uid, email: address }] : [];
        });
        const run = await openRun({ organizationId: p.organization_id, budget, db: svc });
        const results = await sendMany(run, people, (person) => ({
          event: "asset_update",
          to: { user_id: person.uid, email: person.email },
          context: {
            learner_name: person.email,
            learner_email: person.email,
            path_name: p.name ?? "your learning path",
            path_id: pathId,
            // The asset_update template renders {Course_Name}; for a path
            // update we populate it with the path's name so the email reads
            // naturally instead of leaking a literal {Course_Name} token.
            course_name: p.name ?? "your learning path",
            org_name: orgInfo?.name ?? "your org",
            direct_link: directLink,
          },
        }));
        return mailCounts(results, recipients.size - people.length);
      } catch (e) {
        console.warn(JSON.stringify({ event: "assignment_mail_failed", site: "learning-paths/[id]/courses", org_id: orgId, error: e instanceof Error ? e.name : "unknown" }));
        return null;
      }
    })();
  }

  return NextResponse.json({ ok: true, step: nextStep, email });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: pathId } = await params;
  const url = new URL(request.url);
  const courseId = url.searchParams.get("courseId");
  if (!courseId) {
    return NextResponse.json({ error: "courseId required" }, { status: 400 });
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("learning_path_courses")
    .delete()
    .eq("path_id", pathId)
    .eq("course_id", courseId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Renumber the remaining steps to keep them contiguous.
  const { data: rest } = await supabase
    .from("learning_path_courses")
    .select("course_id, step_number")
    .eq("path_id", pathId)
    .order("step_number", { ascending: true });
  if (rest) {
    for (let i = 0; i < rest.length; i++) {
      const want = i + 1;
      if (rest[i].step_number !== want) {
        await supabase
          .from("learning_path_courses")
          .update({ step_number: want })
          .eq("path_id", pathId)
          .eq("course_id", rest[i].course_id);
      }
    }
  }
  return NextResponse.json({ ok: true });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: pathId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    orderedCourseIds?: string[];
  };
  const ids = body.orderedCourseIds ?? [];
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "orderedCourseIds required" },
      { status: 400 }
    );
  }
  const supabase = await createClient();
  // Two-pass update to avoid step_number unique-constraint conflicts: first
  // bump every row to a high temporary step, then assign the final order.
  for (let i = 0; i < ids.length; i++) {
    await supabase
      .from("learning_path_courses")
      .update({ step_number: 10000 + i })
      .eq("path_id", pathId)
      .eq("course_id", ids[i]);
  }
  for (let i = 0; i < ids.length; i++) {
    await supabase
      .from("learning_path_courses")
      .update({ step_number: i + 1 })
      .eq("path_id", pathId)
      .eq("course_id", ids[i]);
  }
  return NextResponse.json({ ok: true });
}
