import type { ReactNode } from "react";
import { ShieldAlert, ShieldCheck, BarChart3, User } from "lucide-react";

/**
 * One pill renderer used everywhere a role is displayed in the admin
 * UI. Color-coded by tier. Use the `tone` variant for status badges
 * (active / pending / suspended) where role doesn't apply.
 */
export function RolePill({ role }: { role: string }) {
  const map: Record<string, { cls: string; Icon: typeof User; label: string }> = {
    super_owner: {
      cls: "bg-violet-50 text-violet-700 border-violet-200",
      Icon: ShieldAlert,
      label: "Super owner",
    },
    owner: {
      cls: "bg-violet-50 text-violet-700 border-violet-200",
      Icon: ShieldAlert,
      label: "Super owner",
    },
    admin: {
      cls: "bg-indigo-50 text-indigo-700 border-indigo-200",
      Icon: ShieldCheck,
      label: "Administrator",
    },
    data_analyst: {
      cls: "bg-amber-50 text-amber-700 border-amber-200",
      Icon: BarChart3,
      label: "Data analyst",
    },
    user: {
      cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
      Icon: User,
      label: "Learner",
    },
    member: {
      cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
      Icon: User,
      label: "Learner",
    },
  };
  const v = map[role] ?? {
    cls: "bg-slate-50 text-slate-700 border-slate-200",
    Icon: User,
    label: role,
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${v.cls}`}>
      <v.Icon className="w-3 h-3" />
      {v.label}
    </span>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "active" | "pending" | "suspended" | "neutral" | "warning" | "success";
  children: ReactNode;
}) {
  const map: Record<typeof tone, string> = {
    active: "bg-emerald-50 text-emerald-700 border-emerald-200",
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    suspended: "bg-red-50 text-red-700 border-red-200",
    neutral: "bg-slate-50 text-slate-700 border-slate-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${map[tone]}`}>
      {children}
    </span>
  );
}
