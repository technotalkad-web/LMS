/**
 * Service-role Supabase helpers for E2E tests.
 *
 * These bypass RLS — they exist to seed and tear down test data. The
 * actual app-under-test still goes through normal auth + RLS; we only
 * use the service role from inside test code, never from a page.
 *
 * Naming conventions (so teardown can find what to delete), the QA
 * namespace of ./namespace.ts:
 *   - emails:  qa+<purpose>-<rand>@example.test
 *   - slugs:   qa-<purpose>-<rand>
 *   - org names: "QA Org <rand>"
 * The lifecycle suite uses its own namespace (tests/bot/lifecycle/data.ts),
 * which purgeAllTestData() never matches.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";
import {
  QA_NAMESPACE,
  isNamespaceEmail,
  namespaceEmail,
  namespaceSlug,
  orgSlugLike,
  otpEmailLike,
} from "./namespace";

export const TEST_EMAIL_DOMAIN = QA_NAMESPACE.emailDomain;
export const TEST_PREFIX = QA_NAMESPACE.prefix;

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
  return namespaceEmail(QA_NAMESPACE, purpose, rand());
}

export function testSlug(purpose = "org"): string {
  return namespaceSlug(QA_NAMESPACE, purpose, rand());
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
// ATTEMPT FIXTURES: the learning context of a seeded course_attempts row
// ---------------------------------------------------------------------------

/** The context columns of a fixture attempt; spread into the insert after the row. */
export type FixtureAttemptContext =
  | { context_kind: "individual" }
  | { context_kind: "path"; learning_path_id: string }
  | { context_kind: "journey"; journey_enrollment_id: string; journey_day: number; journey_day_id: string }
  | { context_kind: "preview"; is_preview: true; preview_kind: "legacy_role" };

const given = (v: unknown) => v !== undefined && v !== null;

/**
 * The context columns of a fixture attempt (ADR 0024 steps 5 and 64), from
 * the row's own flags, so every service-role insert of a fixture names
 * `context_kind` and never relies on 0107's paste-window derive trigger
 * (which 0108 drops; each firing is counted in context_derive_log).
 *
 *   is_preview true            → preview, preview_kind 'legacy_role' (the
 *                                by-role kind), with no official tag and
 *                                no journey_day_id: a new preview never
 *                                carries an official tag (ADR 0024 step 6;
 *                                the check would admit old tags on a
 *                                legacy_role row, the helper does not)
 *   journey_enrollment_id      → journey, with journey_day and journey_day_id
 *   learning_path_id           → path
 *   otherwise                  → individual
 *
 * The order is 0107's backfill and derive order. What is returned passes
 * course_attempts_context_shape_chk on its own, with the row's tags; a
 * pairing the check refuses throws here, before the database is asked.
 * Never returned: context_key, a generated column an insert may not name;
 * journey_version_id, which may stay null on a fixture.
 *
 * Usage: `.insert({ ...row, ...fixtureAttemptContext(row) })`, the spread
 * written inside the insert (tests/unit/attempt-insert-sites.test.ts reads it).
 */
export function fixtureAttemptContext(flags: Readonly<Record<string, unknown>> = {}): FixtureAttemptContext {
  for (const col of ["context_kind", "context_key", "preview_kind", "preview_run_id", "journey_version_id"]) {
    if (given(flags[col])) throw new Error(`fixtureAttemptContext: the row names ${col}; the helper derives the context from the flags`);
  }
  const path = flags.learning_path_id;
  const enrollment = flags.journey_enrollment_id;
  const day = flags.journey_day;
  const dayId = flags.journey_day_id;
  const journeyTags = [enrollment, day, dayId].filter(given).length;
  if (flags.is_preview === true) {
    if (given(dayId)) {
      throw new Error("fixtureAttemptContext: a legacy_role preview has no journey_day_id (0107's shape check)");
    }
    if (given(path) || given(enrollment) || given(day)) {
      throw new Error("fixtureAttemptContext: a preview fixture carries no official tag (ADR 0024 step 6)");
    }
    return { context_kind: "preview", is_preview: true, preview_kind: "legacy_role" };
  }
  if (given(path) && journeyTags > 0) {
    throw new Error("fixtureAttemptContext: one tag per attempt (0107 refuses a path tag with a journey tag)");
  }
  if (journeyTags > 0) {
    if (typeof enrollment !== "string" || typeof day !== "number" || typeof dayId !== "string") {
      throw new Error("fixtureAttemptContext: a journey fixture needs journey_enrollment_id, journey_day and journey_day_id (the journey_days row id)");
    }
    return { context_kind: "journey", journey_enrollment_id: enrollment, journey_day: day, journey_day_id: dayId };
  }
  if (given(path)) {
    if (typeof path !== "string") throw new Error("fixtureAttemptContext: learning_path_id must be a path id");
    return { context_kind: "path", learning_path_id: path };
  }
  return { context_kind: "individual" };
}

// ---------------------------------------------------------------------------
// CLEANUP
// ---------------------------------------------------------------------------

/**
 * Delete every row created by the E2E suite. Idempotent. Safe to run on
 * any environment because it only touches rows that match the qa-* /
 * @example.test naming convention (QA_NAMESPACE). It never matches the
 * lifecycle namespace (lifecycle-* / @lifecycle.test): a pr-checks run no
 * longer wipes a lifecycle run's data (tests/unit/test-data-namespace.test.ts
 * runs this function against a recording fake client).
 */
export async function purgeAllTestData(client?: SupabaseClient): Promise<{
  users: number;
  orgs: number;
  otps: number;
}> {
  const s = client ?? svc();

  // 1. Auth users with our test domain.
  const { data: list } = await s.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const testUsers =
    list?.users?.filter((u) => isNamespaceEmail(QA_NAMESPACE, u.email)) ?? [];
  for (const u of testUsers) {
    await s.auth.admin.deleteUser(u.id).catch(() => {});
  }

  // 2. Orgs with qa- slugs (this cascades to organization_members).
  const { data: orgs } = await s
    .from("organizations")
    .select("id, slug")
    .like("slug", orgSlugLike(QA_NAMESPACE));
  const orgIds = (orgs ?? []).map((o) => o.id as string);
  if (orgIds.length > 0) {
    // Logged, not thrown: a refusal here (for example the 0098 delete guard,
    // if the service-role exemption ever stopped matching) must be visible
    // in the CI log instead of leaving qa-* orgs behind in silence, but it
    // must not fail an otherwise green run.
    const { error } = await s.from("organizations").delete().in("id", orgIds);
    if (error) {
      console.error(`[purgeAllTestData] deleting ${orgIds.length} qa-* org(s) failed: ${error.message}`);
    }
  }

  // 3. Stray OTP rows.
  const { count: otpCount } = await s
    .from("password_reset_otps")
    .delete({ count: "exact" })
    .like("email", otpEmailLike(QA_NAMESPACE));

  return {
    users: testUsers.length,
    orgs: orgIds.length,
    otps: otpCount ?? 0,
  };
}
