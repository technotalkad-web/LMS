import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/announcements/impression
 *   body: { orgSlug, announcement_id, event: "shown" | "dismissed" | "clicked" }
 *
 * Learner-owned popup telemetry (0068): "shown" inserts an impression row;
 * "dismissed"/"clicked" stamp the latest one. Powers the once/daily
 * frequency rules and admin analytics. RLS restricts rows to the caller.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    announcement_id?: string;
    event?: string;
  };
  if (!body.orgSlug || !body.announcement_id) {
    return NextResponse.json(
      { error: "orgSlug and announcement_id required" },
      { status: 400 }
    );
  }
  const event = ["shown", "dismissed", "clicked"].includes(body.event ?? "")
    ? (body.event as "shown" | "dismissed" | "clicked")
    : null;
  if (!event) return NextResponse.json({ error: "Invalid event" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  // The announcement must be a popup in THIS org (members can read active
  // announcements under RLS — a null read means wrong org or inactive).
  const { data: ann } = await supabase
    .from("org_announcements")
    .select("id")
    .eq("id", body.announcement_id)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!ann) return NextResponse.json({ error: "Announcement not found" }, { status: 404 });

  if (event === "shown") {
    const { error } = await supabase.from("announcement_impressions").insert({
      organization_id: org.id,
      announcement_id: body.announcement_id,
      user_id: user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // dismissed / clicked → stamp the caller's most recent impression.
  const { data: latest } = await supabase
    .from("announcement_impressions")
    .select("id")
    .eq("announcement_id", body.announcement_id)
    .eq("user_id", user.id)
    .order("shown_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest) {
    await supabase
      .from("announcement_impressions")
      .update(
        event === "dismissed"
          ? { dismissed_at: new Date().toISOString() }
          : { clicked_at: new Date().toISOString() }
      )
      .eq("id", latest.id);
  }
  return NextResponse.json({ ok: true });
}
