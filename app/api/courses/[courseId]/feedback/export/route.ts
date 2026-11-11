import { NextResponse } from "next/server";
import { fetchReferenceCodes } from "@/lib/reference-codes";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { auditLog } from "@/lib/auth/require-platform-owner";
import {
  exportRange,
  feedbackCsvHeader,
  feedbackCsvRow,
  FEEDBACK_EXPORT_MAX_ROWS,
  pageFeedbackRows,
} from "@/lib/interactions/feedback";
import { csvEscape } from "@/lib/util/csv";

/**
 * GET /api/courses/{courseId}/feedback/export?orgSlug=...[&from=...][&to=...]
 *
 * The Learner Feedback CSV of one course (ADR 0021 E.4): every eligible
 * feedback statement (no staff preview, no revision visit, no reset attempt;
 * the rule of migration 0106's view) with the learner's name, email and
 * employee id, the question, the response and its label, and whether it is
 * the learner's counted (newest) answer. Used by the "Download CSV" form of
 * the Learner feedback section on /[org]/library/[courseId]/reports.
 *
 * Scope: administrators only (canManage; Data Analysts and managers get 403,
 * owner 2026-11-07 and 2026-11-10), tenant-scoped (the caller's own client
 * confirms the course belongs to the organisation before any service read).
 *
 * `from` and `to` are optional bounds on `stored` (when the LMS received the
 * statement); an empty value is absent; a date-only `to` is inclusive. More
 * than 20,000 rows → 413 and no file. A database without 0106 → 503
 * feedback_unavailable; any other read error → 503 feedback_read_failed.
 * Each file written leaves one platform_audit_log row with ids and counts only.
 * The route logs nothing but error codes (in the reader).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("orgSlug");
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  const { user, org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();

  // ---- verify course is in this org (the caller's RLS client) ----
  const { data: course } = await supabase
    .from("courses")
    .select("id, title, organization_id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const c = course as { id: string; title: string; organization_id: string };

  // ---- the optional date range ----
  const range = exportRange(url.searchParams.get("from"), url.searchParams.get("to"));
  if (!range.ok) {
    return NextResponse.json({ error: "invalid_date", param: range.param }, { status: 400 });
  }

  // ---- the rows: 0106's view, service role only, pinned to the verified course ----
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const rows: string[][] = [feedbackCsvHeader()];
  const read = await pageFeedbackRows(svc, c.id, { gte: range.gte, lt: range.lt }, (page) => {
    for (const r of page) rows.push(feedbackCsvRow(r));
  });
  if (read.missing) {
    return NextResponse.json({ error: "feedback_unavailable" }, { status: 503 });
  }
  if (read.failed) {
    return NextResponse.json({ error: "feedback_read_failed" }, { status: 503 });
  }
  if (read.capped) {
    return NextResponse.json(
      { error: "too_many_rows", limit: FEEDBACK_EXPORT_MAX_ROWS, hint: "narrow the export with from and to" },
      { status: 413 }
    );
  }

  // UTF-8 BOM so Excel detects encoding correctly on Windows. Rows are written
  // in the order read; every cell goes through csvEscape (the formula guard).
  const csv =
    "﻿" +
    rows.map((r) => r.map(csvEscape).join(",")).join("\r\n") +
    "\r\n";

  const safeTitle = c.title.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Human-readable code in the file name (feedback_MOD0015_..., 0079), fail-soft before the migration.
  const exportCode = (await fetchReferenceCodes(supabase, "courses", [c.id])).get(c.id);
  const filename = `feedback_${exportCode ? `${exportCode}_` : ""}${safeTitle}_${stamp}.csv`;

  // One audit row per file written: who, which course, how many rows, which range; no text.
  await auditLog({
    actorUserId: user.id,
    action: "course.feedback.exported",
    targetType: "course",
    targetId: c.id,
    metadata: { organizationId: org.id, rows: rows.length - 1, from: range.from, to: range.to },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
