import { resolveEmails } from "@/lib/users/emails";
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog, requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";
import { notifyBackground } from "@/lib/notifications/send";
import { membershipCounts } from "@/lib/auth/org-membership";
import {
  expireLaunchTokensForMembers,
  logLaunchTokenExpiryFailed,
  LAUNCH_TOKENS_NOT_EXPIRED_ON_REMOVE,
} from "@/lib/attempts/abandon";
import { originFromRequest } from "@/lib/http/origin";

function generateTempPassword(): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = randomBytes(16);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const ADMIN_ROLES = new Set(["super_owner", "admin", "data_analyst"]);

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id: tenantId } = await params;
  const s = svc();

  // Each row's status is returned with it: an administrator whose row is
  // not active has no access to the tenant, and the console shows that.
  const { data: members } = await s
    .from("organization_members")
    .select("user_id, role, status")
    .eq("organization_id", tenantId);

  const rows = ((members ?? []) as Array<{ user_id: string; role: string; status: string }>).filter(
    (m) => ADMIN_ROLES.has(m.role)
  );

  const emailById = await resolveEmails(s, rows.map((r) => r.user_id));

  return NextResponse.json({
    admins: rows.map((r) => ({
      user_id: r.user_id,
      role: r.role,
      status: r.status,
      email: emailById.get(r.user_id) ?? "(unknown)",
    })),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id: tenantId } = await params;

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    role?: string;
  };
  const email = body.email?.trim().toLowerCase();
  const role = body.role;
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (!role || !ADMIN_ROLES.has(role)) {
    return NextResponse.json(
      { error: "role must be super_owner, admin, or data_analyst" },
      { status: 400 }
    );
  }

  const s = svc();

  const { data: orgRaw } = await s
    .from("organizations")
    .select("id, name, slug, deleted_at")
    .eq("id", tenantId)
    .maybeSingle();
  if (!orgRaw) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  const org = orgRaw as { id: string; name: string; slug: string; deleted_at: string | null };

  const { data: listed } = await s.auth.admin.listUsers({ page: 1, perPage: 1000 });
  let user = listed?.users?.find((u) => u.email?.toLowerCase() === email);
  let isBrandNew = false;
  let tempPassword: string | null = null;

  if (!user) {
    tempPassword = generateTempPassword();
    const { data: created, error } = await s.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    });
    if (error || !created?.user) {
      return NextResponse.json(
        { error: error?.message ?? "Could not create user" },
        { status: 400 }
      );
    }
    user = created.user;
    isBrandNew = true;
  }

  // The add is a deliberate act that sets the row active, so it brings back
  // a person whose row was inactive or suspended. Read the row it replaces
  // first, so the audit row can say so. An account made just now has no row.
  // A failed read is not "no row": nothing is written.
  let previousStatus: string | null = null;
  if (!isBrandNew) {
    const { data: prior, error: priorErr } = await s
      .from("organization_members")
      .select("status")
      .eq("organization_id", tenantId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (priorErr) {
      return NextResponse.json(
        { error: "Could not read this person's membership. Please try again." },
        { status: 503 }
      );
    }
    previousStatus = (prior as { status?: string | null } | null)?.status ?? null;
  }
  const reactivated = previousStatus !== null && previousStatus !== "active";

  // profiles uses `id` as the FK to auth.users(id) in this DB.
  await s
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email, // NOT NULL in profiles — must be set on insert
        first_name: email.split("@")[0],
        username: email,
        must_change_password: isBrandNew,
      },
      { onConflict: "id" }
    );

  const { error: memErr } = await s
    .from("organization_members")
    .upsert(
      { organization_id: tenantId, user_id: user.id, role, status: "active" },
      { onConflict: "organization_id,user_id" }
    );
  if (memErr) {
    return NextResponse.json({ error: memErr.message }, { status: 400 });
  }

  const origin = await originFromRequest();
  // ADR 0030 rule 10: the welcome goes only when the row just written counts.
  // It is written active, so only a deleted organisation sends none; the add
  // itself stands (the console staffs any tenant), and the platform owner
  // still gets the temporary password in this answer.
  if (isBrandNew && tempPassword && membershipCounts({ status: "active" }, org)) {
    const loginUrl = origin
      ? `${origin}/${org.slug}/login`
      : `/${org.slug}/login`;
    await notifyBackground({
      organizationId: org.id,
      event: "account_creation",
      to: { user_id: user.id, email },
      context: {
        learner_name: email,
        learner_email: email,
        username: email,
        login_id: email,
        password: tempPassword,
        org_name: org.name,
        portal_url: loginUrl,
      },
    });
  }

  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.add_admin",
    targetType: "organization",
    targetId: tenantId,
    metadata: { email, role, brand_new: isBrandNew, reactivated, previous_status: previousStatus },
  });

  return NextResponse.json({
    ok: true,
    user_id: user.id,
    invited: isBrandNew,
    reactivated,
    temp_password: tempPassword,
    login_url: `${origin}/${org.slug}/login`,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id: tenantId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    user_id?: string;
    role?: string;
  };
  if (!body.user_id || !body.role || !ADMIN_ROLES.has(body.role)) {
    return NextResponse.json(
      { error: "user_id + valid role required" },
      { status: 400 }
    );
  }
  // The role only. A role change never sets the status: only the add (POST)
  // brings back a row that is not active.
  const { error } = await svc()
    .from("organization_members")
    .update({ role: body.role })
    .eq("organization_id", tenantId)
    .eq("user_id", body.user_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.change_admin_role",
    targetType: "organization",
    targetId: tenantId,
    metadata: { user_id: body.user_id, role: body.role },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id: tenantId } = await params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }
  const s = svc();
  const { error } = await s
    .from("organization_members")
    .delete()
    .eq("organization_id", tenantId)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  // ADR 0030 decision 4: a removal ends that person's open launches in the
  // tenant, as a deactivation does. A failed expiry leaves the removal
  // standing; it is logged with ids only and reported in the answer.
  const tokErr = await expireLaunchTokensForMembers(s, tenantId, [userId]);
  if (tokErr) logLaunchTokenExpiryFailed("super/tenants/[id]/admins DELETE", tenantId, [userId], tokErr);
  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.remove_admin",
    targetType: "organization",
    targetId: tenantId,
    metadata: { user_id: userId },
  });
  return NextResponse.json(
    tokErr ? { ok: true, tokens_expired: false, warnings: [LAUNCH_TOKENS_NOT_EXPIRED_ON_REMOVE] } : { ok: true }
  );
}
