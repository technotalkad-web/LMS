/**
 * Test-data helpers for the lifecycle suite: the e2e service-role helpers
 * bound to the LIFECYCLE namespace (tests/e2e/helpers/namespace.ts):
 * organisation slugs `lifecycle-<purpose>-<rand>`, emails
 * `lifecycle+<purpose>-<rand>@lifecycle.test`.
 *
 * Why: the e2e purge (purgeAllTestData, run by pr-checks e2e on every push
 * and pull request and by nightly-e2e) deletes every qa-* organisation and
 * every @example.test user on staging. Lifecycle data in that namespace was
 * wiped in the middle of a run (2026-10-18: spec 48 "restarted 0", spec 52
 * "Organization not found"). The purge never matches this namespace; the
 * lifecycle global setup removes it once it is older than 48 h
 * (./cleanup.ts).
 *
 * Specs import the seeding helpers from here, never from
 * ../../e2e/helpers/supabase.
 */
import * as base from "../../e2e/helpers/supabase";
import {
  LIFECYCLE_NAMESPACE,
  isNamespaceSlug,
  namespaceEmail,
  namespaceSlug,
} from "../../e2e/helpers/namespace";

export { addMember, deleteAuthUser, markPlatformOwner, rand, svc } from "../../e2e/helpers/supabase";
export type { SeededOrg, SeededUser } from "../../e2e/helpers/supabase";

export const NAMESPACE = LIFECYCLE_NAMESPACE;

export function testEmail(purpose: string): string {
  return namespaceEmail(LIFECYCLE_NAMESPACE, purpose, base.rand());
}

export function testSlug(purpose = "org"): string {
  return namespaceSlug(LIFECYCLE_NAMESPACE, purpose, base.rand());
}

/** True for a slug this module generates (what specs assert on their seeded orgs). */
export function isLifecycleSlug(slug: string): boolean {
  return isNamespaceSlug(LIFECYCLE_NAMESPACE, slug);
}

export function createOrg(opts?: { name?: string; slug?: string }): Promise<base.SeededOrg> {
  return base.createOrg({ ...opts, slug: opts?.slug ?? testSlug() });
}

export function createAuthUser(opts: Parameters<typeof base.createAuthUser>[0]): Promise<base.SeededUser> {
  return base.createAuthUser({ ...opts, email: opts.email ?? testEmail("user") });
}
