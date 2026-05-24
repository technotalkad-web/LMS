import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { TicketsInbox, type Ticket } from "./tickets-inbox";

export const dynamic = "force-dynamic";

export default async function TicketsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("help_tickets")
    .select(
      "id, user_id, subject, body, status, priority, admin_note, created_at, updated_at"
    )
    .eq("organization_id", org.id)
    .order("created_at", { ascending: false });

  const raw = (rows ?? []) as Array<
    Omit<Ticket, "email"> & { user_id: string }
  >;
  const userIds = Array.from(new Set(raw.map((r) => r.user_id)));
  const emailByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1500 });
    for (const u of data?.users ?? []) {
      if (u.email && userIds.includes(u.id)) emailByUser.set(u.id, u.email);
    }
  }
  const tickets: Ticket[] = raw.map((r) => ({
    ...r,
    email: emailByUser.get(r.user_id) ?? r.user_id.slice(0, 8),
  }));

  return <TicketsInbox tickets={tickets} orgName={org.name} />;
}
