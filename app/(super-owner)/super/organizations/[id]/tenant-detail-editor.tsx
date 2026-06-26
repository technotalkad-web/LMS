"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Save, Mail, ShieldAlert } from "lucide-react";

type Admin = { user_id: string; role: string; email: string };

const ROLE_LABEL: Record<string, string> = {
  super_owner: "Super owner",
  admin: "Admin",
  data_analyst: "Data analyst",
};

export function TenantDetailEditor({
  tenantId,
  initial,
  initialAdmins,
}: {
  tenantId: string;
  initial: {
    name: string;
    allowed_email_domains: string[];
    custom_domain: string | null;
  };
  initialAdmins: Admin[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [domains, setDomains] = useState(initial.allowed_email_domains.join(", "));
  const [customDomain, setCustomDomain] = useState(initial.custom_domain ?? "");
  const [admins, setAdmins] = useState<Admin[]>(initialAdmins);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"super_owner" | "admin" | "data_analyst">("admin");
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  async function saveOrg() {
    setBusy(true);
    setSavedMsg(null);
    const res = await fetch(`/api/super/tenants/${tenantId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update_org",
        name: name.trim(),
        allowed_email_domains: domains
          .split(",")
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
        custom_domain: customDomain.trim() || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    setSavedMsg("Saved.");
    router.refresh();
    setTimeout(() => setSavedMsg(null), 3000);
  }

  async function addAdmin() {
    if (!newEmail.trim()) return;
    setBusy(true);
    const res = await fetch(`/api/super/tenants/${tenantId}/admins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: newEmail.trim().toLowerCase(), role: newRole }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(j.error ?? "Failed");
      return;
    }
    const wasInvited = j.invited;
    setNewEmail("");
    // Refresh admin list locally + server
    const listRes = await fetch(`/api/super/tenants/${tenantId}/admins`);
    const listJson = await listRes.json().catch(() => ({}));
    setAdmins(listJson.admins ?? []);
    router.refresh();
    if (wasInvited) {
      alert(
        "User didn't exist — a magic-link invitation has been emailed. They'll set their password on first sign-in."
      );
    }
  }

  async function changeRole(admin: Admin, role: string) {
    if (role === admin.role) return;
    setBusy(true);
    const res = await fetch(`/api/super/tenants/${tenantId}/admins`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: admin.user_id, role }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    setAdmins(admins.map((a) => (a.user_id === admin.user_id ? { ...a, role } : a)));
    router.refresh();
  }

  async function removeAdmin(admin: Admin) {
    if (!confirm(`Remove ${admin.email} from this organization?`)) return;
    setBusy(true);
    const res = await fetch(
      `/api/super/tenants/${tenantId}/admins?user_id=${admin.user_id}`,
      { method: "DELETE" }
    );
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    setAdmins(admins.filter((a) => a.user_id !== admin.user_id));
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Org details card */}
      <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
        <h2 className="font-bold text-slate-900 mb-4">Organization details</h2>
        <div className="space-y-4">
          <Field label="Workspace name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </Field>
          <Field
            label="Allowed email domains"
            hint="Comma-separated. Leave blank to allow any. Used on user-invite + new-user creation."
          >
            <input
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="acme.com, acme.co.uk"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </Field>
          <Field
            label="Custom domain"
            hint="If set, the tenant's branded login will live at this domain (Pro/Enterprise feature)."
          >
            <input
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value)}
              placeholder="learn.acme.com"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <div className="mt-5 flex items-center justify-end gap-3">
          {savedMsg && <span className="text-sm text-emerald-600">{savedMsg}</span>}
          <button
            onClick={saveOrg}
            disabled={busy || !name.trim()}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-sm font-semibold flex items-center gap-1 disabled:opacity-60"
          >
            <Save className="w-4 h-4" /> Save changes
          </button>
        </div>
      </section>

      {/* Admins card */}
      <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
        <h2 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-indigo-600" />
          Admins & data analysts
        </h2>

        {admins.length === 0 ? (
          <p className="text-sm text-slate-500 mb-4">No admins yet. Add one below.</p>
        ) : (
          <ul className="divide-y divide-slate-100 mb-4">
            {admins.map((a) => (
              <li key={a.user_id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">{a.email}</p>
                  <p className="text-xs text-slate-400 font-mono truncate">{a.user_id}</p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={a.role}
                    onChange={(e) => changeRole(a, e.target.value)}
                    disabled={busy}
                    aria-label={`Change role for ${a.email}`}
                    className="border border-slate-300 rounded-md px-2 py-1 text-xs bg-white"
                  >
                    {Object.entries(ROLE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeAdmin(a)}
                    disabled={busy}
                    className="p-1.5 text-slate-400 hover:text-red-600 transition"
                    title="Remove from organization"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-slate-100 pt-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
            Add admin
          </p>
          <div className="flex gap-2 flex-wrap">
            <div className="flex-1 min-w-[200px] relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="email"
                placeholder="user@acme.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-md text-sm"
              />
            </div>
            <select
              value={newRole}
              onChange={(e) =>
                setNewRole(e.target.value as "super_owner" | "admin" | "data_analyst")
              }
              aria-label="Role for new admin"
              className="border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
            >
              <option value="admin">Admin</option>
              <option value="super_owner">Super owner</option>
              <option value="data_analyst">Data analyst</option>
            </select>
            <button
              onClick={addAdmin}
              disabled={busy || !newEmail.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-sm font-semibold flex items-center gap-1 disabled:opacity-60"
            >
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            If the email doesn&apos;t already have an account, a magic-link invitation is emailed.
          </p>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-slate-700">{label}</span>
      {hint && <span className="block text-xs text-slate-500 mt-0.5 mb-1.5">{hint}</span>}
      {!hint && <span className="block mb-1.5" />}
      {children}
    </label>
  );
}

