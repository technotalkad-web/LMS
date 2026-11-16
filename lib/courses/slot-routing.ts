/**
 * Launch-time handling of in-progress attempts on ANOTHER language slot of
 * the same course (ADR 0004 step 9). Pure and client-safe, so the rules are
 * unit-tested (tests/unit/slot-routing.test.ts); the launch page does the
 * reads and the one write. The language switch route's answer (ADR 0014
 * steps 3 and 18, languageSwitchDecision below) lives here too, for the
 * same reason (tests/unit/language-preference.test.ts).
 *
 * Applied after package resolution and before grandfather routing:
 *
 *   (0) the resolved package has its own in-progress attempt → today's
 *       per-slot resume wins; attempts on other slots are left alone.
 *   (1) the package came from an explicit ?lang= (or the picker, which
 *       navigates to ?lang=) and an in-progress attempt exists on another
 *       ACTIVE package → the launch page's own picker, in the launch's
 *       context, with the language-switch confirm (ADR 0024 P2-9:
 *       languageSwitchLaunchUrl below). Nothing is abandoned.
 *   (2) the package came from the saved preference or the single-active-
 *       package rule and such an attempt exists → launch that attempt's
 *       version (grandfather across slots).
 *   (3) an in-progress attempt on a DEACTIVATED package → abandoned
 *       (conditional on status = 'in_progress', tokens expired), then the
 *       launch continues normally. The only abandon in this module.
 *   (4) an in-progress grant retake is never abandoned or rerouted.
 *
 * A revision visit's row (course_attempts.is_revision, ADR 0014 step 3) is
 * dropped before rule (0): it never makes a slot "own", never confirms or
 * reroutes, and is never abandoned here, so a revision visit resolves to
 * the current version of the chosen slot (the launch page closes a stale
 * one on the chosen package itself).
 *
 * Since ADR 0024 P2-6 the launch hands these rules the open rows of its own
 * product context only (step 23), and since P2-9 the switch route counts and
 * abandons in one context too (step 27). The helpers at the end of the file
 * are P2-9's: the body's context, the launch address of the picker, the
 * confirm's words and the audit row.
 */

export type SlotSource = "explicit" | "preference" | "single";

export type SlotAttempt = {
  id: string;
  course_version_id: string;
  started_at: string | null;
  last_activity_at: string | null;
  /** 0103; undefined on a database without it (= not a revision row). */
  is_revision?: boolean | null;
};

export type SlotRoutingInput = {
  source: SlotSource;
  /** The package resolved by ?lang= / preference / single-active rule. */
  chosenPackageId: string;
  /** course_versions.id → package_id, for every version of the course. */
  packageOfVersion: Map<string, string>;
  /** Packages of the course with is_active = true. */
  activePackageIds: Set<string>;
  /** The learner's attempts on this course with status = 'in_progress'. */
  inProgress: SlotAttempt[];
  /** Consumed grant retakes (grantRetakeIdsFor): never abandoned or rerouted. */
  retakeIds: Set<string>;
};

export type SlotRoutingDecision =
  /** (0) resume on the resolved slot; nothing else happens. */
  | { kind: "own-slot"; abandon: [] }
  /** (1) explicit choice with live progress elsewhere → confirm on the course page. */
  | { kind: "confirm-switch"; abandon: []; otherAttemptId: string }
  /** (2) implicit choice → launch the other slot's attempt version. */
  | { kind: "cross-slot"; versionId: string; packageId: string; attemptId: string; abandon: string[] }
  /** Nothing on other active slots; `abandon` = (3) attempts on deactivated slots. */
  | { kind: "continue"; abandon: string[] };

const activityOf = (a: SlotAttempt) => a.last_activity_at ?? a.started_at ?? "";

