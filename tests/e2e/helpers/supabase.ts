/**
 * Service-role Supabase helpers for E2E tests.
 *
 * These bypass RLS — they exist to seed and tear down test data. The
 * actual app-under-test still goes through normal auth + RLS; we only
 * use the service role from inside test code, never from a page.
 *
 * Naming conventions (so teardown can find what to delete):
 *   - emails:  qa+<purpose>-<rand>@example.test
 *   - slugs:   qa-<rand>
 *   - org names: "QA Org <rand>"
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";

export const TEST_EMAIL_DOMAIN = "example.test";
export const TEST_PREFIX = "qa";

let _svc: SupabaseClient | null = null;
export function svc(): SupabaseClient {
  if (_svc) return _svc;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Copy .env.test.example to .env.test.local and fill in your STAGING project's keys."
    );
  }
  _svc = createClient(url, key, { auth: { persistSession: false } });
  return _svc;
}

/** Short random suffix for unique test data. */
export function rand(n = 6): string {
  return randomBytes(8).toString("hex").slice(0, n);
}

export function testEmail(purpose: string): string {
  return `${TEST_PREFIX}+${purpose}-${rand()}@${TEST_EMAIL_DOMAIN}`;
}

export function testSlug(purpose = "org"): string {
  return `${TEST_PREFIX}-${purpose}-${rand()}`;
}

// ---------------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------------

export interface SeededUser {
  id: string;
  email: string;
  password: string;
}

export async function createAuthUser(opts: {
  email?: string;
  password?: string;
  emailConfirm?: boolean;
  profile?: {
    first_name?: string;
    last_name?: string;
    must_change_password?: boolean;
  };
}): Promise<SeededUser> {
  const email = opts.email ?? testEmail("user");
  const password = opts.password ?? `Test!${rand(10)}Aa1`;
  const { data, error } = await svc().auth.admin.createUser({
    email,
    password,
    email_confirm: opts.emailConfirm ?? true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthUser failed: ${error?.message ?? "no user"}`);
  }
  // Upsert profile row — the app stores first_name etc. in `profiles`.
  // NOTE: this DB uses `id` as profiles PK (Supabase starter schema), not
  // `user_id`. `email` is NOT NULL, so we must pass it on first insert.
  const { error: profErr } = await svc()
    .from("profiles")
    .upsert(
      {
        id: data.user.id,
        email,
        first_name: opts.profile?.first_name ?? "QA",
        last_name: opts.profile?.last_name ?? "Tester",
        must_change_password: opts.profile?.must_change_password ?? false,
      },
      { onConflict: "id" }
    );
  if (profErr) {
    throw new Error(`createAuthUser profile upsert failed: ${profErr.message}`);
  }
  return { id: data.user.id, email, password };
}

export async function deleteAuthUser(userId: string): Promise<void> {
  await svc().auth.admin.deleteUser(userId).catch(() => {});
}

// ---------------------------------------------------------------------------
// ORGS
// ---------------------------------------------------------------------------

export interface SeededOrg {
  id: string;
  name: string;
  slug: string;
}

export async function createOrg(opts?: { name?: string; slug?: string }): Promise<SeededOrg> {
  const slug = opts?.slug ?? testSlug();
  const name = opts?.name ?? `QA Org ${rand(4)}`;
  const { data, error } = await svc()
    .from("organizations")
    .insert({ name, slug })
    .select("id, name, slug")
    .single();
  if (error || !data) throw new Error(`createOrg failed: ${error?.message}`);
  return data;
}

export async function addMember(opts: {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "super_owner" | "data_analyst" | "user";
  employee_id?: string;
  node_id?: string;
}): Promise<void> {
  const { error } = await svc()
    .from("organization_members")
    .upsert(
      {
        organization_id: opts.organizationId,
        user_id: opts.userId,
        role: opts.role,
        employee_id: opts.employee_id ?? `EMP-${rand(4)}`,
        node_id: opts.node_id ?? null,
        status: "active",
      },
      { onConflict: "organization_id,user_id" }
    );
  if (error) throw new Error(`addMember failed: ${error.message}`);
}

export async function markPlatformOwner(userId: string): Promise<void> {
  const { error } = await svc()
    .from("platform_owners")
    .upsert({ user_id: userId, mfa_required: false }, { onConflict: "user_id" });
  if (error) throw new Error(`markPlatformOwner failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// FORGOT-PASSWORD: read the latest OTP for an email so the test can submit it.
// We read the hash and brute-force-compare against the recently-issued code
// — but since the app also logs the code in dev mode, the more reliable
// approach is to set TEST_OTP_OVERRIDE in the API for E2E. Until then,
// we expose `getLatestOtpRow` so tests can validate side effects.
// ---------------------------------------------------------------------------

export interface OtpRow {
  id: string;
  email: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
}

export async function getLatestOtpRow(email: string): Promise<OtpRow | null> {
  const { data } = await svc()
    .from("password_reset_otps")
    .select("*")
    .eq("email", email.toLowerCase())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as OtpRow) ?? null;
}

/**
 * For tests we need the *plaintext* OTP code. The app intentionally only
 * stores the sha-256 hash. Three options for tests:
 *   (1) Read the code from the Next.js dev-server stdout (brittle).
 *   (2) Add a TEST_OTP_BYPASS env that, when set, makes /verify accept
 *       any code (or a fixed "000000"). NOT RECOMMENDED in any shared
 *       environment.
 *   (3) Generate the OTP server-side in test code, hash it, insert the
 *       row directly, then submit the plaintext to /verify.
 *
 * Option (3) is what we do here. It bypasses /request entirely but
 * still exercises /verify and /reset.
 */
export async function seedOtp(email: string): Promise<string> {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  // Invalidate prior codes for this email.
  await svc()
    .from("password_reset_otps")
    .update({ used_at: new Date().toISOString() })
    .eq("email", email.toLowerCase())
    .is("used_at", null);
  const { error } = await svc().from("password_reset_otps").insert({
    email: email.toLowerCase(),
    code_hash: codeHash,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`seedOtp failed: ${error.message}`);
  return code;
}

// ---------------------------------------------------------------------------
// CLEANUP
// ---------------------------------------------------------------------------

/**
 * Delete every row created by the E2E suite. Idempotent. Safe to run on
 * any environment because it only touches rows that match the qa-* /
 * @example.test naming convention.
 */
export async function purgeAllTestData(): Promise<{
  users: number;
  orgs: number;
  otps: number;
}> {
  const s = svc();

  // 1. Auth users with our test domain.
  const { data: list } = await s.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const testUsers =
    list?.users?.filter((u) => u.email?.endsWith(`@${TEST_EMAIL_DOMAIN}`)) ?? [];
  for (const u of testUsers) {
    await s.auth.admin.deleteUser(u.id).catch(() => {});
  }

  // 2. Orgs with qa- slugs (this cascades to organization_members).
  const { data: orgs } = await s
    .from("organizations")
    .select("id, slug")
    .like("slug", `${TEST_PREFIX}-%`);
  const orgIds = (orgs ?? []).map((o) => o.id as string);
  if (orgIds.length > 0) {
    await s.from("organizations").delete().in("id", orgIds);
  }

  // 3. Stray OTP rows.
  const { count: otpCount } = await s
    .from("password_reset_otps")
    .delete({ count: "exact" })
    .like("email", `${TEST_PREFIX}+%@${TEST_EMAIL_DOMAIN}`);

  return {
    users: testUsers.length,
    orgs: orgIds.length,
    otps: otpCount ?? 0,
  };
}
