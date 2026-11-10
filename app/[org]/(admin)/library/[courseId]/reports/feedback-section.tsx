import { createClient as createServiceClient } from "@supabase/supabase-js";
import { canManage } from "@/lib/auth/permissions";
import type { OrgRole } from "@/lib/auth/require-org-access";
import {
  COMMENTS_SHOWN,
  groupQuestions,
  learnerName,
  questionText,
  readFeedbackComments,
  readFeedbackSummary,
  truncateComment,
  type FeedbackBucket,
  type FeedbackQuestion,
} from "@/lib/interactions/feedback";

// =============================================================================
// Learner feedback (ADR 0021): the figures of the feedback slides of KIVO
// modules (verb `responded`), live, with learner names and comments.
//
// Administrators only (owner, 2026-11-07 and 2026-11-10): the page already
// redirects anyone who is not canManage, and this component returns null
// unless canManage(role) as well, so a later widening of the page to Data
// Analysts cannot leak the section. Every read is a service-role read of the
// 0106 objects (granted to service_role only), pinned to the course id the
// page confirmed belongs to the organisation with the caller's own client.
//
// No client component holds a row: this is a server component, comments are
// React text nodes (dangerouslySetInnerHTML is forbidden here), and the CSV
// control is a plain GET form, so no row enters the page payload.
// =============================================================================

export default async function FeedbackSection({
  orgSlug,
  courseId,
  courseTitle,
  role,
  slotCount,
}: {
  orgSlug: string;
  orgId: string;
  courseId: string;
  courseTitle: string;
  role: OrgRole;
  slotCount: number;
}) {
  if (!canManage(role)) return null;

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const [summary, comments] = await Promise.all([
    readFeedbackSummary(svc, courseId),
    readFeedbackComments(svc, courseId, COMMENTS_SHOWN),
  ]);

  const heading = (
    <>
      <h2 className="serif text-xl mb-1">Learner feedback</h2>
      <p className="text-xs text-muted mb-3">
        From the feedback slides of KIVO modules · live · staff previews,
        revision visits and reset attempts excluded · each learner&apos;s
        newest answer is counted
      </p>
    </>
  );

  if (summary.missing || comments.missing) {
    return (
      <section data-testid="feedback-section">
        {heading}
        <p className="text-sm text-muted">Learner feedback is available after migration 0106 is applied.</p>
      </section>
    );
  }
  if (summary.failed || comments.failed) {
    return (
      <section data-testid="feedback-section">
        {heading}
        <p className="text-sm text-muted">Learner feedback could not be read.</p>
      </section>
    );
  }

  const questions = groupQuestions(summary.rows);
  const commentTotal = questions
    .filter((q) => q.kind === "comment")
    .reduce((a, q) => a + q.answered, 0);

  return (
    <section data-testid="feedback-section">
      {heading}
      {questions.length === 0 ? (
        <div className="border border-dashed border-line rounded-2xl bg-paper p-6 text-sm text-muted">
          <strong className="text-ink">No learner feedback yet.</strong>{" "}
          This section fills when learners answer the feedback slides of a
          cmi5 or xAPI module. SCORM 1.2 packages do not send xAPI statements.
        </div>
      ) : (
        <div className="space-y-3">
          {summary.capped && (
            <p className="text-xs text-amber-700">
              The list below is cut off at 1,000 rows of figures. The CSV has every response.
            </p>
          )}
          {questions.map((q) => (
            <QuestionCard key={q.interactionId} q={q} showSlot={slotCount > 1} />
          ))}
        </div>
      )}

      {commentTotal > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium mb-2">
            Written comments{" "}
            <span className="text-muted font-normal">
              · {commentTotal.toLocaleString()} {commentTotal === 1 ? "comment" : "comments"}
            </span>
          </h3>
          <ul className="border border-line rounded-2xl bg-paper divide-y divide-line">
            {comments.rows.map((c) => (
              <li key={c.statement_row_id} className="px-4 py-3" data-testid="feedback-comment">
                <div className="text-[11px] text-muted mb-1">
                  <span className="text-ink font-medium">{learnerName(c)}</span>
                  {" · "}
                  {questionText(c)}
                  {" · "}
                  <span title={c.stored}>{shortDate(c.stored)}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words">{truncateComment(c.response ?? "")}</p>
              </li>
            ))}
          </ul>
          {commentTotal > comments.rows.length && (
            <p className="text-xs text-muted mt-2">
              Showing the newest {comments.rows.length.toLocaleString()} of {commentTotal.toLocaleString()}. The CSV has all.
            </p>
          )}
        </div>
      )}

      <form
        method="get"
        action={`/api/courses/${courseId}/feedback/export`}
        className="mt-6 flex flex-wrap items-end gap-3 text-sm"
        data-testid="feedback-csv"
        aria-label={`Download learner feedback for ${courseTitle} as CSV`}
      >
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <label className="flex flex-col text-[11px] text-muted">
          From (received on or after, UTC)
          <input type="date" name="from" className="mt-1 border border-line rounded-md px-2 py-1 text-sm text-ink bg-paper" />
        </label>
        <label className="flex flex-col text-[11px] text-muted">
          To (inclusive, UTC)
          <input type="date" name="to" className="mt-1 border border-line rounded-md px-2 py-1 text-sm text-ink bg-paper" />
        </label>
        <button
          type="submit"
          className="text-sm text-ink border border-line rounded-md px-3 py-1.5 hover:bg-paper transition-colors"
        >
          Download CSV
        </button>
        <span className="text-[11px] text-muted">
          Every response with names and comments; up to 20,000 rows, else pick a date range.
        </span>
      </form>
    </section>
  );
}

