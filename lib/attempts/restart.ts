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
 * Staff role classes (ADR 0003 step 10, the 0098 delete guard): a user who
 * holds one of these in the attempt's organisation. Every other role, and no
 * membership at all (a former member), reads as a learner.
 */
export const STAFF_ROLES: ReadonlySet<string> = new Set(["super_owner", "admin", "data_analyst"]);

export function isStaffRole(role: string | null | undefined): boolean {
  return !!role && STAFF_ROLES.has(role);
}

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
export type ByRole = { learner: number; staff: number };

/** Key of a staff membership: the role class is judged in the attempt's organisation. */
export function memberKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

/** Attempts per role class (one in-progress attempt per user per version, 0062). */
export function byRoleClass(attempts: RestartAttempt[], staffKeys: ReadonlySet<string>): ByRole {
  const out: ByRole = { learner: 0, staff: 0 };
  for (const a of attempts) {
    if (staffKeys.has(memberKey(a.organization_id, a.user_id))) out.staff++;
    else out.learner++;
  }
  return out;
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
  staffKeys: ReadonlySet<string>
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
    byRole: byRoleClass(selected, staffKeys),
  };
}
