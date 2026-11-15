import { redirect } from "next/navigation";
import { originFromRequest } from "@/lib/http/origin";
import { randomBytes } from "crypto";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import {
  afterSelfEnrol,
  refusalWithoutFacts,
  resolveLaunchContext,
  resumeAfterSlotRouting,
  type JourneyFacts,
  type LaunchContextFacts,
  type LaunchDecision,
  type SelfEnrolInsert,
} from "@/lib/attempts/launch-context";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { ScormRuntime } from "./scorm-runtime";
import { Cmi5Runtime } from "./cmi5-runtime";
import { LaunchLanguagePicker } from "./launch-language-picker";
import { isSupportedLanguage, languageDisplay } from "@/lib/i18n/languages";
import type { CmiData } from "@/lib/scorm/types";
import { parseVersionDays } from "@/lib/journey/journey";
import type { ScoringResult } from "@/lib/scoring/policy";
import { isMissingColumn, isSchemaMissing } from "@/lib/scoring/attempt-kind";
import { contextKeyOf, type ContextResult } from "@/lib/scoring/context";
import { readContextResult, type ReadContextAttempt, type ReadContextGrant } from "@/lib/scoring/context-read";
import { expireLaunchTokens } from "@/lib/attempts/abandon";
import { enqueueAbandonedStatements } from "@/lib/lrs/abandoned";
import { decideSlotRouting, type SlotAttempt, type SlotSource } from "@/lib/courses/slot-routing";
import { launchFallback } from "@/lib/courses/default-rule";
import { aldsP4Enabled, isAldsSchemaMissing, logAldsSkip } from "@/lib/alds/flag";
import {
  buildLaunchData,
  launchModeFor,
  lmsAuActivityId,
  newSessionId,
  p4AttemptColumns,
  previewAttemptColumns,
  recordLearningSession,
  registrationKindFor,
  servedLanguageFor,
  writeLaunchData,
  type LaunchModeParam,
} from "@/lib/alds/launch";
import { LMS_LAUNCH_DATA_STATE_ID, LMS_OFFICIAL_RESULT_STATE_ID } from "@/lib/alds/rpc";
import {
  afterConsumeGrant,
  candidateKind,
  insertIsRevision,
  revisionInsertRefused,
  rowAction,
  seedPlan,
  shouldRecordVisit,
  tokenExpiryTargets,
  type CandidateKind,
  type RowAction,
  type RowDecision,
} from "@/lib/attempts/launch-kind";
import { buildOfficialResult, buildRevisionCmi } from "@/lib/attempts/revision-seed";
import { isKivoStamped } from "@/lib/courses/engine-version";
import { officialResultStored } from "@/lib/learner/continue";

type Course = {
  id: string;
  organization_id: string;
  current_version_id: string | null;
  title: string;
  is_active?: boolean;
  pass_required?: boolean | null;
};

type Version = {
  id: string;
  manifest_type: "scorm12" | "cmi5" | "xapi";
  launch_url: string;
  manifest_data: {
    raw?: { courseId?: string; auId?: string; activityId?: string };
    masteryScore?: number | null;
    /** ADR 0017's cached engine stamp: a string for a KIVO build, null for another, absent when unread. */
    engineVersion?: string | null;
  };
  package_id: string | null;
};

type PackageRow = {
  id: string;
  language: string | null;
  display_name: string | null;
  current_version_id: string | null;
  is_active: boolean;
};

