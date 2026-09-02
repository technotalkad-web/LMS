import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { courseDaysOf } from "@/lib/journey/journey";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/**
 * Completion certificate for the learner's own finished Yoddha Journey.
 * Everything on it comes from the enrollment's pinned version + the org's
 * branding — nothing hard-coded. Print-friendly: the app chrome is hidden
 * under @media print so the browser's Save-as-PDF produces a clean A4/
 * letter certificate at zero server cost.
 */
export default async function JourneyCertificatePage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { user, org } = await requireOrgAccess(orgSlug);
  const supabase = await createClient();

  const { data: enrRows } = await supabase
    .from("journey_enrollments")
    .select(
      "id, completed_at, start_date, journey_versions!inner(name, icon, days_total, completion_title, days)"
    )
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1);
  const enrollment = (enrRows ?? [])[0] as
    | {
        id: string;
        completed_at: string | null;
        start_date: string;
        journey_versions:
          | { name: string; icon: string; days_total: number; completion_title: string; days: unknown }
          | Array<{ name: string; icon: string; days_total: number; completion_title: string; days: unknown }>;
      }
    | undefined;
  if (!enrollment) redirect(`/${orgSlug}/journey`);

  const version = Array.isArray(enrollment.journey_versions)
    ? enrollment.journey_versions[0]
    : enrollment.journey_versions;
  const missions = courseDaysOf(version.days, version.days_total).length;

  const { data: prof } = await supabase
    .from("profiles")
    .select("first_name, last_name, email")
    .eq("id", user.id)
    .maybeSingle();
  const p = prof as {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  } | null;
  const learnerName =
    [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim() ||
    (p?.email ?? user.email ?? "").split("@")[0];

  const completedOn = enrollment.completed_at
    ? new Date(enrollment.completed_at).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";
  const brand =
    ((org as { brand_color?: string | null }).brand_color as string | null) ||
    "#4f46e5";
  const logo = (org as { logo_url?: string | null }).logo_url ?? null;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Hide the app chrome when printing — only the certificate remains. */}
      <style>{`
        @media print {
          header, nav, footer, .print\\:hidden { display: none !important; }
          body { background: white !important; }
          main { padding: 0 !important; max-width: none !important; }
        }
      `}</style>

      <section
        className="relative bg-white text-slate-900 border-8 rounded-md px-8 sm:px-14 py-12 text-center shadow-lg print:shadow-none"
        style={{ borderColor: brand }}
      >
        <div
          className="absolute inset-3 border pointer-events-none"
          style={{ borderColor: brand, opacity: 0.35 }}
          aria-hidden
        />

        {logo ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={logo} alt={org.name} className="h-12 mx-auto object-contain" />
        ) : (
          <p className="text-lg font-bold tracking-wide" style={{ color: brand }}>
            {org.name}
          </p>
        )}

        <p className="mt-6 text-[11px] uppercase tracking-[0.35em] text-slate-500 font-semibold">
          Certificate of Completion
        </p>
        <div className="text-5xl mt-4" aria-hidden>
          {version.icon}
        </div>

        <p className="mt-6 text-sm text-slate-500">This certifies that</p>
        <h1 className="serif text-4xl sm:text-5xl mt-1" style={{ color: brand }}>
          {learnerName}
        </h1>

        <p className="mt-5 text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
          has successfully completed the{" "}
          <strong className="text-slate-900">{version.name}</strong> —{" "}
          {missions} learning mission{missions === 1 ? "" : "s"} across{" "}
          {version.days_total} days — and has earned the title of
        </p>
        <p
          className="mt-3 text-2xl sm:text-3xl font-extrabold tracking-wide uppercase"
          style={{ color: brand }}
        >
          {version.completion_title}
        </p>

        <div className="mt-10 flex items-end justify-between text-left text-xs text-slate-500">
          <div>
            <p className="border-t border-slate-300 pt-1.5 pr-8">
              Completed on
              <span className="block text-slate-800 font-medium text-sm">
                {completedOn || "—"}
              </span>
            </p>
          </div>
          <div className="text-right">
            <p className="border-t border-slate-300 pt-1.5 pl-8">
              Issued by
              <span className="block text-slate-800 font-medium text-sm">
                {org.name}
              </span>
            </p>
          </div>
        </div>
      </section>

      <div className="flex items-center justify-center gap-3 print:hidden">
        <PrintButton />
        <Link
          href={`/${orgSlug}/journey`}
          className="px-4 py-2.5 border border-line rounded-lg text-sm hover:border-ink"
        >
          Back to journey
        </Link>
      </div>
    </div>
  );
}
