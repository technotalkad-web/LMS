import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { departmentsByVerticalOf, loadFieldOptionRows } from "@/lib/org/field-options";
import { listManagers, loadCoverageRows } from "@/lib/manager/coverage";
import { namesAndEmails } from "@/lib/users/people";
import { ManagerCoverageClient, type ManagerRow } from "./manager-coverage-client";

export const dynamic = "force-dynamic";

/**
 * Master data → Manager coverage (0097, decision 14): every manager with the
 * vertical + department from their own record and the extra pairs an admin
 * has granted; the org's "enforce content mapping" switch lives on Master data.
 */
export default async function ManagerCoveragePage({ params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) redirect(`/${orgSlug}/dashboard?denied=1`);
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const managers = await listManagers(svc, org.id);
  const ids = managers.map((m) => m.user_id);
  const [people, coverage, rows, { data: orgRow }] = await Promise.all([
    namesAndEmails(svc, ids),
    loadCoverageRows(svc, org.id, ids),
    loadFieldOptionRows(svc, org.id),
    svc.from("organizations").select("enforce_content_mapping").eq("id", org.id).maybeSingle(),
  ]);
  const list: ManagerRow[] = managers
    .map((m) => ({ user_id: m.user_id, name: people.get(m.user_id)?.name ?? m.user_id.slice(0, 8), vertical: m.vertical, department: m.department, coverage: coverage.get(m.user_id) ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const verticals = rows.filter((r) => r.field === "business_vertical").map((r) => r.value).sort();
  const options = { verticals, departmentsByVertical: departmentsByVerticalOf(rows) };
  const enforce = (orgRow as { enforce_content_mapping?: boolean } | null)?.enforce_content_mapping === true;
  return (
    <div className="max-w-4xl space-y-6">
      <Link href={`/${orgSlug}/master-data`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="w-4 h-4" /> Master data
      </Link>
      <header>
        <h1 className="serif text-5xl mb-2">Manager coverage</h1>
        <p className="text-muted text-sm max-w-2xl">
          A manager sees learning content only when it belongs to their Business Vertical + Department <em>and</em> is assigned to someone in their reporting line.
          The vertical and department come from the manager&apos;s own employee record; grant extra pairs here for a head whose hierarchy spans verticals.
          {enforce ? " Unmapped content is hidden from managers (enforcement on)." : " Unmapped content is still visible to managers until enforcement is switched on in Master data."}
        </p>
      </header>
      <ManagerCoverageClient orgSlug={orgSlug} managers={list} options={options} />
    </div>
  );
}
