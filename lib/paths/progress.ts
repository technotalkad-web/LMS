/**
 * The path rule (ADR 0024 steps 43 and 44): `pathProgress()` is the
 * TypeScript twin of v_path_step_status and v_path_progress (0107 section 4f
 * and 4g; build notes N10 to N12 and O1-d, O1-i; twins contract pair 2), and
 * `pathStepStatus()` is its answer for one step.
 *
 * A step is scored in its path's own context, `path:<path id>`, through
 * contextResult (lib/scoring/context.ts); rows of the same course in another
 * context, the Individual one included, never count for the step.
 *
 *   passed_by_rule    some row of the context's scored window satisfies the
 *                     step's resolved rule as it stands now: a window row
 *                     that passed under pass_required, else a window that is
 *                     not empty (N12). Never contextResult's `done` or the
 *                     standing result (O1-k): those know neither an earlier
 *                     pass (D14) nor a stored fact.
 *   done_recorded_at  the done_at of the step's stored fact, the
 *                     learning_path_step_completions row (O1-a), null when
 *                     there is none
 *   passed_ever       passed_by_rule or a stored fact (the owner's O1
 *                     answer, option (ii)); done = passed_ever (step 44)
 *   latest_result, latest_score, official_attempt_id   the standing official
 *                     result of the context under today's rule; the fact
 *                     never changes them, so nothing is hidden
 *   retake_live       a granted retake of the context is in progress (N9)
 *   failed            not passed_ever, the standing result failed and no
 *                     live retake (step 44)
 *   open_attempt      an official row of the context is in progress
 *   released          TypeScript only: release_at is null or not after now
 *
 * The path's status, in N11's order: in_progress while some step's granted
 * retake is live (completed or not); completed when the completion row
 * exists; failed when some step is failed; in_progress when some step's
 * context holds a row that is not abandoned and not a revision row (the 0099
 * meaning: a learner with reset attempts only reads not started); else
 * not_started. `completed`, `completed_at` and `overdue` read the stored
 * completion row, never the step count, so a path completed before a step
 * was added stays completed (section L).
 *
 * The fact rows are a required input with no default (O1-i), so a caller
 * cannot leave them out and silently judge every step by today's rule. A
 * phase P test run passes an empty list on purpose. No TypeScript code
 * writes the facts; the writer of step 12 does.
 *
 * Field names on the answer are the views' column names (snake_case), so the
 * parity projection compares them directly (twins contract 3.2); the
 * record's `passedEver` (step 44) is the name of a TypeScript variable or
 * prop reading `passed_ever`.
 *
 * Pure: no next/* and no Supabase runtime import (the house shape of
 * lib/attempts/launch-kind.ts and lib/learner/continue.ts).
 */
import { DEFAULT_POLICY } from "@/lib/scoring/policy";
import {
  contextKeyOf,
  contextResult,
  passedInWindow,
  type ContextAttempt,
  type ContextGrant,
  type ContextResult,
} from "@/lib/scoring/context";

/** A learning_path_courses row with its rule resolved: the step's own pass_required, else the course's. */
export type PathStepInput = {
  course_id: string;
  step_number: number;
  release_at: string | null;
  pass_required: boolean;
};

/** A learning_path_step_completions row (build note O1-a): the step's stored done fact. */
export type PathStepFact = {
  path_id: string;
  course_id: string;
  done_at: string;
  rule_pass_required: boolean;
};

export type PathAttempt = ContextAttempt & { course_id: string };
export type PathGrant = ContextGrant & { course_id: string };

export type PathProgressInput = {
  pathId: string;
  /** The path's current steps. */
  steps: PathStepInput[];
  /** The learner's rows on the steps' courses, any context; the reader maps version → course. */
  attempts: PathAttempt[];
  /** The learner's approved grants on the steps' courses, any context. */
  grants: PathGrant[];
  /** The learner's fact rows for this path. Required (O1-i); rows of another path are ignored. */
  facts: PathStepFact[];
  /** The learning_path_completions row, null when there is none. */
  completion: { completed_at: string; path_score?: number | null } | null;
  /** v_path_enrollment_terms' answer, an input (twins contract 3.2). */
  terms: { due_at: string | null; enrolled_at: string | null };
  /** ISO; release dates, grant expiry and overdue. */
  now: string;
};

export type PathStepStatus = {
  course_id: string;
  step_number: number;
  release_at: string | null;
  /** TypeScript only, against now. */
  released: boolean;
  pass_required: boolean;
  passed_ever: boolean;
  passed_by_rule: boolean;
  done_recorded_at: string | null;
  latest_result: "passed" | "failed" | "completed" | null;
  latest_score: number | null;
  done: boolean;
  official_attempt_id: string | null;
  retake_live: boolean;
  failed: boolean;
  open_attempt: boolean;
};

export type PathStatus = "not_started" | "in_progress" | "failed" | "completed";

export type PathProgress = {
  /** By step_number. */
  steps: PathStepStatus[];
  steps_total: number;
  steps_done: number;
  next_step: number | null;
  next_course_id: string | null;
  /** The mean of the steps' latest official scores where a step has one; unrounded. */
  path_score: number | null;
  completed: boolean;
  status: PathStatus;
  due_at: string | null;
  enrolled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  overdue: boolean;
};

function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

const lower = (s: string) => s.toLowerCase();

type StepRead = { status: PathStepStatus; context: ContextResult<PathAttempt, PathGrant> };

