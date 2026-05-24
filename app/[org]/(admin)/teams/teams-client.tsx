"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Users as UsersIcon,
  UserPlus,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  Search,
} from "lucide-react";
import {
  AdminPageHeader,
  KpiCard,
  KpiStrip,
  Card,
  Avatar,
  EmptyState,
} from "@/components/admin";
import { BulkAddMembers } from "./bulk-add-members";

type Team = { id: string; name: string; slug: string; created_at: string };
type TeamMember = { team_id: string; user_id: string; email: string };
type OrgMember = { user_id: string; email: string; role: string };

export function TeamsClient({
  orgSlug,
  orgName,
  teams,
  teamMembers,
  orgMembers,
}: {
  orgSlug: string;
  orgName: string;
  teams: Team[];
  teamMembers: TeamMember[];
  orgMembers: OrgMember[];
}) {
  const router = useRouter();
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  // Tracks which team is currently dispatching a bulk-add (so we can
  // show "Adding…" state and disable the button on the BulkAddMembers
  // panel for that team). Null = no add in flight.
  const [addingTo, setAddingTo] = useState<string | null>(null);

  async function createTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, name: newName.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Failed to create team");
      return;
    }
    setNewName("");
    setCreateOpen(false);
    router.refresh();
  }

  async function deleteTeam(id: string, name: string) {
    if (!confirm(`Delete team "${name}"? Members will be unassigned.`)) return;
    const res = await fetch(`/api/teams/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    if (activeTeamId === id) setActiveTeamId(null);
    router.refresh();
  }

  // Bulk-aware: takes an array (1 or N user_ids). Backend already
  // supports the array shape via upsert with onConflict ignore, so
  // adding 100 members is one round-trip rather than 100. Driven by
  // the BulkAddMembers component's onAdd prop (pick + paste modes).
  async function addMembers(teamId: string, userIds: string[]) {
    if (userIds.length === 0) return;
    setAddingTo(teamId);
    const res = await fetch(`/api/teams/${teamId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userIds }),
    });
    setAddingTo(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function removeMember(teamId: string, userId: string) {
    const res = await fetch(
      `/api/teams/${teamId}/members?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  const teamSizeById = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of teams) m.set(t.id, 0);
    for (const tm of teamMembers) m.set(tm.team_id, (m.get(tm.team_id) ?? 0) + 1);
    return m;
  }, [teams, teamMembers]);

  const stats = useMemo(() => {
    const totalTeams = teams.length;
    const totalMembers = teamMembers.length;
    let largest = 0;
    for (const c of teamSizeById.values()) if (c > largest) largest = c;
    const avg = totalTeams === 0 ? 0 : Math.round(totalMembers / totalTeams);
    return { totalTeams, totalMembers, largest, avg };
  }, [teams, teamMembers, teamSizeById]);

  const filteredTeams = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(
      (t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q)
    );
  }, [teams, query]);

  const activeTeam = activeTeamId
    ? teams.find((t) => t.id === activeTeamId) ?? null
    : null;
  const activeTeamMembers = activeTeam
    ? teamMembers.filter((m) => m.team_id === activeTeam.id)
    : [];
  const activeCandidates = activeTeam
    ? orgMembers.filter(
        (m) => !activeTeamMembers.some((tm) => tm.user_id === m.user_id)
      )
    : [];

  return (
    <div>
      <AdminPageHeader
        title="Teams"
        description={`Group learners in ${orgName} for bulk assignment.`}
        action={
          <button
            type="button"
            onClick={() => setCreateOpen((s) => !s)}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90 transition-opacity shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New team
          </button>
        }
      />

      <KpiStrip>
        <KpiCard
          label="Total teams"
          value={stats.totalTeams}
          icon={<UsersIcon className="w-4 h-4" />}
        />
        <KpiCard
          label="Total members"
          value={stats.totalMembers}
          icon={<UserPlus className="w-4 h-4" />}
        />
        <KpiCard label="Largest team" value={stats.largest} />
        <KpiCard label="Avg per team" value={stats.avg} />
      </KpiStrip>

      {createOpen && (
        <Card className="p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="serif text-xl">Create a team</h2>
            <button
              type="button"
              onClick={() => {
                setCreateOpen(false);
                setError(null);
              }}
              className="p-1.5 border border-line rounded-md hover:border-ink text-muted hover:text-ink transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <form
            onSubmit={createTeam}
            className="flex flex-col sm:flex-row gap-3 sm:items-end"
          >
            <div className="flex-1">
              <label className="block text-xs font-medium text-muted mb-1.5">
                Team name
              </label>
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Sales, Engineering, Compliance..."
                className="w-full px-4 py-2.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2.5 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating..." : "Create team"}
            </button>
          </form>
          {error && <p className="text-sm text-red-700 mt-2">{error}</p>}
        </Card>
      )}

      {teams.length > 0 && (
        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teams..."
            className="w-full pl-9 pr-3 py-2 bg-paper border border-line rounded-xl text-sm outline-none focus:border-ink"
          />
        </div>
      )}

      {teams.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={<UsersIcon className="w-5 h-5" />}
            title="No teams yet"
            description={`Create your first team for ${orgName} to start grouping learners.`}
            action={
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90"
              >
                <Plus className="w-4 h-4" />
                New team
              </button>
            }
          />
        </Card>
      ) : filteredTeams.length === 0 ? (
        <Card className="p-10 text-center text-muted text-sm">
          No teams match &ldquo;{query}&rdquo;.
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredTeams.map((t) => {
            const members = teamMembers.filter((m) => m.team_id === t.id);
            const preview = members.slice(0, 5);
            const more = members.length - preview.length;
            return (
              <article
                key={t.id}
                className="bg-paper border border-line rounded-xl p-4 transition-all hover:border-ink/30 hover:shadow-sm flex flex-col gap-3 cursor-pointer text-left"
                onClick={() => setActiveTeamId(t.id)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="serif text-xl text-ink truncate">{t.name}</h3>
                    <p className="text-xs text-muted mt-0.5">
                      /{t.slug} {"·"}{" "}
                      <span className="font-medium text-ink">
                        {members.length}
                      </span>{" "}
                      {members.length === 1 ? "member" : "members"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveTeamId(t.id);
                      }}
                      className="p-1.5 border border-line rounded-md hover:border-ink text-muted hover:text-ink transition-colors"
                      title="Manage members"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteTeam(t.id, t.name);
                      }}
                      className="p-1.5 border border-line rounded-md hover:border-red-500 text-muted hover:text-red-600 transition-colors"
                      title="Delete team"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {members.length === 0 ? (
                  <p className="text-xs text-muted italic">No members yet.</p>
                ) : (
                  <div className="flex items-center -space-x-2">
                    {preview.map((m) => (
                      <div
                        key={m.user_id}
                        title={m.email}
                        className="ring-2 ring-paper rounded-full"
                      >
                        <Avatar name={m.email} size={28} />
                      </div>
                    ))}
                    {more > 0 && (
                      <span className="ml-3 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border border-line bg-canvas text-muted">
                        +{more} more
                      </span>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {activeTeam && (
        <div
          className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-ink/40 backdrop-blur-sm p-3 sm:p-6"
          onClick={() => setActiveTeamId(null)}
        >
          <div
            className="w-full max-w-xl bg-paper border border-line rounded-2xl shadow-xl max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="serif text-2xl text-ink truncate">
                  {activeTeam.name}
                </h2>
                <p className="text-xs text-muted mt-0.5">
                  /{activeTeam.slug} {"·"} {activeTeamMembers.length}{" "}
                  {activeTeamMembers.length === 1 ? "member" : "members"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveTeamId(null)}
                className="p-1.5 border border-line rounded-md hover:border-ink text-muted hover:text-ink transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-4 overflow-y-auto flex-1">
              <div className="mb-4">
                <BulkAddMembers
                  candidates={activeCandidates}
                  existingEmails={activeTeamMembers.map((m) => m.email)}
                  onAdd={(userIds) => addMembers(activeTeam.id, userIds)}
                  busy={addingTo === activeTeam.id}
                />
              </div>

              {activeTeamMembers.length === 0 ? (
                <p className="text-sm text-muted text-center py-8">
                  No members yet. Pick a user above to add them.
                </p>
              ) : (
                <ul className="space-y-2">
                  {activeTeamMembers.map((m) => (
                    <li
                      key={m.user_id}
                      className="flex items-center gap-3 px-3 py-2 border border-line rounded-xl bg-canvas"
                    >
                      <Avatar name={m.email} size={32} />
                      <span className="flex-1 text-sm truncate">{m.email}</span>
                      <button
                        type="button"
                        onClick={() => removeMember(activeTeam.id, m.user_id)}
                        className="text-xs inline-flex items-center gap-1 px-2 py-1 border border-line rounded-md hover:border-red-500 hover:text-red-700"
                      >
                        <X className="w-3 h-3" />
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
