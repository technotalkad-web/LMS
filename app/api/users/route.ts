import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";
import { checkQuota } from "@/lib/billing/enforce-quota";

/**
 *   POST /api/users
 *   body: see CreateUserBody below.
 *
 * Creates a brand-new user OR adds an existing-by-email user to this org.
 * If `password` is provided, the account is provisioned immediately.
 * If `password` is blank, the system auto-generates one and sends a
 * Supabase magic-link invitation email so the user can set their own.
 */

type CreateUserBody = {
  orgSlug: string;
  // Personal
  first_name: string;
  last_name?: string;
  username?: string;
  email: string;
  password?: string;
  gender?: "male" | "female" | "other" | "prefer_not_to_say" | "";
  date_of_birth?: string;
  phone?: string;
  // Org context
  employee_id: string;
  status?: "active" | "inactive" | "suspended";
  date_of_joining?: string;
  grade?: string;
  designation?: string;
  job_role?: string;
  line_manager_id?: string;
  indirect_manager_id?: string;
  lms_role: "user" | "data_analyst" | "admin" | "super_owner";
  node_id: string;
  city?: string;
  state?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_LMS_ROLES = ["user", "data_analyst", "admin", "super_owner"] as const;
const VALID_STATUSES = ["active", "inactive", "suspended"] as const;
const VALID_GENDERS = ["male", "female", "other", "prefer_not_to_say"] as const;

function randomPassword(): string {
  // 24 chars, mixed alphanumeric. Strong enough as a one-time bootstrap;
  // the user will reset it via the invite link.
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Partial<CreateUserBody>;

  // ---- Required-field validation ----
  const missing: string[] = [];
  if (!body.orgSlug) missing.push("orgSlug");
  if (!body.first_name?.trim()) missing.push("first_name");
  if (!body.email?.trim()) missing.push("email");
  if (!body.employee_id?.trim()) missing.push("employee_id");
  if (!body.lms_role) missing.push("lms_role");
  if (!body.node_id?.trim()) missing.push("node_id");
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(", ")}` },
      { status: 400 }
    );
  }
  const email = body.email!.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }
  if (!VALID_LMS_ROLES.includes(body.lms_role as (typeof VALID_LMS_ROLES)[number])) {
    return NextResponse.json({ error: "Invalid lms_role" }, { status: 400 });
  }
  const status =
    body.status && VALID_STATUSES.includes(body.status as (typeof VALID_STATUSES)[number])
      ? body.status
      : "active";
  const gender =
    body.gender && VALID_GENDERS.includes(body.gender as (typeof VALID_GENDERS)[number])
      ? body.gender
      : null;

  const password = body.password?.trim() || "";
  const wantsInvite = password.length === 0;
  if (!wantsInvite && password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  // ---- Auth: caller must be admin in this org ----
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, slug, allowed_email_domains")
    .eq("slug", body.orgSlug!)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const { data: callerMem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", caller.id)
    .maybeSingle();
  const cr = callerMem?.role as string | undefined;
  const canWrite =
    cr === "super_owner" || cr === "owner" || cr === "admin";
  if (!canWrite) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (body.lms_role === "super_owner" && cr !== "super_owner" && cr !== "owner") {
    return NextResponse.json(
      { error: "Only super owners can appoint other super owners" },
      { status: 403 }
    );
  }

  // ---- Plan/quota enforcement (Phase 10b) ----
  const quota = await checkQuota(org.id as string, "users");
  if (!quota.ok) {
    return NextResponse.json({ error: quota.message, reason: quota.reason }, { status: 402 });
  }

  // ---- Domain restriction ----
  const allowed = ((org.allowed_email_domains ?? []) as string[])
    .map((d) => d.toLowerCase().trim())
    .filter(Boolean);
  if (allowed.length > 0) {
    const domain = email.split("@")[1] ?? "";
    if (!allowed.includes(domain)) {
      return NextResponse.json(
        {
          error: `Email domain "${domain}" is not allowed. Allowed: ${allowed.join(", ")}`,
        },
        { status: 400 }
      );
    }
  }

  // ---- Service-role client for admin auth operations ----
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ---- Find or create the auth.user ----
  let authUserId: string | null = null;
  let didInvite = false;

  // Look up by email first.
  const { data: existing } = await svc.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const found = existing?.users?.find(
    (u) => u.email?.toLowerCase() === email
  );

  if (found) {
    authUserId = found.id;
  } else if (wantsInvite) {
    // Generate the auth row + email a magic link.
    const { data: inv, error: invErr } = await svc.auth.admin.inviteUserByEmail(email);
    if (invErr || !inv?.user) {
      return NextResponse.json(
        { error: invErr?.message ?? "Could not invite user" },
        { status: 400 }
      );
    }
    authUserId = inv.user.id;
    didInvite = true;
  } else {
    const { data: created, error: createErr } = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      return NextResponse.json(
        { error: createErr?.message ?? "Could not create user" },
        { status: 400 }
      );
    }
    authUserId = created.user.id;
  }

  if (!authUserId) {
    return NextResponse.json({ error: "Could not provision user" }, { status: 500 });
  }

  // ---- Upsert the profile (global, per-user) ----
  const username = body.username?.trim() || email;
  // When the admin let us auto-generate the password (wantsInvite = true)
  // OR didn't supply one and we synthesized a temp, force first-login
  // password change. Existing accounts (found) preserve their current flag.
  const mustChangePassword = wantsInvite && !found;
  // NOTE: `profiles` uses `id` as the PK (Supabase starter schema), NOT
  // `user_id`. Keep in sync with lib/auth/must-change-password.ts and
  // app/api/super/tenants/[id]/admins/route.ts.
  const profilePayload = {
    id: authUserId,
    email, // NOT NULL in profiles — must be set on insert
    first_name: body.first_name!.trim(),
    last_name: body.last_name?.trim() || null,
    username,
    gender,
    date_of_birth: body.date_of_birth?.trim() || null,
    phone: body.phone?.trim() || null,
    must_change_password: mustChangePassword,
  };
  const { error: profileErr } = await svc
    .from("profiles")
    .upsert(profilePayload, { onConflict: "id" });
  if (profileErr) {
    return NextResponse.json(
      { error: `Profile write failed: ${profileErr.message}` },
      { status: 400 }
    );
  }

  // ---- Insert the membership (per-org) ----
  // Check if the user is already a member — if so, update; otherwise insert.
  const { data: priorMem } = await svc
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id)
    .eq("user_id", authUserId)
    .maybeSingle();

  const membershipPayload = {
    organization_id: org.id,
    user_id: authUserId,
    role: body.lms_role,
    employee_id: body.employee_id!.trim(),
    status,
    date_of_joining: body.date_of_joining?.trim() || null,
    grade: body.grade?.trim() || null,
    designation: body.designation?.trim() || null,
    job_role: body.job_role?.trim() || null,
    line_manager_id: body.line_manager_id?.trim() || null,
    indirect_manager_id: body.indirect_manager_id?.trim() || null,
    node_id: body.node_id!.trim(),
    city: body.city?.trim() || null,
    state: body.state?.trim() || null,
  };

  const memOp = priorMem
    ? svc
        .from("organization_members")
        .update(membershipPayload)
        .eq("organization_id", org.id)
        .eq("user_id", authUserId)
    : svc.from("organization_members").insert(membershipPayload);

  const { error: memErr } = await memOp;
  if (memErr) {
    return NextResponse.json(
      { error: `Membership write failed: ${memErr.message}` },
      { status: 400 }
    );
  }

  // Fire welcome / account-creation email (background, non-blocking).
  if (!priorMem) {
    // Derive origin from the incoming request headers (same fix as #145
    // and the broadcast endpoint). NEXT_PUBLIC_SITE_URL is inlined at
    // build time and was producing http://localhost:3000 in the welcome
    // email's sign-in link. Headers are always live and work on staging,
    // prod, and any future custom domain with no rebuild.
    const h = await headers();
    const reqProto = h.get("x-forwarded-proto") ?? "https";
    const reqHost = h.get("host") ?? h.get("x-forwarded-host") ?? "";
    const origin = reqHost ? `${reqProto}://${reqHost}` : "";
    await notifyBackground({
      organizationId: org.id,
      event: "account_creation",
      to: { user_id: authUserId, email },
      context: {
        learner_name:
          body.first_name?.trim() +
          (body.last_name ? " " + body.last_name.trim() : ""),
        learner_email: email,
        username,
        login_id: email,
        // 3-way: invited via magic link / existing user with their own
        // password / brand-new account where we generated the password.
        password: didInvite
          ? "(set via the invite link)"
          : found
          ? "(use your existing password)"
          : password,
        portal_url: origin
          ? `${origin}/${org.slug}/dashboard`
          : `/${org.slug}/dashboard`,
        // {Org_Name} placeholder needs `org_name` in context — was
        // missing, so the welcome email rendered "Welcome to {Org_Name}"
        // and "— The {Org_Name} team" with the literal placeholder.
        org_name: org.name,
      },
    });
  }

  return NextResponse.json({
    user_id: authUserId,
    invited: didInvite,
  });
}
