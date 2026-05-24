import { createClient as createServiceClient } from "@supabase/supabase-js";
import { Megaphone } from "lucide-react";
import { BroadcastsManager, type BroadcastRow } from "./broadcasts-manager";

export const dynamic = "force-dynamic";

export default async function BroadcastsPage() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data } = await svc
    .from("platform_broadcasts")
    .select("*")
    .order("posted_at", { ascending: false })
    .limit(200);

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    body_md: r.body_md as string,
    tone: (r.tone as BroadcastRow["tone"]) ?? "info",
    audience: (r.audience as BroadcastRow["audience"]) ?? "all",
    dismissable: (r.dismissable as boolean) ?? true,
    is_active: (r.is_active as boolean) ?? true,
    posted_at: r.posted_at as string,
    expires_at: (r.expires_at as string | null) ?? null,
  })) as BroadcastRow[];

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
          <Megaphone className="w-7 h-7 text-indigo-600" /> Global broadcasts
        </h1>
        <p className="text-slate-500 mt-1">
          Platform-wide announcements rendered as a top-bar banner inside every tenant. Pick an audience and a tone, set an expiry, and ship.
        </p>
      </header>
      <BroadcastsManager initial={rows} />
    </div>
  );
}
