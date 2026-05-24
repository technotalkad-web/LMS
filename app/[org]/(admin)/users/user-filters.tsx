"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * Filter strip for the /users list page. URL-driven so links stay
 * shareable ("send this filtered view to your colleague"). Three
 * filter dimensions for v0 — the ones that have data on day 1:
 *
 *   ?status=active|inactive|suspended
 *   ?role=super_owner|admin|data_analyst|user
 *   ?team=<team_id>
 *
 * The other 9 filter dimensions (city, state, designation, grade,
 * job_role, line_manager, node_id, date_of_joining range, employee_id)
 * are deferred to ticket #163's post-launch v1 because their fields
 * aren't populated until tenants run their HR data sync. Adding them
 * later doesn't require a URL-schema change — just new params.
 *
 * The hook `readUserFilters` gives the parent component the current
 * filter values (read once from URL on each render — the URL is the
 * source of truth, no duplicate state).
 */

export type UserFilterState = {
  status: "all" | "active" | "inactive" | "suspended";
  role: "all" | "super_owner" | "admin" | "data_analyst" | "user";
  teamId: string; // "" = all teams
};

export type TeamOption = { id: string; name: string };

export function readUserFilters(
  sp: URLSearchParams | ReadonlyURLSearchParams
): UserFilterState {
  const get = (k: string) => sp.get(k) ?? "";
  const status = get("status");
  const role = get("role");
  return {
    status:
      status === "active" || status === "inactive" || status === "suspended"
        ? status
        : "all",
    role:
      role === "super_owner" ||
      role === "admin" ||
      role === "data_analyst" ||
      role === "user"
        ? role
        : "all",
    teamId: get("team"),
  };
}

// next/navigation's useSearchParams returns a ReadonlyURLSearchParams in
// strict typings; ergonomic alias so readUserFilters accepts both shapes.
type ReadonlyURLSearchParams = ReturnType<typeof useSearchParams>;

export function UserFilters({
  teams,
  totalMatching,
  totalAll,
}: {
  teams: TeamOption[];
  totalMatching: number;
  totalAll: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const current = readUserFilters(searchParams);
  const anyActive =
    current.status !== "all" ||
    current.role !== "all" ||
    current.teamId !== "";

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null || value === "" || value === "all") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    const qs = next.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  function clearAll() {
    startTransition(() => {
      router.push(pathname);
    });
  }

  const statusChips: Array<{
    key: UserFilterState["status"];
    label: string;
    tone: string;
  }> = [
    { key: "all", label: "All", tone: "border-line text-ink" },
    {
      key: "active",
      label: "Active",
      tone: "border-emerald-300 text-emerald-800",
    },
    { key: "inactive", label: "Inactive", tone: "border-line text-muted" },
    {
      key: "suspended",
      label: "Suspended",
      tone: "border-red-300 text-red-800",
    },
  ];

  const roleChips: Array<{
    key: UserFilterState["role"];
    label: string;
  }> = [
    { key: "all", label: "All roles" },
    { key: "super_owner", label: "Super owner" },
    { key: "admin", label: "Admin" },
    { key: "data_analyst", label: "Data analyst" },
    { key: "user", label: "Learner" },
  ];

  return (
    <div className={`space-y-2 ${isPending ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">
          Status
        </span>
        <div className="flex flex-wrap gap-1.5">
          {statusChips.map((c) => {
            const active = current.status === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => updateParam("status", c.key)}
                className={`px-2.5 py-0.5 rounded-full border text-xs transition-colors ${
                  active
                    ? "bg-ink text-canvas border-ink"
                    : `bg-paper hover:bg-canvas ${c.tone}`
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">
          Role
        </span>
        <div className="flex flex-wrap gap-1.5">
          {roleChips.map((c) => {
            const active = current.role === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => updateParam("role", c.key)}
                className={`px-2.5 py-0.5 rounded-full border text-xs transition-colors ${
                  active
                    ? "bg-ink text-canvas border-ink"
                    : "bg-paper border-line text-ink hover:bg-canvas"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">
          Team
        </span>
        <select
          value={current.teamId}
          onChange={(e) => updateParam("team", e.target.value || null)}
          className="px-3 py-1 border border-line rounded-lg bg-canvas text-xs outline-none focus:border-ink"
        >
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        {anyActive && (
          <button
            type="button"
            onClick={clearAll}
            className="ml-auto text-[11px] text-muted hover:text-ink px-2 py-0.5 rounded hover:bg-canvas"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="text-[11px] text-muted tabular-nums pt-1">
        Showing{" "}
        <span className="text-ink font-medium">
          {totalMatching.toLocaleString()}
        </span>{" "}
        of {totalAll.toLocaleString()}
        {anyActive && " matching filters"}
      </div>
    </div>
  );
}
