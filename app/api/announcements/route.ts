import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/announcements
 *   body: { orgSlug, title, body?, tone?, expires_at? }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    title?: string;
    body?: string;
    tone?: string;
    expires_at?: string;
  };
  if (!body.orgSlug || !body.title?.trim()) {
    return NextResponse.json(
      { error: "orgSlug and title required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const tone =
    body.tone && ["info", "success", "warning", "critical"].includes(body.tone)
      ? body.tone
      : "info";

  const { data, error } = await supabase
    .from("org_announcements")
    .insert({
      organization_id: org.id,
      title: body.title.trim(),
      body: body.body?.trim() || null,
      tone,
      expires_at: body.expires_at?.trim() || null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ id: data?.id });
}
