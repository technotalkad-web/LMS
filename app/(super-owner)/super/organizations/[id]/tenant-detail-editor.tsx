"use client";


import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Save, Mail, ShieldAlert, Send } from "lucide-react";

/** `setup_link`: "Send setup link again" is offered (ADR 0029, rule N12). */
type Admin = { user_id: string; role: string; status: string; email: string; setup_link?: boolean };

/** What the admins route says of the welcome email. */
type WelcomeOutcome = { status: "sent" } | { status: "not_sent"; class: string };

/** Why a welcome was not sent, by the platform sender's class. */
const WHY: Record<string, string> = {
  not_configured: "the platform sender is not configured",
  test_domain: "the address is a reserved test address",
  not_allowed: "the address is not on this environment's allow-list",
  ceiling: "the platform's daily email ceiling was reached",
  org_limit: "this organisation's daily platform email limit was reached",
  account_limit: "too many emails to this person today",
  log_unreadable: "the platform's email limits could not be read",
  timeout: "the mail server did not answer in time",
  auth: "the platform mailbox refused the sign-in",
  quota: "the platform mailbox's own sending limit was reached",
  unreachable: "the platform mail server could not be reached",
  rejected: "the receiving mailbox refused the message",
  unknown: "the mail server answered with an error",
};

const ROLE_LABEL: Record<string, string> = {
  super_owner: "Super owner",
  admin: "Admin",
  data_analyst: "Data analyst",
};

