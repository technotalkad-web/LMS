import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/integrations/auth";
import { readParams, pick, list, bool, int, iso, isUuid } from "@/lib/integrations/params";
import { resolveIdsOrCodes } from "@/lib/reference-codes";
import {
  buildProgress,
  hasAttemptFilters,
  loadMembers,
  orgTimezone,
  usersEnrolledIn,
  usersMatchingAttempts,
  type LearnerProgress,
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
 *     course_id     list of LMS ids           (alias: curriculum_id)
 *     journey_id    list of LMS ids           (alias: program_id) → only learners
 *                                             enrolled in these journeys, and only
 *                                             those journey rows (OJT dashboards)
 *     completed_from / completed_to           ISO 8601; "YYYY-MM-DD HH:MM" or a
 *     last_access_from / last_access_to       bare date are read in the org's
 *                                             time zone (aliases: *_date)
 *     include_inactive  true → deactivated members too
 *
 * Selection: active members of the key's org, narrowed by employee_id /
 * email / journey_id. When any course or date filter is set, only learners
 * with at least one course row matching ALL of them are returned, and only
 * those rows are listed (Upside semantics); totals are counted after that
 * filtering, so total_records always matches what the pages hold. Pages
 * are ordered by employee number, then email.
 */
const BATCH = 100;

async function handle(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  const { svc, orgId, orgSlug } = auth;
  try {
    const p = await readParams(request);
    const page = int(pick(p, "page"), 1, 1, 100000);
    const perPage = int(pick(p, "per_page"), 100, 1, 100);
    const tz = await orgTimezone(svc, orgId);
    const dates = {
      completed_from: iso(pick(p, "completed_from", "completed_from_date"), "from", tz),
      completed_to: iso(pick(p, "completed_to", "completed_to_date"), "to", tz),
      last_access_from: iso(pick(p, "last_access_from", "last_access_from_date"), "from", tz),
      last_access_to: iso(pick(p, "last_access_to", "last_access_to_date"), "to", tz),
    };
    for (const [k, v] of Object.entries(dates)) {
      if (v === "invalid") {
        return NextResponse.json(
          { error: `${k} must be a date: ISO 8601, "YYYY-MM-DD HH:MM" or YYYY-MM-DD` },
          { status: 400 }
        );
      }
    }
    // course_id / journey_id accept the LMS uuid OR the human-readable code
    // (MOD0015, JUR0002). A code that matches nothing is a 400, never a
    // silently empty page.
    const courseSel = await resolveIdsOrCodes(svc, orgId, "courses", list(pick(p, "course_id", "curriculum_id")));
    const journeySel = await resolveIdsOrCodes(svc, orgId, "journey_programs", list(pick(p, "journey_id", "program_id")));
    for (const [name, sel] of [["course_id", courseSel], ["journey_id", journeySel]] as const) {
      if (sel.unknown.length) {
        return NextResponse.json(
          { error: `${name}: unknown code "${sel.unknown[0]}" for this organisation` },
          { status: 400 }
        );
      }
      const bad = sel.ids.find((x) => !isUuid(x));
      if (bad) {
        return NextResponse.json(
          { error: `${name} must be LMS ids (uuid) or codes (e.g. MOD0015) from the catalogue; got "${bad}"` },
          { status: 400 }
        );
      }
    }
    const f: ProgressFilters = {
      employeeIds: list(pick(p, "employee_id", "unique_id")),
      emails: list(pick(p, "email", "email_id")),
      courseIds: courseSel.ids,
      journeyIds: journeySel.ids,
      completedFrom: dates.completed_from as string | null,
      completedTo: dates.completed_to as string | null,
      lastAccessFrom: dates.last_access_from as string | null,
      lastAccessTo: dates.last_access_to as string | null,
      includeInactive: bool(pick(p, "include_inactive")),
    };

    let members = await loadMembers(svc, orgId, f);
    if (f.journeyIds.length) {
      const enrolled = await usersEnrolledIn(svc, orgId, f.journeyIds);
      members = members.filter((m) => enrolled.has(m.user_id));
    }

    let total: number;
    let progress: LearnerProgress[];
    if (hasAttemptFilters(f)) {
      // Exact rows for every candidate, then page: the attempt pre-selection
      // is a superset and buildProgress applies the row-level filter.
      const matching = await usersMatchingAttempts(svc, orgId, f);
      const candidates = members.filter((m) => matching.has(m.user_id));
      const rows: LearnerProgress[] = [];
      for (let i = 0; i < candidates.length; i += BATCH) {
        rows.push(...(await buildProgress(svc, orgId, orgSlug, candidates.slice(i, i + BATCH), f, tz)));
      }
      total = rows.length;
      progress = rows.slice((page - 1) * perPage, page * perPage);
    } else {
      total = members.length;
      progress = await buildProgress(svc, orgId, orgSlug, members.slice((page - 1) * perPage, page * perPage), f, tz);
    }

    return NextResponse.json({
      success: true,
      current_page: page,
      per_page: perPage,
      total_records: total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
      progress,
    });
  } catch (e) {
    console.error("[integrations/progress] failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Progress query failed" },
      { status: 500 }
    );
  }
}

export const GET = handle;
export const POST = handle;
