import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   PATCH /api/profile
 *   body: { first_name, last_name, username, gender, date_of_birth, phone }
 *
 * Lets the signed-in user update their OWN personal fields. Cannot touch
 * org-context fields (employee_id, status, lms_role, line_manager, etc.) —
 * those are managed by admins via /api/users/[userId].
 */

const VALID_GENDERS = ["male", "female", "other", "prefer_not_to_say"] as const;

type Body = {
  first_name?: string;
  last_name?: string;
  username?: string;
  gender?: string;
  date_of_birth?: string;
  phone?: string;
};

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as Body;

  // NOTE: profiles PK is `id`, not `user_id` (Supabase starter schema).
  // `email` is NOT NULL on the table — must be included so an upsert that
  // falls through to INSERT (when no row exists yet for this auth user)
  // doesn't violate the constraint. See migration 0027 for the schema
  // reconciliation. user.email should always be present for an authenticated
  // user, but we coalesce to "" as a defensive guard rather than crashing.
  const payload: Record<string, string | null> = {
    id: user.id,
    email: user.email ?? "",
  };
  if (body.first_name !== undefined) {
    const v = body.first_name.trim();
    if (!v) {
      return NextResponse.json(
        { error: "First name cannot be empty" },
        { status: 400 }
      );
    }
    payload.first_name = v;
  }
  if (body.last_name !== undefined)
    payload.last_name = body.last_name.trim() || null;
  if (body.username !== undefined)
    payload.username = body.username.trim() || null;
  if (body.gender !== undefined) {
    const g = body.gender.trim().toLowerCase();
    payload.gender =
      g && VALID_GENDERS.includes(g as (typeof VALID_GENDERS)[number])
        ? g
        : null;
  }
  if (body.date_of_birth !== undefined)
    payload.date_of_birth = body.date_of_birth.trim() || null;
  if (body.phone !== undefined) payload.phone = body.phone.trim() || null;

  // No editable field was supplied → noop. (payload always has id + email
  // as sentinel keys, so length 2 means nothing else was set.)
  if (Object.keys(payload).length === 2) {
    return NextResponse.json({ ok: true, noop: true });
  }

  const { error } = await supabase
    .from("profiles")
    .upsert(payload, { onConflict: "id" });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
