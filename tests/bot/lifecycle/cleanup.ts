/**
 * Bounded cleanup of the lifecycle namespace on STAGING (./data.ts):
 * lifecycle organisations older than 48 h (their courses, versions,
 * attempts and members go by cascade; the 0098 delete guard exempts the
 * service_role claim, spec 50 "purge path"), then @lifecycle.test auth users
 * and password-reset OTP rows older than 48 h.
 *
 * The lifecycle global setup (./setup.ts) runs it before every lifecycle run
 * (by hand or lifecycle-nightly.yml), so data from earlier runs is swept and
 * the last 48 h stay for inspection. It refuses to run unless
 * NEXT_PUBLIC_SUPABASE_URL is the staging project, and prints counts and
 * error codes only (the CI log is public).
 *
 * Only slugs of the shape data.ts generates (`lifecycle-<purpose>-<6 hex>`)
 * are deleted: a hand-made staging org that merely starts with `lifecycle-`
 * (say `lifecycle-academy`) is counted as kept, never deleted.
 *
 * Accepted staging debt: the deleted organisations' package files stay in
 * the staging storage bucket (the e2e purge has the same gap). The fixture
 * packages are a few KB each; see tests/bot/README.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { svc } from "../../e2e/helpers/supabase";
import {
  LIFECYCLE_NAMESPACE,
  isNamespaceEmail,
  orgSlugLike,
  otpEmailLike,
} from "../../e2e/helpers/namespace";

export const STAGING_PROJECT_REF = "zeaclbapadosqqttexxh";
export const CLEANUP_MIN_AGE_HOURS = 48;

/** Per-run bounds: a run never deletes more than this, whatever it finds. */
export const CLEANUP_MAX_ORGS = 200;
export const CLEANUP_MAX_USERS = 500;
const USER_PAGE_SIZE = 1000;
const USER_MAX_PAGES = 20;

/** True only for https://<staging ref>.supabase.co (no other host, port or scheme). */
export function isStagingSupabaseUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === `${STAGING_PROJECT_REF}.supabase.co` && u.port === "";
  } catch {
    return false;
  }
}

/**
 * The slug shape data.ts generates: `<prefix>-<purpose>-<rand>`, where the
 * purpose is lower-case words joined by dashes (`org`, `th-invite`) and rand
 * is base.rand(), six lower-case hex characters.
 */
const escapedPrefix = LIFECYCLE_NAMESPACE.prefix.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
const GENERATED_SLUG = new RegExp(`^${escapedPrefix}-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}$`);
export function isGeneratedLifecycleSlug(slug: string | null | undefined): boolean {
  return !!slug && GENERATED_SLUG.test(slug);
}

export function cleanupCutoff(now: Date, hours = CLEANUP_MIN_AGE_HOURS): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

/** An auth user in scope: a lifecycle email, created before the cutoff. */
export function isExpiredLifecycleUser(
  u: { email?: string | null; created_at?: string | null },
  cutoff: Date
): boolean {
  if (!isNamespaceEmail(LIFECYCLE_NAMESPACE, u.email) || !u.created_at) return false;
  const t = Date.parse(u.created_at);
  return Number.isFinite(t) && t < cutoff.getTime();
}

export interface CleanupResult {
  dryRun: boolean;
  /** kept: `lifecycle-` slugs not of the generated shape, never deleted. */
  orgs: { matched: number; deleted: number; failed: number; kept: number };
  users: { matched: number; deleted: number; failed: number };
  otps: { deleted: number };
  /** A per-run bound was reached: more expired data may remain for the next run. */
  capped: Array<"orgs" | "users">;
  /** Distinct error codes or statuses (never messages: they name tables). */
  errors: string[];
  /** Matched ids, for assertions in tests; formatCleanup() never prints them. */
  ids: { orgs: string[]; users: string[] };
}

