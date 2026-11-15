/**
 * Per-version restart (ADR 0008 decision A, steps 1–5): the pure parts of
 * POST /api/courses/[courseId]/packages/[packageId]/versions/[versionId]/restart.
 * The route does the I/O; everything that decides what is refused, selected,
 * excluded and counted lives here so it is unit-tested.
 *
 * Deliberately free of next/* and Supabase imports so unit tests can load it.
 */

/** Same bound as the super_owner override reason (ADR 0004 step 3a). */
export const RESTART_REASON_MAX = 500;

/**
 * `dry_run` is optional; when present it must be a JSON boolean. Anything
 * else ("true", 1, null) is refused rather than read as a real run, because
 * a real run cannot be undone.
 */
export function parseDryRun(raw: unknown): { ok: true; dryRun: boolean } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, dryRun: false };
  if (typeof raw === "boolean") return { ok: true, dryRun: raw };
  return { ok: false, message: "dry_run must be true or false." };
}

/** A real run needs a reason: trimmed, 1–500 characters. */
export function parseRestartReason(raw: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0 || reason.length > RESTART_REASON_MAX) {
    return { ok: false, message: `A reason of 1–${RESTART_REASON_MAX} characters is required.` };
  }
  return { ok: true, reason };
}

export type RestartRefusal = {
  status: 409;
  error: "version_not_ready" | "version_is_current";
  message: string;
};

/**
 * Step 2: refusals, nothing changed. A version that is not fully uploaded,
 * or the current version of an ACTIVE package (resetting learners onto the
 * version they are already on corrects nothing). The current version of an
 * inactive package is allowed.
 */
export function restartRefusal(args: {
  versionId: string;
  /** undefined before migration 0077 = ready. */
  uploadStatus?: string | null;
  packageCurrentVersionId: string | null;
  packageActive: boolean;
}): RestartRefusal | null {
  if (args.uploadStatus && args.uploadStatus !== "ready") {
    return {
      status: 409,
      error: "version_not_ready",
      message: `Only fully uploaded versions can be restarted (this one is ${args.uploadStatus}).`,
    };
  }
  if (args.packageActive && args.packageCurrentVersionId === args.versionId) {
    return {
      status: 409,
      error: "version_is_current",
      message:
        "This is the current version of an active language: learners would restart on the same version. Replace the package first, then restart this version.",
    };
  }
  return null;
}

export type RestartAttempt = { id: string; user_id: string; organization_id: string };
/**
 * The dry run's two classes, under the keys the dialog reads. ADR 0024 step 23
 * (P2-5 item 4): `staff` counts the Previews (`context_kind = 'preview'`: a
 * Preview by mode, or a by-role row the 0107 paste labelled), and `learner`
 * every other row, a staff member's real attempt included. The member's role
 * no longer decides.
 */
export type ByRole = { learner: number; staff: number };

/**
 * The selection's Previews: every selected id that the route's context-filtered
 * read (readWithContextFilter over withoutPreviews, by id) did not keep. On a
 * database without 0107 that read keeps every id, so nothing is a Preview: no
 * preview split (ADR 0024 step 23, step 72's fallback-safe readers).
 */
export function previewIdsOf(selectedIds: readonly string[], keptIds: Iterable<string>): Set<string> {
  const kept = new Set(keptIds);
  return new Set(selectedIds.filter((id) => !kept.has(id)));
}

/** Attempts per class (one in-progress attempt per user per version and context): a Preview, or a learner's row. */
export function byRoleClass(attempts: RestartAttempt[], previewIds: ReadonlySet<string>): ByRole {
  const out: ByRole = { learner: 0, staff: 0 };
  for (const a of attempts) {
    if (previewIds.has(a.id)) out.staff++;
    else out.learner++;
  }
  return out;
}

/** The answer's `by_role`: the same keys (ADR 0024 A23); `staff` is null when Previews could not be told apart. */
export type ByRoleAnswer = { learner: number; staff: number | null };

/**
 * What the route answers under `by_role` (ADR 0024 P2-5, the review's reads
 * F2). `split` is the preview filter's decision for the request
 * (ContextFilterState.applies). false is a database without 0107: no row
 * could be told a Preview, so `staff` is null ("previews not counted" in the
 * dialog) rather than a 0 that would read as "no previews", and `learner`
 * holds every row. true (the filter applied) or null (no read was needed:
 * nothing selected) keeps the count.
 */
export function byRoleAnswer(byRole: ByRole, split: boolean | null): ByRoleAnswer {
  return split === false ? { learner: byRole.learner + byRole.staff, staff: null } : byRole;
}

/**
 * Step 3: of the version's in-progress attempts, grant retakes (approved
 * attempt_requests whose used_attempt_id is the attempt) are excluded by id;
 * everything else is selected. Ids are sorted so the dry run and the real
 * run list the same attempts in the same order.
 */
export function planRestart(
  inProgress: RestartAttempt[],
  grantRetakeIds: ReadonlySet<string>,
  previewIds: ReadonlySet<string>
): { selected: RestartAttempt[]; attemptIds: string[]; excludedGrantRetakeIds: string[]; byRole: ByRole } {
  const seen = new Set<string>();
  const unique = inProgress.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  const selected = unique.filter((a) => !grantRetakeIds.has(a.id)).sort((a, b) => a.id.localeCompare(b.id));
  const excludedGrantRetakeIds = unique
    .filter((a) => grantRetakeIds.has(a.id))
    .map((a) => a.id)
    .sort();
  return {
    selected,
    attemptIds: selected.map((a) => a.id),
    excludedGrantRetakeIds,
    byRole: byRoleClass(selected, previewIds),
  };
}