/** A row that is not active gives no access; adding the person again sets it active. */
const STATUS_LABEL: Record<string, string> = {
  inactive: "Inactive",
  suspended: "Suspended",
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
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(initial.name);
  const [domains, setDomains] = useState(initial.allowed_email_domains.join(", "));
  const [customDomain, setCustomDomain] = useState(initial.custom_domain ?? "");
  const [admins, setAdmins] = useState<Admin[]>(initialAdmins);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"super_owner" | "admin" | "data_analyst">("admin");
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  /** A setup link the answer returned because the welcome was not sent; shown once, until dismissed. */
  const [shownLink, setShownLink] = useState<{ url: string; mayHaveArrived: boolean; why: string } | null>(null);

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
      toast.error(j.error ?? "Failed");
      return;
    }
    setSavedMsg("Saved.");
    router.refresh();
    setTimeout(() => setSavedMsg(null), 3000);
  }

  /** The list again, with whether "Send setup link again" is offered for each person. */
  async function refreshAdmins() {
    const listRes = await fetch(`/api/super/tenants/${tenantId}/admins`);
    const listJson = await listRes.json().catch(() => ({}));
    if (listRes.ok && Array.isArray(listJson.admins)) setAdmins(listJson.admins);
  }

  useEffect(() => {
    void refreshAdmins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  /**
   * What the answer says of the welcome (ADR 0029, rule N8). The link is in
   * the answer only when the welcome was not sent; it is then shown once
   * here for the platform owner to pass on, and kept nowhere else.
   */
  function showWelcomeOutcome(j: { email_outcome?: WelcomeOutcome | null; setup_link?: string }) {
    const outcome = j.email_outcome;
    if (!outcome) return;
    if (outcome.status === "sent") {
      setShownLink(null);
      toast.success("Welcome email sent, with a link to set a password. It works once and expires in 7 days.");
      return;
    }
    if (j.setup_link) {
      setShownLink({ url: new URL(j.setup_link, window.location.origin).toString(), mayHaveArrived: outcome.class === "timeout", why: outcome.class });
      return;
    }
    setShownLink(null);
    if (outcome.class === "inactive") {
      toast.info("No welcome email was sent: this person's membership here does not count (the organisation is deleted, or the row is not active).");
    } else if (outcome.class === "link_failed") {
      toast.error("The account was added, but its setup link could not be saved, so no welcome email was sent. The person can choose \"Forgot password?\" on the sign-in page.");
    } else {
      toast.error(`No welcome email was sent (${WHY[outcome.class] ?? outcome.class}).`);
    }
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
      toast.error(j.error ?? "Failed");
      return;
    }
    const wasInvited = j.invited === true;
    const wasReactivated = j.reactivated === true;
    setNewEmail("");
    // Refresh admin list locally + server
    await refreshAdmins();
    router.refresh();
    if (wasInvited) {
      showWelcomeOutcome(j);
    } else if (wasReactivated) {
      toast.success("This person's membership was not active. It is active again, so they have access.");
    } else {
      toast.success("Added. This person already had an account and signs in as before; no email was sent.");
    }
  }

  async function sendSetupLinkAgain(admin: Admin) {
    setBusy(true);
    const res = await fetch(`/api/super/tenants/${tenantId}/admins`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: admin.user_id }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(j.error ?? "Failed");
      return;
    }
    showWelcomeOutcome(j);
    await refreshAdmins();
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
      toast.error(j.error ?? "Failed");
      return;
    }
    setAdmins(admins.map((a) => (a.user_id === admin.user_id ? { ...a, role } : a)));
    router.refresh();
  }

  async function removeAdmin(admin: Admin) {
    if (!await confirm(`Remove ${admin.email} from this organization?`)) return;
    setBusy(true);
    const res = await fetch(
      `/api/super/tenants/${tenantId}/admins?user_id=${admin.user_id}`,
      { method: "DELETE" }
    );
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as { error?: string; warnings?: string[] };
    if (!res.ok) {
      toast.error(j.error ?? "Failed");
      return;
    }
    // The removal stands; say so when their open course launches could not be closed.
    for (const w of j.warnings ?? []) toast.info(w);
    setAdmins(admins.filter((a) => a.user_id !== admin.user_id));
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Org details card */}
      <section className="bg-paper border border-line rounded-xl shadow-sm p-6">
        <h2 className="font-bold text-ink mb-4">Organization details</h2>
        <div className="space-y-4">
          <Field label="Workspace name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-line rounded-md px-3 py-2 text-sm"
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
              className="w-full border border-line rounded-md px-3 py-2 text-sm"
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
              className="w-full border border-line rounded-md px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <div className="mt-5 flex items-center justify-end gap-3">
          {savedMsg && <span className="text-sm text-emerald-600">{savedMsg}</span>}
          <button
            onClick={saveOrg}
            disabled={busy || !name.trim()}
            className="bg-ink text-canvas hover:opacity-90 px-4 py-2 rounded-md text-sm font-semibold flex items-center gap-1 disabled:opacity-60"
          >
            <Save className="w-4 h-4" /> Save changes
          </button>
        </div>
      </section>

      {/* Admins card */}
      <section className="bg-paper border border-line rounded-xl shadow-sm p-6">
        <h2 className="font-bold text-ink mb-4 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-accent" />
          Admins & data analysts
        </h2>

        {shownLink && (
          <div className="mb-4 border border-amber-200 bg-amber-50 text-amber-900 rounded-lg p-3 text-sm space-y-2">
            <p className="font-semibold">
              {shownLink.mayHaveArrived
                ? "The welcome email may have been sent: the mail server did not answer in time."
                : `The welcome email was not sent (${WHY[shownLink.why] ?? shownLink.why}).`}
            </p>
            <p>
              Pass this link to the person by another way. It lets them set their own password, works once and
              expires in 7 days. It is shown only now.
            </p>
            <div className="flex gap-2 items-center">
              <input
                readOnly
                value={shownLink.url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Setup link"
                className="flex-1 min-w-0 border border-amber-300 rounded-md px-2 py-1 text-xs font-mono bg-paper"
              />
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(shownLink.url).then(
                    () => toast.success("Link copied."),
                    () => toast.error("Could not copy; select the link and copy it.")
                  );
                }}
                className="px-2 py-1 border border-amber-300 rounded-md text-xs font-semibold bg-paper"
              >
                Copy
              </button>
              <button onClick={() => setShownLink(null)} className="px-2 py-1 text-xs underline">
                Done
              </button>
            </div>
          </div>
        )}

        {admins.length === 0 ? (
          <p className="text-sm text-muted mb-4">No admins yet. Add one below.</p>
        ) : (
          <ul className="divide-y divide-line mb-4">
            {admins.map((a) => (
              <li key={a.user_id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink truncate">
                    {a.email}
                    {a.status !== "active" && (
                      <span
                        className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wider text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                        title="No access while the membership is not active. Add this person again to make it active."
                      >
                        {STATUS_LABEL[a.status] ?? a.status ?? "Unknown"}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted font-mono truncate">{a.user_id}</p>
                </div>
                <div className="flex items-center gap-2">
                  {a.setup_link && (
                    <button
                      onClick={() => sendSetupLinkAgain(a)}
                      disabled={busy}
                      className="px-2 py-1 border border-line rounded-md text-xs font-semibold text-ink hover:bg-canvas flex items-center gap-1 disabled:opacity-60"
                      title="This person has not set a password yet. Email them a new link; the older one stops working."
                    >
                      <Send className="w-3.5 h-3.5" /> Send setup link again
                    </button>
                  )}
                  <select
                    value={a.role}
                    onChange={(e) => changeRole(a, e.target.value)}
                    disabled={busy}
                    aria-label={`Change role for ${a.email}`}
                    className="border border-line rounded-md px-2 py-1 text-xs bg-paper"
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
                    className="p-1.5 text-muted hover:text-red-600 transition"
                    title="Remove from organization"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-line pt-4">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            Add admin
          </p>
          <div className="flex gap-2 flex-wrap">
            <div className="flex-1 min-w-[200px] relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input
                type="email"
                placeholder="user@acme.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-line rounded-md text-sm"
              />
            </div>
            <select
              value={newRole}
              onChange={(e) =>
                setNewRole(e.target.value as "super_owner" | "admin" | "data_analyst")
              }
              aria-label="Role for new admin"
              className="border border-line rounded-md px-3 py-2 text-sm bg-paper"
            >
              <option value="admin">Admin</option>
              <option value="super_owner">Super owner</option>
              <option value="data_analyst">Data analyst</option>
            </select>
            <button
              onClick={addAdmin}
              disabled={busy || !newEmail.trim()}
              className="bg-ink text-canvas hover:opacity-90 px-4 py-2 rounded-md text-sm font-semibold flex items-center gap-1 disabled:opacity-60"
            >
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
          <p className="text-xs text-muted mt-2">
            If the email has no account yet, one is created without a password and the person is emailed a link
            to set their own (it works once and expires in 7 days). An existing account is added as it is, and no
            email is sent.
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
      <span className="text-sm font-semibold text-ink">{label}</span>
      {hint && <span className="block text-xs text-muted mt-0.5 mb-1.5">{hint}</span>}
      {!hint && <span className="block mb-1.5" />}
      {children}
    </label>
  );
}