export function decideSlotRouting(input: SlotRoutingInput): SlotRoutingDecision {
  const { chosenPackageId, packageOfVersion, activePackageIds, retakeIds } = input;
  const pkgOf = (a: SlotAttempt) => packageOfVersion.get(a.course_version_id) ?? null;
  // ADR 0014 step 3: revision visits' rows are invisible to every rule.
  const inProgress = input.inProgress.filter((a) => a.is_revision !== true);

  // (0) Own-slot resume wins (grant retakes included: they ARE resumable here).
  if (inProgress.some((a) => pkgOf(a) === chosenPackageId)) return { kind: "own-slot", abandon: [] };

  // (4) Grant retakes are invisible to the rules below.
  const others = inProgress.filter((a) => !retakeIds.has(a.id) && pkgOf(a) !== null && pkgOf(a) !== chosenPackageId);
  const onDeactivated = others.filter((a) => !activePackageIds.has(pkgOf(a)!));
  const onActive = others
    .filter((a) => activePackageIds.has(pkgOf(a)!))
    .sort((x, y) => (activityOf(x) < activityOf(y) ? 1 : activityOf(x) > activityOf(y) ? -1 : 0));

  if (onActive.length > 0) {
    // (1) An explicit choice never silently abandons and never silently reroutes.
    if (input.source === "explicit") return { kind: "confirm-switch", abandon: [], otherAttemptId: onActive[0].id };
    // (2) Grandfather across slots: the attempt the learner last worked in.
    const pick = onActive[0];
    return {
      kind: "cross-slot",
      versionId: pick.course_version_id,
      packageId: pkgOf(pick)!,
      attemptId: pick.id,
      abandon: onDeactivated.map((a) => a.id),
    };
  }
  // (3) Only deactivated slots hold live attempts: close them, launch normally.
  return { kind: "continue", abandon: onDeactivated.map((a) => a.id) };
}

// ---------------------------------------------------------------------------
// The language switch (PUT /api/courses/{courseId}/language-preference),
// ADR 0014 step 3 (the is_revision filter) and step 18 (requires_finish).
// The route does the reads and the writes; what it answers is decided here,
// so every case is unit-tested (the route authenticates through the
// cookie-bound server client and has no unit rig).
// ---------------------------------------------------------------------------

/**
 * ADR 0014 step 18 (owner R1b yes; "Finish now" ships with the A.1 engine):
 * the answer when an official cmi5 attempt on the other language
 * has already taken an assessment.
 */
export const REQUIRES_FINISH_MESSAGE =
  "You have already taken an assessment in this course attempt. Continue it in its language, or end it with Finish now, before switching language.";

/**
 * ADR 0024 P2-9 (review F1): the answer when the switch would close a
 * journey day's open attempt and the day would open no new official attempt
 * afterwards (a completed enrolment, a removed or credited day, a day whose
 * course was swapped, a day that is not the open day): contextEntitlement()'s
 * `freshAfterClose` is false. The same 409 shape as step 18's.
 */
export const RESTART_NOT_ADMITTED_MESSAGE =
  "Your attempt in progress on this day of your journey cannot start again in another language, because the day would not open a new attempt. Continue it in its language.";

/** One in-progress row on the other language's versions, as the route reads it. */
export type SwitchRow = { id: string; course_version_id: string; is_revision?: boolean | null };

/**
 * The rows a confirmed switch would reset: in progress on another language,
 * not a consumed grant retake (ALDS Decision 9), not a revision visit's row
 * (ADR 0014 step 3: it stays open and is re-seeded at its next revisit).
 */
export function resettableSwitchRows(rows: SwitchRow[], retakeIds: ReadonlySet<string>): SwitchRow[] {
  return rows.filter((r) => r.is_revision !== true && !retakeIds.has(r.id));
}

/**
 * Step 18: the resettable rows the statements read checks, the cmi5 ones
 * (`manifest_type` of the row's version). SCORM stores no statements, and a
 * plain-xAPI launch keeps no bookmark, so both keep today's confirm.
 */
export function finishCheckAttemptIds(resettable: SwitchRow[], manifestTypeOfVersion: ReadonlyMap<string, string | null>): string[] {
  return resettable.filter((r) => manifestTypeOfVersion.get(r.course_version_id) === "cmi5").map((r) => r.id);
}

