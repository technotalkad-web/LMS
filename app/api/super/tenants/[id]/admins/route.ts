import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/auth/require-platform-owner";
import { notifyBackground } from "@/lib/notifications/send";

function generateTempPassword(): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = randomBytes(16);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const ADMIN_ROLES = new Set(["super_owner", "admin", "data_analyst"]);

async function assertPlatformOwner(): Promise<
  { ok: true; userId: string } | { ok: false; res: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: row } = await svc
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row) {
    return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, userId: user.id };
}

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
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;
  const { id: tenantId } = await params;
  const s = svc();

  const { data: members } = await s
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", tenantId);

  const rows = ((members ?? []) as Array<{ user_id: string; role: string }>).filter(
    (m) => ADMIN_ROLES.has(m.role)
  );

  const { data: listed } = await s.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailById = new Map<string, string>();
  for (const u of listed?.users ?? []) {
    if (u.email) emailById.set(u.id, u.email);
  }

  return NextResponse.json({
    admins: rows.map((r) => ({
      user_id: r.user_id,
      role: r.role,
      email: emailById.get(r.user_id) ?? "(unknown)",
    })),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;
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
    .select("id, name, slug")
    .eq("id", tenantId)
    .maybeSingle();
  if (!orgRaw) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  const org = orgRaw as { id: string; name: string; slug: string };

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
      { organization_id: tenantId, user_id: user.id, role },
      { onConflict: "organization_id,user_id" }
    );
  if (memErr) {
    return NextResponse.json({ error: memErr.message }, { status: 400 });
  }

  if (isBrandNew && tempPassword) {
    const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
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
    metadata: { email, role, brand_new: isBrandNew },
  });

  return NextResponse.json({
    ok: true,
    user_id: user.id,
    invited: isBrandNew,
    temp_password: tempPassword,
    login_url: `${process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? ""}/${org.slug}/login`,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;
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
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;
  const { id: tenantId } = await params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }
  const { error } = await svc()
    .from("organization_members")
    .delete()
    .eq("organization_id", tenantId)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.remove_admin",
    targetType: "organization",
    targetId: tenantId,
    metadata: { user_id: userId },
  });
  return NextResponse.json({ ok: true });
}
