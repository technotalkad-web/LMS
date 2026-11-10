import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { launchModeFor } from "@/lib/alds/launch";
import { createClient } from "@/lib/supabase/server";
import { computeScoring, officialDone, type ScorableAttempt } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { readWithOptionalColumn } from "@/lib/scoring/attempt-kind";
import {
  CONTINUE_POLL_MS,
  CONTINUE_WAIT_MS,
  continueTarget,
  isUuid,
  nextStepAfter,
  resultStored,
  verdictPending,
} from "@/lib/learner/continue";

/**
 * The continue address (ADR 0019 steps 1 and 2): from a finished module to the
 * next step of the Learning Path it was launched from. The launch bar's
 * Continue button links here with `?lp=<path>&from=<course>`.
 *
 * It reads only, on the caller's RLS session, and writes nothing: the result
 * is written by the statements and commit routes as today. It waits, at most
 * CONTINUE_WAIT_MS, for the module's official result to be stored (on a
 * pass_required course, with its pass or fail: verdictPending), then moves
 * the learner on only when that result completes the step under the course's
 * pass_required setting. The launch page keeps its own gates (release dates,
 * the strict lock, assignment) for the next launch; nothing here repeats them.
 * loading.tsx shows "Saving your result" while this page waits.
 *
 * Every refusal is a redirect() outside any try (redirect throws).
 */
const ATTEMPT_COLUMNS = "id, score, started_at, completed_at, completion_status, success_status, status";

export default async function ContinuePage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ lp?: string; from?: string }>;
}) {
  const { org: orgSlug } = await params;
  const { lp, from } = await searchParams;
  if (!isUuid(lp) || !isUuid(from)) redirect(`/${orgSlug}/dashboard`);
  const pathId: string = lp;
  const fromCourseId: string = from;

  const { user, org, role } = await requireOrgAccess(orgSlug);
  const supabase = await createClient();
  const log = (event: string) =>
    console.warn(JSON.stringify({ event, path_id: pathId, course_id: fromCourseId, user_id: user.id }));

  // The path, in this organisation and active. Another organisation's path
  // reads as absent under RLS.
  const { data: pathRow, error: pathErr } = await supabase
    .from("learning_paths")
    .select("id, is_active")
    .eq("id", pathId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (pathErr || !pathRow || (pathRow as { is_active?: boolean | null }).is_active === false) {
    redirect(`/${orgSlug}/dashboard`);
  }

  const { data: stepRows, error: stepErr } = await supabase
    .from("learning_path_courses")
    .select("course_id, step_number")
    .eq("path_id", pathId)
    .order("step_number", { ascending: true });
  if (stepErr) redirect(`/${orgSlug}/dashboard`);
  const steps = (stepRows ?? []) as Array<{ course_id: string; step_number: number }>;
  if (!steps.some((s) => s.course_id === fromCourseId)) {
    log("continue_not_a_step");
    redirect(`/${orgSlug}/paths/${pathId}`);
  }
  const next = nextStepAfter(steps, fromCourseId);
  const target = (t: { timedOut: boolean; stored: boolean; done: boolean; isStaff?: boolean }) =>
    continueTarget({ orgSlug, pathId, isStaff: t.isStaff ?? false, timedOut: t.timedOut, stored: t.stored, done: t.done, next });

  // Staff and data analysts launch previews, which record no official result
  // (the launch page's own test), so a wait could never end early: go now.
  const isStaff = launchModeFor({ role, revision: false }).isPreview;
  if (isStaff) redirect(target({ isStaff: true, timedOut: false, stored: false, done: false }));

  // Before the wait, once, strictly: a read error ends as the timeout target,
  // never as "not required" or "no grants" (the fail-soft helpers would read
  // that and move a learner on wrongly).
  const readError: () => never = () => {
    log("continue_read_error");
    redirect(target({ timedOut: true, stored: false, done: false }));
  };

  const { data: courseRow, error: courseErr } = await supabase
    .from("courses")
    .select("pass_required")
    .eq("id", fromCourseId)
    .maybeSingle();
  if (courseErr || !courseRow) readError();
  const passRequired = (courseRow as { pass_required?: boolean | null }).pass_required === true;

  const { data: verRows, error: verErr } = await supabase
    .from("course_versions")
    .select("id")
    .eq("course_id", fromCourseId);
  const versionIds = ((verRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (verErr || versionIds.length === 0) readError();

  // The learner's own consumed grants on this course (0083 policy "learners
  // read their own attempt requests"): the ids computeScoring takes.
  const { data: grantRows, error: grantErr } = await supabase
    .from("attempt_requests")
    .select("used_attempt_id")
    .eq("user_id", user.id)
    .eq("course_id", fromCourseId)
    .eq("status", "approved")
    .not("used_attempt_id", "is", null);
  if (grantErr) readError();
  const retakeIds = new Set(
    ((grantRows ?? []) as Array<{ used_attempt_id: string | null }>)
      .map((r) => r.used_attempt_id)
      .filter((id): id is string => typeof id === "string")
  );

  // Fail-soft to the default policy, accepted (ADR 0019 step 2): under one
  // official attempt with extra attempts only by grant, the default and a read
  // policy choose the same official attempt once the grant ids are passed.
  const policy = await resolvePolicy(supabase, fromCourseId);

  // The wait: one read of the learner's attempts on this course per
  // CONTINUE_POLL_MS, for at most CONTINUE_WAIT_MS. The sleep costs no CPU.
  // It ends only on a stored result whose verdict is not pending: on a
  // pass_required course a completed row without its pass or fail keeps it
  // going, and at the bound the learner lands on the saving banner.
  const maxReads = Math.floor(CONTINUE_WAIT_MS / CONTINUE_POLL_MS) + 1;
  let stored = false;
  let done = false;
  for (let read = 0; read < maxReads; read++) {
    const { data: rows, error: rowsErr } = await readWithOptionalColumn<unknown[]>(
      "is_revision",
      (columns) =>
        supabase
          .from("course_attempts")
          .select(columns)
          .eq("user_id", user.id)
          .in("course_version_id", versionIds),
      ATTEMPT_COLUMNS
    );
    if (rowsErr) readError();
    const attempts = (rows ?? []) as ScorableAttempt[];
    const scoring = computeScoring(attempts, policy, retakeIds);
    if (resultStored(scoring, attempts) && !verdictPending(scoring, passRequired)) {
      stored = true;
      done = officialDone(scoring, passRequired);
      break;
    }
    if (read < maxReads - 1) await new Promise((r) => setTimeout(r, CONTINUE_POLL_MS));
  }

  if (!stored) log("continue_timeout");
  else if (!done) log("continue_not_done");
  redirect(target({ timedOut: !stored, stored, done }));
}
