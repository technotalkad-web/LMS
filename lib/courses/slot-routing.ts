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
 *       ACTIVE package → back to the course page with the existing
 *       language-switch confirm. Nothing is abandoned.
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
 * resettable set is known, before the requires_confirm 409 and before the
 * preference upsert, on both values of restart_if_in_progress.
 */
export function languageSwitchDecision(i: {
  rows: SwitchRow[];
  retakeIds: ReadonlySet<string>;
  /** Attempt ids among finishCheckAttemptIds() with a stored passed or failed statement (full verb IRIs). */
  assessedAttemptIds: ReadonlySet<string>;
  restartIfInProgress: boolean;
}): LanguageSwitchDecision {
  const resettable = resettableSwitchRows(i.rows, i.retakeIds);
  if (resettable.some((r) => i.assessedAttemptIds.has(r.id))) {
    return { kind: "requires_finish", message: REQUIRES_FINISH_MESSAGE };
  }
  if (resettable.length > 0 && !i.restartIfInProgress) {
    return { kind: "requires_confirm", inProgressAttempts: resettable.length };
  }
  const keptRetakes = i.rows.filter((r) => r.is_revision !== true && i.retakeIds.has(r.id)).length;
  return { kind: "proceed", resettableIds: resettable.map((r) => r.id), keptRetakes };
}
