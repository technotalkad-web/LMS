/**
 * Test-data namespaces on STAGING. Pure: no client, no env, so the unit test
 * (tests/unit/test-data-namespace.test.ts) checks the exact patterns the
 * purge and the lifecycle cleanup send to the database.
 *
 *   QA         the e2e and bot suites (tests/e2e/helpers/supabase.ts).
 *              purgeAllTestData() deletes ALL of it at the global setup and
 *              teardown of every pr-checks e2e run (every push and pull
 *              request) and of nightly-e2e, whoever created it.
 *   LIFECYCLE  the lifecycle suite (tests/bot/lifecycle/data.ts). That purge
 *              never matches it, so a lifecycle run is not wiped by a push;
 *              the lifecycle global setup deletes it once it is older than
 *              48 h (tests/bot/lifecycle/cleanup.ts, staging only).
 *
 * Shapes: org slug `<prefix>-<purpose>-<rand>`, email
 * `<prefix>+<purpose>-<rand>@<emailDomain>`. The two namespaces differ in the
 * slug prefix AND in the registrable email domain (not a subdomain), so
 * neither the slug `like` nor the email suffix of one can match the other.
 */

export interface TestNamespace {
  readonly name: string;
  /** Org slug prefix and email local-part prefix. */
  readonly prefix: string;
  /** Email domain of every generated address. */
  readonly emailDomain: string;
}

export const QA_NAMESPACE: TestNamespace = Object.freeze({
  name: "qa",
  prefix: "qa",
  emailDomain: "example.test",
});

export const LIFECYCLE_NAMESPACE: TestNamespace = Object.freeze({
  name: "lifecycle",
  prefix: "lifecycle",
  emailDomain: "lifecycle.test",
});

export function namespaceSlug(ns: TestNamespace, purpose: string, suffix: string): string {
  return `${ns.prefix}-${purpose}-${suffix}`;
}

export function namespaceEmail(ns: TestNamespace, purpose: string, suffix: string): string {
  return `${ns.prefix}+${purpose}-${suffix}@${ns.emailDomain}`;
}

/** PostgREST `like` pattern for the namespace's organisation slugs. */
export function orgSlugLike(ns: TestNamespace): string {
  return `${ns.prefix}-%`;
}

/** PostgREST `like` pattern for password_reset_otps rows of the namespace's emails. */
export function otpEmailLike(ns: TestNamespace): string {
  return `${ns.prefix}+%@${ns.emailDomain}`;
}

/** Whether an auth user's email belongs to the namespace (the JS-side user filter). */
export function isNamespaceEmail(ns: TestNamespace, email: string | null | undefined): boolean {
  return !!email && email.endsWith(`@${ns.emailDomain}`);
}

/** Whether an organisation slug belongs to the namespace (same rule as orgSlugLike). */
export function isNamespaceSlug(ns: TestNamespace, slug: string | null | undefined): boolean {
  return !!slug && slug.startsWith(`${ns.prefix}-`);
}
