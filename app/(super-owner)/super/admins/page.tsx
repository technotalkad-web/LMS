import { createClient as createServiceClient } from "@supabase/supabase-js";
import { ShieldAlert } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SuperAdminsPage() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: rows } = await svc
    .from("platform_owners")
    .select("user_id, added_at, note");
  const owners = (rows ?? []) as Array<{
    user_id: string;
    added_at: string;
    note: string | null;
  }>;

  const emailById = new Map<string, string>();
  if (owners.length > 0) {
    const { data: listed } = await svc.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    for (const u of listed?.users ?? []) {
      if (u.email) emailById.set(u.id, u.email);
    }
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
          <ShieldAlert className="w-7 h-7 text-emerald-500" /> Super Admins
        </h1>
        <p className="text-slate-500 mt-1">
          Users with platform-level access. They can see every tenant,
          impersonate org admins, and schedule deletions. Be sparing.
        </p>
      </header>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {owners.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm">
            No platform owners yet. Bootstrap one via SQL:
            <pre className="mt-3 inline-block text-left bg-slate-100 px-4 py-3 rounded-lg font-mono text-xs">
{`insert into public.platform_owners (user_id, note)
values ('<your auth.users.id>', 'bootstrap');`}
            </pre>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">
                  Email
                </th>
                <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">
                  Added
                </th>
                <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">
                  Note
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {owners.map((o) => (
                <tr key={o.user_id} className="hover:bg-slate-50">
                  <td className="px-6 py-3">
                    <p className="font-medium">
                      {emailById.get(o.user_id) ?? o.user_id.slice(0, 8)}
                    </p>
                    <p className="font-mono text-xs text-slate-400 mt-0.5">
                      {o.user_id}
                    </p>
                  </td>
                  <td className="px-6 py-3 text-xs text-slate-500 whitespace-nowrap">
                    {new Date(o.added_at).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-6 py-3 text-xs text-slate-600">
                    {o.note ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-6 border border-amber-200 bg-amber-50 text-amber-900 rounded-xl p-4 text-sm">
        <strong>Phase 10b queued:</strong> add-owner form, MFA enforcement,
        IP allowlist. For now, manage via SQL — that's intentional friction
        for an extremely high-privilege role.
      </div>
    </div>
  );
}
