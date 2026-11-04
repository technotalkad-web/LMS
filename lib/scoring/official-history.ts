/**
 * The official-result chain of one learner on one course (ADR 0014 step 7,
 * "The chain, stated once"; placed beside computeScoring by step 6). Pure
 * and client-safe, no imports beyond types.
 *
 *   - official #1 = the first completed non-retake attempt (the earliest
 *     complete, non-abandoned, non-revision row that no approved grant
 *     links);
 *   - then each completed granted retake, in completion order;
 *   - a running retake (in progress, not complete) is the chain's open end;
 *   - the official result at time T is the newest entry completed before T,
 *     and each entry but the last is superseded by the next;
 *   - a grant carrying `reissued_from` is followed (transitively) to the
 *     grant originally approved, which gives who, when and why;
 *   - a decided request's request-time result is the chain before the
 *     request's `created_at` (officialResultAt).
 *
 * Ordering key: (completed_at ?? started_at, started_at, id), the key of
 * computeScoring and of the 0090 view. The SQL restatement of the current
 * official row is 0103's consume_grant (its `stale` and `stands` refusals),
 * so this file is that rule's TypeScript twin.
 *
 * Inputs need `status` and `is_revision` on every attempt row and
 * `reissued_from` on every grant row (a row without it follows no link).
 */

export type HistoryAttempt = {
  id: string;
  started_at: string;
  completed_at: string | null;
  completion_status?: string | null;
  success_status?: string | null;
  score: number | null;
  status?: string | null;
  is_revision?: boolean | null;
};

export type HistoryGrant = {
  id: string;
  /** Only approved grants link a retake; a row without `status` is read as approved (the snapshot's rows). */
  status?: string | null;
  used_attempt_id: string | null;
  used_at?: string | null;
  created_at?: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  reason: string | null;
  reissued_from?: string | null;
};

/** Who, when and why of the grant behind a retake, taken from the grant originally approved. */
export type HistoryGrantInfo = {
  /** The grant whose used_attempt_id is the retake. */
  grantId: string;
  /** The end of the reissued_from chain (= grantId when the grant was not re-issued). */
  originalGrantId: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  reason: string | null;
  /** decided_at of the re-issued grant when the retake was opened through a re-issue; null otherwise. */
  reissuedAt: string | null;
};

export type HistoryEntry = {
  attemptId: string;
  kind: "first" | "retake";
  /** The ordering key's date: completed_at, or started_at when the row has none. */
  completedAt: string;
  status: "passed" | "failed" | "completed";
  score: number | null;
  grant: HistoryGrantInfo | null;
  /** The entry that replaced this one; null for the current official result. */
  supersededBy: string | null;
};

export type OfficialHistory = {
  /** Oldest first; the last entry is the current official result. */
  entries: HistoryEntry[];
  /** The running granted retake, the chain's open end; null when none. */
  running: { attemptId: string; grant: HistoryGrantInfo | null } | null;
};

function ts(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function byKey(a: HistoryAttempt, b: HistoryAttempt): number {
  const ka = ts(a.completed_at ?? a.started_at);
  const kb = ts(b.completed_at ?? b.started_at);
  if (ka !== kb) return ka - kb;
  const sa = ts(a.started_at);
  const sb = ts(b.started_at);
  if (sa !== sb) return sa - sb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const isComplete = (a: HistoryAttempt) => a.completion_status === "completed" || a.success_status === "passed";
const counts = (a: HistoryAttempt) => a.status !== "abandoned" && a.is_revision !== true;
const resultOf = (a: HistoryAttempt): HistoryEntry["status"] =>
  a.success_status === "passed" ? "passed" : a.success_status === "failed" ? "failed" : "completed";

/** The grant behind a retake, with who/when/why followed through reissued_from to the original. */
function grantInfo(grant: HistoryGrant, byId: Map<string, HistoryGrant>): HistoryGrantInfo {
  let original = grant;
  const seen = new Set<string>([grant.id]);
  while (original.reissued_from) {
    const prev = byId.get(original.reissued_from);
    if (!prev || seen.has(prev.id)) break;
    seen.add(prev.id);
    original = prev;
  }
  return {
    grantId: grant.id,
    originalGrantId: original.id,
    decidedBy: original.decided_by,
    decidedAt: original.decided_at,
    decisionNote: original.decision_note,
    reason: original.reason,
    reissuedAt: original === grant ? null : grant.decided_at,
  };
}

export function officialHistory(attempts: HistoryAttempt[], grants: HistoryGrant[]): OfficialHistory {
  const approved = grants.filter((g) => (g.status ?? "approved") === "approved");
  const byId = new Map(grants.map((g) => [g.id, g]));
  const grantOfAttempt = new Map<string, HistoryGrant>();
  for (const g of approved) if (g.used_attempt_id && !grantOfAttempt.has(g.used_attempt_id)) grantOfAttempt.set(g.used_attempt_id, g);

  const rows = attempts.filter(counts);
  const completed = rows.filter(isComplete).sort(byKey);
  const first = completed.find((a) => !grantOfAttempt.has(a.id));
  const chain = completed.filter((a) => a === first || grantOfAttempt.has(a.id));

  const entries: HistoryEntry[] = chain.map((a) => {
    const g = grantOfAttempt.get(a.id);
    return {
      attemptId: a.id,
      kind: g ? "retake" : "first",
      completedAt: (a.completed_at ?? a.started_at) as string,
      status: resultOf(a),
      score: typeof a.score === "number" && Number.isFinite(a.score) ? a.score : null,
      grant: g ? grantInfo(g, byId) : null,
      supersededBy: null,
    };
  });
  for (let i = 0; i < entries.length - 1; i++) entries[i].supersededBy = entries[i + 1].attemptId;

  const live = rows
    .filter((a) => grantOfAttempt.has(a.id) && a.status === "in_progress" && !isComplete(a))
    .sort(byKey);
  const runningRow = live[live.length - 1];
  const running = runningRow
    ? { attemptId: runningRow.id, grant: grantInfo(grantOfAttempt.get(runningRow.id)!, byId) }
    : null;
  return { entries, running };
}

/** The current official result: the newest entry; null before any official attempt. */
export function currentOfficial(history: OfficialHistory): HistoryEntry | null {
  return history.entries[history.entries.length - 1] ?? null;
}

/**
 * The official result at time `iso`: the newest entry completed before it
 * (a decided request's request-time result is this at the request's
 * `created_at`). Null when no entry was complete by then.
 */
export function officialResultAt(history: OfficialHistory, iso: string): HistoryEntry | null {
  const t = ts(iso);
  let out: HistoryEntry | null = null;
  for (const e of history.entries) if (ts(e.completedAt) < t) out = e;
  return out;
}
