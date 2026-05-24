import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const VALID = [
  "account_creation",
  "asset_assignment",
  "asset_unassignment",
  "asset_completion",
  "asset_reminder",
  "asset_update",
  "custom_broadcast",
  "path_assignment",
  "path_unassignment",
  "path_completion",
] as const;

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    event_type?: string;
    subject?: string;
    body_md?: string;
    is_active?: boolean;
    cta_label?: string;
  };
  if (
    !body.orgSlug ||
    !body.event_type ||
    !VALID.includes(body.event_type as (typeof VALID)[number])
  ) {
    return NextResponse.json(
      { error: "orgSlug and valid event_type required" },
      { status: 400 }
    );
  }
  if (!body.subject?.trim() || !body.body_md?.trim()) {
    return NextResponse.json(
      { error: "subject and body_md required" },
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

  const { error } = await supabase
    .from("notification_templates")
    .upsert(
      {
        organization_id: org.id,
        event_type: body.event_type,
        subject: body.subject.trim(),
        body_md: body.body_md,
        is_active: body.is_active !== false,
        cta_label: body.cta_label?.trim() || null,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      },
      { onConflict: "organization_id,event_type" }
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
