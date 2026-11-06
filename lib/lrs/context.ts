/**
 * Batched loader for the dimensions an enriched statement carries — one set
 * of queries per batch of attempts (live enqueue = one attempt; backfill and
 * the LMS-event sweeper = hundreds). Service role only; read-only.
 *
 * Every lookup is fail-soft: a missing table, column or row narrows the
 * context (fewer extensions) but never throws, so the forwarding path stays
 * exactly as robust as it was before enrichment existed. Two exceptions:
 * the two attempt reads behind the revision markers and the ordinal fall back
 * only on a missing `is_revision` column (ADR 0014 step 7), and the read behind
 * the not-applied marker only on a missing `ignored_pass` column (ADR 0017 step
 * 18). Any other error throws ContextReadError, because a forwarded statement
 * is write-once and must not leave with a revision row read as unflagged, or an
 * ignored pass read as applied.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { launchedActivityIds } from "@/lib/xapi/process-statement";
import { notAppliedStatementIds } from "@/lib/xapi/ignored-pass";
import { resolvePolicies } from "@/lib/scoring/resolve";
import { isMissingColumn, type PgError } from "@/lib/scoring/attempt-kind";
import {
  fetchActiveMembers,
  resolveGroupMembers,
  resolveUserGroupIds,
  type GroupRow,
} from "@/lib/org/groups";
import type { AttemptContext } from "./enrich";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

export function currentEnvironment(): string | null {
  return (
    process.env.NEXT_PUBLIC_SENTRY_ENV ||
    (process.env.NEXT_PUBLIC_SITE_URL?.includes("workers.dev") ? "staging" : null) ||
    null
  );
}

// The typed query builder cannot parse our long embedded selects; results are
// handled as untyped rows on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function safe<T>(p: PromiseLike<any>): Promise<T | null> {
  try {
    const { data, error } = (await p) as { data: T | null; error: unknown };
    return error ? null : data;
  } catch {
    return null;
  }
}

/**
 * A read behind the LRS markers (ADR 0014 step 7, ADR 0017 step 18) failed for a
 * reason other than a missing `is_revision` or `ignored_pass` column. Thrown,
 * never swallowed:
 * the sweep is cursor-paged, so a row skipped inside a
 * processed chunk is never re-selected, whereas a thrown source error is
 * caught by the sweep's orchestration, which leaves that source's cursor
 * where it was and marks it not done, so the next run retries the chunk.
 * The live callers catch it too (lib/lrs/abandoned.ts per slice, logged;
 * lib/lrs/enqueue.ts forwards the statements raw, never with a false label).
 */
export class ContextReadError extends Error {
  constructor(readonly read: "attempts" | "siblings" | "ignored_pass") {
    super(`attempt context read failed: ${read}`);
    this.name = "ContextReadError";
  }
}

/**
 * One read with a three-way answer, for the reads that must not be
 * fail-soft: `data`, `missing` (a missing-column error naming `column`, the
 * narrower-select fallback's trigger, isMissingColumn) or `failed` (any
 * other error, a thrown exception, or an answer with neither rows nor an
 * error).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readOrMissing<T>(p: PromiseLike<any>, column: string): Promise<{ data: T } | { missing: true } | { failed: true }> {
  try {
    const { data, error } = (await p) as { data: T | null; error: PgError };
    if (error) return isMissingColumn(error, column) ? { missing: true } : { failed: true };
    return data == null ? { failed: true } : { data };
  } catch {
    return { failed: true };
  }
}

/**
 * Every non-abandoned attempt of these users on these courses, for the
 * attempt ordinal. ADR 0014 step 7: revision rows are excluded from the
 * ordinal (a first tier filters `is_revision = false`); only a missing
 * column falls back to today's select (no row is flagged on such a
 * database); any other error throws ContextReadError, since an ordinal
 * re-read with revision rows in it would stamp write-once statements with
 * a wrong attempt/number.
 */
