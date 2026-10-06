import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk, fetchByIds } from "@/lib/db/chunked";
import { computeLearnerInsights, periodKey, type InsightsResult } from "./insights";
import type { LearnerInsight } from "./types";

/**
 * Report Card precompute (Phase 3, §13): the L3 screen reads insights the
 * 15-minute refresh stored in report_card_cache (0093) instead of computing
 * a few hundred people live on every request. Same rules as the live path —
 * the refresh calls computeLearnerInsights and stores its output.
 */

/** A cached row older than this is treated as missing (the page computes live). */
export const CACHE_MAX_AGE_MS = 45 * 60 * 1000;
/** Learners per computeLearnerInsights call during a refresh. */
const REFRESH_BATCH = 100;
const PERIODS: Array<number | null> = [7, 30, 90, null];

export type CachedInsights = { learners: LearnerInsight[]; computedAt: string; missing: string[] };

export type ScopedInsights = Pick<InsightsResult, "learners" | "catalog" | "benchmark" | "today"> & {
  /** Oldest cached row used, or null when everything was computed live. */
  computedAt: string | null;
};

/**
 * Insights for a manager scope: the cache when `useCache` and no content lens
 * (people missing from it are computed live and merged, so nobody vanishes),
 * otherwise live. Catalog / benchmark / calendar always come from the live
 * call (an empty one when nobody is missing).
 */
export async function loadScopedInsights(
  svc: SupabaseClient,
  opts: { orgId: string; orgSlug: string; userIds: string[]; periodDays: number | null; content?: string; useCache: boolean }
): Promise<ScopedInsights> {
  const { orgId, orgSlug, userIds, periodDays } = opts;
  const cached = opts.useCache && !opts.content ? await readCachedInsights(svc, orgId, userIds, periodDays) : null;
  if (!cached) {
    const live = await computeLearnerInsights(svc, { orgId, orgSlug, userIds, periodDays, content: opts.content });
    return { learners: live.learners, catalog: live.catalog, benchmark: live.benchmark, today: live.today, computedAt: null };
  }
  const live = await computeLearnerInsights(svc, { orgId, orgSlug, userIds: cached.missing, periodDays });
  const order = new Map(userIds.map((id, i) => [id, i]));
  const learners = [...cached.learners, ...live.learners].sort((a, b) => (order.get(a.userId) ?? 0) - (order.get(b.userId) ?? 0));
  return { learners, catalog: live.catalog, benchmark: live.benchmark, today: live.today, computedAt: cached.computedAt };
}

/**
 * Cached insights for `userIds` at `period`. Returns null when the cache is
 * missing or stale for more than a tenth of the people — the caller then
 * computes live.
 */
export async function readCachedInsights(
  svc: SupabaseClient,
  orgId: string,
  userIds: string[],
  periodDays: number | null
): Promise<CachedInsights | null> {
  if (userIds.length === 0) return { learners: [], computedAt: new Date().toISOString(), missing: [] };
  let rows: Array<{ user_id: string; computed_at: string; insight: LearnerInsight }>;
  try {
    rows = await fetchByIds<{ user_id: string; computed_at: string; insight: LearnerInsight }>(
      svc, "report_card_cache", "user_id, computed_at, insight", "user_id", userIds,
      (q) => q.eq("organization_id", orgId).eq("period", periodKey(periodDays)), "user_id"
    );
  } catch {
    return null; // pre-0093
  }
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  const fresh = rows.filter((r) => new Date(r.computed_at).getTime() >= cutoff);
  const have = new Set(fresh.map((r) => r.user_id));
  const missing = userIds.filter((id) => !have.has(id));
  if (missing.length > Math.max(1, Math.floor(userIds.length / 10))) return null;
  const order = new Map(userIds.map((id, i) => [id, i]));
  const learners = fresh.map((r) => r.insight).sort((a, b) => (order.get(a.userId) ?? 0) - (order.get(b.userId) ?? 0));
  const computedAt = fresh.reduce((min, r) => (r.computed_at < min ? r.computed_at : min), fresh[0]?.computed_at ?? new Date().toISOString());
  return { learners, computedAt, missing };
}

