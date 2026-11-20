import { resolveEmailsStrict } from "@/lib/users/emails";
import { NextResponse } from "next/server";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { auditLog, requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";
import { sendPlatformEmail, type PlatformSendResult } from "@/lib/email/platform-sender";
import { membershipCounts } from "@/lib/auth/org-membership";
import {
  HAS_A_WAY_IN_MESSAGE,
  SETUP_LINKS_NEED_0117,
  SETUP_LINKS_PER_DAY,
  SETUP_LINK_DAYS,
  createAccountForSetupLink,
  issueSetupLink,
  platformSetupLinkOffers,
  platformSetupLinkResendCheck,
  setupLinksReady,
} from "@/lib/auth/setup-link";
import {
  expireLaunchTokensForMembers,
  logLaunchTokenExpiryFailed,
  LAUNCH_TOKENS_NOT_EXPIRED_ON_REMOVE,
} from "@/lib/attempts/abandon";
import { originFromRequest } from "@/lib/http/origin";

/**
 * The console's administrators of a tenant (ADR 0029 step 15, section N
 * rules N4, N8 and N12; ADR 0030 rules 9 and 10).
 *
 *   GET     the administrators, each with the status of their row and
 *           whether "Send setup link again" is offered for them;
 *   POST    add one. A new account is created with no password (the address
 *           alone) and issued a setup link; the platform sender mails it in
 *           platform_admin_welcome. The answer says whether the welcome was
 *           sent and holds the link only when it was not (rule N8). An
 *           account that already existed is added as before and mailed
 *           nothing. Without migration 0117 a new account is refused before
 *           anything is created; an existing one is added as before;
 *   PUT     "Send setup link again" (rule N12): a new link, the older one
 *           ended, for an administrator the console created with a link who
 *           has never signed in, at most three in 24 hours;
 *   PATCH   the role only;
 *   DELETE  remove the row.
 *
 * No answer, log line or audit row holds a password, and no audit row holds
 * a link.
 */

const ADMIN_ROLES = new Set(["super_owner", "admin", "data_analyst"]);
type AdminRole = "super_owner" | "admin" | "data_analyst";

const TRY_AGAIN = "Could not check this right now. Please try again.";

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/** What an answer says of the welcome: sent, or not sent with its class (the platform sender's code). */
type WelcomeAnswer = { status: "sent" } | { status: "not_sent"; class: string };

/**
 * Mail the welcome with its setup link, through the platform sender only.
 * Never throws: a content check that fails (no absolute address to build the
 * link on) is "not sent", as a failed send is.
 */
async function sendWelcome(args: {
  userId: string;
  email: string;
  org: { id: string; name: string; slug: string };
  role: AdminRole;
  setupLink: string;
  origin: string;
}): Promise<WelcomeAnswer> {
  let result: PlatformSendResult;
  try {
    result = await sendPlatformEmail({
      event: "platform_admin_welcome",
      to: { userId: args.userId, email: args.email, platformOwner: false },
      organizationId: args.org.id,
      content: {
        organizationName: args.org.name,
        signInUrl: `${args.origin}/${args.org.slug}/login`,
        role: args.role,
        setupLink: args.setupLink,
        days: SETUP_LINK_DAYS,
      },
    });
  } catch {
    return { status: "not_sent", class: "unknown" };
  }
  if (result.status === "sent") return { status: "sent" };
  return { status: "not_sent", class: result.errorCode ?? "unknown" };
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

  // The addresses are shown, never mailed, from this read: one that fails
  // shows "(unknown)" for everyone rather than a partial list.
  const ids = rows.map((r) => r.user_id);
  const [emails, offered] = await Promise.all([resolveEmailsStrict(s, ids), platformSetupLinkOffers(s, tenantId, ids)]);
  const emailById = emails === "unreadable" ? new Map<string, string>() : emails;

  return NextResponse.json({
    admins: rows.map((r) => ({
      user_id: r.user_id,
      role: r.role,
      status: r.status,
      email: emailById.get(r.user_id) ?? "(unknown)",
      setup_link: offered.has(r.user_id),
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

  // Whether the account is new decides whether an account, a link and a
  // welcome are made, so a failed read is never "no account" (ADR 0029,
  // stage 2's one rule): nothing is made and the console is asked to try
  // again. One page of up to 1,000 accounts, as before ADR 0027's slice 2.
  let listed: Awaited<ReturnType<typeof s.auth.admin.listUsers>> | null;
  try {
    listed = await s.auth.admin.listUsers({ page: 1, perPage: 1000 });
  } catch {
    listed = null;
  }
  if (!listed || listed.error || !Array.isArray(listed.data?.users)) {
    return NextResponse.json({ error: TRY_AGAIN }, { status: 503 });
  }
  let user = listed.data.users.find((u) => u.email?.toLowerCase() === email);
  let isBrandNew = false;

  if (!user) {
    // A new account gets a setup link (rule N9), which needs migration 0117:
    // without the table nothing is created (section J).
    const ready = await setupLinksReady(s);
    if (ready === "missing") return NextResponse.json({ error: SETUP_LINKS_NEED_0117 }, { status: 503 });
    if (ready === "unreadable") return NextResponse.json({ error: TRY_AGAIN }, { status: 503 });
    const created = await createAccountForSetupLink(s, email);
    if ("error" in created) {
      return NextResponse.json({ error: created.error }, { status: 400 });
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

  // profiles uses `id` as the FK to auth.users(id) in this DB. The forced
  // change is never set: a new account has no password to change, and a
  // found account's flag is left as it is.
  await s
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email, // NOT NULL in profiles — must be set on insert
        first_name: email.split("@")[0],
        username: email,
        ...(isBrandNew ? { must_change_password: false } : {}),
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
  let welcome: WelcomeAnswer | null = null;
  let setupLink: string | null = null;
  if (isBrandNew) {
    // The link's row is written whether or not the welcome then goes (ADR
    // 0029 section Q, point 6), so "Send setup link again" can follow.
    const issued = await issueSetupLink(s, { userId: user.id, organizationId: tenantId, issuer: "platform", issuedBy: guard.userId, origin });
    if (!issued.ok) {
      welcome = { status: "not_sent", class: "link_failed" };
    } else if (!membershipCounts({ status: "active" }, org)) {
      // ADR 0030 rule 10: the row is written active, so only a deleted
      // organisation sends none. No link is returned: rule N14 (a) would
      // refuse it at once.
      welcome = { status: "not_sent", class: "inactive" };
    } else {
      welcome = await sendWelcome({ userId: user.id, email, org, role: role as AdminRole, setupLink: issued.url, origin });
      // Rule N8: the link is returned only when the welcome was not sent.
      if (welcome.status !== "sent") setupLink = issued.url;
    }
  }

  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.add_admin",
    targetType: "organization",
    targetId: tenantId,
    metadata: {
      email,
      role,
      brand_new: isBrandNew,
      reactivated,
      previous_status: previousStatus,
      welcome: welcome ? (welcome.status === "sent" ? "sent" : welcome.class) : null,
    },
  });

  return NextResponse.json({
    ok: true,
    user_id: user.id,
    invited: isBrandNew,
    reactivated,
    email_outcome: welcome,
    ...(setupLink ? { setup_link: setupLink } : {}),
    login_url: `${origin}/${org.slug}/login`,
  });
}

/** The answer of "Send setup link again" when a check refuses it. */
function refusal(check: "missing" | "unreadable" | "has_way_in" | "limit") {
  if (check === "missing") return NextResponse.json({ error: SETUP_LINKS_NEED_0117 }, { status: 503 });
  if (check === "unreadable") return NextResponse.json({ error: TRY_AGAIN }, { status: 503 });
  if (check === "limit") {
    return NextResponse.json(
      { error: `At most ${SETUP_LINKS_PER_DAY} setup links in 24 hours for one person. Try again later.` },
      { status: 429 }
    );
  }
  return NextResponse.json({ error: HAS_A_WAY_IN_MESSAGE }, { status: 409 });
}

/** The tenant and the person's row in it; null when either read failed. */
async function readTenantRow(s: SupabaseClient, tenantId: string, userId: string) {
  const orgRead = await s.from("organizations").select("id, name, slug, deleted_at").eq("id", tenantId).maybeSingle();
  if (orgRead.error) return null;
  const memberRead = await s
    .from("organization_members")
    .select("role, status")
    .eq("organization_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberRead.error) return null;
  return {
    org: orgRead.data as { id: string; name: string; slug: string; deleted_at: string | null } | null,
    member: memberRead.data as { role: string | null; status: string | null } | null,
  };
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id: tenantId } = await params;
  const body = (await request.json().catch(() => ({}))) as { user_id?: unknown };
  const userId = typeof body.user_id === "string" ? body.user_id : "";
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

  const s = svc();
  const read = await readTenantRow(s, tenantId, userId);
  if (!read) return refusal("unreadable");
  if (!read.org) return NextResponse.json({ error: "Org not found" }, { status: 404 });
  const { org, member } = read;
  if (!member || !ADMIN_ROLES.has(member.role ?? "")) return refusal("has_way_in");

  const check = await platformSetupLinkResendCheck(s, tenantId, userId);
  if (check !== "ok") return refusal(check);

  // Rule N12 with ADR 0030 rule 10: a row that does not count gets no link,
  // and no new row is written. The console makes the person active first.
  if (!membershipCounts(member, org)) {
    return NextResponse.json({ ok: true, email_outcome: { status: "not_sent", class: "inactive" } });
  }

  const emails = await resolveEmailsStrict(s, [userId]);
  if (emails === "unreadable") return refusal("unreadable");
  const email = emails.get(userId);
  if (!email) return NextResponse.json({ error: "This person has no email address on file." }, { status: 409 });

  const origin = await originFromRequest();
  const issued = await issueSetupLink(s, { userId, organizationId: tenantId, issuer: "platform", issuedBy: guard.userId, origin });
  if (!issued.ok) return refusal(issued.missing ? "missing" : "unreadable");
  const welcome = await sendWelcome({ userId, email, org, role: member.role as AdminRole, setupLink: issued.url, origin });

  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.resend_setup_link",
    targetType: "organization",
    targetId: tenantId,
    metadata: { user_id: userId, welcome: welcome.status === "sent" ? "sent" : welcome.class },
  });

  return NextResponse.json({
    ok: true,
    email_outcome: welcome,
    ...(welcome.status !== "sent" ? { setup_link: issued.url } : {}),
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