function QuestionCard({ q, showSlot }: { q: FeedbackQuestion; showSlot: boolean }) {
  const counts =
    q.responses !== q.learners
      ? `${q.responses.toLocaleString()} responses from ${q.learners.toLocaleString()} ${q.learners === 1 ? "learner" : "learners"}`
      : `${q.learners.toLocaleString()} ${q.learners === 1 ? "learner" : "learners"}`;
  return (
    <div className="border border-line rounded-2xl bg-paper p-4" data-testid="feedback-question" data-kind={q.kind}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-medium break-words">{q.title}</div>
          <div className="text-[11px] text-muted mt-0.5 break-all">
            {q.name && <span className="mr-2">{q.name}</span>}
            <code>{q.interactionId}</code>
            {showSlot && q.slotLanguages.length > 0 && (
              <span className="ml-2 border border-line rounded px-1.5 py-0.5">
                {q.slotLanguages.join(", ")}
              </span>
            )}
          </div>
        </div>
        <div className="text-[11px] text-muted tabular-nums">{counts}</div>
      </div>

      {q.kind === "stars" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 text-sm">
          <StatCard
            label="Average rating"
            value={q.average !== null ? q.average.toFixed(1) : "—"}
            sub={`${q.answered.toLocaleString()} ${q.answered === 1 ? "rating" : "ratings"}`}
            testId="feedback-average"
          />
          <div className="md:col-span-2">
            <BucketTable buckets={q.buckets} noAnswer={q.noAnswer} labelSuffix=" ★" />
          </div>
        </div>
      )}
      {(q.kind === "likert" || q.kind === "choice") && (
        <div className="mt-3">
          <BucketTable buckets={q.buckets} noAnswer={q.noAnswer} />
        </div>
      )}
      {q.kind === "other" && (
        <div className="mt-3">
          <div className="text-[10px] text-muted uppercase tracking-wide mb-1">Other</div>
          <BucketTable buckets={q.buckets} noAnswer={q.noAnswer} />
        </div>
      )}
      {q.kind === "comment" && (
        <div className="mt-2 text-sm">
          <span data-bucket="__text__" data-count={q.answered}>
            {q.answered.toLocaleString()} {q.answered === 1 ? "comment" : "comments"}
          </span>
          {q.noAnswer > 0 && (
            <span className="text-muted" data-bucket="none" data-count={q.noAnswer}>
              {" "}· No answer {q.noAnswer.toLocaleString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function BucketTable({
  buckets,
  noAnswer,
  labelSuffix = "",
}: {
  buckets: FeedbackBucket[];
  noAnswer: number;
  labelSuffix?: string;
}) {
  return (
    <table className="w-full text-sm">
      <tbody className="divide-y divide-line">
        {buckets.map((b) => (
          <tr key={b.id} data-bucket={b.id} data-count={b.learners}>
            <td className="py-1.5 pr-3 align-top break-words">{`${b.label}${labelSuffix}`}</td>
            <td className="py-1.5 pr-3 w-1/2 align-middle">
              <div className="h-2 rounded bg-canvas overflow-hidden" aria-hidden="true">
                <div className="h-2 bg-emerald-600" style={{ width: `${Math.round((b.share ?? 0) * 100)}%` }} />
              </div>
            </td>
            <td className="py-1.5 text-right tabular-nums whitespace-nowrap">
              {b.learners.toLocaleString()}
              <span className="text-[11px] text-muted ml-1">
                {b.share !== null ? `${Math.round(b.share * 100)}%` : "—"}
              </span>
            </td>
          </tr>
        ))}
        {noAnswer > 0 && (
          <tr data-bucket="none" data-count={noAnswer} className="text-muted">
            <td className="py-1.5 pr-3">No answer</td>
            <td className="py-1.5 pr-3 text-[11px]">not in the shares</td>
            <td className="py-1.5 text-right tabular-nums">{noAnswer.toLocaleString()}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** The page's BigStat card form (reports/page.tsx), for the star average. */
function StatCard({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="border border-line rounded-xl bg-paper p-4">
      <div className="text-[10px] text-muted uppercase tracking-wide">{label}</div>
      <div className="serif text-3xl mt-1 text-ink" data-testid={testId}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