async function loadSiblings(svc: SupabaseClient, userIds: string[], courseIds: string[]): Promise<Row[] | null> {
  const flagged = await readOrMissing<Row[]>(
    svc
      .from("course_attempts")
      .select("id, user_id, started_at, status, is_revision, course_versions!inner(course_id)")
      .in("user_id", userIds)
      .in("course_versions.course_id", courseIds)
      .neq("status", "abandoned")
      .eq("is_revision", false),
    "is_revision"
  );
  if ("data" in flagged) return flagged.data;
  if ("failed" in flagged) throw new ContextReadError("siblings");
  return safe<Row[]>(
    svc
      .from("course_attempts")
      .select("id, user_id, started_at, status, course_versions!inner(course_id)")
      .in("user_id", userIds)
      .in("course_versions.course_id", courseIds)
      .neq("status", "abandoned")
  );
}

export type LearnerDims = AttemptContext["learner"];

/** Group names per user for ONE org, resolved org-wide in O(groups) queries —
 *  what a batch needs instead of O(users) per-user resolutions. */
export async function loadGroupMembership(
  svc: SupabaseClient,
  orgId: string
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const { data } = await svc
      .from("org_groups")
      .select("id, organization_id, group_type, rules, is_active, name")
      .eq("organization_id", orgId)
      .eq("is_active", true);
    const groups = (data ?? []) as Array<GroupRow & { name: string }>;
    if (!groups.length) return out;
    const cache = groups.some((g) => g.group_type === "dynamic")
      ? await fetchActiveMembers(svc, orgId)
      : undefined;
    for (const g of groups) {
      for (const uid of await resolveGroupMembers(svc, g, cache)) {
        const key = `${orgId}:${uid}`;
        out.set(key, [...(out.get(key) ?? []), g.name]);
      }
    }
  } catch {
    /* fail-soft: no group dimension */
  }
  return out;
}

/** Learner dimensions for a set of (org, user) pairs — shared by attempt
 *  contexts and by LMS-derived events that have no attempt. Pass
 *  `groupsByOrgUser` (from loadGroupMembership) for batches; without it,
 *  groups are resolved per user only for small batches. */
export async function loadLearnerDims(
  svc: SupabaseClient,
  pairs: Array<{ orgId: string; userId: string }>,
  groupsByOrgUser?: Map<string, string[]>
): Promise<Map<string, LearnerDims>> {
  const out = new Map<string, LearnerDims>();
  const userIds = [...new Set(pairs.map((p) => p.userId))];
  const orgIds = [...new Set(pairs.map((p) => p.orgId))];
  if (userIds.length === 0) return out;

  const [members, profiles, teamRows] = await Promise.all([
    safe<Row[]>(
      svc
        .from("organization_members")
        .select(
          "organization_id, user_id, role, employee_id, business_vertical, branch, city, state, node_id, designation, job_role, grade, line_manager_id, date_of_joining"
        )
        .in("organization_id", orgIds)
        .in("user_id", userIds)
    ),
    safe<Row[]>(svc.from("profiles").select("id, email, first_name, last_name, full_name").in("id", userIds)),
    safe<Row[]>(svc.from("team_members").select("user_id, teams(name, organization_id)").in("user_id", userIds)),
  ]);

  const memberBy = new Map<string, Row>();
  for (const m of members ?? []) memberBy.set(`${m.organization_id}:${m.user_id}`, m);
  const profileBy = new Map<string, Row>();
  for (const p of profiles ?? []) profileBy.set(String(p.id), p);
  const teamsBy = new Map<string, string[]>();
  for (const t of teamRows ?? []) {
    const team = one(t.teams as Row | Row[] | null);
    if (!team) continue;
    const key = `${team.organization_id}:${t.user_id}`;
    teamsBy.set(key, [...(teamsBy.get(key) ?? []), String(team.name)]);
  }

  // Groups: per user (O(groups) each, no org-wide scan); names resolved once.
  const groupNames = new Map<string, string>();
  if (orgIds.length) {
    const rows = await safe<Row[]>(svc.from("org_groups").select("id, name").in("organization_id", orgIds));
    for (const g of rows ?? []) groupNames.set(String(g.id), String(g.name));
  }

  for (const { orgId, userId } of pairs) {
    const key = `${orgId}:${userId}`;
    if (out.has(key)) continue;
    const m = memberBy.get(key) ?? {};
    const p = profileBy.get(userId) ?? {};
    const name =
      str(p.full_name) ??
      [str(p.first_name), str(p.last_name)].filter(Boolean).join(" ").trim() ??
      null;
    let groups: string[] = [];
    if (groupsByOrgUser) {
      groups = groupsByOrgUser.get(key) ?? [];
    } else if (groupNames.size && pairs.length <= 3) {
      try {
        const ids = await resolveUserGroupIds(svc, orgId, userId);
        groups = [...ids].map((id) => groupNames.get(id)).filter((n): n is string => Boolean(n));
      } catch {
        groups = [];
      }
    }
    out.set(key, {
      userId,
      email: str(p.email),
      displayName: name || null,
      employeeId: str(m.employee_id),
      role: str(m.role),
      vertical: str(m.business_vertical),
      branch: str(m.branch),
      city: str(m.city),
      state: str(m.state),
      node: str(m.node_id),
      designation: str(m.designation),
      jobRole: str(m.job_role),
      grade: str(m.grade),
      lineManagerId: str(m.line_manager_id),
      dateOfJoining: str(m.date_of_joining),
      teams: teamsBy.get(key) ?? [],
      groups,
    });
  }
  return out;
}

