import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { loadFieldOptionRows } from "@/lib/org/field-options";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadScopes, type ContentScopes, type ContentType } from "@/lib/content/scopes";
import { ContentMappingClient, type MappingRow } from "./content-mapping-client";

export const dynamic = "force-dynamic";

/**
 * Master data → Content mapping (0096, addendum §5): every active course,
 * learning path and journey with the Vertical + Department pairs it belongs
 * to; filter to the unmapped ones and map them one by one or in bulk.
 * Admin-controlled (not Super-Owner-only like the value lists).
 */
export default async function ContentMappingPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) redirect(`/${orgSlug}/dashboard?denied=1`);

  const supabase = await createClient();
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const [{ data: courses }, { data: paths }, { data: journeys }, { data: optRows }] = await Promise.all([
    supabase.from("courses").select("id, title, is_active").eq("organization_id", org.id).order("title"),
    supabase.from("learning_paths").select("id, name, is_active").eq("organization_id", org.id).order("name"),
    supabase.from("journey_programs").select("id, name, is_active").eq("organization_id", org.id).order("name"),
    loadFieldOptionRows(supabase, org.id).then((rows) => ({ data: rows })),
  ]);
  const items: Array<{ type: ContentType; id: string; title: string; active: boolean }> = [
    ...((courses ?? []) as Array<{ id: string; title: string; is_active: boolean | null }>).map((c) => ({ type: "course" as const, id: c.id, title: c.title, active: c.is_active !== false })),
    ...((paths ?? []) as Array<{ id: string; name: string; is_active: boolean | null }>).map((p) => ({ type: "path" as const, id: p.id, title: p.name, active: p.is_active !== false })),
    ...((journeys ?? []) as Array<{ id: string; name: string; is_active: boolean | null }>).map((j) => ({ type: "journey" as const, id: j.id, title: j.name, active: j.is_active !== false })),
  ];
  const scopes = await loadScopes(svc, org.id, items);
  const rows: MappingRow[] = items.map((it) => ({ ...it, scopes: scopes.get(`${it.type}:${it.id}`) ?? ({ common: false, pairs: [] } as ContentScopes) }));

  const opts = (optRows ?? []) as Array<{ id: string; field: string; value: string; parent_id?: string | null }>;
  const verticalById = new Map(opts.filter((o) => o.field === "business_vertical").map((o) => [o.id, o.value]));
  const departmentsByVertical: Record<string, string[]> = {};
  for (const o of opts) {
    if (o.field !== "department" || !o.parent_id) continue;
    const v = verticalById.get(o.parent_id);
    if (v) (departmentsByVertical[v] ??= []).push(o.value);
  }
  const options = { verticals: [...verticalById.values()].sort(), departmentsByVertical };

  return (
    <div className="max-w-5xl space-y-6">
      <Link href={`/${orgSlug}/master-data`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="w-4 h-4" /> Master data
      </Link>
      <header>
        <h1 className="serif text-5xl mb-2">Content mapping</h1>
        <p className="text-muted text-sm max-w-2xl">
          Where each course, learning path and journey <strong>belongs</strong>: one or more Business Vertical + Department pairs, a whole vertical, or common to all.
          Mapping does not assign or unlock anything. Managers see content only when it is mapped to their vertical and department <em>and</em> assigned to people in their reporting line.
        </p>
      </header>
      <ContentMappingClient orgSlug={orgSlug} rows={rows} options={options} />
    </div>
  );
}
