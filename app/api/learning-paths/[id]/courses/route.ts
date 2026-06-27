import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";
import { originFromRequest } from "@/lib/http/origin";

/**
 *   POST   /api/learning-paths/{id}/courses   body: { courseId }
 *   DELETE /api/learning-paths/{id}/courses?courseId=...
 *   PUT    /api/learning-paths/{id}/courses   body: { orderedCourseIds: string[] }
 *
 * POST appends the course at the next step_number.
 * PUT resets the entire step ordering.
 */
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
  const { data: course } = await supabase
    .from("courses")
    .select("id")
    .eq("id", courseId)
    .eq("organization_id", (path as { organization_id: string }).organization_id)
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
  if (body.notify_update) {
    await (async () => {
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const { data: pathRow } = await svc
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
        if (!p?.organization_id) return;
        const orgInfo = Array.isArray(p.organizations)
          ? p.organizations[0]
          : p.organizations;

        const recipientIds = await resolvePathLearners(svc, p.organization_id, pathId);
        if (recipientIds.size === 0) return;

        const { data: listed } = await svc.auth.admin.listUsers({
          page: 1,
          perPage: 1500,
        });
        const emailById = new Map<string, string>();
        for (const u of listed?.users ?? []) {
          if (u.email && recipientIds.has(u.id)) emailById.set(u.id, u.email);
        }

        const portalBase = await originFromRequest();
        const directLink = portalBase && orgInfo?.slug
          ? `${portalBase}/${orgInfo.slug}/dashboard`
          : "";

        for (const uid of recipientIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          await notifyBackground({
            organizationId: p.organization_id,
            event: "asset_update",
            to: { user_id: uid, email },
            context: {
              learner_name: email,
              learner_email: email,
              path_name: p.name ?? "your learning path",
              path_id: pathId,
              // The asset_update template renders {Course_Name}; for a path
              // update we populate it with the path's name so the email reads
              // naturally instead of leaking a literal {Course_Name} token.
              course_name: p.name ?? "your learning path",
              org_name: orgInfo?.name ?? "your org",
              direct_link: directLink,
            },
          });
        }
      } catch (e) {
        console.warn("[path/add-course] update-notify failed:", e);
      }
    })();
  }

  return NextResponse.json({ ok: true, step: nextStep });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function resolvePathLearners(
  svc: any,
  orgId: string,
  pathId: string
): Promise<Set<string>> {
  const out = new Set<string>();
  const { data: rows } = await svc
    .from("learning_path_assignments")
    .select("assignee_type, user_id, team_id")
    .eq("path_id", pathId);
  const teamIds = new Set<string>();
  let coversOrg = false;
  for (const r of (rows ?? []) as Array<{
    assignee_type: "user" | "team" | "org";
    user_id: string | null;
    team_id: string | null;
  }>) {
    if (r.assignee_type === "user" && r.user_id) out.add(r.user_id);
    else if (r.assignee_type === "team" && r.team_id) teamIds.add(r.team_id);
    else if (r.assignee_type === "org") coversOrg = true;
  }
  if (teamIds.size > 0) {
    const { data: tm } = await svc
      .from("team_members")
      .select("user_id")
      .in("team_id", Array.from(teamIds));
    for (const m of tm ?? []) out.add(m.user_id as string);
  }
  if (coversOrg) {
    const { data: om } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", orgId);
    for (const m of om ?? []) out.add(m.user_id as string);
  }
  return out;
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
