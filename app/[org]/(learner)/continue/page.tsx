import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { readWithOptionalColumn } from "@/lib/scoring/attempt-kind";
import { readContextResult, type ContextRead, type ReadContextGrant } from "@/lib/scoring/context-read";
import { contextKeyOf } from "@/lib/scoring/context";
import { resolvedStepRule } from "@/lib/paths/progress";
import { readPathStepFacts } from "@/lib/paths/facts-read";
import {
  CONTINUE_POLL_MS,
  CONTINUE_WAIT_MS,
  continueTarget,
  isUuid,
  nextStepAfter,
  pathStepDone,
  waitRead,
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
 * to be stored (on a pass-required step, with its pass or fail:
 * verdictPending), then moves the learner on only when the step is done by
 * the path rule. The launch page keeps its own gates (release dates, the
 * strict lock, assignment) for the next launch; nothing here repeats them.
 * loading.tsx shows "Saving your result" while this page waits.
 *
 * ADR 0024 step 27, as build note O1-k makes it exact (P2-7):
 *   - the wait reads through readContextResult in the path's context
 *     (`path:<lp>`), with the step's resolved rule (the step's own
 *     pass_required, else the course's; step 8). That read decides only
 *     whether the result is stored and whether its verdict is pending
 *     (officialResultStored over the context's rows). Each read carries its
 *     own abort signal (step 25: without one, reads 2 to 7 returned the first
 *     read's rows, spec 63 (b2)). A Preview is another context, so it never
 *     reads as the stored result. On a database without 0107 the first read
 *     of the wait makes one failed read first and then reads today's
 *     undivided rows (readContextResult's own fallback); the later reads
 *     reuse its schema decision and its grants (the P2-7 review, F5);
 *   - the step's done is the path rule's per-step answer (pathStepDone over
 *     pathStepStatus), fed with that read's rows and grants, the resolved
 *     rule and the step's stored fact: never contextResult's `done`. So a
 *     step passed earlier (D14) or done by its fact continues to the next
 *     step after a failed granted retake, instead of `?failed=1`;
 *   - the fact row is read at most once, through readPathStepFacts, only
 *     when the step is not done by the rule on a read's rows (only then can
 *     a fact change the answer): after the wait has ended on a stored
 *     result, or at the first read whose verdict is still pending on a
 *     pass-required step. A step done while its verdict is pending (by the
 *     rule or by its fact) ends the wait, because no verdict can undo it
 *     (the P2-7 review, F1; verdictPending's exception). A failed facts read
 *     takes the read-error exit, never `?failed=1`.
 *
 * O5-d and the owner's P2-Q1 answer: an inactive path goes to the dashboard;
 * a step whose course is inactive is left out of the path page, so a `from`
 * step whose course is inactive goes to the plain path page without a wait,
 * and a stored, done result whose next step's course is inactive goes to the
 * plain path page too (not `?end=1`, and nothing is skipped). A wait that
 * times out still goes to `?saving=1`, and a stored result that is not done
 * to `?failed=1`.
 *
 * Every refusal is a redirect() outside any try (redirect throws).
 *
 * Every caller waits, whatever their role (ADR 0024 step 23, P2-5 item 4): a
 * staff member's launch without `?mode=preview` is a real attempt, and a
 * Preview carries no `?lp=`, so it never reaches this address.
 */
type StepRow = {
  course_id: string;
  step_number: number;
  /** The step's own rule (0107); absent on a database without it. */
  pass_required?: boolean | null;
  courses: { is_active: boolean | null; pass_required: boolean | null } | Array<{ is_active: boolean | null; pass_required: boolean | null }> | null;
};

const courseOf = (s: StepRow) => (Array.isArray(s.courses) ? (s.courses[0] ?? null) : s.courses);
/** The step's course is active (O5-d); a course row the learner cannot read reads as not active. */
const isActiveStep = (s: StepRow) => courseOf(s)?.is_active === true;

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

  // The steps in order, each with its course's activity and rule, and the
  // step's own rule (a 0107 column: the narrower-select fallback reads the
  // steps without it on a database that lacks it, and the course's rule
  // decides).
  const { data: stepRows, error: stepErr } = await readWithOptionalColumn<unknown[]>(
    "pass_required",
    (columns) =>
      supabase
        .from("learning_path_courses")
        .select(columns)
        .eq("path_id", pathId)
        .order("step_number", { ascending: true }),
    "course_id, step_number, courses(is_active, pass_required)"
  );
  if (stepErr) redirect(`/${orgSlug}/dashboard`);
  const steps = (stepRows ?? []) as StepRow[];
  const fromStep = steps.find((s) => s.course_id === fromCourseId);
  if (!fromStep) {
    log("continue_not_a_step");
    redirect(`/${orgSlug}/paths/${pathId}`);
  }
  if (!isActiveStep(fromStep)) {
    log("continue_inactive");
    redirect(`/${orgSlug}/paths/${pathId}`);
  }
  const next = nextStepAfter(steps, fromCourseId);
  const nextStep = next === null ? null : (steps.find((s) => s.course_id === next) ?? null);
  const nextHidden = nextStep !== null && !isActiveStep(nextStep);
  const passRequired = resolvedStepRule(fromStep.pass_required, courseOf(fromStep)?.pass_required);
  const target = (t: { timedOut: boolean; stored: boolean; done: boolean }) =>
    continueTarget({ orgSlug, pathId, timedOut: t.timedOut, stored: t.stored, done: t.done, next, nextHidden });

  // A read error ends as the timeout target, never as "not required", "no
  // grants" or "not done" (a fail-soft read would move a learner on wrongly,
  // or send them to the failed banner).
  const readError: () => never = () => {
    log("continue_read_error");
    redirect(target({ timedOut: true, stored: false, done: false }));
  };

  const { data: verRows, error: verErr } = await supabase
    .from("course_versions")
    .select("id")
    .eq("course_id", fromCourseId);
  const versionIds = ((verRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (verErr || versionIds.length === 0) readError();

  // The step's done (O1-k): the path rule's answer for this step on one read
  // of the wait (pathStepDone), then, only when the rule alone does not make
  // it done, the step's stored fact. The facts are read at most once in the
  // request: the first answer, a failed one included, is kept.
  const stepInput = { course_id: fromCourseId, step_number: fromStep.step_number, release_at: null, pass_required: passRequired };
  let factsRead: ReturnType<typeof readPathStepFacts> | null = null;
  const loadFacts = () => {
    if (factsRead === null) factsRead = readPathStepFacts(supabase, user.id, [pathId]);
    return factsRead;
  };
  const stepDone = async (r: Extract<ContextRead, { ok: true }>): Promise<boolean> => {
    const d = await pathStepDone({ pathId, step: stepInput, attempts: r.result.rows, grants: r.grants, now: new Date().toISOString(), loadFacts });
    if (!d.ok) readError();
    return d.done;
  };

  // The wait: one read of the learner's rows in the path's context per
  // CONTINUE_POLL_MS, until a deadline CONTINUE_WAIT_MS after the first read
  // starts (decision 2: 6 s total), at most seven reads; the last one starts
  // at the deadline at the latest, so slow reads shorten the sleeps rather
  // than stretch the wait. The sleep costs no CPU. It ends on a stored result
  // whose verdict is not pending (waitRead `stored`). On a pass-required step
  // a completed row without its pass or fail keeps it going, and at the bound
  // the learner lands on the saving banner, unless the step is already done
  // by the path rule (an earlier pass, D14, or its stored fact): no verdict
  // can undo that, so the wait ends there and the learner moves on (the P2-7
  // review, F1). The first read's schema decision and grants are reused by
  // the later reads (`reuse`), so each later read is the attempts read only.
  const key = contextKeyOf({ kind: "path", pathId });
  const maxReads = Math.floor(CONTINUE_WAIT_MS / CONTINUE_POLL_MS) + 1;
  const deadline = Date.now() + CONTINUE_WAIT_MS;
  let reuse: { contextColumns: boolean; grants: ReadContextGrant[] } | undefined;
  let done: boolean | null = null;
  for (let read = 0; read < maxReads; read++) {
    const r = await readContextResult(supabase, { userId: user.id, courseId: fromCourseId, key, passRequired, versionIds, reuse });
    if (!r.ok) readError();
    reuse = { contextColumns: r.contextColumns, grants: r.grants };
    const w = waitRead(r.result.scoring, r.result.rows, passRequired);
    if (w === "stored") {
      done = await stepDone(r);
      break;
    }
    if (w === "verdict_pending" && (await stepDone(r))) {
      done = true;
      break;
    }
    const left = deadline - Date.now();
    if (read === maxReads - 1 || left <= 0) break;
    await new Promise((res) => setTimeout(res, Math.min(CONTINUE_POLL_MS, left)));
  }
  if (done === null) {
    log("continue_timeout");
    redirect(target({ timedOut: true, stored: false, done: false }));
  }
  if (!done) log("continue_not_done");
  redirect(target({ timedOut: false, stored: true, done }));
}
