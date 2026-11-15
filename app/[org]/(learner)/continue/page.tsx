import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { computeScoring, officialDone, type ScorableAttempt } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { readWithOptionalColumn } from "@/lib/scoring/attempt-kind";
import { readWithContextFilter, withoutPreviews, type ContextFilterState } from "@/lib/scoring/context-read";
import {
  CONTINUE_POLL_MS,
  CONTINUE_WAIT_MS,
  continueTarget,
  isUuid,
  nextStepAfter,
  officialResultStored,
} from "@/lib/learner/continue";

/**
 * The continue address (ADR 0019 steps 1 and 2): from a finished module to the
 * next step of the Learning Path it was launched from. The launch bar's
 * Continue button links here with `?lp=<path>&from=<course>`.
 *
 * It reads only, on the caller's RLS session, and writes nothing: the result
 * is written by the statements and commit routes as today. It waits, one
 * read a second until a deadline CONTINUE_WAIT_MS after its first read (it
 * answers after the read at the deadline), for the module's official result
 * to be stored (on a
 * pass_required course, with its pass or fail: verdictPending), then moves
 * the learner on only when that result completes the step under the course's
 * pass_required setting. The launch page keeps its own gates (release dates,
 * the strict lock, assignment) for the next launch; nothing here repeats them.
 * loading.tsx shows "Saving your result" while this page waits.
 *
 * Every refusal is a redirect() outside any try (redirect throws).
 *
 * Every caller waits, whatever their role (ADR 0024 step 23, P2-5 item 4): a
 * staff member's launch without `?mode=preview` is a real attempt, and a
 * Preview carries no `?lp=`, so it never reaches this address. The wait's read
 * drops `context_kind = 'preview'` rows (item 5b), so a Preview of the module
 * beside the caller's real attempt never reads as the stored result.
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

  const { user, org } = await requireOrgAccess(orgSlug);
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
  const target = (t: { timedOut: boolean; stored: boolean; done: boolean }) =>
    continueTarget({ orgSlug, pathId, timedOut: t.timedOut, stored: t.stored, done: t.done, next });

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
  // CONTINUE_POLL_MS, until a deadline CONTINUE_WAIT_MS after the first read
  // starts (decision 2: 6 s total), at most seven reads; the last one starts
  // at the deadline at the latest, so slow reads shorten the sleeps rather
  // than stretch the wait. The sleep costs no CPU.
  // It ends only on a stored result whose verdict is not pending: on a
  // pass_required course a completed row without its pass or fail keeps it
  // going, and at the bound the learner lands on the saving banner.
  // Every read carries its own abort signal: Next memoizes identical GET
  // fetches within one server render, and without a signal reads 2 to 7
  // returned the first read's rows, so a result stored during the wait was
  // never seen (spec 63 (b2)). A signal opts the request out of that cache.
  // A Preview never counts (ADR 0024 P2-5 item 5b): each read drops
  // `context_kind = 'preview'` rows, and one decision serves every read of the
  // wait, so on a database without 0107 the first read's missing-column error
  // reads today's select once (readWithContextFilter). P2-7 replaces this with
  // the path context's own read.
  const previews: ContextFilterState = { applies: null };
  const maxReads = Math.floor(CONTINUE_WAIT_MS / CONTINUE_POLL_MS) + 1;
  const deadline = Date.now() + CONTINUE_WAIT_MS;
  let stored = false;
  let done = false;
  for (let read = 0; read < maxReads; read++) {
    const { data: rows, error: rowsErr } = await readWithOptionalColumn<unknown[]>(
      "is_revision",
      (columns) =>
        readWithContextFilter(previews, (apply) =>
          withoutPreviews(
            supabase
              .from("course_attempts")
              .select(columns)
              .eq("user_id", user.id)
              .in("course_version_id", versionIds),
            apply
          ).abortSignal(new AbortController().signal)
        ),
      ATTEMPT_COLUMNS
    );
    if (rowsErr) readError();
    const attempts = (rows ?? []) as ScorableAttempt[];
    const scoring = computeScoring(attempts, policy, retakeIds);
    if (officialResultStored(scoring, attempts, passRequired)) {
      stored = true;
      done = officialDone(scoring, passRequired);
      break;
    }
    const left = deadline - Date.now();
    if (read === maxReads - 1 || left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(CONTINUE_POLL_MS, left)));
  }

  if (!stored) log("continue_timeout");
  else if (!done) log("continue_not_done");
  redirect(target({ timedOut: !stored, stored, done }));
}
