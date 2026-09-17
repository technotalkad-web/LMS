import {
  DEFAULT_POLICY,
  normalizePolicy,
  type EffectivePolicy,
  type RuleScope,
  type ScoringRule,
} from "./policy";

/**
 * Server-side helpers around the 0073 scoring rules. Every call is
 * fail-soft: before the migration lands (no RPC / no table) callers get the
 * platform default, so no page or report ever 500s over a missing rule.
 */

// Supabase's builder generics get "excessively deep" when threaded through
// helpers; the calls here are simple enough that a loose client is safer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

export async function resolvePolicies(
  client: AnyClient,
  courseIds: string[]
): Promise<Map<string, EffectivePolicy>> {
  const out = new Map<string, EffectivePolicy>();
  const ids = [...new Set(courseIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data, error } = await client.rpc("effective_attempt_policies", {
      p_course_ids: ids,
    });
    if (!error && Array.isArray(data)) {
      for (const row of data as Array<Record<string, unknown>>) {
        const cid = row.course_id;
        if (typeof cid === "string") out.set(cid, normalizePolicy(row));
      }
    }
  } catch {
    /* pre-0073 */
  }
  for (const id of ids) if (!out.has(id)) out.set(id, DEFAULT_POLICY);
  return out;
}

export async function resolvePolicy(
  client: AnyClient,
  courseId: string
): Promise<EffectivePolicy> {
  return (await resolvePolicies(client, [courseId])).get(courseId) ?? DEFAULT_POLICY;
}

function toRule(row: Record<string, unknown>): ScoringRule {
  const p = normalizePolicy(row);
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    scope: row.scope as RuleScope,
    target_id: String(row.target_id),
    updated_at: String(row.updated_at ?? ""),
    max_scored_attempts: p.max_scored_attempts,
    official_basis: p.official_basis,
    official_attempt_number: p.official_attempt_number,
    retain_first_attempt: p.retain_first_attempt,
    after_limit: p.after_limit,
  };
}

/** Explicit rules for a set of targets of one scope (fail-soft → empty). */
export async function fetchScoringRules(
  client: AnyClient,
  scope: RuleScope,
  targetIds: string[]
): Promise<Map<string, ScoringRule>> {
  const out = new Map<string, ScoringRule>();
  const ids = [...new Set(targetIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data, error } = await client
      .from("attempt_scoring_rules")
      .select("*")
      .eq("scope", scope)
      .in("target_id", ids);
    if (!error && Array.isArray(data)) {
      for (const row of data as Array<Record<string, unknown>>) {
        const r = toRule(row);
        out.set(r.target_id, r);
      }
    }
  } catch {
    /* pre-0073 */
  }
  return out;
}

export async function fetchScoringRule(
  client: AnyClient,
  scope: RuleScope,
  targetId: string
): Promise<ScoringRule | null> {
  return (await fetchScoringRules(client, scope, [targetId])).get(targetId) ?? null;
}
