import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { loadReportingLines } from "@/lib/org/reporting-lines-data";
import { ReportingLinesClient } from "./reporting-lines-client";

export const dynamic = "force-dynamic";

/**
 * Master data → Reporting lines (migration 0091). Super-Owner-only view of
 * the explicit Employee → L1 → L2 → L3 hierarchy: integrity check, backfill
 * suggestions and a per-person editor. Same rules as every other write path
 * (lib/org/reporting-line.ts).
 */
export default async function ReportingLinesPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (role !== "super_owner") redirect(`/${orgSlug}/users?denied=1`);

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const initial = await loadReportingLines(svc, org.id);

  return (
    <div className="max-w-5xl">
      <Link
        href={`/${orgSlug}/master-data`}
        className="text-muted text-sm hover:text-ink transition-colors"
      >
        ← Master data
      </Link>
      <h1 className="serif text-5xl mt-2 mb-2">Reporting lines</h1>
      <p className="text-muted text-sm max-w-2xl mb-8">
        Employee → L1 → L2 → L3. The hierarchy is explicit — nothing is
        inferred — and it decides what each manager can see: exactly the
        people who list them as L1, L2 or L3.
      </p>
      <ReportingLinesClient orgSlug={orgSlug} initial={initial} />
    </div>
  );
}
