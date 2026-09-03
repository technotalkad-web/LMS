"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Plus, RefreshCw, Trash2, Users, X } from "lucide-react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  parseGroupRules,
  summarizeRules,
  type GroupRow,
  type GroupRules,
} from "@/lib/org/groups";

export type MemberOption = { user_id: string; name: string; email: string };

const EMPTY_RULES: GroupRules = {};

/** One rules dimension: collapsible checkbox list (module-level so inputs
 *  keep identity across renders — see the podium ColorField lesson). */
function RuleDim({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; display: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (options.length === 0) return null;
  return (
    <details className="border border-line rounded-lg">
      <summary className="px-3 py-2 text-xs font-medium cursor-pointer select-none flex items-center justify-between">
        <span>{label}</span>
        <span className={selected.length > 0 ? "text-indigo-700 font-bold" : "text-muted"}>
          {selected.length > 0 ? `${selected.length} selected` : "any"}
        </span>
      </summary>
      <div className="px-3 pb-2 max-h-44 overflow-y-auto space-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, o.value]
                    : selected.filter((v) => v !== o.value)
                )
              }
              className="h-3.5 w-3.5 accent-indigo-600"
            />
            <span className="truncate">{o.display}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function RulesEditor({
  rules,
  onChange,
  ruleOptions,
  teams,
  managers,
}: {
  rules: GroupRules;
  onChange: (r: GroupRules) => void;
  ruleOptions: Record<string, string[]>;
  teams: Array<{ id: string; name: string }>;
  managers: Array<{ id: string; name: string }>;
}) {
  const dim = (k: keyof GroupRules) => (next: string[]) =>
    onChange({ ...rules, [k]: next.length > 0 ? next : undefined });
  const vals = (field: string) =>
    (ruleOptions[field] ?? []).map((v) => ({ value: v, display: v }));
  return (
    <div className="space-y-2">
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <RuleDim label="Designations" options={vals("designation")} selected={rules.designations ?? []} onChange={dim("designations")} />
        <RuleDim label="Job roles" options={vals("job_role")} selected={rules.job_roles ?? []} onChange={dim("job_roles")} />
        <RuleDim label="Cities" options={vals("city")} selected={rules.cities ?? []} onChange={dim("cities")} />
        <RuleDim label="States" options={vals("state")} selected={rules.states ?? []} onChange={dim("states")} />
        <RuleDim label="Business verticals" options={vals("business_vertical")} selected={rules.verticals ?? []} onChange={dim("verticals")} />
        <RuleDim label="Branches" options={vals("branch")} selected={rules.branches ?? []} onChange={dim("branches")} />
        <RuleDim label="Teams" options={teams.map((t) => ({ value: t.id, display: t.name }))} selected={rules.team_ids ?? []} onChange={dim("team_ids")} />
        <RuleDim label="L1 managers" options={managers.map((m) => ({ value: m.id, display: m.name }))} selected={rules.l1_manager_ids ?? []} onChange={dim("l1_manager_ids")} />
        <label className="border border-line rounded-lg px-3 py-2 block">
          <span className="block text-xs font-medium mb-1">Joined within (days)</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={rules.joined_within_days ?? ""}
            onChange={(e) =>
              onChange({
                ...rules,
                joined_within_days:
                  e.target.value === ""
                    ? undefined
                    : Math.max(1, Math.min(3650, Number(e.target.value) || 1)),
              })
            }
            placeholder="any"
            className="w-full px-2 py-1.5 border border-line rounded-lg bg-canvas text-xs tabular-nums"
          />
        </label>
      </div>
      <p className="text-[11px] text-muted">
        Filters combine with AND; an untouched filter matches everyone.
        Membership is computed live — new matching employees join and leavers
        drop out automatically.
      </p>
    </div>
  );
}

export function GroupsClient({
  orgSlug,
  groups,
  creatorNames,
  ruleOptions,
  teams,
  managers,
  members,
}: {
  orgSlug: string;
  groups: GroupRow[];
  creatorNames: Record<string, string>;
  ruleOptions: Record<string, string[]>;
  teams: Array<{ id: string; name: string }>;
  managers: Array<{ id: string; name: string }>;
  members: MemberOption[];
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewMembers, setViewMembers] = useState<MemberOption[]>([]);
  // Create/edit form state.
  const [fName, setFName] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fType, setFType] = useState<"dynamic" | "static">("dynamic");
  const [fRules, setFRules] = useState<GroupRules>(EMPTY_RULES);
  const [preview, setPreview] = useState<{ count: number; sample: MemberOption[] } | null>(null);
  // Static membership picker.
  const [pickerFilter, setPickerFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const api = async (method: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/org/groups", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, ...body }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: string;
      };
      if (!res.ok) {
        toast.error(j.error ?? "Request failed");
        return null;
      }
      return j;
    } catch {
      toast.error("Request failed — check your connection");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () => {
    setCreating(true);
    setEditingId(null);
    setFName("");
    setFDesc("");
    setFType("dynamic");
    setFRules(EMPTY_RULES);
    setPreview(null);
  };
  const openEdit = (g: GroupRow) => {
    setEditingId(g.id);
    setCreating(false);
    setFName(g.name);
    setFDesc(g.description ?? "");
    setFType(g.group_type);
    setFRules(parseGroupRules(g.rules));
    setPreview(null);
  };
  const closeForm = () => {
    setCreating(false);
    setEditingId(null);
    setPreview(null);
  };

  const runPreview = async () => {
    const j = await api("POST", { action: "preview", rules: fRules });
    if (j) setPreview({ count: j.count as number, sample: (j.sample as MemberOption[]) ?? [] });
  };

  const submit = async () => {
    if (!fName.trim()) {
      toast.error("Give the group a name");
      return;
    }
    const j = editingId
      ? await api("PATCH", {
          group_id: editingId,
          name: fName,
          description: fDesc,
          ...(fType === "dynamic" ? { rules: fRules } : {}),
        })
      : await api("POST", {
          name: fName,
          description: fDesc,
          group_type: fType,
          rules: fRules,
        });
    if (j) {
      toast.success(editingId ? "Group updated" : "Group created");
      closeForm();
      router.refresh();
    }
  };

  const duplicate = async (g: GroupRow) => {
    const j = await api("POST", {
      name: `${g.name} (copy)`,
      description: g.description ?? "",
      group_type: g.group_type,
      rules: parseGroupRules(g.rules),
    });
    if (j) {
      toast.success("Group duplicated");
      router.refresh();
    }
  };

  const refresh = async (g: GroupRow) => {
    const j = await api("POST", { action: "refresh_count", group_id: g.id });
    if (j) {
      toast.success(`${j.count} member${j.count === 1 ? "" : "s"} right now`);
      router.refresh();
    }
  };

  const toggleActive = async (g: GroupRow) => {
    const j = await api("PATCH", { group_id: g.id, is_active: !(g.is_active !== false) });
    if (j) {
      toast.success(g.is_active !== false ? "Group deactivated" : "Group activated");
      router.refresh();
    }
  };

  const remove = async (g: GroupRow) => {
    const ok = await confirm({
      title: `Delete "${g.name}"?`,
      message:
        "The group is removed everywhere it's used as an audience. Learning already assigned through it is not un-assigned.",
      confirmText: "Delete group",
      destructive: true,
    });
    if (!ok) return;
    const j = await api("DELETE", { group_id: g.id });
    if (j) {
      toast.success("Group deleted");
      if (viewingId === g.id) setViewingId(null);
      router.refresh();
    }
  };

  const view = async (g: GroupRow) => {
    if (viewingId === g.id) {
      setViewingId(null);
      return;
    }
    const j = await api("POST", { action: "members", group_id: g.id });
    if (j) {
      setViewingId(g.id);
      setViewMembers((j.members as MemberOption[]) ?? []);
    }
  };

  const addPicked = async (g: GroupRow) => {
    if (picked.length === 0) return;
    const j = await api("POST", { action: "add_members", group_id: g.id, user_ids: picked });
    if (j) {
      toast.success(`${j.added} added`);
      setPicked([]);
      const m = await api("POST", { action: "members", group_id: g.id });
      if (m) setViewMembers((m.members as MemberOption[]) ?? []);
      router.refresh();
    }
  };

  const removeOne = async (g: GroupRow, userId: string) => {
    const j = await api("POST", { action: "remove_members", group_id: g.id, user_ids: [userId] });
    if (j) {
      setViewMembers((ms) => ms.filter((m) => m.user_id !== userId));
      router.refresh();
    }
  };

  const teamNames = new Map(teams.map((t) => [t.id, t.name]));
  const managerNames = new Map(managers.map((m) => [m.id, m.name]));
  const formOpen = creating || editingId !== null;

  return (
    <div className="max-w-5xl">
      <AdminPageHeader
        title="Custom Groups"
        description="Reusable audiences built from the employee database. Create a group once — target announcements, journeys and filters with it everywhere."
      />

      <div className="flex justify-end mb-4">
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold"
        >
          <Plus className="w-4 h-4" /> New group
        </button>
      </div>

      {formOpen && (
        <section className="border border-indigo-200 bg-indigo-50/40 rounded-2xl p-5 mb-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{editingId ? "Edit group" : "Create group"}</h2>
            <button type="button" onClick={closeForm} aria-label="Close" className="text-muted hover:text-ink">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid sm:grid-cols-[1fr_1fr_180px] gap-3">
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-muted mb-1">Name</span>
              <input
                type="text"
                value={fName}
                maxLength={80}
                onChange={(e) => setFName(e.target.value)}
                placeholder="e.g. Mumbai Retail Sales Advisors"
                className="w-full px-3 py-2 border border-line rounded-lg bg-paper text-sm outline-none focus:border-ink"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-muted mb-1">Description</span>
              <input
                type="text"
                value={fDesc}
                maxLength={300}
                onChange={(e) => setFDesc(e.target.value)}
                className="w-full px-3 py-2 border border-line rounded-lg bg-paper text-sm outline-none focus:border-ink"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-muted mb-1">Type</span>
              <select
                value={fType}
                onChange={(e) => setFType(e.target.value as "dynamic" | "static")}
                disabled={!!editingId}
                className="w-full px-3 py-2 border border-line rounded-lg bg-paper text-sm disabled:opacity-60"
              >
                <option value="dynamic">Dynamic — rule-based</option>
                <option value="static">Static — hand-picked</option>
              </select>
            </label>
          </div>

          {fType === "dynamic" ? (
            <>
              <RulesEditor
                rules={fRules}
                onChange={(r) => {
                  setFRules(r);
                  setPreview(null);
                }}
                ruleOptions={ruleOptions}
                teams={teams}
                managers={managers}
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={busy}
                  className="px-3 py-1.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50 rounded-lg text-xs font-semibold disabled:opacity-50"
                >
                  Preview members
                </button>
                {preview && (
                  <span className="text-xs text-muted">
                    <strong className="text-ink">{preview.count}</strong> match
                    {preview.sample.length > 0 && (
                      <> — {preview.sample.map((s) => s.name).join(", ")}
                        {preview.count > preview.sample.length ? "…" : ""}</>
                    )}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">
              Create the group first, then add members from its row below
              (View members → Add).
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Saving…" : editingId ? "Save changes" : "Create group"}
            </button>
          </div>
        </section>
      )}

      {groups.length === 0 && !formOpen ? (
        <div className="border border-line rounded-2xl bg-paper text-center py-14 px-6">
          <Users className="w-10 h-10 mx-auto text-muted opacity-40" />
          <h2 className="mt-4 font-semibold">No groups yet</h2>
          <p className="text-muted text-sm mt-1 max-w-md mx-auto">
            Groups turn your employee database into reusable audiences —
            &ldquo;Mumbai Retail Sales Advisors&rdquo; in three clicks, usable
            across announcements, journeys and filters.
          </p>
        </div>
      ) : (
        <div className="bg-paper border border-line rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line">
                <th className="px-4 py-3">Group</th>
                <th className="px-4 py-3 hidden sm:table-cell">Type</th>
                <th className="px-4 py-3 hidden md:table-cell">Criteria</th>
                <th className="px-4 py-3 text-right">Members</th>
                <th className="px-4 py-3 hidden lg:table-cell">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {groups.map((g) => (
                <GroupRowView
                  key={g.id}
                  g={g}
                  creator={g.created_by ? creatorNames[g.created_by] ?? "—" : "—"}
                  criteria={
                    g.group_type === "static"
                      ? "Hand-picked"
                      : summarizeRules(parseGroupRules(g.rules), {
                          teams: teamNames,
                          managers: managerNames,
                        })
                  }
                  viewing={viewingId === g.id}
                  viewMembers={viewMembers}
                  members={members}
                  pickerFilter={pickerFilter}
                  setPickerFilter={setPickerFilter}
                  picked={picked}
                  setPicked={setPicked}
                  busy={busy}
                  onEdit={() => openEdit(g)}
                  onDuplicate={() => duplicate(g)}
                  onRefresh={() => refresh(g)}
                  onToggle={() => toggleActive(g)}
                  onDelete={() => remove(g)}
                  onView={() => view(g)}
                  onAddPicked={() => addPicked(g)}
                  onRemoveOne={(uid) => removeOne(g, uid)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GroupRowView({
  g,
  creator,
  criteria,
  viewing,
  viewMembers,
  members,
  pickerFilter,
  setPickerFilter,
  picked,
  setPicked,
  busy,
  onEdit,
  onDuplicate,
  onRefresh,
  onToggle,
  onDelete,
  onView,
  onAddPicked,
  onRemoveOne,
}: {
  g: GroupRow;
  creator: string;
  criteria: string;
  viewing: boolean;
  viewMembers: MemberOption[];
  members: MemberOption[];
  pickerFilter: string;
  setPickerFilter: (v: string) => void;
  picked: string[];
  setPicked: (v: string[]) => void;
  busy: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onRefresh: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onView: () => void;
  onAddPicked: () => void;
  onRemoveOne: (uid: string) => void;
}) {
  const inactive = g.is_active === false;
  const inGroup = new Set(viewMembers.map((m) => m.user_id));
  const pickable = members.filter(
    (m) =>
      !inGroup.has(m.user_id) &&
      (pickerFilter.trim() === "" ||
        m.name.toLowerCase().includes(pickerFilter.toLowerCase()) ||
        m.email.toLowerCase().includes(pickerFilter.toLowerCase()))
  );
  return (
    <>
      <tr className={inactive ? "opacity-60" : undefined}>
        <td className="px-4 py-3">
          <div className="font-medium">
            {g.name}
            {inactive && (
              <span className="ml-2 text-[10px] font-bold uppercase bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full">
                Inactive
              </span>
            )}
          </div>
          {g.description && (
            <div className="text-[11px] text-muted truncate max-w-[260px]">{g.description}</div>
          )}
        </td>
        <td className="px-4 py-3 hidden sm:table-cell">
          <span
            className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full ${
              g.group_type === "dynamic"
                ? "bg-indigo-100 text-indigo-700"
                : "bg-emerald-100 text-emerald-700"
            }`}
          >
            {g.group_type}
          </span>
        </td>
        <td className="px-4 py-3 hidden md:table-cell text-xs text-muted max-w-[240px] truncate" title={criteria}>
          {criteria}
        </td>
        <td className="px-4 py-3 text-right tabular-nums font-semibold">
          {g.member_count ?? "—"}
        </td>
        <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted">
          {creator} · {new Date(g.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-1.5 text-muted">
            <button type="button" onClick={onView} title="View members" className="p-1.5 rounded hover:bg-canvas hover:text-ink">
              <Users className="w-4 h-4" />
            </button>
            <button type="button" onClick={onRefresh} disabled={busy} title="Refresh member count" className="p-1.5 rounded hover:bg-canvas hover:text-ink disabled:opacity-50">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button type="button" onClick={onDuplicate} disabled={busy} title="Duplicate" className="p-1.5 rounded hover:bg-canvas hover:text-ink disabled:opacity-50">
              <Copy className="w-4 h-4" />
            </button>
            <button type="button" onClick={onEdit} title="Edit" className="px-2 py-1 rounded text-xs font-medium hover:bg-canvas hover:text-ink">
              Edit
            </button>
            <button type="button" onClick={onToggle} disabled={busy} title={inactive ? "Activate" : "Deactivate"} className="px-2 py-1 rounded text-xs font-medium hover:bg-canvas hover:text-ink disabled:opacity-50">
              {inactive ? "Activate" : "Deactivate"}
            </button>
            <button type="button" onClick={onDelete} disabled={busy} title="Delete" className="p-1.5 rounded hover:bg-red-50 hover:text-red-700 disabled:opacity-50">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </td>
      </tr>
      {viewing && (
        <tr>
          <td colSpan={6} className="px-4 pb-4 bg-canvas/50">
            <div className="pt-3">
              <p className="text-xs font-semibold mb-2">
                {viewMembers.length} member{viewMembers.length === 1 ? "" : "s"}
                {g.group_type === "dynamic" && (
                  <span className="text-muted font-normal"> — resolved live from the rules just now</span>
                )}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {viewMembers.map((m) => (
                  <span
                    key={m.user_id}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-paper border border-line rounded-full text-xs"
                    title={m.email}
                  >
                    {m.name}
                    {g.group_type === "static" && (
                      <button
                        type="button"
                        onClick={() => onRemoveOne(m.user_id)}
                        aria-label={`Remove ${m.name}`}
                        className="text-muted hover:text-red-700"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                ))}
                {viewMembers.length === 0 && (
                  <span className="text-xs text-muted">Nobody yet.</span>
                )}
              </div>
              {g.group_type === "static" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={pickerFilter}
                    onChange={(e) => setPickerFilter(e.target.value)}
                    placeholder="Search members to add…"
                    className="px-3 py-1.5 border border-line rounded-lg bg-paper text-xs w-56"
                  />
                  <select
                    multiple
                    value={picked}
                    onChange={(e) =>
                      setPicked(Array.from(e.target.selectedOptions).map((o) => o.value))
                    }
                    className="px-2 py-1.5 border border-line rounded-lg bg-paper text-xs min-w-[220px] max-h-28"
                    size={Math.min(5, Math.max(2, pickable.length))}
                  >
                    {pickable.slice(0, 200).map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.name} ({m.email})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={onAddPicked}
                    disabled={busy || picked.length === 0}
                    className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50"
                  >
                    Add {picked.length > 0 ? `(${picked.length})` : ""}
                  </button>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