export type LanguageSwitchDecision =
  /** 409 { requires_finish, error, message }: nothing written, not the preference either, whatever the confirm says. */
  | { kind: "requires_finish"; message: string }
  /** 409 { requires_confirm, in_progress_attempts }: the learner has not confirmed losing the progress yet. */
  | { kind: "requires_confirm"; inProgressAttempts: number }
  /** Save the preference; abandon `resettableIds` when the learner confirmed. */
  | { kind: "proceed"; resettableIds: string[]; keptRetakes: number };

/**
 * The switch's answer, in the route's order: step 18's check runs once the
 * resettable set is known, then P2-9's (a close the context could not start
 * again after), both before the requires_confirm 409 and before the
 * preference upsert, on both values of restart_if_in_progress. Neither
 * refuses a switch that would close nothing (the target is the open
 * attempt's own language, or only a granted retake is open), so the learner
 * can always save the language they are in and continue.
 */
export function languageSwitchDecision(i: {
  rows: SwitchRow[];
  retakeIds: ReadonlySet<string>;
  /** Attempt ids among finishCheckAttemptIds() with a stored passed or failed statement (full verb IRIs). */
  assessedAttemptIds: ReadonlySet<string>;
  restartIfInProgress: boolean;
  /**
   * ADR 0024 P2-9 (review F1): would the context open a fresh official
   * attempt once the resettable rows are closed? contextEntitlement()'s
   * `freshAfterClose` for a path or a journey day; true for the Individual
   * course.
   */
  restartAdmitted: boolean;
}): LanguageSwitchDecision {
  const resettable = resettableSwitchRows(i.rows, i.retakeIds);
  if (resettable.some((r) => i.assessedAttemptIds.has(r.id))) {
    return { kind: "requires_finish", message: REQUIRES_FINISH_MESSAGE };
  }
  if (resettable.length > 0 && !i.restartAdmitted) {
    return { kind: "requires_finish", message: RESTART_NOT_ADMITTED_MESSAGE };
  }
  if (resettable.length > 0 && !i.restartIfInProgress) {
    return { kind: "requires_confirm", inProgressAttempts: resettable.length };
  }
  const keptRetakes = i.rows.filter((r) => r.is_revision !== true && i.retakeIds.has(r.id)).length;
  return { kind: "proceed", resettableIds: resettable.map((r) => r.id), keptRetakes };
}

// ---------------------------------------------------------------------------
// The language switch per product context (ADR 0024 step 27, slice P2-9;
// decisions A24 and A37). The route, the launch page, its picker and the
// course page's menu call these; whether a learner holds a path or journey
// context is lib/attempts/launch-context.ts contextEntitlement()'s.
// ---------------------------------------------------------------------------

/** The route body's `context` (step 27) as a caller sends it: the day by its id (section U). */
export type SwitchContextBody =
  | { kind: "individual" }
  | { kind: "path"; path_id: string }
  | { kind: "journey"; journey_enrollment_id: string; day_id: string };

/** A parsed context: lower-case ids, the shape of lib/scoring/context.ts's ContextRef. */
export type SwitchContext =
  | { kind: "individual" }
  | { kind: "path"; pathId: string }
  | { kind: "journey"; enrollmentId: string; dayId: string };

export type SwitchContextParse =
  | { ok: true; context: SwitchContext }
  /** `preview`: a Preview saves no preference and resets nothing (P2-5). `malformed`: not one of the three forms. */
  | { ok: false; reason: "preview" | "malformed" };

const SWITCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The body's `context` (step 27). Absent or null is the Individual course,
 * which is how every caller before P2-9 reads. Otherwise exactly one of
 * three forms, with no other key: `{kind: "individual"}`, `{kind: "path",
 * path_id}`, `{kind: "journey", journey_enrollment_id, day_id}`, each id a
 * uuid (a journey day by its id, never its number: section U). `{kind:
 * "preview"}`, whatever else it carries, is the preview refusal; anything
 * else is malformed. Whether the learner holds the context is not decided
 * here (contextEntitlement(), for a path or a journey).
 */
