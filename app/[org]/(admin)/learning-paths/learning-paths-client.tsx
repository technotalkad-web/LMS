"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  PathRow,
  PathCourseRow,
  PathAssignmentRow,
  PathEnrollee,
  CourseOption,
  MemberOption,
  TeamOption,
} from "./page";
import { ThumbnailPicker } from "../_components/thumbnail-picker";
import { VisibilityRadio } from "../library/[courseId]/details-form";
import {
  AdminPageHeader,
  KpiStrip,
  KpiCard,
  Card,
  EmptyState,
  StatusPill,
} from "@/components/admin";
import {
  Route,
  CheckCircle2,
  CircleSlash,
  Plus,
  Search,
  Clock,
  Layers,
  Pencil,
  Trash2,
  X,
} from "lucide-react";

function formatDuration(mins: number | null): string | null {
  if (mins === null || mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function LearningPathsClient({
  orgSlug,
  paths,
  pathCourses,
  pathAssignments,
  pathEnrollees,
  courseOptions,
  memberOptions,
  teamOptions,
}: {
  orgSlug: string;
  paths: PathRow[];
  pathCourses: PathCourseRow[];
  pathAssignments: PathAssignmentRow[];
  pathEnrollees: PathEnrollee[];
  courseOptions: CourseOption[];
  memberOptions: MemberOption[];
  teamOptions: TeamOption[];
}) {
  void orgSlug;
  const router = useRouter();

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newThumbnail, setNewThumbnail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-path interaction state
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [pickedCourse, setPickedCourse] = useState<Record<string, string>>({});
  const [notifyOnAdd, setNotifyOnAdd] = useState<Record<string, boolean>>({});
  const [pickedUser, setPickedUser] = useState<Record<string, string>>({});
  const [pickedTeam, setPickedTeam] = useState<Record<string, string>>({});
  const [dueDates, setDueDates] = useState<Record<string, string>>({});
  const [showEnrollees, setShowEnrollees] = useState<Record<string, boolean>>({});
  const [editForm, setEditForm] = useState<
    Record<
      string,
      {
        name: string;
        description: string;
        duration_minutes: string;
        is_active: boolean;
        thumbnail_url: string | null;
        visibility: "private" | "org_public";
        sequence_mode: "strict" | "random";
      }
    >
  >({});

  // Search
  const [query, setQuery] = useState("");

  const filteredPaths = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return paths;
    return paths.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
    );
  }, [paths, query]);

  function startEdit(p: PathRow) {
    setEditForm((s) => ({
      ...s,
      [p.id]: {
        name: p.name,
        description: p.description ?? "",
        duration_minutes:
          p.duration_minutes !== null ? String(p.duration_minutes) : "",
        is_active: p.is_active,
        thumbnail_url: p.thumbnail_url,
        visibility: p.visibility ?? "private",
        sequence_mode: p.sequence_mode ?? "strict",
      },
    }));
    setEditing((s) => ({ ...s, [p.id]: true }));
    setExpanded((s) => ({ ...s, [p.id]: true }));
  }
  function cancelEdit(pid: string) {
    setEditing((s) => ({ ...s, [pid]: false }));
  }
  async function saveEdit(pid: string) {
    const f = editForm[pid];
    if (!f) return;
    const res = await fetch(`/api/learning-paths/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: f.name,
        description: f.description,
        duration_minutes: f.duration_minutes === "" ? null : f.duration_minutes,
        is_active: f.is_active,
        thumbnail_url: f.thumbnail_url,
        visibility: f.visibility,
        sequence_mode: f.sequence_mode,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Save failed");
      return;
    }
    setEditing((s) => ({ ...s, [pid]: false }));
    router.refresh();
  }
  async function toggleActive(pid: string, next: boolean) {
    const res = await fetch(`/api/learning-paths/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function createPath(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/learning-paths", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        thumbnail_url: newThumbnail,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Failed to create path");
      return;
    }
    setNewName("");
    setNewDescription("");
    setNewThumbnail(null);
    setShowCreate(false);
    router.refresh();
  }

  async function deletePath(id: string, name: string) {
    if (!confirm(`Delete path "${name}"? Course assignments to this path will be removed.`))
      return;
    const res = await fetch(`/api/learning-paths/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function addCourseToPath(pathId: string) {
    const courseId = pickedCourse[pathId];
    if (!courseId) return;
    const notify_update = !!notifyOnAdd[pathId];
    const res = await fetch(`/api/learning-paths/${pathId}/courses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ courseId, notify_update }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    setPickedCourse((s) => ({ ...s, [pathId]: "" }));
    router.refresh();
  }

  async function removeCourseFromPath(pathId: string, courseId: string) {
    if (!confirm("Remove this course from the path?")) return;
    const res = await fetch(
      `/api/learning-paths/${pathId}/courses?courseId=${courseId}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function reorder(pathId: string, courseIds: string[]) {
    const res = await fetch(`/api/learning-paths/${pathId}/courses`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedCourseIds: courseIds }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function moveStep(pathId: string, idx: number, direction: -1 | 1) {
    const steps = pathCourses
      .filter((s) => s.path_id === pathId)
      .sort((a, b) => a.step_number - b.step_number);
    const target = idx + direction;
    if (target < 0 || target >= steps.length) return;
    const ids = steps.map((s) => s.course_id);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    await reorder(pathId, ids);
  }

  async function assignPath(pathId: string, opts: {
    user?: boolean;
    team?: boolean;
    org?: boolean;
  }) {
    const userId = opts.user ? pickedUser[pathId] : null;
    const teamId = opts.team ? pickedTeam[pathId] : null;
    const dueAt = dueDates[pathId] || null;

    if (opts.user && !userId) return;
    if (opts.team && !teamId) return;

    const res = await fetch("/api/learning-path-assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        pathId,
        assignToOrg: opts.org ?? false,
        userIds: userId ? [userId] : [],
        teamIds: teamId ? [teamId] : [],
        dueAt,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    if (opts.user) setPickedUser((s) => ({ ...s, [pathId]: "" }));
    if (opts.team) setPickedTeam((s) => ({ ...s, [pathId]: "" }));
    router.refresh();
  }

  async function unassign(id: string) {
    if (!confirm("Remove this path assignment?")) return;
    const res = await fetch(`/api/learning-path-assignments/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  // KPIs
  const totalPaths = paths.length;
  const activePaths = paths.filter((p) => p.is_active).length;
  const inactivePaths = totalPaths - activePaths;

  return (
    <div className="max-w-7xl">
      <AdminPageHeader
        title="Learning paths"
        description="Multi-course journeys."
        action={
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
          >
            {showCreate ? (
              <>
                <X className="w-4 h-4" /> Cancel
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" /> New path
              </>
            )}
          </button>
        }
      />

      <KpiStrip>
        <KpiCard
          label="Total"
          value={totalPaths}
          icon={<Route className="w-4 h-4" />}
        />
        <KpiCard
          label="Active"
          value={activePaths}
          icon={<CheckCircle2 className="w-4 h-4" />}
          accent="text-emerald-600"
        />
        <KpiCard
          label="Inactive"
          value={inactivePaths}
          icon={<CircleSlash className="w-4 h-4" />}
          accent="text-slate-500"
        />
      </KpiStrip>

      {showCreate && (
        <Card className="mb-6">
          <form onSubmit={createPath} className="p-5 space-y-3">
            <h2 className="serif text-xl mb-1">Create path</h2>
            <div>
              <label className="block text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
                Name
              </label>
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New Hire Onboarding"
                className="w-full px-4 py-2 border border-line rounded-xl bg-canvas outline-none focus:border-ink text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
                Description (optional)
              </label>
              <input
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What's this path for?"
                className="w-full px-4 py-2 border border-line rounded-xl bg-canvas outline-none focus:border-ink text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
                Thumbnail (optional)
              </label>
              <ThumbnailPicker
                orgSlug={orgSlug}
                value={newThumbnail}
                onChange={setNewThumbnail}
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating..." : "Create path"}
            </button>
            {error && <p className="text-sm text-red-700 mt-2">{error}</p>}
          </form>
        </Card>
      )}

      {/* Search */}
      {paths.length > 0 && (
        <div className="relative mb-5 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search paths..."
            className="w-full pl-9 pr-3 py-2 bg-paper border border-line rounded-xl text-sm outline-none focus:border-ink"
          />
        </div>
      )}

      {paths.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Route className="w-5 h-5" />}
            title="No paths yet"
            description="Chain courses into ordered sequences. Each step unlocks only when the previous step is completed."
            action={
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90"
              >
                <Plus className="w-4 h-4" /> Create your first path
              </button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredPaths.map((p) => {
            const steps = pathCourses
              .filter((s) => s.path_id === p.id)
              .sort((a, b) => a.step_number - b.step_number);
            const stepCourseIds = new Set(steps.map((s) => s.course_id));
            const candidateCourses = courseOptions.filter(
              (c) => !stepCourseIds.has(c.id)
            );
            const assignments = pathAssignments.filter(
              (a) => a.path_id === p.id
            );
            const orgWide = assignments.find((a) => a.assignee_type === "org");
            const userAssignees = assignments.filter(
              (a) => a.assignee_type === "user"
            );
            const teamAssignees = assignments.filter(
              (a) => a.assignee_type === "team"
            );
            const assignedUserIds = new Set(
              userAssignees.map((a) => a.user_id)
            );
            const assignedTeamIds = new Set(
              teamAssignees.map((a) => a.team_id)
            );
            const userPickerCandidates = memberOptions.filter(
              (m) => !assignedUserIds.has(m.user_id)
            );
            const teamPickerCandidates = teamOptions.filter(
              (t) => !assignedTeamIds.has(t.id)
            );
            const duration = formatDuration(p.duration_minutes);
            const isExpanded = !!expanded[p.id];

            return (
              <div
                key={p.id}
                className={`bg-paper border border-line rounded-xl overflow-hidden transition-all hover:border-ink/30 hover:shadow-sm flex flex-col ${
                  isExpanded ? "sm:col-span-2 lg:col-span-3" : ""
                }`}
              >
                {p.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.thumbnail_url}
                    alt=""
                    className="aspect-video w-full object-cover rounded-t-xl"
                  />
                ) : (
                  <div className="aspect-video w-full bg-canvas rounded-t-xl flex items-center justify-center text-muted">
                    <Route className="w-8 h-8 opacity-40" />
                  </div>
                )}

                <div className="p-4 flex-1 flex flex-col gap-2">
                  <h3 className="serif text-lg leading-snug text-ink line-clamp-2">
                    {p.name}
                  </h3>
                  {p.description ? (
                    <p className="text-sm text-muted line-clamp-2">
                      {p.description}
                    </p>
                  ) : (
                    <p className="text-sm text-muted italic">No description</p>
                  )}
                  <div className="mt-auto pt-3 flex items-center justify-between gap-2 flex-wrap">
                    <StatusPill tone={p.is_active ? "active" : "neutral"}>
                      {p.is_active ? "Active" : "Inactive"}
                    </StatusPill>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span className="inline-flex items-center gap-1">
                        <Layers className="w-3 h-3" />
                        {steps.length} {steps.length === 1 ? "course" : "courses"}
                      </span>
                      {duration && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {duration}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-3 border-t border-line mt-3">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((s) => ({ ...s, [p.id]: !s[p.id] }))
                      }
                      className="flex-1 px-3 py-1.5 text-xs font-medium border border-line rounded-xl hover:border-ink transition-colors"
                    >
                      {isExpanded ? "Collapse" : "Manage"}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      title="Edit details"
                      className="px-2 py-1.5 border border-line rounded-xl hover:border-ink transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePath(p.id, p.name)}
                      title="Delete path"
                      className="px-2 py-1.5 border border-line rounded-xl hover:border-red-500 hover:text-red-700 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-line p-5 space-y-6 bg-canvas/40">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleActive(p.id, !p.is_active)}
                        className="text-xs px-3 py-1.5 border border-line rounded-xl bg-paper hover:border-ink"
                      >
                        {p.is_active ? "Deactivate" : "Activate"}
                      </button>
                      {editing[p.id] && (
                        <button
                          type="button"
                          onClick={() => cancelEdit(p.id)}
                          className="text-xs px-3 py-1.5 border border-line rounded-xl bg-paper hover:border-ink"
                        >
                          Cancel edit
                        </button>
                      )}
                    </div>

                    {editing[p.id] && editForm[p.id] && (
                      <div className="p-4 border border-line rounded-xl bg-paper space-y-3">
                        <div>
                          <label className="block text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
                            Name
                          </label>
                          <input
                            type="text"
                            value={editForm[p.id].name}
                            onChange={(e) =>
                              setEditForm((s) => ({
                                ...s,
                                [p.id]: { ...s[p.id], name: e.target.value },
                              }))
                            }
                            className="w-full px-3 py-2 border border-line rounded-xl bg-canvas text-sm outline-none focus:border-ink"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
                            Description
                          </label>
                          <textarea
                            value={editForm[p.id].description}
                            onChange={(e) =>
                              setEditForm((s) => ({
                                ...s,
                                [p.id]: {
                                  ...s[p.id],
                                  description: e.target.value,
                                },
                              }))
                            }
                            rows={2}
                            className="w-full px-3 py-2 border border-line rounded-xl bg-canvas text-sm outline-none focus:border-ink resize-none"
                          />
                        </div>
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="block text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
                              Duration (minutes)
                            </label>
                            <input
                              type="number"
                              min={0}
                              value={editForm[p.id].duration_minutes}
                              onChange={(e) =>
                                setEditForm((s) => ({
                                  ...s,
                                  [p.id]: {
                                    ...s[p.id],
                                    duration_minutes: e.target.value,
                                  },
                                }))
                              }
                              placeholder="e.g. 90"
                              className="w-32 px-3 py-2 border border-line rounded-xl bg-canvas text-sm outline-none focus:border-ink"
                            />
                          </div>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={editForm[p.id].is_active}
                              onChange={(e) =>
                                setEditForm((s) => ({
                                  ...s,
                                  [p.id]: {
                                    ...s[p.id],
                                    is_active: e.target.checked,
                                  },
                                }))
                              }
                            />
                            Active for learners
                          </label>
                          <button
                            type="button"
                            onClick={() => saveEdit(p.id)}
                            className="ml-auto px-4 py-2 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90"
                          >
                            Save details
                          </button>
                        </div>
                        <div>
                          <label className="block text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
                            Thumbnail
                          </label>
                          <ThumbnailPicker
                            orgSlug={orgSlug}
                            value={editForm[p.id].thumbnail_url}
                            onChange={(url) =>
                              setEditForm((s) => ({
                                ...s,
                                [p.id]: { ...s[p.id], thumbnail_url: url },
                              }))
                            }
                          />
                        </div>
                        <VisibilityRadio
                          value={editForm[p.id].visibility}
                          onChange={(v) =>
                            setEditForm((s) => ({
                              ...s,
                              [p.id]: { ...s[p.id], visibility: v },
                            }))
                          }
                          assetKind="learning path"
                        />
                        <SequenceModeRadio
                          value={editForm[p.id].sequence_mode}
                          onChange={(v) =>
                            setEditForm((s) => ({
                              ...s,
                              [p.id]: { ...s[p.id], sequence_mode: v },
                            }))
                          }
                        />
                      </div>
                    )}

                    {/* Steps */}
                    <div>
                      <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">
                        Steps ({steps.length})
                      </div>
                      {steps.length === 0 ? (
                        <p className="text-muted text-sm">
                          No courses yet. Add the first one below.
                        </p>
                      ) : (
                        <ol className="space-y-1.5">
                          {steps.map((s, idx) => (
                            <li
                              key={s.course_id}
                              className="flex items-center justify-between text-sm border border-line rounded-xl px-3 py-2 bg-paper"
                            >
                              <span>
                                <span className="text-muted tabular-nums mr-3">
                                  {s.step_number}.
                                </span>
                                {s.title}
                              </span>
                              <span className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => moveStep(p.id, idx, -1)}
                                  disabled={idx === 0}
                                  className="text-xs px-2 py-0.5 border border-line rounded hover:border-ink disabled:opacity-30"
                                  title="Move up"
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  onClick={() => moveStep(p.id, idx, 1)}
                                  disabled={idx === steps.length - 1}
                                  className="text-xs px-2 py-0.5 border border-line rounded hover:border-ink disabled:opacity-30"
                                  title="Move down"
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeCourseFromPath(p.id, s.course_id)
                                  }
                                  className="text-xs px-2 py-0.5 border border-line rounded hover:border-red-500 hover:text-red-700 ml-1"
                                >
                                  Remove
                                </button>
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}

                      <div className="flex gap-2 items-center mt-3">
                        <select
                          value={pickedCourse[p.id] ?? ""}
                          onChange={(e) =>
                            setPickedCourse((s) => ({
                              ...s,
                              [p.id]: e.target.value,
                            }))
                          }
                          className="flex-1 px-3 py-1.5 border border-line rounded-xl bg-paper outline-none focus:border-ink text-sm"
                        >
                          <option value="">Add course...</option>
                          {candidateCourses.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.title}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => addCourseToPath(p.id)}
                          disabled={!pickedCourse[p.id]}
                          className="px-3 py-1.5 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          Add step
                        </button>
                      </div>
                      <label className="flex items-start gap-2 mt-2 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={!!notifyOnAdd[p.id]}
                          onChange={(e) =>
                            setNotifyOnAdd((s) => ({
                              ...s,
                              [p.id]: e.target.checked,
                            }))
                          }
                          className="mt-0.5"
                        />
                        <span>
                          Send update notification email to assigned learners.
                          Their previous course completions are preserved; only
                          the new step needs to be done.
                        </span>
                      </label>
                    </div>

                    {/* Assignments */}
                    <div>
                      <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">
                        Assignments
                      </div>

                      <div className="flex items-center justify-between border border-line rounded-xl px-3 py-2 mb-3 bg-paper">
                        <span className="text-sm">Assigned to entire org</span>
                        <button
                          type="button"
                          onClick={() =>
                            orgWide
                              ? unassign(orgWide.id)
                              : assignPath(p.id, { org: true })
                          }
                          className={`px-3 py-1 rounded-xl text-xs font-medium ${
                            orgWide
                              ? "border border-line hover:border-red-500 hover:text-red-700"
                              : "bg-ink text-canvas hover:opacity-90"
                          }`}
                        >
                          {orgWide ? "Unassign all" : "Assign to all"}
                        </button>
                      </div>

                      {(teamAssignees.length > 0 ||
                        userAssignees.length > 0) && (
                        <ul className="space-y-1 mb-3">
                          {teamAssignees.map((a) => (
                            <li
                              key={a.id}
                              className="flex items-center justify-between text-sm"
                            >
                              <span>
                                <span className="text-xs uppercase tracking-wide text-muted mr-2">
                                  Team
                                </span>
                                {a.team_name ?? a.team_id?.slice(0, 8)}
                              </span>
                              <button
                                type="button"
                                onClick={() => unassign(a.id)}
                                className="text-xs px-2 py-0.5 border border-line rounded hover:border-red-500 hover:text-red-700"
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                          {userAssignees.map((a) => (
                            <li
                              key={a.id}
                              className="flex items-center justify-between text-sm"
                            >
                              <span>
                                <span className="text-xs uppercase tracking-wide text-muted mr-2">
                                  User
                                </span>
                                {a.user_email ?? a.user_id?.slice(0, 8)}
                              </span>
                              <button
                                type="button"
                                onClick={() => unassign(a.id)}
                                className="text-xs px-2 py-0.5 border border-line rounded hover:border-red-500 hover:text-red-700"
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="flex gap-2">
                          <select
                            value={pickedTeam[p.id] ?? ""}
                            onChange={(e) =>
                              setPickedTeam((s) => ({
                                ...s,
                                [p.id]: e.target.value,
                              }))
                            }
                            className="flex-1 px-3 py-1.5 border border-line rounded-xl bg-paper outline-none focus:border-ink text-sm"
                          >
                            <option value="">Assign team...</option>
                            {teamPickerCandidates.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => assignPath(p.id, { team: true })}
                            disabled={!pickedTeam[p.id]}
                            className="px-3 py-1.5 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-50"
                          >
                            Add
                          </button>
                        </div>
                        <div className="flex gap-2">
                          <select
                            value={pickedUser[p.id] ?? ""}
                            onChange={(e) =>
                              setPickedUser((s) => ({
                                ...s,
                                [p.id]: e.target.value,
                              }))
                            }
                            className="flex-1 px-3 py-1.5 border border-line rounded-xl bg-paper outline-none focus:border-ink text-sm"
                          >
                            <option value="">Assign learner...</option>
                            {userPickerCandidates.map((m) => (
                              <option key={m.user_id} value={m.user_id}>
                                {m.email}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => assignPath(p.id, { user: true })}
                            disabled={!pickedUser[p.id]}
                            className="px-3 py-1.5 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-50"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                      <input
                        type="date"
                        value={dueDates[p.id] ?? ""}
                        onChange={(e) =>
                          setDueDates((s) => ({
                            ...s,
                            [p.id]: e.target.value,
                          }))
                        }
                        title="Due date (applies to next assignment created)"
                        className="mt-2 px-3 py-1.5 border border-line rounded-xl bg-paper outline-none focus:border-ink text-sm"
                      />
                    </div>

                    {/* Path reports link */}
                    <div className="flex items-center justify-between border-t border-line pt-3">
                      <span className="text-[11px] uppercase tracking-wider font-semibold text-muted">
                        Reports
                      </span>
                      <a
                        href={`/${orgSlug}/learning-paths/${p.id}/reports`}
                        className="text-xs px-3 py-1.5 border border-line rounded-lg hover:border-ink transition-colors"
                      >
                        View path reports →
                      </a>
                    </div>

                    {/* Enrolled learners */}
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          setShowEnrollees((s) => ({
                            ...s,
                            [p.id]: !s[p.id],
                          }))
                        }
                        className="w-full text-left text-[11px] uppercase tracking-wider font-semibold text-muted hover:text-ink flex items-center justify-between"
                      >
                        <span>
                          Enrolled learners (
                          {
                            pathEnrollees.filter((e) => e.path_id === p.id)
                              .length
                          }
                          )
                        </span>
                        <span>{showEnrollees[p.id] ? "Hide" : "Show"}</span>
                      </button>
                      {showEnrollees[p.id] && (
                        <PathEnrolledTable
                          enrollees={pathEnrollees.filter(
                            (e) => e.path_id === p.id
                          )}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PathEnrolledTable({ enrollees }: { enrollees: PathEnrollee[] }) {
  if (enrollees.length === 0) {
    return (
      <div className="mt-3 text-sm text-muted">
        Nobody is enrolled yet. Add an assignee in the Assignments section
        above.
      </div>
    );
  }
  const sorted = [...enrollees].sort((a, b) =>
    a.email.localeCompare(b.email)
  );
  return (
    <div className="mt-3 border border-line rounded-xl overflow-x-auto bg-paper">
      <table className="w-full text-sm">
        <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Learner</th>
            <th className="text-left px-4 py-2 font-medium">Source</th>
            <th className="text-left px-4 py-2 font-medium">Progress</th>
            <th className="text-right px-4 py-2 font-medium">Done</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sorted.map((e) => {
            const pct =
              e.total === 0 ? 0 : Math.round((e.completed / e.total) * 100);
            return (
              <tr key={e.user_id} className="hover:bg-canvas/40">
                <td className="px-4 py-3 text-sm">{e.email}</td>
                <td className="px-4 py-3 text-xs text-muted">
                  {e.via
                    .map((v) =>
                      v === "user"
                        ? "Direct"
                        : v === "team"
                          ? "Team"
                          : "Org-wide"
                    )
                    .join(" · ")}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 max-w-[200px]">
                    <div className="flex-1 h-1.5 bg-canvas rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          pct === 100 ? "bg-emerald-500" : "bg-indigo-600"
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-muted shrink-0">
                      {pct}%
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-xs tabular-nums">
                  {e.completed}/{e.total}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Sequence mode radio for the path inline editor. Strict (default)
 * enforces step ordering at launch; Random allows learners to complete
 * steps in any order. The launch page reads learning_paths.sequence_mode
 * to decide whether to apply the prereq lock when a learner clicks into
 * a course that lives inside a path they're assigned to.
 */
function SequenceModeRadio({
  value,
  onChange,
}: {
  value: "strict" | "random";
  onChange: (next: "strict" | "random") => void;
}) {
  return (
    <div className="block">
      <span className="block text-xs font-medium text-muted mb-1.5">
        How should learners complete the steps?
      </span>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <SequenceOption
          selected={value === "strict"}
          onClick={() => onChange("strict")}
          title="In order (strict)"
          description="Each step unlocks only after the previous one is completed. Best for foundational programs where order matters."
        />
        <SequenceOption
          selected={value === "random"}
          onClick={() => onChange("random")}
          title="Any order (random)"
          description="Learners can take steps in any order they choose. Best for refresher kits or mix-and-match certifications."
        />
      </div>
    </div>
  );
}

function SequenceOption({
  selected,
  onClick,
  title,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left border rounded-xl p-3 transition-colors ${
        selected
          ? "border-ink bg-canvas"
          : "border-line bg-paper hover:border-ink"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-3 h-3 rounded-full border-2 ${
            selected ? "border-ink bg-ink" : "border-line bg-paper"
          }`}
        />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="text-xs text-muted mt-1.5 leading-relaxed">
        {description}
      </div>
    </button>
  );
}
