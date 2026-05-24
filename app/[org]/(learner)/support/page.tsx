import { LifeBuoy } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { SupportClient, type LearnerTicket } from "./support-client";

export const dynamic = "force-dynamic";

export default async function SupportPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { user, org } = await requireOrgAccess(orgSlug);

  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("help_tickets")
    .select(
      "id, subject, body, status, priority, admin_note, created_at, updated_at"
    )
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const tickets = (rows ?? []) as LearnerTicket[];

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-indigo-100 text-indigo-600 mb-4">
          <LifeBuoy className="w-8 h-8" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
          How can we help?
        </h1>
        <p className="text-muted mt-2 text-sm">
          Open a ticket and a {org.name} admin will get back to you.
        </p>
      </div>

      <SupportClient orgSlug={orgSlug} tickets={tickets} />
    </div>
  );
}
