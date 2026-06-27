import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  deriveAttemptStatus,
  deriveCompletionStatus,
  deriveSuccessStatus,
  deriveScore,
  type CmiData,
} from "@/lib/scorm/types";
import { notifyBackground } from "@/lib/notifications/send";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";

/**
 *   POST /api/scorm/{attemptId}/commit
 *   body: { cmi: { ... }, finished: boolean }
 *
 * Persists the CMI snapshot, derives BOTH axes:
 *   - completion_status: did the learner finish the course?
 *   - success_status:    did they pass the assessment?
 *
 * Plus the legacy single-axis `status` for backward compatibility.
 *
 * RLS on `course_attempts` enforces user_id = auth.uid() on updates.
 * Terminal values are never downgraded by a later commit (e.g. an unload
 * beacon arriving after LMSFinish must not erase a completed attempt).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> }
) {
  const { attemptId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: { cmi?: CmiData; finished?: boolean };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const cmi = (payload.cmi ?? {}) as CmiData;
  const finished = Boolean(payload.finished);

  // Load current state + mastery threshold.
  const { data: attempt } = await supabase
    .from("course_attempts")
    .select(
      "status, completion_status, success_status, completed_at, course_version_id, course_versions(manifest_data)"
    )
    .eq("id", attemptId)
    .eq("user_id", user.id)
    .maybeSingle();

  const a = attempt as
    | {
        status?: string;
        completion_status?: string;
        success_status?: string;
        completed_at?: string | null;
        course_versions?: { manifest_data?: { masteryScore?: number | null } };
      }
    | null;

  const currentStatus = a?.status;
  const currentCompletion = a?.completion_status;
  const currentSuccess = a?.success_status;
  const alreadyCompletedAt = a?.completed_at;
  const masteryScore =
    typeof a?.course_versions?.manifest_data?.masteryScore === "number"
      ? a.course_versions.manifest_data.masteryScore
      : null;

  const derivedCompletion = deriveCompletionStatus(cmi, finished);
  const derivedSuccess = deriveSuccessStatus(cmi, finished, masteryScore);
  const derivedStatus = deriveAttemptStatus(cmi, finished, masteryScore);

  // Never downgrade. Once an attempt is completed/passed/failed a later
  // beacon with finished=false must leave the terminal values alone.
  const completion_status =
    currentCompletion === "completed" && derivedCompletion === "in_progress"
      ? currentCompletion
      : derivedCompletion;

  // Non-downgrade: a `passed` attempt is terminal — never let a later commit
  // (a stray unload beacon, a re-run SCO emitting `failed`, or an `unknown`
  // derivation) pull it back to failed/unknown. `failed` is held only against
  // an `unknown` derivation — an actual later `passed` may still upgrade it.
  const success_status =
    currentSuccess === "passed"
      ? "passed"
      : currentSuccess === "failed" && derivedSuccess === "unknown"
        ? "failed"
        : derivedSuccess;

  const terminal: Array<string | undefined> = ["passed", "failed", "completed"];
  const status =
    currentStatus === "passed" && derivedStatus !== "passed"
      ? "passed"
      : terminal.includes(currentStatus) && derivedStatus === "in_progress"
        ? (currentStatus as typeof derivedStatus)
        : derivedStatus;

  const score = deriveScore(cmi);

  const update: Record<string, unknown> = {
    cmi_data: cmi,
    status,
    completion_status,
    success_status,
  };
  if (score !== null) update.score = score;
  if (
    !alreadyCompletedAt &&
    (finished || derivedCompletion === "completed")
  ) {
    update.completed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("course_attempts")
    .update(update)
    .eq("id", attemptId)
    .eq("user_id", user.id);

  if (error) {
    console.error("[scorm/commit] update failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // If this commit transitioned the attempt to completed/passed, fire the
  // milestone notification once. Compare against previous values.
  const justCompleted =
    currentCompletion !== "completed" && completion_status === "completed";
  const justPassed =
    currentSuccess !== "passed" && success_status === "passed";
  if (justCompleted || justPassed) {
    await (async () => {
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const { data: row } = await svc
          .from("course_attempts")
          .select(
            // Disambiguate the embed: course_versions <-> courses has TWO FKs
            // (course_versions.course_id and courses.current_version_id), so an
            // unqualified courses(...) embed errors out ("more than one
            // relationship found") and silently skipped the completion email.
            "organization_id, course_version_id, course_versions(course_id, courses!course_versions_course_id_fkey(title)), score"
          )
          .eq("id", attemptId)
          .maybeSingle();
        const r = row as
          | {
              organization_id?: string;
              course_versions?: {
                course_id?: string;
                courses?: { title?: string } | { title?: string }[];
              };
              score?: number | null;
            }
          | null;
        const orgId = r?.organization_id;
        const courseTitle = (() => {
          const c = r?.course_versions?.courses;
          if (!c) return undefined;
          if (Array.isArray(c)) return c[0]?.title;
          return c.title;
        })();
        if (!orgId) return;
        const { data: orgRow } = await svc
          .from("organizations")
          .select("name, slug")
          .eq("id", orgId)
          .maybeSingle();
        const portalBase = await originFromRequest();
        await notifyBackground({
          organizationId: orgId,
          event: "asset_completion",
          to: { user_id: user.id, email: user.email ?? "" },
          context: {
            learner_name: user.email ?? "Learner",
            learner_email: user.email ?? undefined,
            course_name: courseTitle ?? "the course",
            org_name: (orgRow as { name?: string } | null)?.name ?? "your org",
            score:
              typeof r?.score === "number"
                ? `Final score: ${Math.round(r.score * 100)}%.`
                : "",
            portal_url: portalBase
              ? `${portalBase}/${(orgRow as { slug?: string } | null)?.slug ?? ""}/dashboard`
              : "",
          },
        });

        // ---- Did this completion close out a learning path? -----------
        const courseId = (() => {
          const cv = r?.course_versions;
          if (!cv) return null;
          return cv.course_id ?? null;
        })();
        if (!courseId) return;

        // Find paths containing this course.
        const { data: stepRows } = await svc
          .from("learning_path_courses")
          .select("path_id")
          .eq("course_id", courseId);
        const candidatePathIds = (stepRows ?? []).map(
          (s) => s.path_id as string
        );
        if (candidatePathIds.length === 0) return;

        // Which of those paths is this user actually assigned to?
        // Reuse the assignment-expansion: direct, team, or org-wide.
        const { data: teamRows2 } = await svc
          .from("team_members")
          .select("team_id, teams!inner(organization_id)")
          .eq("user_id", user.id);
        const teamIds = ((teamRows2 ?? []) as Array<{
          team_id: string;
          teams:
            | { organization_id: string }
            | Array<{ organization_id: string }>;
        }>)
          .filter((tr) => {
            const t = Array.isArray(tr.teams) ? tr.teams[0] : tr.teams;
            return t?.organization_id === orgId;
          })
          .map((tr) => tr.team_id);

        const { data: paRows } = await svc
          .from("learning_path_assignments")
          .select("path_id, assignee_type, user_id, team_id")
          .in("path_id", candidatePathIds);
        const assignedPathIds = new Set(
          ((paRows ?? []) as Array<{
            path_id: string;
            assignee_type: "user" | "team" | "org";
            user_id: string | null;
            team_id: string | null;
          }>)
            .filter(
              (a) =>
                (a.assignee_type === "user" && a.user_id === user.id) ||
                a.assignee_type === "org" ||
                (a.assignee_type === "team" &&
                  a.team_id &&
                  teamIds.includes(a.team_id))
            )
            .map((a) => a.path_id)
        );
        if (assignedPathIds.size === 0) return;

        // For each assigned path, check whether the user has completed
        // every course in it.
        const { data: allSteps } = await svc
          .from("learning_path_courses")
          .select("path_id, course_id")
          .in("path_id", Array.from(assignedPathIds));
        const stepsByPath = new Map<string, string[]>();
        for (const s of (allSteps ?? []) as Array<{
          path_id: string;
          course_id: string;
        }>) {
          const arr = stepsByPath.get(s.path_id) ?? [];
          arr.push(s.course_id);
          stepsByPath.set(s.path_id, arr);
        }
        const allCourseIds = Array.from(
          new Set(Array.from(stepsByPath.values()).flat())
        );
        const { data: vRows } = await svc
          .from("course_versions")
          .select("id, course_id")
          .in("course_id", allCourseIds);
        const verToCourse = new Map(
          ((vRows ?? []) as Array<{ id: string; course_id: string }>).map(
            (v) => [v.id, v.course_id]
          )
        );
        const verIds = Array.from(verToCourse.keys());
        const { data: aRows } = verIds.length
          ? await svc
              .from("course_attempts")
              .select(
                "course_version_id, completion_status, success_status"
              )
              .eq("user_id", user.id)
              .in("course_version_id", verIds)
          : { data: [] };
        const doneCourses = new Set<string>();
        for (const a of (aRows ?? []) as Array<{
          course_version_id: string;
          completion_status: string;
          success_status: string;
        }>) {
          if (
            a.completion_status === "completed" ||
            a.success_status === "passed"
          ) {
            const cid = verToCourse.get(a.course_version_id);
            if (cid) doneCourses.add(cid);
          }
        }

        // Resolve names for any path the user has now finished.
        const finishedPathIds = Array.from(assignedPathIds).filter((pid) => {
          const steps = stepsByPath.get(pid) ?? [];
          return steps.length > 0 && steps.every((cid) => doneCourses.has(cid));
        });
        if (finishedPathIds.length === 0) return;

        const { data: pathNameRows } = await svc
          .from("learning_paths")
          .select("id, name")
          .in("id", finishedPathIds);
        for (const p of (pathNameRows ?? []) as Array<{
          id: string;
          name: string;
        }>) {
          await notifyBackground({
            organizationId: orgId,
            event: "path_completion",
            to: { user_id: user.id, email: user.email ?? "" },
            context: {
              learner_name: user.email ?? "Learner",
              learner_email: user.email ?? undefined,
              path_name: p.name,
              path_id: p.id,
              org_name: (orgRow as { name?: string } | null)?.name ?? "your org",
              portal_url: portalBase
                ? `${portalBase}/${(orgRow as { slug?: string } | null)?.slug ?? ""}/dashboard`
                : "",
              direct_link: portalBase
                ? `${portalBase}/${(orgRow as { slug?: string } | null)?.slug ?? ""}/dashboard`
                : "",
            },
          });
        }
      } catch (e) {
        console.warn("[scorm/commit] notify failed:", e);
      }
    })();
  }

  return NextResponse.json({
    ok: true,
    completion_status,
    success_status,
    status,
    score,
  });
}