/**
 * Recompute active members of an org for all four period windows and upsert
 * the rows, stalest people first, until `deadline` (ms epoch) — a large org
 * converges over consecutive runs. Returns counts for the cron's response.
 */
export async function refreshOrgCache(
  svc: SupabaseClient,
  org: { id: string; slug: string },
  deadline = Number.POSITIVE_INFINITY
): Promise<{ learners: number; batches: number; pending: number }> {
  const members: Array<{ user_id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id)
      .eq("status", "active")
      .order("user_id")
      .range(from, from + 999);
    if (error) throw new Error(`members: ${error.message}`);
    const page = (data ?? []) as Array<{ user_id: string }>;
    members.push(...page);
    if (page.length < 1000) break;
  }
  const ids = members.map((m) => m.user_id);
  // Stalest first (people with no row at all come first), so a run cut by the
  // deadline still moves the whole org forward.
  const age = new Map<string, string>();
  try {
    const rows = await fetchByIds<{ user_id: string; computed_at: string }>(
      svc, "report_card_cache", "user_id, computed_at", "user_id", ids, (q) => q.eq("organization_id", org.id).eq("period", "30"), "user_id"
    );
    for (const r of rows) age.set(r.user_id, r.computed_at);
  } catch {
    /* pre-0093: the upsert below will surface the real error */
  }
  ids.sort((a, b) => (age.get(a) ?? "").localeCompare(age.get(b) ?? "") || a.localeCompare(b));
  let batches = 0;
  let done = 0;
  for (const part of chunk(ids, REFRESH_BATCH)) {
    if (Date.now() > deadline) break;
    const result = await computeLearnerInsights(svc, { orgId: org.id, orgSlug: org.slug, userIds: part, periodDays: 30, periods: PERIODS });
    const computedAt = new Date().toISOString();
    const rows: Array<{ organization_id: string; user_id: string; period: string; computed_at: string; insight: LearnerInsight }> = [];
    for (const [key, learners] of result.byPeriod ?? []) {
      for (const l of learners) rows.push({ organization_id: org.id, user_id: l.userId, period: key, computed_at: computedAt, insight: l });
    }
    for (const slice of chunk(rows, 400)) {
      const { error } = await svc.from("report_card_cache").upsert(slice, { onConflict: "organization_id,user_id,period" });
      if (error) throw new Error(`cache upsert: ${error.message}`);
    }
    batches++;
    done += part.length;
  }
  // Drop rows for people no longer active (deactivated / removed).
  if (ids.length > 0) {
    const { data: stale } = await svc
      .from("report_card_cache")
      .select("user_id")
      .eq("organization_id", org.id)
      .lt("computed_at", new Date(Date.now() - CACHE_MAX_AGE_MS).toISOString())
      .limit(1000);
    const gone = [...new Set(((stale ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))].filter((id) => !ids.includes(id));
    for (const part of chunk(gone, 150)) await svc.from("report_card_cache").delete().eq("organization_id", org.id).in("user_id", part);
  }
  return { learners: done, batches, pending: ids.length - done };
}

/**
 * Organisations that need the cache: any with an L3 mapping in use (the only
 * screen that reads it). Keeps the refresh cheap for tenants without one.
 */
export async function orgsNeedingCache(svc: SupabaseClient): Promise<Array<{ id: string; slug: string }>> {
  // Distinct organisations via a skip scan (one tiny query per org), so a
  // single large org can never fill a row window and hide the others.
  const orgIds: string[] = [];
  let last: string | null = null;
  for (;;) {
    let q = svc
      .from("organization_members")
      .select("organization_id")
      .eq("status", "active")
      .not("l3_manager_id", "is", null)
      .order("organization_id")
      .limit(1);
    if (last) q = q.gt("organization_id", last);
    const { data, error } = await q;
    if (error) throw new Error(`members: ${error.message}`);
    const row = ((data ?? []) as Array<{ organization_id: string }>)[0];
    if (!row) break;
    orgIds.push(row.organization_id);
    last = row.organization_id;
  }
  if (orgIds.length === 0) return [];
  return fetchByIds<{ id: string; slug: string }>(svc, "organizations", "id, slug", "id", orgIds);
}