export async function loadOrgs(
  svc: SupabaseClient,
  orgIds: string[]
): Promise<Map<string, { id: string; slug: string | null; name: string | null }>> {
  const out = new Map<string, { id: string; slug: string | null; name: string | null }>();
  const ids = [...new Set(orgIds)];
  if (!ids.length) return out;
  const rows = await safe<Row[]>(svc.from("organizations").select("id, slug, name").in("id", ids));
  for (const o of rows ?? []) out.set(String(o.id), { id: String(o.id), slug: str(o.slug), name: str(o.name) });
  for (const id of ids) if (!out.has(id)) out.set(id, { id, slug: null, name: null });
  return out;
}

/** Full context for each attempt id (missing attempts are simply absent). */
export async function loadAttemptContexts(
  svc: SupabaseClient,
  attemptIds: string[],
  groupsByOrgUser?: Map<string, string[]>
): Promise<Map<string, AttemptContext>> {
  const out = new Map<string, AttemptContext>();
  const ids = [...new Set(attemptIds.filter(Boolean))];
  if (!ids.length) return out;

  // ADR 0014 step 7: a first tier names is_revision. Only a missing
  // is_revision column (a database without 0103, where no row is flagged)
  // falls back to today's two tiers, and the flag then reads false; any
  // other error throws ContextReadError (the sweep retries the chunk).
  const flagged = await readOrMissing<Row[]>(
    svc
      .from("course_attempts")
      .select(
        "id, user_id, organization_id, course_version_id, learning_path_id, journey_enrollment_id, journey_day, started_at, status, is_revision, " +
          "course_versions!inner(id, course_id, version_number, manifest_type, package_id, manifest_data, courses!course_versions_course_id_fkey(id, title), " +
          "course_packages!course_versions_package_id_fkey(id, language))"
      )
      .in("id", ids),
    "is_revision"
  );
  if ("failed" in flagged) throw new ContextReadError("attempts");

  const attempts =
    ("data" in flagged ? flagged.data : null) ??
    (await safe<Row[]>(
      svc
        .from("course_attempts")
        .select(
          "id, user_id, organization_id, course_version_id, learning_path_id, journey_enrollment_id, journey_day, started_at, status, " +
            "course_versions!inner(id, course_id, version_number, manifest_type, package_id, manifest_data, courses!course_versions_course_id_fkey(id, title), " +
            "course_packages!course_versions_package_id_fkey(id, language))"
        )
        .in("id", ids)
    )) ??
    // Pre-0058 / pre-0034 schemas: retry without the optional columns.
    (await safe<Row[]>(
      svc
        .from("course_attempts")
        .select(
          "id, user_id, organization_id, course_version_id, started_at, status, " +
            "course_versions!inner(id, course_id, version_number, manifest_type, package_id, manifest_data, courses!course_versions_course_id_fkey(id, title))"
        )
        .in("id", ids)
    )) ??
    [];
  if (!attempts.length) return out;

  const orgIds = [...new Set(attempts.map((a) => String(a.organization_id)))];
  const pairs = attempts.map((a) => ({ orgId: String(a.organization_id), userId: String(a.user_id) }));
  const pathIds = [...new Set(attempts.map((a) => str(a.learning_path_id)).filter((v): v is string => !!v))];
  const enrollmentIds = [
    ...new Set(attempts.map((a) => str(a.journey_enrollment_id)).filter((v): v is string => !!v)),
  ];
  const courseIds = [
    ...new Set(attempts.map((a) => str((one(a.course_versions as Row | Row[]) ?? {}).course_id)).filter((v): v is string => !!v)),
  ];
  const userIds = [...new Set(attempts.map((a) => String(a.user_id)))];

  const [learners, orgs, paths, pathCourses, enrollments, policies, siblings, grantLinks, ignored] = await Promise.all([
    loadLearnerDims(svc, pairs, groupsByOrgUser),
    loadOrgs(svc, orgIds),
    pathIds.length ? safe<Row[]>(svc.from("learning_paths").select("id, name").in("id", pathIds)) : null,
    pathIds.length
      ? safe<Row[]>(svc.from("learning_path_courses").select("path_id, course_id, step_number").in("path_id", pathIds))
      : null,
    enrollmentIds.length
      ? safe<Row[]>(
          svc
            .from("journey_enrollments")
            .select("id, program_id, journey_programs(name), journey_versions(days_total, name)")
            .in("id", enrollmentIds)
        )
      : null,
    resolvePolicies(svc, courseIds).catch(() => new Map()),
    // Every non-abandoned, non-revision attempt of these users on these courses → ordinal.
    loadSiblings(svc, userIds, courseIds),
    // ADR 0014 step 7: `scored` is grant-aware (a grant retake is scored).
    // Fail-soft: the mirror is not a chain renderer (ADR 0014:188's strict
    // rule is for the history surfaces).
    safe<Row[]>(
      svc.from("attempt_requests").select("used_attempt_id").eq("status", "approved").in("used_attempt_id", ids)
    ),
    // ADR 0017 step 18: a separate read, so a database without 0104 costs the
    // marker and nothing else. Only a missing column falls back (nothing is
    // marked); any other error throws below, so an ignored pass never leaves
    // enriched and unmarked.
    readOrMissing<Row[]>(
      svc.from("course_attempts").select("id, ignored_pass").in("id", ids).not("ignored_pass", "is", null),
      "ignored_pass"
    ),
  ]);
  if ("failed" in ignored) throw new ContextReadError("ignored_pass");
  const notAppliedByAttempt = new Map<string, Set<string>>();
  if ("data" in ignored) {
    for (const r of ignored.data) notAppliedByAttempt.set(String(r.id), new Set(notAppliedStatementIds(r.ignored_pass)));
  }
  const retakeIds = new Set<string>();
  for (const g of grantLinks ?? []) {
    const id = str(g.used_attempt_id);
    if (id) retakeIds.add(id);
  }

  const pathName = new Map<string, string | null>();
  for (const p of paths ?? []) pathName.set(String(p.id), str(p.name));
  const pathStep = new Map<string, number | null>();
  const pathSteps = new Map<string, number>();
  for (const pc of pathCourses ?? []) {
    pathStep.set(`${pc.path_id}:${pc.course_id}`, num(pc.step_number));
    pathSteps.set(String(pc.path_id), (pathSteps.get(String(pc.path_id)) ?? 0) + 1);
  }
  const enrollmentBy = new Map<string, Row>();
  for (const e of enrollments ?? []) enrollmentBy.set(String(e.id), e);

  // Attempt ordinal per (user, course), by started_at then id for stability.
  const ordinal = new Map<string, number>();
  const byUserCourse = new Map<string, Row[]>();
  for (const s of siblings ?? []) {
    const cid = str((one(s.course_versions as Row | Row[]) ?? {}).course_id);
    if (!cid) continue;
    const key = `${s.user_id}:${cid}`;
    byUserCourse.set(key, [...(byUserCourse.get(key) ?? []), s]);
  }
  for (const list of byUserCourse.values()) {
    list
      .sort((a, b) => {
        const ta = String(a.started_at ?? "");
        const tb = String(b.started_at ?? "");
        return ta < tb ? -1 : ta > tb ? 1 : String(a.id).localeCompare(String(b.id));
      })
      .forEach((row, i) => ordinal.set(String(row.id), i + 1));
  }

  const environment = currentEnvironment();

  for (const a of attempts) {
    const version = one(a.course_versions as Row | Row[]) ?? {};
    const course = one(version.courses as Row | Row[] | null) ?? {};
    const pkg = one(version.course_packages as Row | Row[] | null) ?? {};
    const orgId = String(a.organization_id);
    const userId = String(a.user_id);
    const courseId = str(version.course_id) ?? "";
    const versionId = str(version.id) ?? String(a.course_version_id);
    const attemptId = String(a.id);
    const pathId = str(a.learning_path_id);
    const enrollmentId = str(a.journey_enrollment_id);
    const enrollment = enrollmentId ? enrollmentBy.get(enrollmentId) : undefined;
    const program = enrollment ? one(enrollment.journey_programs as Row | Row[] | null) : null;
    const jversion = enrollment ? one(enrollment.journey_versions as Row | Row[] | null) : null;
    const policy = policies.get(courseId);
    const attemptNumber = ordinal.get(attemptId) ?? null;
    const manifest = (version.manifest_data ?? {}) as Row;
    const isRevision = a.is_revision === true;

    out.set(attemptId, {
      attemptId,
      attemptNumber,
      startedAt: str(a.started_at),
      // ADR 0014 step 7: false on a revision visit's row (explicitly, since
      // the row has no ordinal), true on a grant retake whatever its ordinal.
      scored: isRevision
        ? false
        : retakeIds.has(attemptId)
          ? true
          : policy && attemptNumber !== null
            ? attemptNumber <= policy.max_scored_attempts
            : null,
      isRevision,
      notAppliedIds: notAppliedByAttempt.get(attemptId) ?? new Set<string>(),
      scoringBasis: policy?.official_basis ?? null,
      scoringMaxAttempts: policy?.max_scored_attempts ?? null,
      org: orgs.get(orgId) ?? { id: orgId, slug: null, name: null },
      learner: learners.get(`${orgId}:${userId}`) ?? {
        userId,
        email: null,
        displayName: null,
        employeeId: null,
        role: null,
        vertical: null,
        branch: null,
        city: null,
        state: null,
        node: null,
        designation: null,
        jobRole: null,
        grade: null,
        lineManagerId: null,
        dateOfJoining: null,
        teams: [],
        groups: [],
      },
      content: {
        courseId,
        courseTitle: str(course.title),
        versionId,
        versionNumber: num(version.version_number),
        packageId: str(version.package_id),
        language: str(pkg.language),
        manifestType: str(version.manifest_type),
        engineVersion: str(manifest.engineVersion),
        // package_id adds the LMS-issued AU id (ADR 0006 note (d) of
        // 2026-10-19), accepted in every deploy as process-statement.ts does;
        // only SENDING it is flag-gated (ALDS_P4, launch page).
        launchedIds: launchedActivityIds(
          { id: versionId, manifest_data: manifest, package_id: str(version.package_id) },
          versionId
        ),
      },
      path: pathId
        ? {
            id: pathId,
            name: pathName.get(pathId) ?? null,
            step: pathStep.get(`${pathId}:${courseId}`) ?? null,
            steps: pathSteps.get(pathId) ?? null,
          }
        : null,
      journey:
        enrollmentId && enrollment
          ? {
              programId: String(enrollment.program_id),
              name: str(program?.name) ?? str(jversion?.name),
              enrollmentId,
              day: num(a.journey_day),
              daysTotal: num(jversion?.days_total),
            }
          : null,
      environment,
    });
  }
  return out;
}
