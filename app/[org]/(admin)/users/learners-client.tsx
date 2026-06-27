"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { roleLabel } from "@/lib/auth/permissions";
import {
  UserFilters,
  readUserFilters,
  type TeamOption,
} from "./user-filters";
import {
  Users as UsersIcon,
  UserPlus,
  Upload,
  Mail,
  Send,
  ShieldCheck,
  ShieldAlert,
  GraduationCap,
  BarChart3,
  Copy,
  Trash2,
  Pencil,
  Search,
  FileText,
  CheckCircle2,
  Download,
  X,
} from "lucide-react";

type InviteRole = "user" | "data_analyst" | "admin";

type Member = {
  user_id: string;
  role: OrgRole;
  joined_at: string;
  email: string;
  // New for v0 filter strip (#163). Other 9 filter dimensions deferred.
  status: "active" | "inactive" | "suspended";
  teamIds: string[];
};

type Invitation = {
  id: string;
  email: string;
  role: OrgRole;
  token: string;
  invited_at: string;
  expires_at: string;
};

type Tab = "members" | "invitations" | "invite" | "bulk";

export function LearnersClient({
  orgSlug,
  orgName,
  currentUserId,
  currentUserRole,
  members,
  teams,
  invitations,
  shareBase,
}: {
  orgSlug: string;
  orgName: string;
  currentUserId: string;
  currentUserRole: OrgRole;
  members: Member[];
  teams: TeamOption[];
  invitations: Invitation[];
  shareBase: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("members");

  // Invite single
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastShared, setLastShared] = useState<string | null>(null);

  // Bulk
  const [bulkCsv, setBulkCsv] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkFileName, setBulkFileName] = useState("");
  const [bulkSummary, setBulkSummary] = useState<{
    summary?: {
      total: number;
      created?: number;
      invited?: number;
      updated?: number;
      skipped: number;
      errored: number;
    };
    results?: Array<{ row: number; email: string; status: string; message?: string }>;
  } | null>(null);

  // Member search
  const [query, setQuery] = useState("");

  /* ---------- API actions ---------- */
  async function createInvitation(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLastShared(null);
    const res = await fetch("/api/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        email: inviteEmail.trim(),
        role: inviteRole,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      shareUrl?: string;
      error?: string;
    };
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Could not create invitation");
      return;
    }
    setInviteEmail("");
    setLastShared(json.shareUrl ?? null);
    router.refresh();
  }

  async function bulkInvite() {
    if (!bulkCsv.trim()) return;
    setBulkBusy(true);
    setBulkSummary(null);
    const res = await fetch("/api/users/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, csv: bulkCsv }),
    });
    setBulkBusy(false);
    const json = await res.json().catch(() => ({}));
    setBulkSummary(json);
    const s = json?.summary;
    if (s && ((s.created ?? 0) + (s.invited ?? 0) + (s.updated ?? 0)) > 0) {
      router.refresh();
    }
  }

  async function onBulkFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBulkFileName(f.name);
    const text = await f.text();
    setBulkCsv(text);
  }

  async function changeRole(userId: string, role: string) {
    const res = await fetch(
      `/api/organization-members/${userId}?orgSlug=${orgSlug}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      }
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function removeMember(userId: string) {
    if (!(await confirm({ message: "Remove this member from the org?", destructive: true }))) return;
    const res = await fetch(
      `/api/organization-members/${userId}?orgSlug=${orgSlug}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function revokeInvite(id: string) {
    if (!(await confirm({ message: "Revoke this invitation?", destructive: true }))) return;
    const res = await fetch(`/api/invitations/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function copyShareUrl(token: string) {
    const url = `${shareBase}/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Copied invitation link to clipboard");
    } catch {
      window.prompt("Copy this invitation link:", url);
    }
  }

  /* ---------- Derived ---------- */
  // URL-driven filter state (status / role / team) is read directly from
  // search params on each render — no duplicate local state. The
  // UserFilters component writes them; this useMemo reads them.
  const searchParams = useSearchParams();
  const urlFilters = readUserFilters(searchParams);

  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members.filter((m) => {
      if (q && !m.email.toLowerCase().includes(q) && !m.role.includes(q)) {
        return false;
      }
      if (urlFilters.status !== "all" && m.status !== urlFilters.status) {
        return false;
      }
      if (urlFilters.role !== "all" && m.role !== urlFilters.role) {
        return false;
      }
      if (urlFilters.teamId && !m.teamIds.includes(urlFilters.teamId)) {
        return false;
      }
      return true;
    });
  }, [
    members,
    query,
    urlFilters.status,
    urlFilters.role,
    urlFilters.teamId,
  ]);

  const stats = useMemo(() => {
    const total = members.length;
    const admins = members.filter(
      (m) => m.role === "super_owner" || m.role === "admin"
    ).length;
    const analysts = members.filter((m) => m.role === "data_analyst").length;
    const learners = members.filter((m) => m.role === "user").length;
    const pending = invitations.length;
    return { total, admins, analysts, learners, pending };
  }, [members, invitations]);

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="serif text-4xl tracking-tight">Users</h1>
          <p className="text-muted text-sm mt-1">
            Manage who has access to {orgName}, invite new learners, and bulk-import from CSV.
          </p>
        </div>
        <a
          href={`/${orgSlug}/users/new`}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90 transition-opacity shadow-sm"
        >
          <UserPlus className="w-4 h-4" />
          Create user
        </a>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
        <StatCard
          icon={<UsersIcon className="w-4 h-4" />}
          label="Total"
          value={stats.total}
        />
        <StatCard
          icon={<GraduationCap className="w-4 h-4" />}
          label="Learners"
          value={stats.learners}
        />
        <StatCard
          icon={<BarChart3 className="w-4 h-4" />}
          label="Data analysts"
          value={stats.analysts}
        />
        <StatCard
          icon={<ShieldCheck className="w-4 h-4" />}
          label="Admins"
          value={stats.admins}
        />
        <StatCard
          icon={<Mail className="w-4 h-4" />}
          label="Pending"
          value={stats.pending}
          tone={stats.pending > 0 ? "amber" : undefined}
        />
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 p-1 mb-6 bg-paper border border-line rounded-xl text-sm overflow-x-auto">
        <TabBtn active={tab === "members"} onClick={() => setTab("members")}>
          <UsersIcon className="w-4 h-4" /> Members
          <Pill>{stats.total}</Pill>
        </TabBtn>
        <TabBtn
          active={tab === "invitations"}
          onClick={() => setTab("invitations")}
        >
          <Mail className="w-4 h-4" /> Pending
          {stats.pending > 0 && <Pill tone="amber">{stats.pending}</Pill>}
        </TabBtn>
        <TabBtn active={tab === "invite"} onClick={() => setTab("invite")}>
          <Send className="w-4 h-4" /> Quick invite
        </TabBtn>
        <TabBtn active={tab === "bulk"} onClick={() => setTab("bulk")}>
          <Upload className="w-4 h-4" /> Bulk upload
        </TabBtn>
      </div>

      {/* ===== Tab content ===== */}

      {tab === "members" && (
        <section className="border border-line rounded-2xl bg-paper overflow-hidden">
          <div className="px-4 py-3 border-b border-line space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search members by email or role…"
                  className="w-full pl-9 pr-3 py-2 bg-canvas border border-line rounded-lg text-sm outline-none focus:border-ink"
                />
              </div>
            </div>
            {/* URL-driven status/role/team filters (#163 v0). Search input
                above is a separate, local concern (instant email match)
                and intentionally NOT URL-synced. */}
            <UserFilters
              teams={teams}
              totalMatching={filteredMembers.length}
              totalAll={stats.total}
            />
          </div>
          {filteredMembers.length === 0 ? (
            <div className="p-10 text-center text-muted text-sm">
              No members match.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-4 bg-canvas/30">
              {filteredMembers.map((m) => {
                const isSelf = m.user_id === currentUserId;
                const canEdit =
                  currentUserRole === "super_owner" ||
                  (currentUserRole === "admin" &&
                    m.role !== "super_owner");
                return (
                  <article
                    key={m.user_id}
                    className="group relative bg-paper border border-line rounded-xl p-4 transition-all hover:border-ink/30 hover:shadow-sm flex flex-col gap-3"
                  >
                    <div className="flex items-start gap-3">
                      <Avatar email={m.email} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold truncate text-ink">
                            {m.email}
                          </span>
                          {isSelf && (
                            <span className="text-[9px] uppercase tracking-wider text-muted bg-canvas border border-line px-1.5 py-0.5 rounded">
                              you
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted mt-0.5">
                          Joined {new Date(m.joined_at).toISOString().slice(0, 10)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <RoleBadge role={m.role} />
                      <div className="flex items-center gap-1">
                        {canEdit && !isSelf ? (
                          <select
                            value={m.role}
                            onChange={(e) =>
                              changeRole(m.user_id, e.target.value)
                            }
                            className="text-xs px-2 py-1.5 border border-line rounded-md bg-canvas outline-none hover:border-ink"
                            title="Change role"
                          >
                            <option value="user">Learner</option>
                            <option value="data_analyst">Data analyst</option>
                            <option value="admin">Admin</option>
                            {currentUserRole === "super_owner" && (
                              <option value="super_owner">Super owner</option>
                            )}
                          </select>
                        ) : null}
                        <a
                          href={`/${orgSlug}/users/${m.user_id}/edit`}
                          className="p-1.5 border border-line rounded-md hover:border-ink text-muted hover:text-ink transition-colors"
                          title="Edit user"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </a>
                        {canEdit && !isSelf && (
                          <button
                            type="button"
                            onClick={() => removeMember(m.user_id)}
                            className="p-1.5 border border-line rounded-md hover:border-red-500 text-muted hover:text-red-600 transition-colors"
                            title="Remove from organization"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tab === "invitations" && (
        <section className="border border-line rounded-2xl bg-paper overflow-hidden">
          <header className="px-4 py-3 border-b border-line">
            <h2 className="serif text-xl">Pending invitations</h2>
            <p className="text-xs text-muted mt-0.5">
              Links that have been sent but not accepted yet.
            </p>
          </header>
          {invitations.length === 0 ? (
            <div className="p-10 text-center text-muted text-sm">
              <Mail className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No pending invitations. New invites land here until they&apos;re accepted.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-4 bg-canvas/30">
              {invitations.map((inv) => (
                <article
                  key={inv.id}
                  className="bg-paper border border-line rounded-xl p-4 transition-all hover:border-ink/30 hover:shadow-sm flex flex-col gap-3"
                >
                  <div className="flex items-start gap-3">
                    <Avatar email={inv.email} tone="amber" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold truncate block text-ink">{inv.email}</span>
                      <div className="text-xs text-muted mt-0.5">
                        Invited {new Date(inv.invited_at).toISOString().slice(0, 10)} · expires {new Date(inv.expires_at).toISOString().slice(0, 10)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <RoleBadge role={inv.role} />
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => copyShareUrl(inv.token)}
                      className="text-xs inline-flex items-center gap-1 px-2 py-1.5 border border-line rounded-lg hover:border-ink"
                    >
                      <Copy className="w-3 h-3" /> Copy link
                    </button>
                    <button
                      type="button"
                      onClick={() => revokeInvite(inv.id)}
                      className="text-xs inline-flex items-center gap-1 px-2 py-1.5 border border-line rounded-lg hover:border-red-500 hover:text-red-700"
                    >
                      <X className="w-3 h-3" /> Revoke
                    </button>
                  </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "invite" && (
        <section className="border border-line rounded-2xl bg-paper p-6 md:p-8">
          <div className="mb-5">
            <h2 className="serif text-2xl">Quick invite</h2>
            <p className="text-xs text-muted mt-1">
              Email-only invite. For full user details (employee ID, line
              manager, node, etc.), use{" "}
              <a
                href={`/${orgSlug}/users/new`}
                className="underline hover:text-ink"
              >
                Create user
              </a>{" "}
              instead.
            </p>
          </div>
          <form
            onSubmit={createInvitation}
            className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-3"
          >
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="learner@company.com"
                  className="w-full pl-9 pr-3 py-2.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">
                Role
              </label>
              <select
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(e.target.value as InviteRole)
                }
                className="w-full px-3 py-2.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink text-sm"
              >
                <option value="user">User</option>
                <option value="data_analyst">Data Analyst</option>
                <option value="admin">Administrator</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={busy}
                className="w-full md:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50 shadow-sm"
              >
                <Send className="w-4 h-4" />
                {busy ? "Sending…" : "Send invite"}
              </button>
            </div>
          </form>
          {error && (
            <div className="mt-4 border border-red-200 bg-red-50 text-red-900 rounded-xl p-3 text-sm flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {lastShared && (
            <div className="mt-4 border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-xl p-4">
              <div className="flex items-start gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
                <div className="text-sm font-medium">
                  Invitation sent! Share this link with the learner:
                </div>
              </div>
              <code className="block break-all bg-paper border border-emerald-200 rounded-lg px-3 py-2 text-xs font-mono">
                {lastShared}
              </code>
            </div>
          )}
        </section>
      )}

      {tab === "bulk" && (
        <section className="border border-line rounded-2xl bg-paper p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="serif text-2xl">Bulk upload</h2>
              <p className="text-xs text-muted mt-1 max-w-2xl">
                One row per user. 20-column schema. Required:{" "}
                <code>first_name</code>, <code>email</code>,{" "}
                <code>unique_id</code>, <code>lms_role</code>,{" "}
                <code>node_id</code>. Leave <code>password</code> blank to email
                a setup link. Existing users (matched on email) are updated, not
                duplicated.
              </p>
            </div>
            <a
              href="/api/users/template"
              download
              className="inline-flex items-center gap-2 px-3 py-2 border border-line rounded-xl text-xs hover:border-ink"
            >
              <Download className="w-3.5 h-3.5" /> Template
            </a>
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-3">
            <label className="inline-flex items-center gap-2 px-3 py-2 border border-line rounded-xl text-xs cursor-pointer hover:border-ink">
              <FileText className="w-3.5 h-3.5" />
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={onBulkFile}
                className="hidden"
              />
              Choose CSV file…
            </label>
            {bulkFileName && (
              <span className="text-xs text-muted font-mono">
                {bulkFileName}
              </span>
            )}
            <span className="text-xs text-muted">or paste below</span>
          </div>

          <textarea
            value={bulkCsv}
            onChange={(e) => setBulkCsv(e.target.value)}
            placeholder={
              "first_name,last_name,unique_id,...,email,...,lms_role,node_id,...\nJane,Doe,EMP-1001,...,jane@acme.com,...,user,ENG-PLATFORM,..."
            }
            rows={6}
            className="w-full px-3 py-2.5 border border-line rounded-xl bg-canvas font-mono text-xs outline-none focus:border-ink focus:ring-2 focus:ring-ink/10"
          />

          <div className="flex justify-end mt-3">
            <button
              type="button"
              onClick={bulkInvite}
              disabled={bulkBusy || !bulkCsv.trim()}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50 shadow-sm"
            >
              <Upload className="w-4 h-4" />
              {bulkBusy ? "Processing…" : "Upload users"}
            </button>
          </div>

          {bulkSummary?.summary && (
            <div className="mt-5 border border-line rounded-xl bg-canvas/50 p-4 text-sm">
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {(bulkSummary.summary.created ?? 0) > 0 && (
                  <Counter
                    label="created"
                    n={bulkSummary.summary.created!}
                    tone="emerald"
                  />
                )}
                {(bulkSummary.summary.invited ?? 0) > 0 && (
                  <Counter
                    label="invited"
                    n={bulkSummary.summary.invited!}
                    tone="emerald"
                  />
                )}
                {(bulkSummary.summary.updated ?? 0) > 0 && (
                  <Counter label="updated" n={bulkSummary.summary.updated!} />
                )}
                {bulkSummary.summary.skipped > 0 && (
                  <Counter
                    label="skipped"
                    n={bulkSummary.summary.skipped}
                    tone="amber"
                  />
                )}
                {bulkSummary.summary.errored > 0 && (
                  <Counter
                    label="errored"
                    n={bulkSummary.summary.errored}
                    tone="red"
                  />
                )}
              </div>
              {(
                bulkSummary.results?.filter(
                  (r) => r.status === "skipped" || r.status === "error"
                ) ?? []
              ).length > 0 && (
                <ul className="mt-3 text-xs text-muted space-y-1">
                  {bulkSummary.results
                    ?.filter(
                      (r) => r.status === "skipped" || r.status === "error"
                    )
                    .map((r) => (
                      <li key={r.row}>
                        Row {r.row}{" "}
                        <span className="text-ink">{r.email || "—"}</span>:{" "}
                        <span
                          className={
                            r.status === "error" ? "text-red-700" : ""
                          }
                        >
                          {r.message}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/* ----------- Small building blocks ----------- */

function StatCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "amber";
}) {
  return (
    <div className="border border-line rounded-2xl bg-paper p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
        <span className="text-muted">{icon}</span>
        {label}
      </div>
      <div
        className={`serif text-3xl mt-1 ${
          tone === "amber" ? "text-amber-700" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
        active
          ? "bg-ink text-canvas shadow-sm"
          : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "amber";
}) {
  const cls =
    tone === "amber"
      ? "bg-amber-100 text-amber-800"
      : "bg-canvas text-muted";
  return (
    <span
      className={`inline-flex items-center justify-center text-[10px] px-1.5 rounded-full ${cls} min-w-[18px] h-[18px]`}
    >
      {children}
    </span>
  );
}

function Avatar({
  email,
  tone,
}: {
  email: string;
  tone?: "amber";
}) {
  const initials = (email.split("@")[0] || "?")
    .split(/[.\-_]/)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .filter(Boolean)
    .join("") || "?";
  return (
    <div
      className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0 ${
        tone === "amber"
          ? "bg-amber-500"
          : "bg-gradient-to-br from-indigo-500 to-indigo-700"
      }`}
    >
      {initials}
    </div>
  );
}

function RoleBadge({ role }: { role: OrgRole }) {
  const config: Record<
    OrgRole,
    { icon: React.ReactNode; tone: string }
  > = {
    super_owner: {
      icon: <ShieldAlert className="w-3 h-3" />,
      tone: "border-violet-300 bg-violet-50 text-violet-800",
    },
    admin: {
      icon: <ShieldCheck className="w-3 h-3" />,
      tone: "border-indigo-300 bg-indigo-50 text-indigo-800",
    },
    data_analyst: {
      icon: <BarChart3 className="w-3 h-3" />,
      tone: "border-sky-300 bg-sky-50 text-sky-800",
    },
    user: {
      icon: <GraduationCap className="w-3 h-3" />,
      tone: "border-line bg-canvas text-muted",
    },
  };
  const c = config[role];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium ${c.tone}`}
    >
      {c.icon}
      {roleLabel(role)}
    </span>
  );
}

function Counter({
  label,
  n,
  tone,
}: {
  label: string;
  n: number;
  tone?: "emerald" | "amber" | "red";
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "red"
          ? "text-red-700"
          : "text-ink";
  return (
    <span className={`text-xs ${toneClass}`}>
      <span className="font-semibold tabular-nums">{n}</span> {label}
    </span>
  );
}
