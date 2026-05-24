import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { extractInteractionsFromXapi } from "@/lib/interactions/extract-xapi";
import { extractInteractionsFromCmi } from "@/lib/interactions/extract-cmi";
import type { Interaction } from "@/lib/interactions/types";
import type { CmiData } from "@/lib/scorm/types";
import type { XapiStatement } from "@/lib/xapi/types";

type Attempt = {
  id: string;
  user_id: string;
  organization_id: string;
  course_version_id: string;
  completion_status: "in_progress" | "completed";
  success_status: "unknown" | "passed" | "failed";
  status: string;
  score: number | null;
  started_at: string;
  completed_at: string | null;
  cmi_data: CmiData;
};

type Version = {
  id: string;
  course_id: string;
  manifest_type: "scorm12" | "cmi5";
  version_number: number;
};

type Course = {
  id: string;
  title: string;
  organization_id: string;
};

export default async function AttemptDetailPage({
  params,
}: {
  params: Promise<{ org: string; courseId: string; attemptId: string }>;
}) {
  const { org: orgSlug, courseId, attemptId } = await params;
  const { org, role, user } = await requireOrgAccess(orgSlug);
  const isAdmin = role === "super_owner" || role === "admin";

  const supabase = await createClient();
  const { data: attemptRow } = await supabase
    .from("course_attempts")
    .select(
      "id, user_id, organization_id, course_version_id, completion_status, success_status, status, score, started_at, completed_at, cmi_data"
    )
    .eq("id", attemptId)
    .maybeSingle();

  if (!attemptRow) redirect(`/${orgSlug}/courses/${courseId}`);
  const a = attemptRow as Attempt;

  // Non-admins can only see their own attempts.
  if (!isAdmin && a.user_id !== user.id) {
    redirect(`/${orgSlug}/courses/${courseId}`);
  }
  if (a.organization_id !== org.id) {
    redirect(`/${orgSlug}/dashboard`);
  }

  // Load course + version for context.
  const { data: versionRow } = await supabase
    .from("course_versions")
    .select("id, course_id, manifest_type, version_number")
    .eq("id", a.course_version_id)
    .maybeSingle();
  const v = (versionRow ?? null) as Version | null;

  const { data: courseRow } = await supabase
    .from("courses")
    .select("id, title, organization_id")
    .eq("id", courseId)
    .maybeSingle();
  const c = (courseRow ?? null) as Course | null;
  if (!v || !c) redirect(`/${orgSlug}/courses/${courseId}`);

  // Pull statements (cmi5) and extract interactions.
  let interactions: Interaction[] = [];
  let rawStatements: XapiStatement[] = [];
  if (v.manifest_type === "cmi5") {
    const { data: stmts } = await supabase
      .from("xapi_statements")
      .select("raw, stored")
      .eq("attempt_id", a.id)
      .order("stored", { ascending: true });
    rawStatements = ((stmts ?? []) as Array<{ raw: XapiStatement }>).map(
      (r) => r.raw
    );
    interactions = extractInteractionsFromXapi(rawStatements);
  } else {
    interactions = extractInteractionsFromCmi(a.cmi_data ?? {});
  }

  // Look up the learner email (admins only).
  let learnerEmail: string | null = null;
  if (isAdmin) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data: u } = await svc.auth.admin.getUserById(a.user_id);
    learnerEmail = u?.user?.email ?? null;
  } else {
    learnerEmail = user.email ?? null;
  }

  const correctCount = interactions.filter((i) => i.success === true).length;
  const wrongCount = interactions.filter((i) => i.success === false).length;
  const ungradedCount = interactions.filter((i) => i.success === null).length;

  const durationMs =
    a.completed_at && a.started_at
      ? new Date(a.completed_at).getTime() - new Date(a.started_at).getTime()
      : null;

  return (
    <div className="max-w-5xl">
      <Link
        href={`/${orgSlug}/courses/${c.id}`}
        className="text-muted text-sm hover:text-ink transition-colors"
      >
        {c.title}
      </Link>

      <div className="mt-2 mb-8">
        <h1 className="serif text-4xl mb-2">Attempt detail</h1>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
          <span>
            Learner:{" "}
            <span className="text-ink">{learnerEmail ?? a.user_id.slice(0, 8)}</span>
          </span>
          <span>
            Standard: <span className="text-ink">{v.manifest_type}</span>
          </span>
          <span>
            Version: <span className="text-ink">v{v.version_number}</span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-8 text-sm">
        <Stat
          label="Completion"
          value={a.completion_status === "completed" ? "Completed" : "In progress"}
          tone={a.completion_status === "completed" ? "ink" : "muted"}
        />
        <Stat
          label="Result"
          value={
            a.success_status === "passed"
              ? "Passed"
              : a.success_status === "failed"
              ? "Failed"
              : "Not graded"
          }
          tone={
            a.success_status === "passed"
              ? "green"
              : a.success_status === "failed"
              ? "red"
              : "muted"
          }
        />
        <Stat
          label="Score"
          value={a.score === null ? "-" : `${(a.score * 100).toFixed(2)}%`}
        />
        <Stat label="Time on course" value={fmtDuration(durationMs)} />
      </div>

      <div className="flex items-baseline justify-between mb-3">
        <h2 className="serif text-2xl">Interactions</h2>
        <div className="text-xs text-muted">
          <span className="text-emerald-700">{correctCount} correct</span>
          {" · "}
          <span className="text-red-700">{wrongCount} wrong</span>
          {ungradedCount > 0 && (
            <>
              {" · "}
              <span>{ungradedCount} ungraded</span>
            </>
          )}
        </div>
      </div>

      {interactions.length === 0 ? (
        <div className="border border-line rounded-lg bg-paper p-6 text-muted text-sm">
          No interaction data captured for this attempt. Some courses only
          track aggregate completion; per-question detail is only available
          if the package itself reports it (cmi5 <code>answered</code>{" "}
          statements or SCORM <code>cmi.interactions.*</code>).
        </div>
      ) : (
        <div className="border border-line rounded-lg bg-paper overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium w-8">#</th>
                <th className="text-left px-4 py-2 font-medium">Question</th>
                <th className="text-left px-4 py-2 font-medium">Type</th>
                <th className="text-left px-4 py-2 font-medium">Response</th>
                <th className="text-left px-4 py-2 font-medium">Correct answer</th>
                <th className="text-left px-4 py-2 font-medium">Result</th>
                <th className="text-right px-4 py-2 font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {interactions.map((it, i) => (
                <tr key={`${it.id}-${i}`} className="align-top">
                  <td className="px-4 py-3 text-muted text-xs tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {it.name ?? it.id ?? "(unnamed)"}
                    </div>
                    {it.description && (
                      <div className="text-xs text-muted mt-0.5">
                        {it.description}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 text-[10px] uppercase tracking-wide bg-canvas border border-line rounded-full">
                      {it.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono break-all">
                    {fmtAnswer(it.response) || "-"}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono break-all">
                    {fmtAnswer(it.correctResponse) || "-"}
                  </td>
                  <td className="px-4 py-3">
                    <ResultPill success={it.success} />
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted whitespace-nowrap">
                    {fmtIsoDuration(it.duration)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {v.manifest_type === "cmi5" && rawStatements.length > 0 && (
        <details className="mt-10 border border-line rounded-lg bg-paper">
          <summary className="px-5 py-3 cursor-pointer text-sm font-medium">
            Raw xAPI statements ({rawStatements.length})
          </summary>
          <div className="px-5 pb-4">
            <ol className="space-y-2 text-xs">
              {rawStatements.map((s, i) => (
                <li
                  key={i}
                  className="border-t border-line pt-2 grid grid-cols-[auto_1fr] gap-x-4"
                >
                  <span className="text-muted tabular-nums">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="font-medium">
                      {(s.verb?.id ?? "").split("/").pop()}
                    </div>
                    <pre className="text-[10px] whitespace-pre-wrap break-all bg-canvas p-2 rounded mt-1 max-h-40 overflow-auto">
                      {JSON.stringify(s, null, 2)}
                    </pre>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}
    </div>
  );
}

function ResultPill({ success }: { success: boolean | null }) {
  if (success === true) {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-200">
        Correct
      </span>
    );
  }
  if (success === false) {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-red-100 text-red-800 border border-red-200">
        Wrong
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-canvas text-muted border border-line">
      -
    </span>
  );
}

function Stat({
  label,
  value,
  tone = "ink",
}: {
  label: string;
  value: string;
  tone?: "ink" | "muted" | "green" | "red";
}) {
  const toneCls =
    tone === "green"
      ? "text-emerald-700"
      : tone === "red"
      ? "text-red-700"
      : tone === "muted"
      ? "text-muted"
      : "text-ink";
  return (
    <div className="border border-line rounded-lg bg-paper p-4">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className={`serif text-2xl mt-1 ${toneCls}`}>{value}</div>
    </div>
  );
}

function fmtAnswer(s: string | undefined): string {
  if (!s) return "";
  // SCORM packs matching/sequencing responses as "a[.]1[,]b[.]2"; cmi5
  // uses simpler comma-separated lists. Light prettify either way.
  return s
    .replace(/\[,\]/g, ", ")
    .replace(/\[\.\]/g, " - ")
    .replace(/\[:\]/g, ": ");
}

function fmtIsoDuration(s: string | undefined): string {
  if (!s) return "-";
  // Accept ISO 8601 (PT5.2S) and SCORM (00:00:05.20)
  const m = s.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (m) {
    const h = parseFloat(m[1] ?? "0");
    const min = parseFloat(m[2] ?? "0");
    const sec = parseFloat(m[3] ?? "0");
    const total = Math.round(h * 3600 + min * 60 + sec);
    return formatSeconds(total);
  }
  const c = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (c) {
    const total = Math.round(
      parseInt(c[1], 10) * 3600 + parseInt(c[2], 10) * 60 + parseFloat(c[3])
    );
    return formatSeconds(total);
  }
  return s;
}

function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "-";
  return formatSeconds(Math.round(ms / 1000));
}