export async function cleanupLifecycleData(
  opts: { now?: Date; dryRun?: boolean; client?: SupabaseClient } = {}
): Promise<CleanupResult> {
  if (!isStagingSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    throw new Error(
      `[lifecycle-cleanup] refused: NEXT_PUBLIC_SUPABASE_URL is not the staging project (${STAGING_PROJECT_REF}).`
    );
  }
  const dryRun = opts.dryRun ?? false;
  const cutoff = cleanupCutoff(opts.now ?? new Date());
  const s = opts.client ?? svc();
  const errors = new Set<string>();
  const res: CleanupResult = {
    dryRun,
    orgs: { matched: 0, deleted: 0, failed: 0, kept: 0 },
    users: { matched: 0, deleted: 0, failed: 0 },
    otps: { deleted: 0 },
    capped: [],
    errors: [],
    ids: { orgs: [], users: [] },
  };

  // 1. Organisations first: the cascade removes their attempts and members,
  // so the users below hold no rows that could block their delete. Newest
  // expired first: an org whose delete keeps failing ages to the back of
  // the queue instead of holding the per-run bound against newer ones.
  const { data: orgs, error: orgErr } = await s
    .from("organizations")
    .select("id, slug")
    .like("slug", orgSlugLike(LIFECYCLE_NAMESPACE))
    .lt("created_at", cutoff.toISOString())
    .order("created_at", { ascending: false })
    .limit(CLEANUP_MAX_ORGS);
  if (orgErr) errors.add(`orgs.select:${orgErr.code ?? "error"}`);
  const rows = (orgs ?? []) as Array<{ id: string; slug: string | null }>;
  if (rows.length >= CLEANUP_MAX_ORGS) res.capped.push("orgs");
  const orgIds = rows.filter((o) => isGeneratedLifecycleSlug(o.slug)).map((o) => o.id);
  res.orgs.kept = rows.length - orgIds.length;
  res.orgs.matched = orgIds.length;
  res.ids.orgs = orgIds;
  if (!dryRun) {
    // One at a time, so one refused cascade does not keep the rest.
    for (const id of orgIds) {
      const { error } = await s.from("organizations").delete().eq("id", id);
      if (error) {
        res.orgs.failed++;
        errors.add(`orgs.delete:${error.code ?? "error"}`);
      } else {
        res.orgs.deleted++;
      }
    }
  }

  // 2. Auth users on the lifecycle domain, older than the cutoff.
  const expired: string[] = [];
  for (let page = 1; page <= USER_MAX_PAGES && expired.length < CLEANUP_MAX_USERS; page++) {
    const { data, error } = await s.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE });
    if (error) {
      errors.add(`users.list:${error.status ?? "error"}`);
      break;
    }
    const users = data?.users ?? [];
    for (const u of users) if (isExpiredLifecycleUser(u, cutoff)) expired.push(u.id);
    if (users.length < USER_PAGE_SIZE) break;
  }
  if (expired.length >= CLEANUP_MAX_USERS) res.capped.push("users");
  const userIds = expired.slice(0, CLEANUP_MAX_USERS);
  res.users.matched = userIds.length;
  res.ids.users = userIds;
  if (!dryRun) {
    for (const id of userIds) {
      const { error } = await s.auth.admin.deleteUser(id);
      if (error) {
        res.users.failed++;
        errors.add(`users.delete:${error.status ?? "error"}`);
      } else {
        res.users.deleted++;
      }
    }
  }

  // 3. Stray OTP rows of lifecycle emails.
  if (!dryRun) {
    const { count, error } = await s
      .from("password_reset_otps")
      .delete({ count: "exact" })
      .like("email", otpEmailLike(LIFECYCLE_NAMESPACE))
      .lt("created_at", cutoff.toISOString());
    if (error) errors.add(`otps.delete:${error.code ?? "error"}`);
    res.otps.deleted = count ?? 0;
  }

  res.errors = [...errors].sort();
  return res;
}

/**
 * One log line: counts and error codes only. scripts/lifecycle-nightly.sh
 * reads it: `failed=` above 0, `errors=` or `capped=` raise a warning.
 */
export function formatCleanup(r: CleanupResult): string {
  const o = r.orgs, u = r.users;
  return (
    `[lifecycle-cleanup] ${r.dryRun ? "dry run, " : ""}older than ${CLEANUP_MIN_AGE_HOURS} h: ` +
    `orgs matched=${o.matched} deleted=${o.deleted} failed=${o.failed} kept=${o.kept}; ` +
    `users matched=${u.matched} deleted=${u.deleted} failed=${u.failed}; ` +
    `otps deleted=${r.otps.deleted}` +
    (r.capped.length ? `; capped=${r.capped.join(",")}` : "") +
    (r.errors.length ? `; errors=${r.errors.join(",")}` : "")
  );
}
