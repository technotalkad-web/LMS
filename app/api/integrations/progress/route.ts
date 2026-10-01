import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/integrations/auth";
import { readParams, pick, list, bool, int, iso } from "@/lib/integrations/params";
import {
  buildProgress,
  hasAttemptFilters,
  loadMembers,
  usersEnrolledIn,
  usersMatchingAttempts,
  type ProgressFilters,
} from "@/lib/integrations/progress";

/**
 * Bulk learner progress (the UpsideLMS "Progress API" replacement): one
 * call returns a page of learners with every course, learning path and
 * journey they hold, using the same rules as learner-summary.
 *
 *   GET|POST /api/integrations/progress
 *   Authorization: Bearer ambk_...
 *   params (GET query, JSON body or form body):
 *     page (1), per_page (100, max 100)       learners per page
 *     employee_id   list                      (alias: unique_id)
 *     email         list                      (alias: email_id)
 *     course_id     list                      (alias: curriculum_id)
 *     journey_id    list                      (alias: program_id) → only learners
 *                                             enrolled in these journeys, and only
 *                                             those journey rows (OJT dashboards)
 *     completed_from / completed_to           ISO, "YYYY-MM-DD HH:MM" or a date
 *     last_access_from / last_access_to       (aliases: *_date)
 *     include_inactive  true → deactivated members too
 *
 * Selection: active members of the key's org, narrowed by employee_id /
 * email. When any course or date filter is set, only learners with at least
 * one attempt matching ALL of them are returned, and only their matching
 * course rows are listed (Upside semantics). Pages are ordered by employee
 * number, then email.
 */
async function handle(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  const { svc, orgId, orgSlug } = auth;
  const p = await readParams(request);

  const page = int(pick(p, "page"), 1, 1, 100000);
  const perPage = int(pick(p, "per_page"), 100, 1, 100);
  const dates = {
    completedFrom: iso(pick(p, "completed_from", "completed_from_date"), "from"),
    completedTo: iso(pick(p, "completed_to", "completed_to_date"), "to"),
    lastAccessFrom: iso(pick(p, "last_access_from", "last_access_from_date"), "from"),
    lastAccessTo: iso(pick(p, "last_access_to", "last_access_to_date"), "to"),
  };
  for (const [k, v] of Object.entries(dates)) {
    if (v === "invalid") {
      return NextResponse.json({ error: `${k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())} must be an ISO 8601 date` }, { status: 400 });
    }
  }
  const f: ProgressFilters = {
    employeeIds: list(pick(p, "employee_id", "unique_id")),
    emails: list(pick(p, "email", "email_id")),
    courseIds: list(pick(p, "course_id", "curriculum_id")),
    journeyIds: list(pick(p, "journey_id", "program_id")),
    completedFrom: dates.completedFrom as string | null,
    completedTo: dates.completedTo as string | null,
    lastAccessFrom: dates.lastAccessFrom as string | null,
    lastAccessTo: dates.lastAccessTo as string | null,
    includeInactive: bool(pick(p, "include_inactive")),
  };

  let members = await loadMembers(svc, orgId, f);
  if (hasAttemptFilters(f)) {
    const matching = await usersMatchingAttempts(svc, orgId, f);
    members = members.filter((m) => matching.has(m.user_id));
  }
  if (f.journeyIds.length) {
    const enrolled = await usersEnrolledIn(svc, orgId, f.journeyIds);
    members = members.filter((m) => enrolled.has(m.user_id));
  }
  const total = members.length;
  const pageMembers = members.slice((page - 1) * perPage, page * perPage);
  const progress = await buildProgress(svc, orgId, orgSlug, pageMembers, f);

  return NextResponse.json({
    success: true,
    current_page: page,
    per_page: perPage,
    total_records: total,
    total_pages: Math.max(1, Math.ceil(total / perPage)),
    progress,
  });
}

export const GET = handle;
export const POST = handle;