export default async function LaunchPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; courseId: string }>;
  searchParams: Promise<{
    lang?: string;
    lp?: string;
    journey?: string;
    day?: string;
    back?: string;
    /** A repeated parameter arrives as a list: its first value is read. */
    mode?: string | string[];
    run?: string | string[];
  }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const {
    lang: langParam,
    lp: lpRaw,
    journey: journeyRaw,
    day: dayRaw,
    back: backParam,
    mode: modeRaw,
    run: runRaw,
  } = await searchParams;
  const { user, org, role, impersonation } = await requireOrgAccess(orgSlug);

  // ADR 0024 step 23 (Start and Preview, the owner's R6 answer): the launch's
  // mode comes from ?mode=preview, never from the role. Without it every
  // role is a learner: a Start, with a real attempt.
  const firstOf = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  const mode: LaunchModeParam = firstOf(modeRaw) === "preview" ? "preview" : null;

  // P2-5 item 3c, ruled (a): while requireOrgAccess answers an impersonation
  // (super_owner), a Start is refused, before any read, so an impersonation
  // writes no official attempt. requireOrgAccess reads the organisation
  // under the caller's own session before its impersonation branch, so a
  // platform owner who is not a member is sent to /select-org first: in
  // practice this refuses an impersonating platform owner who is also a
  // member of this organisation, whose own Start would otherwise be real.
  if (impersonation && mode !== "preview") {
    console.warn(JSON.stringify({ event: "launch_refused", reason: "impersonation_start", course_id: courseId, user_id: user.id }));
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  // P2-5 item 3b: the page itself refuses a preview to a role that may not
  // have one, through the resolver's preview row (step 22: canViewReports),
  // before the access call and before any read of attempts. The row answers
  // before any fact is read, so no launch_context call is made (facts:
  // null). A refused preview (a plain user, a run, both product parameters)
  // goes to today's ?denied=1 and writes nothing; it never falls through to a
  // Start.
  if (mode === "preview") {
    const decision = resolveLaunchContext({
      courseId,
      role,
      params: { lp: lpRaw ?? null, journey: journeyRaw ?? null, day: dayRaw ?? null, mode, run: firstOf(runRaw) },
      facts: null,
      now: new Date().toISOString(),
    });
    if (decision.kind !== "launch" || decision.context.kind !== "preview" || decision.context.previewKind !== "course") {
      const reason = decision.kind === "refused" ? decision.reason : decision.kind;
      console.warn(JSON.stringify({ event: "launch_refused", reason, course_id: courseId, user_id: user.id }));
      redirect(`/${orgSlug}/dashboard?denied=1`);
    }
  }
  const preview = mode === "preview";
  // A preview opens the course outside every path and journey (step 23, the
  // owner's A21 answer): its ?lp=, ?journey= and day are not read, so it
  // carries no path or journey tag, no Continue and no path or journey exit.
  const lpParam = preview ? undefined : lpRaw;
  const journeyParam = preview ? undefined : journeyRaw;
  const dayParam = preview ? undefined : dayRaw;

  // A Start's product parameters, trimmed (an empty one is absent; a
  // repeated one is read by its first value, as ?mode= and ?run= are).
  const given = (v: unknown): string | null => {
    const x: unknown = Array.isArray(v) ? v[0] : v;
    return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
  };
  const lpArg = given(lpParam);
  const journeyArg = given(journeyParam);
  const dayArg = given(dayParam);

  // ADR 0024 P2-6 item 1: the rows that refuse before any fact (the
  // resolver's own rule, refusalWithoutFacts): both product parameters
  // (context_conflict) and a run without the mode (phase P). No read and no
  // launch_context call is made for them; they go to today's ?denied=1.
  if (!preview) {
    const early = refusalWithoutFacts({ lp: lpArg, journey: journeyArg, run: firstOf(runRaw) });
    if (early !== null) {
      console.warn(JSON.stringify({ event: "launch_refused", reason: early, course_id: courseId, user_id: user.id }));
      redirect(`/${orgSlug}/dashboard?denied=1`);
    }
  }

  const supabase = await createClient();
  const { data: course } = await supabase
    .from("courses")
    .select("id, organization_id, current_version_id, title, is_active, pass_required")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();

  if (!course) {
    redirect(`/${orgSlug}/courses/${courseId}`);
  }
  if ((course as Course).is_active === false) {
    redirect(`/${orgSlug}/dashboard`);
  }
  const c = course as Course;
  // The bar's Continue state (ADR 0019, note of 2026-11-11): the continue
  // address's own reading of the course's setting.
  const passRequired = c.pass_required === true;

  // ADR 0014 step 3, fail closed: every read that feeds the launch verdict or
  // the row choice refuses on error, and so does every disagreement between
  // the launch kind and the row. One refusal for all of them: back to the
  // course page with the retry notice, nothing written. redirect() throws, so
  // no refusal may sit inside a try that would swallow it.
  const refuse: (reason: string) => never = (reason) => {
    console.warn(JSON.stringify({ event: "launch_refused", reason, course_id: c.id, user_id: user.id }));
    redirect(`/${orgSlug}/courses/${courseId}?retry=1`);
  };

  // Language packages (ADR 0008 step 13), read BEFORE the context and the
  // attempt rule below: a launch with every language hidden goes back to the
  // course page before anything is written (a self-enrolment included) or a
  // granted retake resets anything. A failed read goes back too, never to
  // the course-default fallback (which may be a hidden language's version).
  const { data: pkgRows, error: pkgErr } = await supabase
    .from("course_packages")
    .select("id, language, display_name, current_version_id, is_active")
    .eq("course_id", courseId);
  if (pkgErr) {
    console.warn("[launch] package read failed:", pkgErr.message);
    redirect(`/${orgSlug}/courses/${courseId}`);
  }
  const allPackages = (pkgRows ?? []) as PackageRow[];
  const activePackages = allPackages.filter((p) => p.is_active);
  const fallback = launchFallback({ packageCount: allPackages.length, activeCount: activePackages.length });
  if (fallback === "redirect") {
    // Every language is hidden from learners: nothing to launch.
    redirect(`/${orgSlug}/courses/${courseId}`);
  }

  // ADR 0009: attempt rows are written by the server only. Every write below
  // goes through this ONE service client with explicit id/user_id/
  // organization_id (ADR 0014 step 3 adds the strict reads, the closes,
  // consume_grant, the cutover flag, the seed and the visit record). ADR 0024
  // P2-N6: it is created before the launch_context call, which only the
  // service role may execute, with the session's user id and the
  // organisation requireOrgAccess answered; the self-enrolment of step 24
  // writes through it too (the enrolment tables are admin-write under RLS).
  const svcAttempt = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ---- The launch's context (ADR 0024 steps 22 and 24; P2-6 items 1 and 2) ----
  // A Start makes one launch_context call (a POST through .rpc(), never
  // { get: true }, so it is never memoized) and resolves it with the pure
  // resolver; a failed call or an answer the resolver cannot read refuses
  // with the retry notice. The call replaces the page's own journey block,
  // the access call (P2-N5) and the path entitlement, release and lock block:
  // the release gate and the strict lock apply to the path named in ?lp=
  // only (D2). A ?mode=preview launch makes no call (P2-5 item 3b). A day of
  // digits goes as p_day and a uuid as p_day_id (an old link's number is
  // resolved through the pinned version, 0107's launch_context); an id that
  // is not a uuid is sent as null (the cast would fail) and the resolver
  // refuses it.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DIGITS_RE = /^[0-9]{1,6}$/;
  const resolverParams = { lp: lpArg, journey: journeyArg, day: dayArg, mode: null, run: firstOf(runRaw) };
  const readLaunchContext = async (): Promise<LaunchContextFacts> => {
    const { data, error } = await svcAttempt.rpc("launch_context", {
      p_user: user.id,
      p_org: org.id,
      p_course: c.id,
      p_path: lpArg !== null && UUID_RE.test(lpArg) ? lpArg : null,
      p_enrollment: journeyArg !== null && UUID_RE.test(journeyArg) ? journeyArg : null,
      p_day_id: journeyArg !== null && dayArg !== null && UUID_RE.test(dayArg) ? dayArg : null,
      p_day: journeyArg !== null && dayArg !== null && DIGITS_RE.test(dayArg) ? Number(dayArg) : null,
    })
      // Step 25 (P2-6 item 4): the second call after the self-enrolment
      // insert is the enrolment re-read. A POST is never memoized; the
      // signal is carried as on every other re-read of the render.
      .abortSignal(new AbortController().signal);
    // On a database without 0107 the function is missing: every Start is
    // refused here, before any write (an A19 launch; ADR 0024 section 4).
    if (error) refuse(isSchemaMissing(error) ? "schema_missing" : `launch_context_${error.code ?? "error"}`);
    const answer = data as LaunchContextFacts | null;
    if (!answer || typeof answer !== "object" || answer.v !== 1) refuse("launch_context_answer");
    return answer;
  };
  const decide = (f: LaunchContextFacts): LaunchDecision => {
    let d: LaunchDecision | null = null;
    try {
      d = resolveLaunchContext({ courseId: c.id, role, params: resolverParams, facts: f, now: new Date().toISOString() });
    } catch {
      d = null;
    }
    if (d === null) refuse("launch_context_unreadable");
    return d;
  };
  // Where a launch that is not admitted goes: today's notices (P2-6 item 5).
  // Every refusal is today's ?denied=1 (P2-N5); the upcoming and locked
  // answers keep /dashboard?upcoming=<course> and ?locked=<course>, the
  // journey_locked answer /journey?locked=<day> (the journey page reads only
  // that the parameter is present). One holder: the launch again, inside
  // that path or journey day (a fixed in-app path built from the resolver's
  // ids; the product row never answers another holder redirect, so it cannot
  // loop). Several: the dashboard until phase 6's chooser. A journey day
  // started on another course (the day's course swapped after the learner
  // started it): the launch of the same day on the started course, which
  // resumes it (steps 22 and 93; the resolver's journey row, whose answer for
  // that course is `resume`, so it cannot loop either).
  const launchInto = (product: { lp: string } | { journey: string; day: string }, courseOf: string = c.id): string => {
    const q = new URLSearchParams(product);
    if (langParam && isSupportedLanguage(langParam)) q.set("lang", langParam);
    if (backParam === "dashboard") q.set("back", "dashboard");
    return `/${orgSlug}/courses/${encodeURIComponent(courseOf)}/launch?${q.toString()}`;
  };
  const targetOf = (d: Exclude<LaunchDecision, { kind: "launch" }>, f: LaunchContextFacts): string => {
    if (d.kind === "refused") return `/${orgSlug}/dashboard?denied=1`;
    switch (d.to) {
      case "upcoming":
        return `/${orgSlug}/dashboard?upcoming=${courseId}`;
      case "locked":
        return `/${orgSlug}/dashboard?locked=${courseId}`;
      case "journey_locked": {
        const n = f.journey && f.journey.found ? f.journey.day.number : null;
        return `/${orgSlug}/journey?locked=${encodeURIComponent(String(n ?? d.dayId ?? ""))}`;
      }
      case "path":
        return d.pathId ? launchInto({ lp: d.pathId }) : `/${orgSlug}/dashboard`;
      case "journey": {
        const holder = f.holders.journey_days.find((h) => h.enrollment_id.toLowerCase() === d.enrollmentId);
        const day = d.dayId ?? (holder ? String(holder.day_number) : null);
        return d.enrollmentId && day ? launchInto({ journey: d.enrollmentId, day }, d.courseId ?? c.id) : `/${orgSlug}/dashboard`;
      }
      case "chooser":
        return `/${orgSlug}/dashboard`;
    }
  };
  // Step 24: the self-enrolment on an "Everyone" course or path, a plain
  // insert (not an upsert: the unique user indexes are partial), source
  // 'self', assigned by the learner, no due date, naming the organisation.
  // It runs only after requireOrgAccess and the call's active-membership and
  // visibility facts (the resolver refuses not_member first). A 23505 reads
  // as enrolled. An A19 write: `source` is a 0107 column.
  const enrolSelf = async (kind: "course" | "path", pathId: string | null): Promise<SelfEnrolInsert> => {
    const { error } =
      kind === "course"
        ? await svcAttempt.from("course_assignments").insert({
            course_id: c.id,
            organization_id: org.id,
            assignee_type: "user",
            user_id: user.id,
            due_at: null,
            assigned_by: user.id,
            source: "self",
          })
        : await svcAttempt.from("learning_path_assignments").insert({
            path_id: pathId,
            organization_id: org.id,
            assignee_type: "user",
            user_id: user.id,
            due_at: null,
            assigned_by: user.id,
            source: "self",
          });
    if (!error) return "inserted";
    if (error.code === "23505") return "already_enrolled";
    console.warn(JSON.stringify({ event: "self_enrol_failed", kind, course_id: c.id, user_id: user.id, code: error.code ?? null }));
    return "failed";
  };

  let facts: LaunchContextFacts | null = null;
  let admitted: Extract<LaunchDecision, { kind: "launch" }> | null = null;
  if (!preview) {
    facts = await readLaunchContext();
    let decision = decide(facts);
    if (decision.kind === "launch" && decision.selfEnrol !== null) {
      // Ruling A3 and P2-Q2 (i-a): the insert, then one more call and the
      // resolver again (a POST, never memoized: the second answer is fresh,
      // step 25), then the one pure decision beside the resolver.
      const selfEnrol = decision.selfEnrol;
      const insert = await enrolSelf(selfEnrol, decision.context.kind === "path" ? decision.context.pathId : null);
      let second: LaunchDecision | null = null;
      if (insert !== "failed") {
        facts = await readLaunchContext();
        second = decide(facts);
      }
      const after = afterSelfEnrol({ selfEnrol, insert, second });
      if (after.kind === "retry") refuse(after.reason);
      if (after.kind === "upcoming") {
        // The learner's own direct assignment is dated: "not yet released",
        // no attempt written (P2-Q2 (i-a)).
        console.warn(JSON.stringify({ event: "launch_refused", reason: "own_assignment_not_released", course_id: c.id, user_id: user.id }));
        redirect(`/${orgSlug}/dashboard?upcoming=${courseId}`);
      }
      decision = after.decision;
    }
    if (decision.kind !== "launch") {
      const reason = decision.kind === "refused" ? decision.reason : `redirect_${decision.to}`;
      console.warn(JSON.stringify({ event: "launch_refused", reason, course_id: c.id, user_id: user.id }));
      redirect(targetOf(decision, facts));
    }
    // A Start is never a preview and never a further self-enrolment
    // (afterSelfEnrol answers only a launch with none).
    if (decision.context.kind === "preview" || decision.selfEnrol !== null) refuse("launch_context_mismatch");
    admitted = decision;
  }

  // The launch's context: the key every attempts read, close and write of
  // this render takes (step 23), and the tags both Start inserts name. A
  // journey row needs its day's number (0107's shape check): the day's number
  // in the pinned version, else the credit row's (a removed day); none, and
  // no insert or grant is made for it.
  type LaunchCtx =
    | { kind: "preview" }
    | Extract<Extract<LaunchDecision, { kind: "launch" }>["context"], { kind: "individual" | "path" | "journey" }>;
  const ctx: LaunchCtx =
    admitted === null || admitted.context.kind === "preview" ? { kind: "preview" } : admitted.context;
  const jf: Extract<JourneyFacts, { found: true }> | null = facts?.journey && facts.journey.found ? facts.journey : null;
  let ctxKey = "preview";
  if (ctx.kind !== "preview") {
    let key: string | null = null;
    try {
      key = contextKeyOf(ctx);
    } catch {
      key = null;
    }
    if (key === null) refuse("context_key_unreadable");
    ctxKey = key;
  }
  const journeyDayNumber: number | null =
    ctx.kind === "journey" ? (ctx.dayNumber ?? jf?.day_credit?.day_number ?? null) : null;
  const tags = {
    context_kind: ctx.kind,
    learning_path_id: ctx.kind === "path" ? ctx.pathId : null,
    journey_enrollment_id: ctx.kind === "journey" ? ctx.enrollmentId : null,
    journey_day: journeyDayNumber,
    journey_day_id: ctx.kind === "journey" ? ctx.dayId : null,
    journey_version_id: ctx.kind === "journey" ? (jf?.version_id ?? null) : null,
  };
  // Step 22's journey rows: a review is a revision visit of the credited day
  // and never a new official attempt (when the day's credit came from another
  // context, the day's own context holds no official attempt, so its window
  // reads as used here); a completed enrolment admits review and resume
  // only, so neither consumes a grant.
  const reviewOnly = ctx.kind === "journey" && ctx.admission === "review";
  const noNewOfficial = ctx.kind === "journey" && (reviewOnly || jf?.status !== "active");

  // The launch's own rows (step 23; P2-5 item 3): a Start reads and closes
  // the rows of its context key only, so a path's, a journey day's, another
  // product's or a preview's row never routes, resumes, closes or scores it;
  // a preview takes only the caller's course previews (context_kind
  // 'preview', preview_kind 'course': a legacy_role row shares the key
  // `preview`, note N4). Both name 0107 columns with no fallback: a Start
  // reaches here only when launch_context answered (0107 is there), and a
  // preview's first read refuses without it, before any write.
  function inLaunchContext<Q>(query: Q): Q {
    const q = query as unknown as { eq: (column: string, value: string) => Q };
    if (!preview) return q.eq("context_key", ctxKey);
    return (q.eq("context_kind", "preview") as unknown as { eq: (column: string, value: string) => Q }).eq("preview_kind", "course");
  }

  // The course's versions with their packages, read once (step 70's count):
  // the attempts read in context, slot routing and the grandfather read take
  // them from here. A failed read refuses.
  const { data: verRows, error: verErr } = await supabase
    .from("course_versions")
    .select("id, package_id")
    .eq("course_id", c.id);
  if (verErr) refuse("versions_read_failed");
  const courseVersions = (verRows ?? []) as Array<{ id: string; package_id: string | null }>;
  const versionIds = courseVersions.map((r) => r.id);

  // 0073/0081 attempt rule (ADR 0014: one official attempt, then review-only
  // revision visits; extra official attempts only by a consumed grant), in
  // the launch's context (ADR 0024 step 23): readContextResult reads the
  // context's rows on every version and language of the course, and every
  // approved grant of the course (a retake's membership is by its grant, any
  // context, N9), each read with its own abort signal (step 25: it runs again
  // in this render after consume_grant); a failed read refuses. It writes
  // nothing, so a launch that ends on the language picker spends nothing. The
  // candidate kind (lib/attempts/launch-kind.ts): `first` while the
  // context's window has a free slot, `grant` when the context's unused grant
  // is consumed on this launch (a path grant is never consumed by an
  // Individual launch), otherwise `at_row` (the row decides: a granted retake
  // resumes, anything else is a revision visit). A Preview by mode never
  // runs it (below).
  type MyAttempt = ReadContextAttempt;
  type InContext = ContextResult<ReadContextAttempt, ReadContextGrant>;
  type Grants = { retakeIds: Set<string>; unusedGrant: { id: string } | null };
  type Evaluation = { my: MyAttempt[]; scoring: ScoringResult | null; candidate: CandidateKind };
  const readInContext = async (): Promise<InContext> => {
    const read = await readContextResult(svcAttempt, { userId: user.id, courseId: c.id, key: ctxKey, passRequired, versionIds });
    if (!read.ok) refuse(`context_read_${read.reason}`);
    return read.result;
  };
  const grantsOf = (r: InContext): Grants => ({ retakeIds: new Set(r.retakeIds), unusedGrant: r.unusedGrant });
  const evaluate = (r: InContext, consumeGrants: boolean): Evaluation => {
    // Every row of the context, revision rows included (resume, the token
    // expiry, Continue's reading); scoring sees the official rows only.
    const my = r.rows;
    const scoring = r.scoring;
    // A granted retake in progress in this context only blocks consuming
    // another grant; whether THIS launch resumes a retake is the row's call.
    const liveRetakeOnAnyVersion = my.some((a) => a.status === "in_progress" && r.retakeIds.has(a.id));
    const candidate = candidateKind({
      limitReached: scoring.limitReached || reviewOnly,
      unusedGrantId: r.unusedGrant?.id ?? null,
      consumeGrants: consumeGrants && !noNewOfficial,
      liveRetakeOnAnyVersion,
    });
    // ADR 0014 step 9: the block rule is retired, so no launch is refused
    // for a used window (normalizePolicy clamps every rule to the default).
    return { my, scoring, candidate };
  };
  // P2-5 item 3: a Preview by mode reads no grant and runs no attempt rule.
  // Its row is never official, never a grant's retake and never seeded, so
  // nothing below consumes, scores or seeds for it; these stand-ins only keep
  // the shared steps (routing, the runtime) typed.
  let inCtx: InContext | null = preview ? null : await readInContext();
  let grants: Grants = inCtx ? grantsOf(inCtx) : { retakeIds: new Set<string>(), unusedGrant: null };
  let ev: Evaluation = inCtx ? evaluate(inCtx, true) : { my: [], scoring: null, candidate: "first" };

  // ---------------------------------------------------------------
  // Multi-language resolution (Phase 2 + Phase 3 of #158)
  //
  // Priority order:
  //   1. ?lang=xx query param (if it matches an active package on the course)
  //   2. user's saved preference in course_language_preferences
  //   3. if only ONE active package exists, auto-use it
  //   4. otherwise render the picker (early return)
  //   5. legacy fallback to course.current_version_id only when the course
  //      has NO package rows at all; packages exist but none is active →
  //      back to the course page (ADR 0008 step 13, checked above, before
  //      the attempt rule). The course default never chooses a learner's
  //      language.
  // ---------------------------------------------------------------
  let resolvedVersionId: string | null = null;
  let chosenPackageId: string | null = null;
  // How the package was chosen (ADR 0004 step 9): an explicit ?lang= (the
  // picker navigates there too), the saved preference, or the only active one.
  let slotSource: SlotSource = "single";

  if (fallback === "legacy") {
    // Legacy path: no packages at all — fall back to course.current_version_id
    resolvedVersionId = c.current_version_id;
  } else if (activePackages.length === 1) {
    resolvedVersionId = activePackages[0].current_version_id;
    chosenPackageId = activePackages[0].id;
  } else {
    // Pick from explicit ?lang= if it matches an active package.
    let chosen: PackageRow | null = null;
    if (langParam && isSupportedLanguage(langParam)) {
      chosen =
        activePackages.find((p) => p.language === langParam) ?? null;
      if (chosen) slotSource = "explicit";
    }
    if (!chosen) {
      slotSource = "preference";
      // Look up saved preference.
      const { data: prefRow } = await supabase
        .from("course_language_preferences")
        .select("language")
        .eq("user_id", user.id)
        .eq("course_id", courseId)
        .maybeSingle();
      const savedLang = (prefRow?.language as string | undefined) ?? null;
      if (savedLang) {
        chosen =
          activePackages.find((p) => p.language === savedLang) ?? null;
      }
    }
    if (!chosen) {
      // Render picker — learner has no signal we can use.
      return (
        <LaunchLanguagePicker
          orgSlug={orgSlug}
          courseId={courseId}
          courseTitle={c.title}
          preview={preview}
          packages={activePackages.map((p) => ({
            id: p.id,
            language: p.language,
            display_label:
              p.display_name ??
              languageDisplay(p.language, "native") ??
              p.language ??
              "Default",
          }))}
        />
      );
    }
    resolvedVersionId = chosen.current_version_id;
    chosenPackageId = chosen.id;
  }

  if (!resolvedVersionId) {
    redirect(`/${orgSlug}/courses/${courseId}`);
  }

  const initialVersionId: string = resolvedVersionId;
  const initialPackageId: string | null = chosenPackageId;

  // The version this launch runs (ADR 0014 step 3, Routing), resolved once
  // per kind decision: the other-slot handling, the grandfather routing and
  // the version read. A revision visit's rows are invisible to both routing
  // steps, so a revisit resolves to the current version of the chosen slot;
  // the same reads list the stale revision rows (flagged, in progress, on a
  // non-current version of the chosen package), closed below. A `grant`
  // launch ignores every open row: consume_grant closes them all, so its
  // version is the chosen slot's current one.
  type Resolution = { v: Version; deactivated: string[]; staleRevisionIds: string[] };
  const versionById = new Map<string, Version>();
  const IP_COLUMNS = "id, course_version_id, started_at, last_activity_at";
  const resolveVersion = async (candidate: CandidateKind, grantsNow: Grants): Promise<Resolution> => {
    let versionId: string = initialVersionId;
    let packageId: string | null = initialPackageId;
    let deactivated: string[] = [];
    let openRevisionRows: SlotAttempt[] = [];
    // The context's open rows on every version of the course (one read): the
    // other-slot handling and the grandfather routing both decide from them.
    let inProgress: SlotAttempt[] = [];
    // From the one versions read above (step 70: no second read of the
    // course's packages or versions here; the packages are allPackages).
    const packageOfVersion = new Map<string, string>();
    for (const r of courseVersions) if (r.package_id) packageOfVersion.set(r.id, r.package_id);

    // OTHER-SLOT HANDLING (ADR 0004 step 9, lib/courses/slot-routing.ts): an
    // in-progress attempt on ANOTHER language slot of this course. Own-slot
    // resume wins; an explicit ?lang= goes back to the course page's language
    // switch confirm (nothing abandoned); a preference / single-slot launch
    // continues the other slot's attempt; only an attempt on a DEACTIVATED
    // slot is closed (conditional on status = 'in_progress', tokens expired).
    // Grant retakes are never touched. Skipped on the legacy no-package path.
    if (candidate !== "grant" && packageId) {
      const allVersionIds = [...packageOfVersion.keys()];
      if (allVersionIds.length) {
        // The launch's own open rows (step 23; P2-5 item 3): a Start's are its
        // context's, so an open row of another product or a preview never
        // reroutes or bounces it, and a preview never routes onto, confirms
        // over or closes a real attempt. Its own abort signal: this read runs
        // again in this render after consume_grant (step 25).
        const readIp = (columns: string) =>
          inLaunchContext(
            supabase
              .from("course_attempts")
              .select(columns)
              .eq("user_id", user.id)
              .in("course_version_id", allVersionIds)
              .eq("status", "in_progress")
          ).abortSignal(new AbortController().signal);
        let { data: ipRows, error: ipErr } = await readIp(`${IP_COLUMNS}, is_revision`);
        if (ipErr && isMissingColumn(ipErr, "is_revision")) ({ data: ipRows, error: ipErr } = await readIp(IP_COLUMNS));
        if (ipErr) refuse("routing_read_failed");
        inProgress = (ipRows ?? []) as unknown as SlotAttempt[];
      }
      openRevisionRows = inProgress.filter((a) => a.is_revision === true);
      const decision = inProgress.length
        ? decideSlotRouting({
            source: slotSource,
            chosenPackageId: packageId,
            packageOfVersion,
            activePackageIds: new Set(activePackages.map((p) => p.id)),
            inProgress,
            retakeIds: grantsNow.retakeIds,
          })
        : ({ kind: "continue", abandon: [] } as const);

      if (decision.kind === "confirm-switch" && !preview) {
        // (1) Back to the course page, which opens the existing confirm for
        // this language (a confirmed switch resets the other slot's progress).
        // A preview never goes there: the switch it confirms resets the
        // learner's rows on the other slot whatever their context, a real
        // attempt included. It runs the language asked for, and its preview
        // on the other slot stays open (nothing is closed).
        redirect(`/${orgSlug}/courses/${courseId}?switch=${encodeURIComponent(langParam ?? "")}`);
      }
      // (3) is carried out below, only once every launch gate has passed: a
      // launch that is then refused (no version, prerequisite lock, scheduled
      // release) closes nothing.
      deactivated = [...decision.abandon];
      if (decision.kind === "cross-slot") {
        // (2) Grandfather across slots: run the attempt the learner already has.
        packageId = decision.packageId;
        versionId = decision.versionId;
      }
    }

    // GRANDFATHER ROUTING (silent module versioning):
    // If the learner already has an in-progress attempt on ANY version of the
    // chosen package — including a now-retired version that a newer one replaced —
    // resume THAT version so their bookmark/suspend_data stays intact. New
    // learners (no in-progress attempt) get the current version. "Force restart"
    // replaces abandon old in-progress attempts at replace time, so none match
    // here and the learner starts fresh on the new version. No learner-facing
    // choice or notice either way. A revision visit's row never routes
    // (is_revision = false, with the filter dropped on a database without it).
    // The launch's own rows only (step 23; P2-5 item 3): a Start is pinned
    // to a version only by an open row of its context, never by a preview's
    // or another product's, and a preview with no open preview of its own
    // runs the chosen slot's current version. Read from the open rows above
    // (step 70: no second attempts read): the newest started open row, not a
    // revision visit's, on a version of the chosen package (a row read
    // without the flag, on a database without 0103, counts as not one).
    if (candidate !== "grant" && packageId) {
      const chosen = packageId;
      const grandfather = inProgress
        .filter((a) => packageOfVersion.get(a.course_version_id) === chosen && a.is_revision !== true)
        .sort((a, b) => Date.parse(b.started_at ?? "") - Date.parse(a.started_at ?? "") || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
      if (grandfather) versionId = grandfather.course_version_id;
    }

    // A version is read once per render (a rerun after consume_grant that
    // resolves to the same version reuses it; step 70).
    let resolved = versionById.get(versionId);
    if (!resolved) {
      const { data: version } = await supabase
        .from("course_versions")
        .select("id, manifest_type, launch_url, manifest_data, package_id")
        .eq("id", versionId)
        // Bound to this course: a pointer to another course's version redirects
        // and is never written into an attempt.
        .eq("course_id", c.id)
        .maybeSingle();
      if (!version) redirect(`/${orgSlug}/courses/${courseId}`);
      resolved = version as Version;
      versionById.set(versionId, resolved);
    }
    const currentOfChosen = packageId ? (allPackages.find((p) => p.id === packageId)?.current_version_id ?? null) : null;
    const staleRevisionIds = packageId
      ? openRevisionRows
          .filter(
            (a) =>
              packageOfVersion.get(a.course_version_id) === packageId &&
              a.course_version_id !== currentOfChosen &&
              a.course_version_id !== resolved.id
          )
          .map((a) => a.id)
      : [];
    return { v: resolved, deactivated, staleRevisionIds };
  };
  let res = await resolveVersion(ev.candidate, grants);
  let v = res.v;

  // ALDS P4 launch contract (ADR 0006 §C, notes (a)–(c) of 2026-10-19),
  // behind ALDS_P4 (default off). With the flag off nothing below that
  // names `p4` runs and this launch is today's. A Start's row is 'Normal',
  // a revision visit's row 'Review' (ADR 0014 step 3); a Preview by mode
  // names its own columns, flag or not (previewAttemptColumns, ADR 0024
  // P2-5); the served language is the attempt's slot (by the
  // version's package, which also covers a cross-slot resume): the attempt
  // column stores null for the unlabeled legacy slot (as the 0100 backfill
  // does), the LaunchData says "und". Never read by scoring (ADR 0005 D1).
  const p4 = aldsP4Enabled();
  const packageOfServed = (ver: Version) => allPackages.find((p) => p.id === ver.package_id);

  // The closes of a resolution, run only once every launch gate has passed
  // (a launch that is then refused closes nothing), conditional on
  // status = 'in_progress' and the learner's own rows, fail-soft. Each takes
  // the launch's own rows only (step 23; P2-5 item 3), as the reads that
  // listed them did: a Start closes rows of its context only, a preview
  // never closes a real attempt.
  // Step 22, a journey `resume` whose open official rows routing abandons
  // (a deactivated slot): decided before the close (resumeAfterSlotRouting),
  // from the context's rows evaluate read. `refuse` closes nothing; `open`
  // lists the rows whose close lets the day's fresh official attempt in at
  // the row step below, and only the rows this close returns count as closed
  // (it is fail-soft, and the open-row index is per version).
  let resumeReopens: string[] = [];
  const closedOnDeactivatedSlot = new Set<string>();
  const closeAfterResolution = async (r: Resolution) => {
    if (ctx.kind === "journey") {
      const openOfficialIds = ev.my.filter((a) => a.status === "in_progress" && a.is_revision !== true).map((a) => a.id);
      const resumeAnswer = resumeAfterSlotRouting({
        admission: ctx.admission,
        openOfficialIds,
        abandon: r.deactivated,
        enrolmentStatus: jf?.status ?? null,
        dayCredited: (jf?.day_credit ?? null) !== null,
        dayNumber: tags.journey_day,
        candidate: ev.candidate,
      });
      if (resumeAnswer === "refuse") refuse("journey_resume_row_abandoned");
      if (resumeAnswer === "open") resumeReopens = openOfficialIds;
    }
    if (r.deactivated.length > 0) {
      // (3) The slot was deactivated by an admin: this attempt can never be
      // resumed from the picker again.
      // Abandoning is irreversible: re-check (4) with an error-checked read
      // and close nothing if it cannot be read. A database without
      // attempt_requests (pre-0083) has no grants.
      const { data: grantRows, error: grantErr } = await svcAttempt
        .from("attempt_requests")
        .select("used_attempt_id")
        .in("used_attempt_id", r.deactivated)
        .eq("status", "approved");
      const grantMissing = (grantErr as { code?: string } | null)?.code === "42P01";
      const closable =
        grantErr && !grantMissing
          ? []
          : r.deactivated.filter(
              (id) => !((grantRows ?? []) as Array<{ used_attempt_id: string | null }>).some((g) => g.used_attempt_id === id)
            );
      if (grantErr && !grantMissing) console.warn("[launch] grant re-check failed; nothing closed:", grantErr.message);
      if (closable.length > 0) {
        const { data: abRows, error: abErr } = await inLaunchContext(
          svcAttempt
            .from("course_attempts")
            .update({ status: "abandoned" })
            .in("id", closable)
            .eq("user_id", user.id)
            .eq("status", "in_progress")
        ).select("id");
        if (abErr) console.warn("[launch] deactivated-slot close failed:", abErr.message);
        const closedIds = ((abRows ?? []) as Array<{ id: string }>).map((row) => row.id);
        for (const id of closedIds) closedOnDeactivatedSlot.add(id.toLowerCase());
        const tokErr = await expireLaunchTokens(svcAttempt, closedIds);
        if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
        // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
        await enqueueAbandonedStatements(svcAttempt, closedIds);
      }
    }
    if (r.staleRevisionIds.length > 0) {
      // ADR 0014 step 3 (Routing): a revision visit's row left in progress on
      // a non-current version of the chosen package closes here, so the next
      // revisit opens on the current version (revision rows only; nothing is
      // lost, every revisit re-seeds from the official attempt).
      const { data: stRows, error: stErr } = await inLaunchContext(
        svcAttempt
          .from("course_attempts")
          .update({ status: "abandoned" })
          .in("id", r.staleRevisionIds)
          .eq("user_id", user.id)
          .eq("status", "in_progress")
          .eq("is_revision", true)
      ).select("id");
      if (stErr && !isMissingColumn(stErr, "is_revision")) console.warn("[launch] stale revision close failed:", stErr.message);
      const staleIds = ((stRows ?? []) as Array<{ id: string }>).map((row) => row.id);
      const tokErr = await expireLaunchTokens(svcAttempt, staleIds);
      if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
      await enqueueAbandonedStatements(svcAttempt, staleIds);
    }
  };
  await closeAfterResolution(res);

  // The in-progress row on the resolved version: resume by most recent
  // ACTIVITY (not started_at): when historical duplicate attempts exist, the
  // one the learner actually worked in is the one holding their bookmark —
  // resuming the other one is exactly the "lost my place" bug (0062 also
  // makes new duplicates impossible via a partial unique index). The row's
  // own flag decides the kind (is_revision, with the fallback); a failed
  // read refuses. The launch's own rows only (step 23; P2-5 item 3): a
  // Start's lookup is its context's open row; a preview's is the open row of
  // its key, `preview`, with preview_kind = 'course'.
  type LaunchRowFull = { id: string; cmi_data: CmiData | null; is_revision?: boolean | null; status?: string };
  const ROW_COLUMNS = "id, cmi_data, status";
  // Each read has its own abort signal: Next memoizes identical GET fetches
  // within one render, and I-5 below re-reads after a concurrent request's
  // insert; without it the re-read returned the first "no row" answer.
  const lookupRow = async (versionId: string): Promise<LaunchRowFull | null> => {
    const read = (columns: string) =>
      inLaunchContext(
        supabase
          .from("course_attempts")
          .select(columns)
          .eq("course_version_id", versionId)
          .eq("user_id", user.id)
          .eq("status", "in_progress")
      )
        .order("last_activity_at", { ascending: false, nullsFirst: false })
        .order("started_at", { ascending: false })
        .limit(1)
        .abortSignal(new AbortController().signal)
        .maybeSingle();
    let { data: found, error: rowErr } = await read(`${ROW_COLUMNS}, is_revision`);
    if (rowErr && isMissingColumn(rowErr, "is_revision")) ({ data: found, error: rowErr } = await read(ROW_COLUMNS));
    if (rowErr) refuse("row_read_failed");
    return (found ?? null) as unknown as LaunchRowFull | null;
  };

  // Resuming a row the kind rule accepted (lib/attempts/launch-kind.ts
  // rowAction): the cutover rule flags an unflagged row of a revision launch
  // in place first, and only a result of exactly 1 resumes it.
  type Taken = { attemptId: string; cmi: CmiData; isRevision: boolean; flagResult: number | null; action: RowAction };
  const takeRow = async (decision: RowDecision, existing: LaunchRowFull): Promise<Taken> => {
    if (decision.action === "refuse") refuse(decision.reason);
    if (decision.action === "insert_first" || decision.action === "insert_revision") refuse("row_exists");
    let flag: number | null = null;
    if (decision.action === "flag_then_resume") {
      // Cutover (ADR 0014 step 3): rows opened before 0103, or under a legacy
      // multi-attempt rule. Any error, 0 rows (a retake, completed, or changed
      // under us) or a missing function refuses; the retry decides again.
      const { data: flagged, error: flagErr } = await svcAttempt.rpc("flag_revision_attempt", { p_attempt_id: existing.id });
      if (flagErr) refuse(isSchemaMissing(flagErr) ? "schema_missing" : "flag_failed");
      if (flagged !== 1) refuse("flag_not_applied");
      flag = 1;
    }
    // ADR 0024 step 23: no resume re-tag. A row's context is fixed at its
    // insert (step 7), and the lookup reads the launch's context only, so a
    // resumed row is always the context's own.
    return {
      attemptId: existing.id,
      cmi: (existing.cmi_data ?? {}) as CmiData,
      isRevision: existing.is_revision === true || flag === 1,
      flagResult: flag,
      action: decision.action,
    };
  };

  let attemptId: string | null = null;
  let cmi: CmiData = {};
  let rowIsRevision = false;
  let rowAct: RowAction = "insert_first";
  let flagResult: number | null = null;
  // The grant consumed on THIS launch (consume_grant answered `opened`).
  let openedGrantId: string | null = null;

  // P2-5 item 3, a Preview by mode's row: no evaluate, no grant, no
  // self-enrolment, no revision visit, no path or journey tag. The open
  // course preview of the resolved version resumes. Otherwise the launch
  // first closes an open legacy_role row of that version (note N4: both rows
  // carry the key `preview`, so the insert would meet 23505 under the
  // open-row index), then inserts the row with context_kind = 'preview',
  // preview_kind = 'course', is_preview true and launch_mode 'Normal'
  // (decision A32) and no official tag. The close sends no "abandoned"
  // statement (a preview never reaches a tenant LRS) and expires the closed
  // row's launch tokens. The close and the insert are not one transaction, so
  // a 23505 (a concurrent launch's preview, or a legacy_role row opened
  // between them) re-reads, and with no course preview there runs the close
  // and the insert once more. An A19 write: it names 0107 columns and has no
  // fallback; on a database without 0107 the lookup refuses first, before
  // any write.
  if (preview) {
    let open = await lookupRow(v.id);
    for (let tries = 0; !open && attemptId === null && tries < 2; tries++) {
      const { data: lrRows, error: lrErr } = await svcAttempt
        .from("course_attempts")
        .update({ status: "abandoned" })
        .eq("course_version_id", v.id)
        .eq("user_id", user.id)
        .eq("status", "in_progress")
        .eq("context_kind", "preview")
        .eq("preview_kind", "legacy_role")
        .select("id");
      if (lrErr) console.warn(JSON.stringify({ event: "preview_legacy_close_failed", course_id: c.id, user_id: user.id, code: lrErr.code ?? null }));
      const lrIds = ((lrRows ?? []) as Array<{ id: string }>).map((row) => row.id);
      if (lrIds.length > 0) {
        const tokErr = await expireLaunchTokens(svcAttempt, lrIds);
        if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
      }
      const { data: created, error: insErr } = await svcAttempt
        .from("course_attempts")
        .insert({
          course_version_id: v.id,
          user_id: user.id,
          organization_id: org.id,
          status: "in_progress",
          cmi_data: {},
          context_kind: "preview",
          preview_kind: "course",
          ...previewAttemptColumns({ language: packageOfServed(v)?.language }),
        })
        .select("id")
        .single();
      if (created) attemptId = created.id;
      else if (insErr?.code === "23505") open = await lookupRow(v.id);
      else refuse(isSchemaMissing(insErr) ? "schema_missing" : "preview_insert_failed");
    }
    if (attemptId === null) {
      if (!open) refuse("preview_row_missing");
      attemptId = open.id;
      cmi = (open.cmi_data ?? {}) as CmiData;
      rowAct = "resume_first";
    }
  }

  // I-1, the grant path, ONE transaction (ADR 0014 step 3; 0107
  // consume_grant in its day-id form, ADR 0024 step 10): the grant row of
  // this context is locked, every open row of the learner on the course in
  // this context closed, the fresh unseeded retake inserted with the
  // context's tags and the grant stamped, or nothing at all. There is no
  // fallback to separate writes. All nine arguments are named, so PostgREST
  // picks the nine-argument form, never the eight-argument wrapper.
  if (ev.candidate === "grant" && grants.unusedGrant) {
    const grantId = grants.unusedGrant.id;
    if (tags.context_kind === "journey" && tags.journey_day === null) refuse("journey_day_unknown");
    const { data: cgData, error: cgErr } = await svcAttempt.rpc("consume_grant", {
      p_grant_id: grantId,
      p_user_id: user.id,
      p_course_id: c.id,
      p_version_id: v.id,
      p_org_id: org.id,
      p_learning_path_id: tags.learning_path_id,
      p_journey_enrollment_id: tags.journey_enrollment_id,
      p_journey_day: tags.journey_day,
      p_journey_day_id: tags.journey_day_id,
    });
    // A raised error (a 23505 race, the consistency check, a deadlock) or a
    // missing function refuses, nothing written.
    if (cgErr) refuse(isSchemaMissing(cgErr) ? "schema_missing" : `consume_grant_error_${cgErr.code ?? "unknown"}`);
    const cg = (Array.isArray(cgData) ? cgData[0] : cgData) as
      | { outcome?: string | null; attempt_id?: string | null; abandoned_ids?: string[] | null }
      | null;
    const next = afterConsumeGrant(cg?.outcome);
    if (next === "refuse") refuse(`consume_grant_${String(cg?.outcome ?? "no_answer")}`);
    if (next === "proceed") {
      if (!cg?.attempt_id) refuse("consume_grant_no_attempt");
      const retakeId = cg.attempt_id;
      attemptId = retakeId;
      openedGrantId = grantId;
      const abandonedIds = cg.abandoned_ids ?? [];
      // The tokens of every NON-revision attempt of the learner on the course
      // in this context die now, not only the abandoned ones: a "Try again"
      // pass in attempt #1's still-open tab must not upgrade it after the
      // retake opened. Another product's attempts are not this grant's
      // (step 23). Fail-soft, as every token expiry.
      const tokErr = await expireLaunchTokens(
        svcAttempt,
        tokenExpiryTargets({ attempts: ev.my, abandonedIds, newAttemptId: retakeId })
      );
      if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
      // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
      await enqueueAbandonedStatements(svcAttempt, abandonedIds);
      // The 0100 columns of the retake, only with ALDS_P4 on: one update,
      // skipped on a database without 0100, never refusing (the grant is
      // already spent and the retake open; scoring never reads them).
      if (p4) {
        const { error: p4Err } = await svcAttempt
          .from("course_attempts")
          .update(p4AttemptColumns({ revision: false, language: packageOfServed(v)?.language }))
          .eq("id", retakeId)
          .eq("user_id", user.id)
          .eq("organization_id", org.id);
        if (p4Err) {
          if (isAldsSchemaMissing(p4Err)) logAldsSkip("grant_retake_columns", "schema_missing", { attemptId: retakeId });
          else console.warn("[alds] retake columns update failed", { attemptId: retakeId, code: p4Err.code });
        }
      }
    } else {
      // used | stale | retake_live | stands: never an unrequested retake.
      // Re-read the context's attempts and the grants (readContextResult's
      // own abort signals, step 25) and run the kind rule again in THIS
      // request, without consuming (never a self-redirect); routing runs in
      // full now (the grant resolution skipped it). The launch's context and
      // its gates do not depend on the version and are not repeated.
      inCtx = await readInContext();
      grants = grantsOf(inCtx);
      ev = evaluate(inCtx, false);
      res = await resolveVersion(ev.candidate, grants);
      v = res.v;
      await closeAfterResolution(res);
    }
  }

  if (!attemptId) {
    // A journey review reads its window as used (reviewOnly, above): it is a
    // revision visit, never a new official attempt on a credited day.
    const limitReached = (ev.scoring?.limitReached ?? false) || reviewOnly;
    // H: a `first` launch first closes any open flagged row of its context on
    // the resolved version (conditional on in_progress and is_revision;
    // nothing is lost, the next revisit re-seeds), then looks up unflagged
    // rows. Fail-soft: a row left open is refused by the kind rule below.
    // Never another context's row nor a preview's (a preview never reaches
    // this block).
    if (ev.candidate === "first") {
      const { data: flRows, error: flErr } = await inLaunchContext(
        svcAttempt
          .from("course_attempts")
          .update({ status: "abandoned" })
          .eq("course_version_id", v.id)
          .eq("user_id", user.id)
          .eq("status", "in_progress")
          .eq("is_revision", true)
      ).select("id");
      if (flErr && !isMissingColumn(flErr, "is_revision")) console.warn("[launch] flagged-row close failed:", flErr.message);
      const flIds = ((flRows ?? []) as Array<{ id: string }>).map((row) => row.id);
      if (flIds.length > 0) {
        const tokErr = await expireLaunchTokens(svcAttempt, flIds);
        if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
        await enqueueAbandonedStatements(svcAttempt, flIds);
      }
    }

    // I-2: the kind rule at the row.
    const existing = await lookupRow(v.id);
    const decision = rowAction({ candidate: ev.candidate, limitReached, row: existing, retakeIds: grants.retakeIds });
    let taken: Taken | null = null;
    if (existing) {
      taken = await takeRow(decision, existing);
    } else if (decision.action === "insert_first" || decision.action === "insert_revision") {
      // I-3, the insert invariant: a new row is official only for a free
      // window slot; every other new row is a revision visit's, and only
      // then is the column named, so a first launch never names it.
      const namedIsRevision = decision.action === "insert_revision";
      if (namedIsRevision !== insertIsRevision(limitReached, null)) refuse("kind_mismatch");
      // Step 22: a journey resume resumes the day's open attempt and never
      // inserts beside it, except after resumeAfterSlotRouting's `open`
      // once the close above returned every one of the context's open
      // official rows (phase 1's fresh attempt); a journey row needs its
      // day's number.
      const resumeReopened = resumeReopens.length > 0 && resumeReopens.every((id) => closedOnDeactivatedSlot.has(id.toLowerCase()));
      if (ctx.kind === "journey" && ctx.admission === "resume" && !resumeReopened) refuse("journey_resume_without_row");
      if (tags.context_kind === "journey" && tags.journey_day === null) refuse("journey_day_unknown");
      // ADR 0024 step 23: both inserts name the launch's context and its
      // tags (the resolver's context: a path's id, a journey's enrolment, day
      // number, day id and pinned version; null where the kind admits none),
      // so 0107's derive trigger never gives the row its context. An A19
      // write: on a database without 0107 the launch was refused at the
      // launch_context call, before any write.
      let { data: created, error: insErr } = await svcAttempt
        .from("course_attempts")
        .insert({
          course_version_id: v.id,
          user_id: user.id,
          organization_id: org.id,
          status: "in_progress",
          cmi_data: {},
          context_kind: tags.context_kind,
          learning_path_id: tags.learning_path_id,
          journey_enrollment_id: tags.journey_enrollment_id,
          journey_day: tags.journey_day,
          journey_day_id: tags.journey_day_id,
          journey_version_id: tags.journey_version_id,
          ...(namedIsRevision ? { is_revision: true } : {}),
          // The 0100 columns, only with ALDS_P4 on (ADR 0006 note (c)).
          ...(p4 ? p4AttemptColumns({ revision: namedIsRevision, language: packageOfServed(v)?.language }) : {}),
        })
        .select("id")
        .single();
      let namedP4 = p4;
      // I-4: flag on, 0100 absent on this database: retry once without the
      // three 0100 columns (is_revision re-sent when it was named), so a
      // launch never fails for P4. The 0062 23505 fallback below follows
      // either insert as before.
      if (p4 && !created && isAldsSchemaMissing(insErr)) {
        logAldsSkip("launch_insert", "schema_missing", { versionId: v.id });
        namedP4 = false;
        ({ data: created, error: insErr } = await svcAttempt
          .from("course_attempts")
          .insert({
            course_version_id: v.id,
            user_id: user.id,
            organization_id: org.id,
            status: "in_progress",
            cmi_data: {},
            context_kind: tags.context_kind,
            learning_path_id: tags.learning_path_id,
            journey_enrollment_id: tags.journey_enrollment_id,
            journey_day: tags.journey_day,
            journey_day_id: tags.journey_day_id,
            journey_version_id: tags.journey_version_id,
            ...(namedIsRevision ? { is_revision: true } : {}),
          })
          .select("id")
          .single());
      }
      // A revision insert failing on a missing schema: 0103 is not on this
      // database. Refuse (logged schema_missing); never an unflagged
      // revision row, never a retry without the column.
      if (!created && revisionInsertRefused(insErr, namedIsRevision, namedP4)) refuse("schema_missing");
      if (created) {
        taken = { attemptId: created.id, cmi: {}, isRevision: namedIsRevision, flagResult: null, action: decision.action };
      } else if (insErr?.code === "23505") {
        // I-5: a concurrent request (double click / router prefetch) created
        // the attempt a moment ago on 0062's one-in-progress index. Re-read
        // it with its flag and apply the kind rule; any disagreement refuses.
        const raced = await lookupRow(v.id);
        if (!raced) refuse("raced_row_missing");
        taken = await takeRow(
          rowAction({ candidate: ev.candidate, limitReached, row: raced, retakeIds: grants.retakeIds }),
          raced
        );
      }
    } else {
      refuse(decision.reason);
    }
    // Step 22: a journey review is a revision visit of the credited day,
    // whatever row it met (no official attempt, no grant's retake).
    if (taken && ctx.kind === "journey" && ctx.admission === "review" && !taken.isRevision) refuse("journey_review_not_revision");
    if (taken) {
      attemptId = taken.attemptId;
      cmi = taken.cmi;
      rowIsRevision = taken.isRevision;
      rowAct = taken.action;
      flagResult = taken.flagResult;
    }
  }
  if (!attemptId) {
    return <div className="p-10 text-red-700">Failed to create attempt.</div>;
  }

  // K: the seed, keyed on the row, on EVERY launch whose resolved row is a
  // revision visit's (ADR 0014 step 3; lib/attempts/launch-kind.ts seedPlan),
  // from the context's OFFICIAL attempt (scoring.officialAttempt in the
  // launch's context, ADR 0024 step 23, whatever version or language it is
  // on), never on a first, retake or grant launch. What the learner sees is
  // the official attempt's progress, answers and result. Failures are logged
  // with ids and the launch goes on.
  const seed = seedPlan({ action: rowAct, flagResult, manifestType: v.manifest_type });
  const official = (ev.scoring?.officialAttempt ?? null) as MyAttempt | null;
  if (seed.scorm) {
    // SCORM: the served cmi and the row's cmi_data are rebuilt from the
    // official attempt alone, by an update conditional on the row's flag.
    // The context's rows carry no cmi_data (readContextResult's columns), so
    // the official attempt's is read here, by its id, on the SCORM revision
    // branch only. Like every seed failure, a failed read is logged with ids
    // and the launch goes on, with the review cmi a revision visit with no
    // official attempt gets (the row is written already; the next revisit
    // seeds it again).
    let officialCmi: CmiData | null = null;
    if (official) {
      const { data: offRow, error: offErr } = await supabase
        .from("course_attempts")
        .select("cmi_data")
        .eq("id", official.id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (offErr) {
        console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official.id, step: "official_cmi_read" }));
      }
      officialCmi = offErr ? null : ((offRow as { cmi_data?: CmiData | null } | null)?.cmi_data ?? null);
    }
    cmi = buildRevisionCmi(official ? { cmi_data: officialCmi } : null);
    const { error: seedErr } = await svcAttempt
      .from("course_attempts")
      .update({ cmi_data: cmi })
      .eq("id", attemptId)
      .eq("user_id", user.id)
      .eq("is_revision", true)
      .eq("status", "in_progress");
    if (seedErr) {
      console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official?.id ?? null }));
    }
  }
  if (seed.state && official) {
    // cmi5 / xAPI: the official attempt's State documents overwrite the
    // revision row's, never the two LMS-owned documents (cmi5 §10.1, ADR
    // 0006 note (j)): LMS.LaunchData names the SOURCE attempt (registration,
    // session, launch mode), and LMS.OfficialResult is written below.
    // Unconditional: the flag may be off now and the source's document still
    // stored. The guard is this request's own verdict (seedPlan: the row read,
    // inserted or raced is flagged, or the cutover answered 1). supabase-js
    // returns its errors, so both calls destructure and log theirs (ids
    // only, as the SCORM branch does); the launch goes on either way.
    try {
      const { data: states, error: stateReadErr } = await svcAttempt
        .from("xapi_state")
        .select("state_id, content, content_type")
        .eq("attempt_id", official.id)
        .neq("state_id", LMS_LAUNCH_DATA_STATE_ID)
        .neq("state_id", LMS_OFFICIAL_RESULT_STATE_ID);
      if (stateReadErr) {
        console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official.id, step: "state_read" }));
      }
      const rows = (stateReadErr ? [] : (states ?? [])) as Array<{ state_id: string; content: unknown; content_type: string | null }>;
      if (rows.length > 0) {
        const { error: stateSeedErr } = await svcAttempt
          .from("xapi_state")
          .upsert(rows.map((r) => ({ ...r, attempt_id: attemptId })), { onConflict: "attempt_id,state_id" });
        if (stateSeedErr) {
          console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official.id, step: "state_upsert" }));
        }
      }
    } catch (e) {
      console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official.id, reason: e instanceof Error ? e.message : String(e) }));
    }
  }
  if (seed.officialResult && ev.scoring) {
    // LMS.OfficialResult (cmi5 and xAPI only): the official
    // attempt's status, integer-percent score and dates, for the revision
    // registration; not P4-gated. Ids, a status, a score and dates only.
    const { error: orErr } = await svcAttempt.from("xapi_state").upsert(
      {
        attempt_id: attemptId,
        state_id: LMS_OFFICIAL_RESULT_STATE_ID,
        content: buildOfficialResult({ scoring: { ...ev.scoring, officialAttempt: official }, writtenAt: new Date().toISOString() }),
        content_type: "application/json",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "attempt_id,state_id" }
    );
    if (orErr) console.warn(JSON.stringify({ event: "official_result_write_failed", attempt_id: attemptId }));
  }

  // Row-driven decisions (ADR 0014 step 3): the launch mode follows the
  // launch's mode and the row's flag (ADR 0024 step 23): a Preview by mode
  // is a preview in Normal; every role's Start is Normal, or Review on a
  // revision visit's row.
  const launch = launchModeFor({ mode, revision: rowIsRevision });
  const servedLanguage = servedLanguageFor(packageOfServed(v)?.language);

  // L: the revision visit record (ADR 0014 step 3), written once the launch
  // is certain, only for a flagged row and never for a preview
  // (shouldRecordVisit): through record_revision_visit in its seven-argument
  // form (0107: its 10 s dedupe per learner, course and context key, ADR 0024
  // step 23), a plain insert naming the context key when the function fails
  // for another reason than a missing schema (one high rather than lost), a
  // log line when that fails too. An A19 write.
  const recordRevisionVisit = async (visitAttemptId: string): Promise<void> => {
    const visit = {
      p_org: org.id,
      p_user: user.id,
      p_course: c.id,
      p_version: v.id,
      p_attempt: visitAttemptId,
      p_kind: v.manifest_type,
      p_context_key: ctxKey,
    };
    const { error: visitErr } = await svcAttempt.rpc("record_revision_visit", visit);
    if (!visitErr) return;
    if (isSchemaMissing(visitErr)) {
      console.warn(JSON.stringify({ event: "revision_visit_skipped", reason: "schema_missing", attempt_id: visitAttemptId }));
      return;
    }
    const { error: plainErr } = await svcAttempt.from("revision_visits").insert({
      organization_id: visit.p_org,
      user_id: visit.p_user,
      course_id: visit.p_course,
      course_version_id: visit.p_version,
      attempt_id: visit.p_attempt,
      launch_kind: visit.p_kind,
      context_key: visit.p_context_key,
    });
    if (plainErr) console.warn(JSON.stringify({ event: "revision_visit_failed", attempt_id: visitAttemptId }));
  };

  // ALDS step 0 (P1): every content URL names the ATTEMPT's version, so the
  // iframe runs the package this attempt was opened on (its language, or a
  // retired version it is grandfathered on) — never the course's current
  // one. The attempt above was selected/inserted with course_version_id =
  // v.id, so v.id IS course_attempts.course_version_id.
  const attemptVersionId = v.id;
  const contentBase = `/${orgSlug}/courses/${courseId}/content/v/${attemptVersionId}/`;
  // Exit returns the learner to the context they launched in: the journey,
  // the learning path (the resolver's context: a path this course is a step
  // of), the dashboard (?back=dashboard from its cards), otherwise the course
  // page. Fixed targets only — never a caller-supplied URL.
  const { backHref, backLabel } = resolveReturnTarget({
    orgSlug,
    courseId,
    journeyEnrollmentId: ctx.kind === "journey" ? ctx.enrollmentId : null,
    pathId: ctx.kind === "path" ? ctx.pathId : null,
    back: backParam || null,
  });

  // ADR 0019 step 8: the bar's Continue goes to the continue address only on a
  // Learning Path launch (the path context), never on a journey launch. A
  // preview has no path context, so it has no Continue (ADR 0024 step 23, the
  // owner's A21 answer). The title stays in the bar unless the version's
  // cached engine stamp says it is a KIVO build, which shows its own title.
  const continueHref =
    ctx.kind === "path"
      ? `/${orgSlug}/continue?lp=${encodeURIComponent(ctx.pathId)}&from=${encodeURIComponent(courseId)}`
      : null;
  const showTitle = !isKivoStamped(v.manifest_data);
  // ADR 0019, note of 2026-11-11: Continue waits until the module's official
  // result is stored. Ready at once when the page's own scoring of the
  // learner's attempts on the course in the launch's context already reads
  // stored, through the continue address's own test (a revision visit, a
  // relaunch after a result). Waiting on a first launch (its new row is not in ev.my, and no
  // official attempt exists yet), on a resumed granted retake (courseStatus
  // reads in_progress), on a pass_required course whose verdict is pending,
  // and on the launch that has just opened a granted retake (openedGrantId):
  // ev was read before consume_grant inserted the retake, so ev.my still
  // reads the earlier result as stored. The preview term is gone with the
  // preview's Continue (ADR 0024 step 23).
  const continueReady =
    continueHref !== null &&
    openedGrantId === null &&
    ev.scoring !== null &&
    officialResultStored(ev.scoring, ev.my, passRequired);
  // The status the bar polls while it waits (a learner-owned GET, the caller's session).
  const continueStatusHref =
    continueHref !== null ? `/api/attempts/${encodeURIComponent(attemptId)}/result-stored` : null;

  // Background preload of the NEXT module (journey: the next day with a
  // course in the enrolment's pinned version; learning path: the next step,
  // from launch_context's steps, with no read). Only its content launch file
  // is warmed — the runtime fetches it after this module is up and the
  // browser is idle, so the following step opens from cache. Fail-soft: no
  // next → nothing. A journey review warms nothing.
  const preloadUrls: string[] = [];
  try {
    let nextCourseId: string | null = null;
    const pf = facts?.path && facts.path.found ? facts.path : null;
    if (ctx.kind === "path" && pf && pf.course_step !== null) {
      const cur = pf.course_step;
      const nextStep = pf.steps.filter((s) => s.step_number > cur).sort((a, b) => a.step_number - b.step_number)[0];
      nextCourseId = nextStep?.course_id ?? null;
    } else if (ctx.kind === "journey" && ctx.admission !== "review" && ctx.dayNumber !== null && jf) {
      const dayN = ctx.dayNumber;
      const { data: pinned } = await supabase
        .from("journey_versions")
        .select("days")
        .eq("id", jf.version_id)
        .maybeSingle();
      const upcoming = [...parseVersionDays((pinned as { days?: unknown } | null)?.days).values()]
        .filter((d) => d.day > dayN && d.day <= jf.days_total && d.course_id)
        .sort((a, b) => a.day - b.day)[0];
      nextCourseId = upcoming?.course_id ?? null;
    }
    if (nextCourseId && nextCourseId.toLowerCase() !== courseId.toLowerCase()) {
      const { data: nextCourse } = await supabase
        .from("courses")
        .select("id, current_version_id")
        .eq("id", nextCourseId)
        .eq("organization_id", org.id)
        .maybeSingle();
      const nextVersionId = (nextCourse as { current_version_id?: string | null } | null)?.current_version_id;
      if (nextVersionId) {
        const { data: nextVersion } = await supabase
          .from("course_versions")
          .select("launch_url")
          .eq("id", nextVersionId)
          .maybeSingle();
        const launch = (nextVersion as { launch_url?: string } | null)?.launch_url;
        if (launch) {
          preloadUrls.push(
            `/${orgSlug}/courses/${nextCourseId}/content/v/${nextVersionId}/${launch.replace(/^\/+/, "").split("?")[0]}`
          );
        }
      }
    }
  } catch {
    /* preloading is best effort */
  }

  // --- SCORM 1.2 path ---
  if (v.manifest_type === "scorm12") {
    if (rowIsRevision) {
      // ADR 0014 step 3 (SCORM runtime): a revision visit's row runs in
      // review / no-credit, set unconditionally before entry = resume (the
      // SCO may overwrite any key at runtime; the commit route records
      // nothing for this row either way).
      cmi["cmi.core.lesson_mode"] = "review";
      cmi["cmi.core.credit"] = "no-credit";
      cmi["cmi.core.entry"] = "resume";
    }
    if (!cmi["cmi.core.student_id"]) cmi["cmi.core.student_id"] = user.id;
    if (!cmi["cmi.core.student_name"]) {
      cmi["cmi.core.student_name"] = user.email ?? "Learner";
    }
    const launchSrc = contentBase + v.launch_url.replace(/^\/+/, "");
    if (shouldRecordVisit({ isPreview: launch.isPreview, rowIsRevision })) await recordRevisionVisit(attemptId);
    return (
      <ScormRuntime
        attemptId={attemptId}
        initialCmi={cmi}
        iframeSrc={launchSrc}
        courseTitle={c.title}
        backHref={backHref}
        backLabel={backLabel}
        preloadUrls={preloadUrls}
        revision={rowIsRevision}
        preview={launch.isPreview}
        showTitle={showTitle}
        continueHref={continueHref}
        continueReady={continueReady}
        continueStatusHref={continueStatusHref}
      />
    );
  }

  // --- cmi5 / standalone xAPI (TinCan) path ---
  // Both mint the same attempt-bound LRS token. cmi5 hands it over through
  // the one-shot `fetch` handshake; a tincan.xml package gets it directly
  // on the launch URL as the standard `auth` parameter. Everything after
  // that (statements, State API resume, progress) is shared.
  const authToken = randomBytes(32).toString("hex");
  const { data: token } = await svcAttempt
    .from("cmi5_launch_tokens")
    .insert({
      auth_token: authToken,
      attempt_id: attemptId,
    })
    .select("fetch_token")
    .single();

  if (!token) {
    return (
      <div className="p-10 text-red-700">Failed to mint launch token.</div>
    );
  }
  if (shouldRecordVisit({ isPreview: launch.isPreview, rowIsRevision })) await recordRevisionVisit(attemptId);

  // xAPI endpoint URL must point at the live host so the SCORM/cmi5
  // player (in the iframe) can POST progress back. The helper handles
  // the build-time-inlining bug (#145, #146) — keep the empty-string
  // fallback so this never regresses to localhost.
  const host = (await originFromRequest()) || "https://localhost:3000";

  const actor = JSON.stringify({
    objectType: "Agent",
    name: user.email ?? "Learner",
    account: {
      homePage: host,
      name: user.id,
    },
  });
  // ADR 0006 step 17: with ALDS_P4 on, a cmi5 launch names the LMS-issued
  // AU id (BLUEPRINT §1.2); launchedActivityIds() accepts it in every
  // deploy and keeps the publisher ids. Flag off, a version without a
  // package, or a tincan package: today's publisher-id chain.
  const lmsAuId =
    p4 && v.manifest_type === "cmi5" && v.package_id ? lmsAuActivityId(v.package_id) : null;
  const activityId =
    lmsAuId ??
    (v.manifest_data?.raw?.auId ??
      v.manifest_data?.raw?.activityId ??
      v.manifest_data?.raw?.courseId ??
      `urn:uuid:${v.id}`);

  const isXapi = v.manifest_type === "xapi";
  const launchParams = isXapi
    ? // TinCan launch (xAPI launch guidelines): endpoint, auth, actor,
      // activity_id, registration. `auth` is the verbatim Authorization
      // header value; Basic <base64(user:token)> is what every TinCan
      // player (Storyline, Captivate, iSpring, KIVO) expects, and
      // authenticateXapi() unwraps it back to the attempt token.
      new URLSearchParams({
        endpoint: `${host}/api/xapi/`,
        auth: `Basic ${Buffer.from(`lms:${authToken}`).toString("base64")}`,
        actor,
        activity_id: activityId,
        // Same attempt ⇒ same registration on relaunch, so saved state
        // (State API) is found again and the session resumes.
        registration: attemptId,
        // Some engines read the cmi5-style name for the activity.
        activityId,
      })
    : new URLSearchParams({
        endpoint: `${host}/api/xapi/`,
        fetch: `${host}/api/xapi/fetch?fetch_token=${token.fetch_token}`,
        actor,
        registration: attemptId,
        activityId,
      });

  const launchPath = v.launch_url.replace(/^\/+/, "");
  const sep = launchPath.includes("?") ? "&" : "?";
  const iframeSrc = `${contentBase}${launchPath}${sep}${launchParams}`;

  // ADR 0006 step 16 (cmi5 §10.1), ALDS_P4 on, cmi5 only: write the
  // LMS-owned LMS.LaunchData document before the runtime renders and record
  // the session. Both fail soft: a failed write is logged with ids and the
  // launch proceeds (a 2.0 engine then runs its flagged fallback,
  // uncertified). The document carries ids and the slot language only. A
  // version without a package (the legacy no-package path) has no package
  // id for the template, so it gets no document; its session is recorded.
  if (p4 && !isXapi) {
    const sessionId = newSessionId();
    if (v.package_id) {
      // alds_manifest is a 0100 column: a separate, fail-soft read (any
      // error, or 0100 absent, leaves the course family out of grouping).
      let courseUlid: string | null = null;
      try {
        const { data: aldsRow, error: aldsErr } = await svcAttempt
          .from("course_versions")
          .select("alds_manifest")
          .eq("id", v.id)
          .maybeSingle();
        if (!aldsErr) {
          const manifest = (aldsRow as { alds_manifest?: unknown } | null)?.alds_manifest as
            | { courseUlid?: unknown }
            | null
            | undefined;
          courseUlid = typeof manifest?.courseUlid === "string" ? manifest.courseUlid : null;
        }
      } catch {
        courseUlid = null;
      }
      // ADR 0006 note (h): a registration's kind never changes between its
      // launches. A relaunch of an in-progress grant retake consumes no
      // grant, so the kind comes from the attempt's own link to its grant,
      // from this launch's strict grant snapshot (ADR 0014 step 3); a
      // revision visit's row stays `retake`.
      const launchData = buildLaunchData({
        attemptId,
        packageId: v.package_id,
        versionId: v.id,
        servedLanguage,
        launchMode: launch.launchMode,
        registrationKind: registrationKindFor({
          consumeGrantId: openedGrantId,
          revision: rowIsRevision,
          attemptIsGrantRetake: grants.retakeIds.has(attemptId),
        }),
        sessionId,
        publisherCourseId: v.manifest_data?.raw?.courseId ?? null,
        courseUlid,
        masteryScore: typeof v.manifest_data?.masteryScore === "number" ? v.manifest_data.masteryScore : null,
        // cmi5 §10.2.6: a URL, not a path (the fixed in-app back target).
        returnURL: `${host}${backHref}`,
        // ADR 0024 step 26: the launched row's context, three additive
        // extensions (context/kind, context/id, context/day): the kind, the
        // path id or the journey enrolment id, and the row's own journey day
        // number (a resumed row keeps the number it was launched on, so a
        // relaunch writes the same values); ids and a number only.
        context: {
          kind: ctx.kind,
          id: ctx.kind === "path" ? ctx.pathId : ctx.kind === "journey" ? ctx.enrollmentId : null,
          day: ctx.kind === "journey" ? (ev.my.find((a) => a.id === attemptId)?.journey_day ?? journeyDayNumber) : null,
        },
      });
      const { error: ldErr } = await writeLaunchData(svcAttempt, attemptId, launchData);
      if (ldErr) console.warn("[alds] LaunchData write failed", { attemptId, code: ldErr.code });
    } else {
      logAldsSkip("launch_data", "no_package", { attemptId, versionId: v.id });
    }
    await recordLearningSession(svcAttempt, {
      sessionId,
      organizationId: org.id,
      attemptId,
      launchKind: "cmi5",
      fetchToken: token.fetch_token,
      activityId,
      launchMode: launch.launchMode,
    });
  }

  return (
    <Cmi5Runtime
      iframeSrc={iframeSrc}
      courseTitle={c.title}
      backHref={backHref}
      backLabel={backLabel}
      preloadUrls={preloadUrls}
      revision={rowIsRevision}
      preview={launch.isPreview}
      showTitle={showTitle}
      continueHref={continueHref}
      continueReady={continueReady}
      continueStatusHref={continueStatusHref}
    />
  );
}

/**
 * Where "Exit course" goes. Every target is a fixed in-app path built from
 * validated ids, so a crafted launch URL can never bounce a learner
 * elsewhere.
 */
function resolveReturnTarget({
  orgSlug,
  courseId,
  journeyEnrollmentId,
  pathId,
  back,
}: {
  orgSlug: string;
  courseId: string;
  journeyEnrollmentId: string | null;
  pathId: string | null;
  back: string | null;
}): { backHref: string; backLabel: string } {
  if (journeyEnrollmentId) {
    return {
      backHref: `/${orgSlug}/journey?j=${encodeURIComponent(journeyEnrollmentId)}`,
      backLabel: "Back to journey",
    };
  }
  if (pathId) {
    return {
      backHref: `/${orgSlug}/paths/${encodeURIComponent(pathId)}`,
      backLabel: "Back to path",
    };
  }
  if (back === "dashboard") {
    return { backHref: `/${orgSlug}/dashboard`, backLabel: "Back to dashboard" };
  }
  return { backHref: `/${orgSlug}/courses/${courseId}`, backLabel: "Back to course" };
}
