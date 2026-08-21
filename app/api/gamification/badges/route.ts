import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/gamification/badges
 *   body: { orgSlug, name, description?, icon?, criteria_type, threshold?, slug? }
 *
 * Creates an ORG badge (or an org override of a global badge when the slug
 * matches a global one). Authorization is RLS: the org-badge policy only lets
 * admins write rows for their own org.
 */

const CRITERIA = [
  "perfect_score",
  "streak_days",
  "courses_completed",
  "assessments_passed",
  "completion_speed",
  "manual",
] as const;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    slug?: string;
    name?: string;
    description?: string;
    icon?: string;
    criteria_type?: string;
    threshold?: number | null;
  };
  if (!body.orgSlug || !body.name?.trim() || !body.criteria_type) {
    return NextResponse.json(
      { error: "orgSlug, name and criteria_type required" },
      { status: 400 }
    );
  }
  if (!CRITERIA.includes(body.criteria_type as (typeof CRITERIA)[number])) {
    return NextResponse.json(
      { error: `criteria_type must be one of: ${CRITERIA.join(", ")}` },
      { status: 400 }
    );
  }
  if (
    body.threshold !== undefined &&
    body.threshold !== null &&
    (typeof body.threshold !== "number" || body.threshold <= 0)
  ) {
    return NextResponse.json(
      { error: "threshold must be a positive number" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("gamification_badges")
    .insert({
      organization_id: org.id,
      slug: body.slug?.trim() || slugify(body.name),
      name: body.name.trim(),
      description: body.description?.trim() || null,
      icon: body.icon?.trim() || "🏅",
      criteria_type: body.criteria_type,
      threshold: body.threshold ?? null,
    })
    .select("*")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ badge: data });
}
