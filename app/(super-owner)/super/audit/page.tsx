import { createClient as createServiceClient } from "@supabase/supabase-js";
import { Activity } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AuditLogPage() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: rows } = await svc
    .from("platform_audit_log")
    .select("id, action, target_type, target_id, metadata, actor_user_id, at")
    .order("at", { ascending: false })
    .limit(200);

  // Resolve actor emails (best-effort).
  const actorIds = Array.from(
    new Set(
      ((rows ?? []) as Array<{ actor_user_id: string | null }>)
        .map((r) => r.actor_user_id)
        .filter((id): id is string => !!id)
    )
  );
  const emailById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: listed } = await svc.auth.admin.listUsers({
      page: 1,
      perPage: 1500,
    });
    for (const u of listed?.users ?? []) {
      if (u.email && actorIds.includes(u.id)) emailById.set(u.id, u.email);
    }
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
          <Activity className="w-7 h-7 text-indigo-600" /> System Audit Logs
        </h1>
        <p className="text-slate-500 mt-1">
          Every platform-owner action (suspend, restore, delete, plan
          change, impersonate) is recorded here.
        </p>
      </header>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {(rows ?? []).length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm">
            No audit events yet.
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">
                  When
                </th>
                <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">
                  Actor
                </th>
                <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">
                  Action
                </th>
                <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">
                  Target
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(rows ?? []).map((r) => {
                const row = r as {
                  id: string;
                  action: string;
                  target_type: string | null;
                  target_id: string | null;
                  actor_user_id: string | null;
                  at: string;
                };
                return (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {new Date(row.at).toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="px-6 py-3 text-xs">
                      {row.actor_user_id
                        ? emailById.get(row.actor_user_id) ??
                          row.actor_user_id.slice(0, 8)
                        : "system"}
                    </td>
                    <td className="px-6 py-3 font-mono text-xs">{row.action}</td>
                    <td className="px-6 py-3 text-xs font-mono text-slate-600">
                      {row.target_type
                        ? `${row.target_type}:${row.target_id?.slice(0, 8) ?? ""}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