export function parseSwitchContext(raw: unknown): SwitchContextParse {
  if (raw === undefined || raw === null) return { ok: true, context: { kind: "individual" } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "malformed" };
  const o = raw as Record<string, unknown>;
  if (o.kind === "preview") return { ok: false, reason: "preview" };
  const keys = Object.keys(o).sort().join(",");
  const id = (v: unknown): string | null => (typeof v === "string" && SWITCH_ID.test(v) ? v.toLowerCase() : null);
  if (o.kind === "individual" && keys === "kind") return { ok: true, context: { kind: "individual" } };
  if (o.kind === "path" && keys === "kind,path_id") {
    const pathId = id(o.path_id);
    if (pathId) return { ok: true, context: { kind: "path", pathId } };
  }
  if (o.kind === "journey" && keys === "day_id,journey_enrollment_id,kind") {
    const enrollmentId = id(o.journey_enrollment_id);
    const dayId = id(o.day_id);
    if (enrollmentId && dayId) return { ok: true, context: { kind: "journey", enrollmentId, dayId } };
  }
  return { ok: false, reason: "malformed" };
}

/** The body form of a context: what the launch's picker sends for its launch's context. */
export function switchContextBody(c: SwitchContext): SwitchContextBody {
  switch (c.kind) {
    case "individual":
      return { kind: "individual" };
    case "path":
      return { kind: "path", path_id: c.pathId };
    case "journey":
      return { kind: "journey", journey_enrollment_id: c.enrollmentId, day_id: c.dayId };
  }
}

/**
 * The `?switch=` value that opens the launch's picker with no language chosen
 * yet: "Change language" on a path step or a journey day (step 27 (c)).
 */
export const SWITCH_CHOOSE = "choose";

/**
 * The launch address of the language switch in one context: where rule (1)
 * sends a launch (step 27 (b)), and where "Change language" on a path step or
 * a journey day goes (step 27 (c), with SWITCH_CHOOSE). It is the launch page
 * itself, with the launch's context (`?lp=`, or `?journey=` and `day`) and
 * `?switch=<language>`: the page renders its own picker there, which opens the
 * confirm for that language at once (for SWITCH_CHOOSE, the picker alone).
 * `?lang=` is never carried (the launch would meet rule (1) again);
 * `?back=dashboard` is. The course page is no longer the target: its menu
 * switches the Individual course only, so for a path or a journey it would
 * confirm a switch of the wrong product, and the launch would loop.
 */
export function languageSwitchLaunchUrl(i: {
  orgSlug: string;
  courseId: string;
  /** The day as the launch reads it: its id (a number only from a link made without 0107). */
  context: SwitchContext;
  /** A language code, or SWITCH_CHOOSE. */
  switchTo: string;
  back?: string | null;
}): string {
  const q = new URLSearchParams();
  if (i.context.kind === "path") q.set("lp", i.context.pathId);
  if (i.context.kind === "journey") {
    q.set("journey", i.context.enrollmentId);
    q.set("day", i.context.dayId);
  }
  q.set("switch", i.switchTo);
  if (i.back === "dashboard") q.set("back", "dashboard");
  return `/${i.orgSlug}/courses/${encodeURIComponent(i.courseId)}/launch?${q.toString()}`;
}

/** One open attempt of the switch's product, as its confirm reads it (revision rows left out). */
export type InProgressAttemptLang = {
  /** Package language of the attempt's version (null = legacy/unknown). */
  language: string | null;
  /** A consumed admin grant (official retake): never reset by a switch. */
  grantedRetake: boolean;
};

const PRODUCT_WORDS: Record<SwitchContext["kind"], { here: string; elsewhere: string }> = {
  individual: {
    here: "on this course",
    elsewhere: "in a learning path or a journey",
  },
  path: {
    here: "on this step of the path",
    elsewhere: "on this course outside this path, in another path or in a journey",
  },
  journey: {
    here: "on this day of your journey",
    elsewhere: "on this course outside this journey day, in a learning path or on another day",
  },
};

