import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchScoringRule, resolvePolicy } from "@/lib/scoring/resolve";
import type { AfterLimit, OfficialBasis, RuleScope } from "@/lib/scoring/policy";

/**
 * Attempt scoring rules (0073). Admin-only (super_owner / owner / admin).
 *
 *   GET    /api/scoring-rules?orgSlug=&scope=course|path|journey&target_id=
 *            → { rule: ScoringRule | null, effective?: EffectivePolicy }
 *              (effective is returned for scope=course: what actually applies
 *               after path/journey inheritance)
 *   POST   /api/scoring-rules   { orgSlug, scope, target_id, ...fields }
 *            → upsert; { ok, rule }
 *   DELETE /api/scoring-rules   { orgSlug, scope, target_id }
 *            → remove the explicit rule (target inherits again); { ok }
 *
 * The target must belong to the caller's org (courses / learning_paths /
 * journey_programs are checked by id + organization_id).
 */

const SCOPES: RuleScope[] = ["course", "path", "journey"];
const BASES: OfficialBasis[] = ["first", "best", "latest", "nth"];
const AFTER: AfterLimit[] = ["practice", "block"];

const TARGET_TABLE: Record<RuleScope, string> = {
  course: "courses",
  path: "learning_paths",
  journey: "journey_programs",
};

async function ctx(orgSlug: string | undefined) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 as const };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (mem?.role as string) ?? "";
  if (!["super_owner", "owner", "admin"].includes(role)) {
    return { error: "Admins only", status: 403 as const };
  }
  return { supabase, orgId: org.id as string, userId: user.id };
}

function parseScope(v: unknown): RuleScope | null {
  return SCOPES.includes(v as RuleScope) ? (v as RuleScope) : null;
}

async function targetInOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  scope: RuleScope,
  targetId: string,
  orgId: string
): Promise<boolean> {
  const { data } = await supabase
    .from(TARGET_TABLE[scope])
    .select("id")
    .eq("id", targetId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return !!data;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const c = await ctx(url.searchParams.get("orgSlug") ?? undefined);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const scope = parseScope(url.searchParams.get("scope"));
  const targetId = url.searchParams.get("target_id") ?? "";
  if (!scope || !targetId) {
    return NextResponse.json({ error: "scope and target_id required" }, { status: 400 });
  }
  if (!(await targetInOrg(c.supabase, scope, targetId, c.orgId))) {
    return NextResponse.json({ error: "Target not found" }, { status: 404 });
  }
  const rule = await fetchScoringRule(c.supabase, scope, targetId);
  const effective = scope === "course" ? await resolvePolicy(c.supabase, targetId) : undefined;
  return NextResponse.json({ rule, effective });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    scope?: string;
    target_id?: string;
    max_scored_attempts?: number | string;
    official_basis?: string;
    official_attempt_number?: number | string | null;
    retain_first_attempt?: boolean;
    after_limit?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });

  const scope = parseScope(body.scope);
  const targetId = typeof body.target_id === "string" ? body.target_id : "";
  if (!scope || !targetId) {
    return NextResponse.json({ error: "scope and target_id required" }, { status: 400 });
  }
  if (!(await targetInOrg(c.supabase, scope, targetId, c.orgId))) {
    return NextResponse.json({ error: "Target not found" }, { status: 404 });
  }

  const max = Math.round(Number(body.max_scored_attempts ?? 3));
  if (!Number.isFinite(max) || max < 1 || max > 99) {
    return NextResponse.json(
      { error: "max_scored_attempts must be between 1 and 99" },
      { status: 400 }
    );
  }
  const basis = (body.official_basis ?? "first") as OfficialBasis;
  if (!BASES.includes(basis)) {
    return NextResponse.json(
      { error: `official_basis must be one of: ${BASES.join(", ")}` },
      { status: 400 }
    );
  }
  let nth: number | null = null;
  if (basis === "nth") {
    nth = Math.round(Number(body.official_attempt_number));
    if (!Number.isFinite(nth) || nth < 1 || nth > max) {
      return NextResponse.json(
        { error: `official_attempt_number must be between 1 and ${max}` },
        { status: 400 }
      );
    }
  }
  const after = (body.after_limit ?? "practice") as AfterLimit;
  if (!AFTER.includes(after)) {
    return NextResponse.json(
      { error: `after_limit must be one of: ${AFTER.join(", ")}` },
      { status: 400 }
    );
  }

  const { data, error } = await c.supabase
    .from("attempt_scoring_rules")
    .upsert(
      {
        organization_id: c.orgId,
        scope,
        target_id: targetId,
        max_scored_attempts: max,
        official_basis: basis,
        official_attempt_number: nth,
        retain_first_attempt: body.retain_first_attempt !== false,
        after_limit: after,
        updated_by: c.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "scope,target_id" }
    )
    .select("*")
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Could not save rule (is migration 0073 applied?)" },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, rule: data });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    scope?: string;
    target_id?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const scope = parseScope(body.scope);
  const targetId = typeof body.target_id === "string" ? body.target_id : "";
  if (!scope || !targetId) {
    return NextResponse.json({ error: "scope and target_id required" }, { status: 400 });
  }
  const { error } = await c.supabase
    .from("attempt_scoring_rules")
    .delete()
    .eq("organization_id", c.orgId)
    .eq("scope", scope)
    .eq("target_id", targetId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
