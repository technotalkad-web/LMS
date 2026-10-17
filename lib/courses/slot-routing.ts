/**
 * Launch-time handling of in-progress attempts on ANOTHER language slot of
 * the same course (ADR 0004 step 9). Pure and client-safe, so the rules are
 * unit-tested (tests/unit/slot-routing.test.ts); the launch page does the
 * reads and the one write.
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
 */

export type SlotSource = "explicit" | "preference" | "single";

export type SlotAttempt = {
  id: string;
  course_version_id: string;
  started_at: string | null;
  last_activity_at: string | null;
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

  // (0) Own-slot resume wins (grant retakes included: they ARE resumable here).
  if (input.inProgress.some((a) => pkgOf(a) === chosenPackageId)) return { kind: "own-slot", abandon: [] };

  // (4) Grant retakes are invisible to the rules below.
  const others = input.inProgress.filter((a) => !retakeIds.has(a.id) && pkgOf(a) !== null && pkgOf(a) !== chosenPackageId);
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