/**
 * The words of the switch's confirm (step 27 (d), decision A37), for the
 * course page's menu (the Individual course) and the launch's picker (the
 * launch's product). `inProgress` is that product's open attempts only, as
 * the route counts them. It says what the route does: only this product's
 * open attempt is reset (an extra attempt an admin granted never is), other
 * products keep their attempts in their own language, and nothing completed
 * changes. Before P2-9 the copy promised a reset in every case.
 */
export function switchConfirmText(i: {
  product: SwitchContext["kind"];
  target: string;
  targetLabel: string;
  inProgress: InProgressAttemptLang[];
  labelOf: (language: string | null) => string;
}): string {
  const words = PRODUCT_WORDS[i.product];
  const others = i.inProgress.filter((a) => a.language !== i.target);
  const kept = others.find((a) => a.grantedRetake);
  const continuesRetake = i.inProgress.some((a) => a.grantedRetake && a.language === i.target);
  const resets = others.some((a) => !a.grantedRetake);
  const freshInTarget = !i.inProgress.some((a) => a.language === i.target);
  const parts: string[] = [];
  if (!kept && !continuesRetake) {
    if (resets) parts.push(`Your attempt in progress ${words.here} will be reset, and the course starts again from the beginning in ${i.targetLabel}.`);
    else if (freshInTarget) parts.push(`You have no attempt in progress ${words.here}, so nothing is reset. The course opens in ${i.targetLabel}.`);
    else parts.push(`Your attempt in progress in ${i.targetLabel} continues. Nothing is reset.`);
  } else {
    if (continuesRetake) parts.push(`Switching to ${i.targetLabel} lets you continue your extra attempt.`);
    if (kept) parts.push(`Your extra attempt in progress is kept: it stays in ${i.labelOf(kept.language)}, and you can continue it by switching back.`);
    if (resets) parts.push(`Other progress you have ${words.here} in another language will be reset.`);
    if (freshInTarget) parts.push(`In ${i.targetLabel} the course starts from the beginning.`);
  }
  parts.push(`Attempts you have open ${words.elsewhere} keep their language and progress, and completed results are not changed.`);
  return parts.join(" ");
}

/** The audit row's action (decision A37 (a)); platform_audit_log.action is free text, so it needs no schema change. */
export const LANGUAGE_SWITCHED_ACTION = "course.language_switched";

/**
 * The audit row of a switch that closed attempts (decision A37 (a)), for
 * auditLog: written only when the abandon returned at least one row, naming
 * the rows it returned. Ids and language codes only: the course, the
 * organisation, the context (its kind, ids and key), the languages the
 * closed rows were on, the language chosen, and the closed attempt ids. No
 * name, no email, no score or result.
 */
export function languageSwitchAudit(i: {
  courseId: string;
  organizationId: string;
  context: SwitchContext;
  contextKey: string;
  toLanguage: string;
  closed: Array<{ id: string; language: string | null }>;
}): { action: typeof LANGUAGE_SWITCHED_ACTION; targetType: "course"; targetId: string; metadata: Record<string, unknown> } {
  const c = i.context;
  const context =
    c.kind === "path"
      ? { kind: "path", pathId: c.pathId }
      : c.kind === "journey"
        ? { kind: "journey", journeyEnrollmentId: c.enrollmentId, dayId: c.dayId }
        : { kind: "individual" };
  const fromLanguages = [...new Set(i.closed.map((r) => r.language).filter((l): l is string => typeof l === "string" && l !== ""))].sort();
  return {
    action: LANGUAGE_SWITCHED_ACTION,
    targetType: "course",
    targetId: i.courseId,
    metadata: {
      courseId: i.courseId,
      organizationId: i.organizationId,
      context,
      contextKey: i.contextKey,
      fromLanguages,
      toLanguage: i.toLanguage,
      attemptIds: i.closed.map((r) => r.id).sort(),
    },
  };
}
