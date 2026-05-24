import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { Mail } from "lucide-react";
import {
  AdminPageHeader,
  Card,
  EmptyState,
  StatusPill,
} from "@/components/admin";
import {
  BroadcastClient,
  type RecipientUser,
  type RecipientTeam,
  type RecipientCourse,
  type RecipientPath,
} from "./broadcast-client";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({
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
  const { data: memberRows } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id);
  const memberIds = (memberRows ?? []).map((m) => m.user_id);

  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name")
    .eq("organization_id", org.id);
  const teams = (teamRows ?? []) as RecipientTeam[];

  const { data: courseRows } = await supabase
    .from("courses")
    .select("id, title")
    .eq("organization_id", org.id)
    .order("title");
  const courses = (courseRows ?? []) as RecipientCourse[];

  const { data: pathRows } = await supabase
    .from("learning_paths")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name");
  const paths = (pathRows ?? []) as RecipientPath[];

  const emailById = new Map<string, string>();
  if (memberIds.length > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1500 });
    for (const u of data?.users ?? []) {
      if (u.email && memberIds.includes(u.id)) emailById.set(u.id, u.email);
    }
  }
  const users: RecipientUser[] = memberIds.map((id) => ({
    user_id: id,
    email: emailById.get(id) ?? id.slice(0, 8),
  }));
  users.sort((a, b) => a.email.localeCompare(b.email));

  const { data: logRows } = await supabase
    .from("notification_log")
    .select("to_address, subject, status, error, sent_at")
    .eq("organization_id", org.id)
    .eq("event_type", "custom_broadcast")
    .order("sent_at", { ascending: false })
    .limit(20);

  type LogRow = {
    to_address?: string;
    subject?: string;
    status?: string;
    error?: string;
    sent_at?: string;
  };
  const logs = (logRows ?? []) as LogRow[];

  return (
    <div>
      <AdminPageHeader
        title="Broadcast"
        description={`Send a one-off email to a selected audience in ${org.name}.`}
      />

      <BroadcastClient
        orgSlug={orgSlug}
        users={users}
        teams={teams}
        courses={courses}
        paths={paths}
      />

      <h2 className="serif text-xl mt-10 mb-3 text-ink">Recent broadcasts</h2>
      {logs.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={<Mail className="w-5 h-5" />}
            title="No broadcasts yet"
            description="Once you send your first broadcast, deliveries will appear here."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">When</th>
                <th className="text-left px-4 py-2 font-medium">To</th>
                <th className="text-left px-4 py-2 font-medium">Subject</th>
                <th className="text-left px-4 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {logs.map((l, i) => (
                <tr key={i} className="hover:bg-canvas/50">
                  <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">
                    {l.sent_at
                      ? new Date(l.sent_at)
                          .toISOString()
                          .slice(0, 16)
                          .replace("T", " ")
                      : ""}
                  </td>
                  <td className="px-4 py-3 text-xs">{l.to_address}</td>
                  <td className="px-4 py-3">{l.subject}</td>
                  <td className="px-4 py-3 text-xs">
                    {l.status === "sent" ? (
                      <StatusPill tone="success">Sent</StatusPill>
                    ) : (
                      <span title={l.error ?? undefined}>
                        <StatusPill tone="suspended">
                          {l.status ?? "failed"}
                        </StatusPill>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
