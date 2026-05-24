"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MemberCombobox } from "./member-combobox";

export type AssignmentRow = {
  id: string;
  assignee_type: "user" | "org" | "team";
  user_id: string | null;
  team_id: string | null;
  due_at: string | null;
  assigned_at: string;
  user_email?: string | null;
  team_name?: string | null;
};

export type AssignableMember = {
  user_id: string;
  email: string;
  role: import("@/lib/auth/require-org-access").OrgRole;
  // New fields used by MemberCombobox so admins can search by name or
  // employee_id instead of scrolling a 1000-item native <select>.
  employee_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export type AssignableTeam = {
  id: string;
  name: string;
  slug: string;
  member_count: number;
};

export function AssignSection({
  orgSlug,
  courseId,
  isAdmin,
  assignments,
  members,
  teams,
}: {
  orgSlug: string;
  courseId: string;
  isAdmin: boolean;
  assignments: AssignmentRow[];
  members: AssignableMember[];
  teams: AssignableTeam[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState("");
  const [selectedTeam, setSelectedTeam] = useState("");
  const [dueAt, setDueAt] = useState("");

  const orgWide = assignments.find((a) => a.assignee_type === "org");
  const userAssignments = assignments.filter((a) => a.assignee_type === "user");
  const teamAssignments = assignments.filter((a) => a.assignee_type === "team");
  const assignedUserIds = new Set(userAssignments.map((a) => a.user_id));
  const assignedTeamIds = new Set(teamAssignments.map((a) => a.team_id));
  const userCandidates = members.filter((m) => !assignedUserIds.has(m.user_id));
  const teamCandidates = teams.filter((t) => !assignedTeamIds.has(t.id));

  async function post(body: object) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Failed");
      return false;
    }
    router.refresh();
    return true;
  }

  async function unassign(id: string) {
    if (!confirm("Remove this assignment?")) return;
    const res = await fetch(`/api/assignments/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function toggleOrgWide() {
    if (orgWide) {
      await unassign(orgWide.id);
      return;
    }
    await post({ orgSlug, courseId, assignToOrg: true, dueAt: dueAt || null });
  }

  async function addUser() {
    if (!selectedUser) return;
    const ok = await post({
      orgSlug,
      courseId,
      userIds: [selectedUser],
      dueAt: dueAt || null,
    });
    if (ok) setSelectedUser("");
  }

  async function addTeam() {
    if (!selectedTeam) return;
    const ok = await post({
      orgSlug,
      courseId,
      teamIds: [selectedTeam],
      dueAt: dueAt || null,
    });
    if (ok) setSelectedTeam("");
  }

  return (
    <div>
      <h2 className="serif text-2xl mb-3">Assignments</h2>

      <div className="border border-line rounded-lg bg-paper">
        <div className="px-5 py-3 flex items-center justify-between border-b border-line">
          <div>
            <div className="font-medium">Assigned to entire org</div>
            <div className="text-xs text-muted">
              Every member of this workspace will see this course.
              {orgWide?.due_at && (
                <>
                  {" "}
                  Due by{" "}
                  <span className="text-ink">
                    {new Date(orgWide.due_at).toISOString().slice(0, 10)}
                  </span>
                  .
                </>
              )}
            </div>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={toggleOrgWide}
              disabled={busy}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                orgWide
                  ? "border border-line hover:border-red-500 hover:text-red-700"
                  : "bg-ink text-canvas hover:opacity-90"
              } disabled:opacity-50`}
            >
              {orgWide ? "Unassign all" : "Assign to all"}
            </button>
          )}
        </div>

        {teamAssignments.length > 0 && (
          <div className="px-5 py-3 border-b border-line">
            <div className="text-xs uppercase tracking-wide text-muted mb-2">
              Teams ({teamAssignments.length})
            </div>
            <ul className="space-y-1.5">
              {teamAssignments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{a.team_name ?? a.team_id?.slice(0, 8) ?? "-"}</span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    {a.due_at && (
                      <span>Due {new Date(a.due_at).toISOString().slice(0, 10)}</span>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => unassign(a.id)}
                        className="px-2 py-0.5 border border-line rounded hover:border-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {userAssignments.length > 0 && (
          <div className="px-5 py-3 border-b border-line">
            <div className="text-xs uppercase tracking-wide text-muted mb-2">
              Individually assigned ({userAssignments.length})
            </div>
            <ul className="space-y-1.5">
              {userAssignments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{a.user_email ?? a.user_id?.slice(0, 8) ?? "-"}</span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    {a.due_at && (
                      <span>Due {new Date(a.due_at).toISOString().slice(0, 10)}</span>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => unassign(a.id)}
                        className="px-2 py-0.5 border border-line rounded hover:border-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {isAdmin && (
          <div className="px-5 py-3 space-y-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted mb-2">
                Assign team
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <select
                  value={selectedTeam}
                  onChange={(e) => setSelectedTeam(e.target.value)}
                  className="flex-1 min-w-[200px] px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
                >
                  <option value="">Pick a team...</option>
                  {teamCandidates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.member_count}{" "}
                      {t.member_count === 1 ? "member" : "members"})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addTeam}
                  disabled={busy || !selectedTeam}
                  className="px-3 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  Assign team
                </button>
              </div>
              {teamCandidates.length === 0 && teams.length === 0 && (
                <p className="text-xs text-muted mt-2">
                  No teams yet. Create one in the{" "}
                  <a
                    href={`/${orgSlug}/teams`}
                    className="underline hover:text-ink"
                  >
                    Teams
                  </a>{" "}
                  page.
                </p>
              )}
            </div>

            <div>
              <div className="text-xs uppercase tracking-wide text-muted mb-2">
                Assign learner
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <MemberCombobox
                  members={userCandidates}
                  value={selectedUser}
                  onChange={setSelectedUser}
                  disabled={busy}
                />
                <input
                  type="date"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  title="Due date (optional)"
                  className="px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
                />
                <button
                  type="button"
                  onClick={addUser}
                  disabled={busy || !selectedUser}
                  className="px-3 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  Assign
                </button>
              </div>
              {userCandidates.length === 0 && members.length > 0 && (
                <p className="text-xs text-muted mt-2">
                  Every member of this org is already individually assigned.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-700 mt-2">{error}</p>}
    </div>
  );
}
