import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { collectAttention } from "@/lib/attention/collect";
import { ATTENTION_PROVIDERS, effectiveConfig } from "@/lib/attention/types";
import { AttentionCenter } from "./attention-center";

export const dynamic = "force-dynamic";

export default async function AttentionPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Config + dismissals — fail-soft before 0086 lands.
  let settingsRow: { enabled?: boolean | null; config?: Record<string, { enabled?: boolean; priority?: string }> | null } | null = null;
  try {
    const { data } = await svc.from("attention_settings").select("enabled, config").eq("organization_id", org.id).maybeSingle();
    settingsRow = data as typeof settingsRow;
  } catch {
    /* pre-0086 */
  }
  const dismissals = new Map<string, string>();
  try {
    const { data } = await svc.from("attention_dismissals").select("item_key, dismissed_at").eq("organization_id", org.id);
    for (const d of (data ?? []) as Array<{ item_key: string; dismissed_at: string }>) dismissals.set(d.item_key, d.dismissed_at);
  } catch {
    /* pre-0086 */
  }

  const { items, byPriority, total } = await collectAttention({
    svc,
    orgId: org.id,
    orgSlug,
    settings: settingsRow,
    dismissals,
  });

  const eff = effectiveConfig(settingsRow);

  return (
    <AttentionCenter
      orgSlug={orgSlug}
      orgName={org.name}
      items={items}
      byPriority={byPriority}
      total={total}
      providers={ATTENTION_PROVIDERS}
      masterEnabled={eff.masterEnabled}
      config={eff.byType}
    />
  );
}
