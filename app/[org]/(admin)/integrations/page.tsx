import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { AdminPageHeader } from "@/components/admin";
import { IntegrationsClient, type ApiKeyRow } from "./integrations-client";

/**
 * CRM & API integrations (0071) — Super Owner only. API keys for the CRM
 * backend, the completion webhook, and the endpoint cheat-sheet the CRM
 * team needs. The keys themselves are shown once at creation and never
 * again (only prefixes are stored for display).
 */
export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!["super_owner", "owner"].includes(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const supabase = await createClient();
  let keys: ApiKeyRow[] = [];
  let webhookUrl: string | null = null;
  try {
    const [{ data: keyRows }, { data: settings }] = await Promise.all([
      supabase
        .from("org_api_keys")
        .select("id, name, key_prefix, is_active, created_at, last_used_at")
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("org_integration_settings")
        .select("webhook_url")
        .eq("organization_id", org.id)
        .maybeSingle(),
    ]);
    keys = (keyRows ?? []) as ApiKeyRow[];
    webhookUrl = (settings as { webhook_url?: string | null } | null)?.webhook_url ?? null;
  } catch {
    // pre-0071 database — the client shows the migration hint on first write
  }

  return (
    <div>
      <AdminPageHeader
        title="CRM & API"
        description="Connect your in-house CRM: machine keys for its backend, single-click sign-in for employees, and completion webhooks back to the employee record."
      />
      <IntegrationsClient orgSlug={orgSlug} initialKeys={keys} initialWebhookUrl={webhookUrl} />
    </div>
  );
}
