/**
 * Unit test for the test-data namespaces on staging
 * (tests/e2e/helpers/namespace.ts):
 *
 *   - the e2e purge (purgeAllTestData: pr-checks e2e on every push and pull
 *     request, nightly-e2e) never matches lifecycle data: its org-slug `like`
 *     pattern, its OTP `like` pattern and its user-email filter are evaluated
 *     against slugs and emails from the lifecycle suite's own generators
 *     (tests/bot/lifecycle/data.ts), and still match qa data;
 *   - the lifecycle cleanup (tests/bot/lifecycle/cleanup.ts) matches only
 *     lifecycle data older than 48 h, and only on the staging project.
 *
 * The `like` patterns run in Postgres; likeMatches() below gives them
 * Postgres LIKE semantics (`%` any run, `_` one character, case-sensitive,
 * whole string).
 *
 * Run:  npx tsx tests/unit/test-data-namespace.test.ts   (or npm run test:unit)
 * (No DB: the deletes themselves are covered by lifecycle spec 50 "purge path".)
 */
import {
  LIFECYCLE_NAMESPACE,
  QA_NAMESPACE,
  isNamespaceEmail,
  isNamespaceSlug,
  namespaceEmail,
  namespaceSlug,
  orgSlugLike,
  otpEmailLike,
} from "../e2e/helpers/namespace";
import { testEmail as qaEmail, testSlug as qaSlug } from "../e2e/helpers/supabase";
import { isLifecycleSlug, testEmail as lcEmail, testSlug as lcSlug } from "../bot/lifecycle/data";
import {
  CLEANUP_MIN_AGE_HOURS,
  cleanupCutoff,
  isExpiredLifecycleUser,
  isStagingSupabaseUrl,
} from "../bot/lifecycle/cleanup";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/** Postgres LIKE (no ESCAPE clause): % = any run, _ = one char, everything else literal. */
function likeMatches(pattern: string, value: string): boolean {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "%") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(re + "$").test(value);
}

console.log("likeMatches (Postgres LIKE semantics)");
eq("% matches any run", likeMatches("qa-%", "qa-org-abc123"), true);
eq("anchored at the start", likeMatches("qa-%", "xqa-org"), false);
eq("case-sensitive", likeMatches("qa-%", "QA-org"), false);
eq("_ is one character", [likeMatches("a_c", "abc"), likeMatches("a_c", "ac")], [true, false]);
eq("+ and . are literal", [likeMatches("qa+%@example.test", "qa+x@example.test"), likeMatches("qa+%@example.test", "qa+x@exampleXtest")], [true, false]);

// Every purpose the suites pass to the generators, plus the defaults.
const PURPOSES = ["org", "tenant", "user", "th-invite", "roleedit", "tenantadmin", "x"];
const N = 200; // random suffixes per purpose

const qaSlugs = [...PURPOSES.map((p) => qaSlug(p)), qaSlug()];
const qaEmails = PURPOSES.map((p) => qaEmail(p));
const lcSlugs: string[] = [];
const lcEmails: string[] = [];
for (let i = 0; i < N; i++) {
  for (const p of PURPOSES) {
    lcSlugs.push(lcSlug(p));
    lcEmails.push(lcEmail(p));
  }
  lcSlugs.push(lcSlug());
}

console.log("\nthe e2e purge still matches qa data (the test is not vacuous)");
eq("purge slug pattern is qa-%", orgSlugLike(QA_NAMESPACE), "qa-%");
eq("purge OTP pattern is qa+%@example.test", otpEmailLike(QA_NAMESPACE), "qa+%@example.test");
eq("every qa slug matches the purge's like", qaSlugs.every((s) => likeMatches(orgSlugLike(QA_NAMESPACE), s)), true);
eq("every qa email matches the purge's user filter", qaEmails.every((e) => isNamespaceEmail(QA_NAMESPACE, e)), true);
eq("every qa email matches the purge's OTP like", qaEmails.every((e) => likeMatches(otpEmailLike(QA_NAMESPACE), e)), true);

console.log("\nthe e2e purge never matches lifecycle data");
eq(`no lifecycle slug (${lcSlugs.length}) matches the purge's like`, lcSlugs.filter((s) => likeMatches(orgSlugLike(QA_NAMESPACE), s)), []);
eq(`no lifecycle email (${lcEmails.length}) matches the purge's user filter`, lcEmails.filter((e) => isNamespaceEmail(QA_NAMESPACE, e)), []);
eq("no lifecycle email matches the purge's OTP like", lcEmails.filter((e) => likeMatches(otpEmailLike(QA_NAMESPACE), e)), []);
eq("nor the lower-cased form (auth stores emails lower-cased)", lcEmails.filter((e) => isNamespaceEmail(QA_NAMESPACE, e.toLowerCase())), []);
eq("lifecycle slug shape", /^lifecycle-org-[0-9a-f]{6}$/.test(lcSlug()), true);
eq("lifecycle email shape", /^lifecycle\+user-[0-9a-f]{6}@lifecycle\.test$/.test(lcEmail("user")), true);
eq("the domains are distinct registrable domains (not one a subdomain of the other)",
  [LIFECYCLE_NAMESPACE.emailDomain.endsWith(`.${QA_NAMESPACE.emailDomain}`), QA_NAMESPACE.emailDomain.endsWith(`.${LIFECYCLE_NAMESPACE.emailDomain}`), LIFECYCLE_NAMESPACE.emailDomain === QA_NAMESPACE.emailDomain],
  [false, false, false]);