function readStep(i: {
  pathKey: string;
  step: PathStepInput;
  attempts: PathAttempt[];
  grants: PathGrant[];
  fact: PathStepFact | null;
  now: string;
}): StepRead {
  const context = contextResult({
    key: i.pathKey,
    attempts: i.attempts,
    grants: i.grants,
    policy: DEFAULT_POLICY,
    passRequired: i.step.pass_required,
    now: i.now,
  });
  const s = context.scoring;
  const passedByRule = i.step.pass_required ? passedInWindow(context) : s.scoredAttempts > 0;
  const doneRecordedAt = i.fact ? i.fact.done_at : null;
  const passedEver = passedByRule || doneRecordedAt !== null;
  const latestResult = s.officialStatus;
  const retakeLive = context.liveRetake;
  const releaseMs = ms(i.step.release_at);
  return {
    context,
    status: {
      course_id: i.step.course_id,
      step_number: i.step.step_number,
      release_at: i.step.release_at,
      released: i.step.release_at === null || (Number.isFinite(releaseMs) && releaseMs <= ms(i.now)),
      pass_required: i.step.pass_required,
      passed_ever: passedEver,
      passed_by_rule: passedByRule,
      done_recorded_at: doneRecordedAt,
      latest_result: latestResult,
      latest_score: s.officialScore,
      done: passedEver,
      official_attempt_id: s.officialAttempt?.id ?? null,
      retake_live: retakeLive,
      failed: !passedEver && latestResult === "failed" && !retakeLive,
      open_attempt: context.officialRows.some((a) => a.status === "in_progress"),
    },
  };
}

/**
 * One step's answer: the step's rows and grants (any context; the path's own
 * is picked here), its resolved rule and its stored fact or null. The page
 * that already holds one context's rows (Continue, O1-k) calls this for the
 * step it asks about.
 */
export function pathStepStatus(i: {
  pathId: string;
  step: PathStepInput;
  attempts: Array<ContextAttempt & { course_id?: string }>;
  grants: Array<ContextGrant & { course_id?: string }>;
  fact: PathStepFact | null;
  now: string;
}): PathStepStatus {
  const course = lower(i.step.course_id);
  const onCourse = <T extends { course_id?: string }>(x: T) => x.course_id === undefined || lower(x.course_id) === course;
  return readStep({
    pathKey: contextKeyOf({ kind: "path", pathId: i.pathId }),
    step: i.step,
    attempts: i.attempts.filter(onCourse).map((a) => ({ ...a, course_id: i.step.course_id })),
    grants: i.grants.filter(onCourse).map((g) => ({ ...g, course_id: i.step.course_id })),
    fact: i.fact && lower(i.fact.course_id) === course && lower(i.fact.path_id) === lower(i.pathId) ? i.fact : null,
    now: i.now,
  }).status;
}

/** The path rule for one (path, learner) (the header has the columns and the status order). */
export function pathProgress(i: PathProgressInput): PathProgress {
  const pathKey = contextKeyOf({ kind: "path", pathId: i.pathId });
  const pathId = lower(i.pathId);

  const attemptsByCourse = new Map<string, PathAttempt[]>();
  for (const a of i.attempts) {
    const k = lower(a.course_id);
    const list = attemptsByCourse.get(k);
    if (list) list.push(a);
    else attemptsByCourse.set(k, [a]);
  }
  const grantsByCourse = new Map<string, PathGrant[]>();
  for (const g of i.grants) {
    const k = lower(g.course_id);
    const list = grantsByCourse.get(k);
    if (list) list.push(g);
    else grantsByCourse.set(k, [g]);
  }
  const factByCourse = new Map<string, PathStepFact>();
  for (const f of i.facts) {
    if (lower(f.path_id) !== pathId) continue;
    const k = lower(f.course_id);
    if (!factByCourse.has(k)) factByCourse.set(k, f);
  }

  const read = [...i.steps]
    .sort((a, b) => a.step_number - b.step_number)
    .map((step) => {
      const k = lower(step.course_id);
      return readStep({
        pathKey,
        step,
        attempts: attemptsByCourse.get(k) ?? [],
        grants: grantsByCourse.get(k) ?? [],
        fact: factByCourse.get(k) ?? null,
        now: i.now,
      });
    });
  const steps = read.map((r) => r.status);

  const next = steps.find((s) => !s.done) ?? null;
  const scores = steps.map((s) => s.latest_score).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const completed = i.completion !== null;

  let status: PathStatus;
  if (steps.some((s) => s.retake_live)) status = "in_progress";
  else if (completed) status = "completed";
  else if (steps.some((s) => s.failed)) status = "failed";
  else if (read.some((r) => r.context.officialRows.length > 0)) status = "in_progress";
  else status = "not_started";

  let startedAt: string | null = null;
  for (const r of read) {
    for (const a of r.context.officialRows) {
      if (startedAt === null || ms(a.started_at) < ms(startedAt)) startedAt = a.started_at;
    }
  }

  const dueMs = ms(i.terms.due_at);
  return {
    steps,
    steps_total: steps.length,
    steps_done: steps.filter((s) => s.done).length,
    next_step: next ? next.step_number : null,
    next_course_id: next ? next.course_id : null,
    path_score: scores.length > 0 ? scores.reduce((sum, x) => sum + x, 0) / scores.length : null,
    completed,
    status,
    due_at: i.terms.due_at,
    enrolled_at: i.terms.enrolled_at,
    started_at: startedAt,
    completed_at: i.completion ? i.completion.completed_at : null,
    overdue: i.terms.due_at !== null && Number.isFinite(dueMs) && dueMs < ms(i.now) && !completed,
  };
}
