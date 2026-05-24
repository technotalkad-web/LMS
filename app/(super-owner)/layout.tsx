import Link from "next/link";
import {
  ShieldAlert,
  Building2,
  Database,
  Activity,
  Users,
  Megaphone,
} from "lucide-react";
import { requirePlatformOwner } from "@/lib/auth/require-platform-owner";

export default async function SuperOwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await requirePlatformOwner();

  return (
    <div className="min-h-screen flex font-sans text-slate-900 bg-slate-100">
      <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col fixed h-full z-10">
        <div className="h-16 flex items-center px-6 bg-slate-950 border-b border-slate-800">
          <ShieldAlert className="w-6 h-6 text-emerald-500 mr-2" />
          <span className="font-bold text-white tracking-wide">LMS SYSTEM</span>
        </div>
        <div className="p-4">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">
            Master Controls
          </p>
          <nav className="space-y-1">
            <SidebarLink href="/super/organizations" icon={<Building2 className="w-4 h-4" />} label="Organizations" />
            <SidebarLink href="/super/plans" icon={<Database className="w-4 h-4" />} label="Plans & Billing" />
            <SidebarLink href="/super/broadcasts" icon={<Megaphone className="w-4 h-4" />} label="Global Broadcasts" />
            <SidebarLink href="/super/audit" icon={<Activity className="w-4 h-4" />} label="System Audit Logs" />
            <SidebarLink href="/super/admins" icon={<Users className="w-4 h-4" />} label="Super Admins" />
          </nav>
        </div>

        <div className="mt-auto p-4 bg-slate-950/50 border-t border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center border border-emerald-500/50">
              <ShieldAlert className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-white truncate">
                {user.email ?? "Platform owner"}
              </p>
              <p className="text-xs text-slate-400">Restricted access</p>
            </div>
          </div>
          <form action="/auth/sign-out" method="post" className="mt-3">
            <button
              type="submit"
              className="w-full text-xs text-slate-400 hover:text-white text-left"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="ml-64 flex-1 p-8 min-h-screen">{children}</main>
    </div>
  );
}

function SidebarLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition"
    >
      {icon}
      {label}
    </Link>
  );
}