eq("lifecycle slugs fit the tenant slug rule (2-42 chars, a-z 0-9 -, no edge dash)",
  lcSlugs.every((s) => /^[a-z0-9](?:[a-z0-9-]{1,40})?[a-z0-9]$/.test(s)), true);

console.log("\nthe lifecycle cleanup matches lifecycle data only");
eq("cleanup slug pattern is lifecycle-%", orgSlugLike(LIFECYCLE_NAMESPACE), "lifecycle-%");
eq("every lifecycle slug matches the cleanup's like", lcSlugs.every((s) => likeMatches(orgSlugLike(LIFECYCLE_NAMESPACE), s)), true);
eq("isLifecycleSlug agrees with the cleanup's like", lcSlugs.every((s) => isLifecycleSlug(s) && isNamespaceSlug(LIFECYCLE_NAMESPACE, s)), true);
eq("no qa slug matches the cleanup's like", qaSlugs.filter((s) => likeMatches(orgSlugLike(LIFECYCLE_NAMESPACE), s)), []);
eq("no qa email matches the cleanup's user filter", qaEmails.filter((e) => isNamespaceEmail(LIFECYCLE_NAMESPACE, e)), []);
eq("every lifecycle email matches the cleanup's OTP like", lcEmails.every((e) => likeMatches(otpEmailLike(LIFECYCLE_NAMESPACE), e)), true);
const realish = ["ambak", "acme", "lifecycle", "lifecycleacademy", "qa", "ambak-hindi"];
eq("plain tenant slugs match neither pattern",
  realish.filter((s) => likeMatches(orgSlugLike(LIFECYCLE_NAMESPACE), s) || likeMatches(orgSlugLike(QA_NAMESPACE), s)), []);
eq("real-looking emails match neither filter",
  ["jane@ambak.com", "lifecycle@ambak.com", "x@lifecycle.test.ambak.com", "x@example.test.ambak.com"].filter(
    (e) => isNamespaceEmail(LIFECYCLE_NAMESPACE, e) || isNamespaceEmail(QA_NAMESPACE, e)), []);
eq("namespaceSlug / namespaceEmail shapes", [namespaceSlug(LIFECYCLE_NAMESPACE, "p", "abc"), namespaceEmail(LIFECYCLE_NAMESPACE, "p", "abc")], ["lifecycle-p-abc", "lifecycle+p-abc@lifecycle.test"]);

console.log("\nthe cleanup's age bound");
const now = new Date("2026-10-18T12:00:00.000Z");
const cutoff = cleanupCutoff(now);
eq("48 h", CLEANUP_MIN_AGE_HOURS, 48);
eq("cutoff = now - 48 h", cutoff.toISOString(), "2026-10-16T12:00:00.000Z");
const user = (email: string, created_at: string | null) => ({ email, created_at });
const lc = "lifecycle+user-abc123@lifecycle.test";
eq("lifecycle user 49 h old → expired", isExpiredLifecycleUser(user(lc, "2026-10-16T11:00:00Z"), cutoff), true);
eq("lifecycle user 47 h old → kept", isExpiredLifecycleUser(user(lc, "2026-10-16T13:00:00Z"), cutoff), false);
eq("exactly 48 h → kept (strictly older only)", isExpiredLifecycleUser(user(lc, "2026-10-16T12:00:00.000Z"), cutoff), false);
eq("auth's microsecond timestamp format parses", isExpiredLifecycleUser(user(lc, "2026-10-01T08:15:42.123456Z"), cutoff), true);
eq("no created_at → kept", isExpiredLifecycleUser(user(lc, null), cutoff), false);
eq("unparseable created_at → kept", isExpiredLifecycleUser(user(lc, "yesterday"), cutoff), false);
eq("old qa user → not the cleanup's", isExpiredLifecycleUser(user("qa+user-abc123@example.test", "2026-01-01T00:00:00Z"), cutoff), false);
eq("old real user → not the cleanup's", isExpiredLifecycleUser(user("jane@ambak.com", "2026-01-01T00:00:00Z"), cutoff), false);

console.log("\nthe cleanup runs on the staging project only");
eq("staging project URL", isStagingSupabaseUrl("https://zeaclbapadosqqttexxh.supabase.co"), true);
eq("staging project URL with a trailing slash", isStagingSupabaseUrl("https://zeaclbapadosqqttexxh.supabase.co/"), true);
eq("another project", isStagingSupabaseUrl("https://abcdefghijklmnopqrst.supabase.co"), false);
eq("look-alike host suffix", isStagingSupabaseUrl("https://zeaclbapadosqqttexxh.supabase.co.evil.example"), false);
eq("look-alike host prefix", isStagingSupabaseUrl("https://xzeaclbapadosqqttexxh.supabase.co"), false);
eq("plain http", isStagingSupabaseUrl("http://zeaclbapadosqqttexxh.supabase.co"), false);
eq("another port", isStagingSupabaseUrl("https://zeaclbapadosqqttexxh.supabase.co:8443"), false);
eq("ref only in the path", isStagingSupabaseUrl("https://prod.example/zeaclbapadosqqttexxh.supabase.co"), false);
eq("empty / missing / not a URL", [isStagingSupabaseUrl(""), isStagingSupabaseUrl(undefined), isStagingSupabaseUrl("zeaclbapadosqqttexxh")], [false, false, false]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
