import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/tickets
 *   body: { orgSlug, subject, body?, priority? }
 *
 * Anyone in the org can submit a ticket.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    subject?: string;
    body?: string;
    priority?: "low" | "normal" | "high";
  };
  if (!body.orgSlug || !body.subject?.trim()) {
    return NextResponse.json(
      { error: "orgSlug and subject required" },
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

  const priority = body.priority && ["low", "normal", "high"].includes(body.priority)
    ? body.priority
    : "normal";

  const { data, error } = await supabase
    .from("help_tickets")
    .insert({
      organization_id: org.id,
      user_id: user.id,
      subject: body.subject.trim(),
      body: body.body?.trim() || null,
      priority,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data?.id });
}
