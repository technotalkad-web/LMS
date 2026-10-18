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
 *
 * No database. purgeAllTestData() and cleanupLifecycleData() themselves run
 * against an in-memory fake client that applies the PostgREST filters they
 * send (like, lt, eq, in, order, limit) to seeded rows, so the test checks
 * what each one would delete, not only the patterns. A static case keeps
 * every tracked lifecycle file on ./data for seeding. The real deletes are
 * covered by lifecycle spec 50 ("purge path" and the cleanup dry run).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
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
import { purgeAllTestData, testEmail as qaEmail, testSlug as qaSlug } from "../e2e/helpers/supabase";
import { isLifecycleSlug, testEmail as lcEmail, testSlug as lcSlug } from "../bot/lifecycle/data";
import {
  CLEANUP_MAX_ORGS,
  CLEANUP_MIN_AGE_HOURS,
  cleanupCutoff,
  cleanupLifecycleData,
  formatCleanup,
  isExpiredLifecycleUser,
  isGeneratedLifecycleSlug,
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

console.log("\nthe cleanup deletes only generated lifecycle slugs");
eq(`every generated lifecycle slug (${lcSlugs.length}) has the generated shape`, lcSlugs.filter((s) => !isGeneratedLifecycleSlug(s)), []);
eq("hand-made lifecycle- slugs are not generated",
  ["lifecycle-academy", "lifecycle-", "lifecycle--abcdef", "lifecycle-org-ABCDEF", "lifecycle-org-abc12", "lifecycle-org-abc1234", "lifecycle-org-abcdef-", "lifecycle-new-campus"].filter((s) => isGeneratedLifecycleSlug(s)),
  []);
eq("qa slugs and plain slugs are not generated lifecycle slugs", [...qaSlugs, ...realish].filter((s) => isGeneratedLifecycleSlug(s)), []);
eq("a multi-word purpose is generated", isGeneratedLifecycleSlug("lifecycle-th-invite-0a1b2c"), true);

// ---------------------------------------------------------------------------
// In-memory fake of the supabase-js calls the purge and the cleanup make.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Op = { table: string; kind: "select" | "delete"; filters: Array<[string, unknown[]]> };
interface FakeOpts {
  tables: Record<string, Row[]>;
  users: Array<{ id: string; email: string; created_at: string }>;
  failOrgDelete?: Set<string>;
}
function fakeClient(opts: FakeOpts) {
  const ops: Op[] = [];
  const likeCalls: Array<[string, string, string]> = [];
  const match = (row: Row, [m, a]: [string, unknown[]]) => {
    const v = row[a[0] as string];
    switch (m) {
      case "like": return typeof v === "string" && likeMatches(a[1] as string, v);
      case "lt": return String(v) < String(a[1]);
      case "eq": return v === a[1];
      case "in": return (a[1] as unknown[]).includes(v);
      default: return true;
    }
  };
  const from = (table: string) => {
    const op: Op = { table, kind: "select", filters: [] };
    ops.push(op);
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.delete = () => { op.kind = "delete"; return b; };
    for (const m of ["like", "lt", "eq", "in"]) {
      b[m] = (...a: unknown[]) => {
        op.filters.push([m, a]);
        if (m === "like") likeCalls.push([table, a[0] as string, a[1] as string]);
        return b;
      };
    }
    b.order = (col: string, o?: { ascending?: boolean }) => { order = { col, asc: o?.ascending !== false }; return b; };
    b.limit = (n: number) => { limit = n; return b; };
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const rows = opts.tables[table] ?? [];
      let hit = rows.filter((r) => op.filters.every((f) => match(r, f)));
      if (op.kind === "delete") {
        if (table === "organizations" && hit.some((r) => opts.failOrgDelete?.has(r.id as string))) {
          return Promise.resolve({ data: null, error: { code: "P0001", message: "refused" }, count: null }).then(ok, ko);
        }
        opts.tables[table] = rows.filter((r) => !hit.includes(r));
        return Promise.resolve({ data: null, error: null, count: hit.length }).then(ok, ko);
      }
      if (order) {
        const { col, asc } = order;
        hit = [...hit].sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (limit !== null) hit = hit.slice(0, limit);
      return Promise.resolve({ data: hit, error: null, count: null }).then(ok, ko);
    };
    return b;
  };
  const auth = {
    admin: {
      listUsers: async ({ page, perPage }: { page: number; perPage: number }) => ({
        data: { users: opts.users.slice((page - 1) * perPage, page * perPage) },
        error: null,
      }),
      deleteUser: async (id: string) => {
        opts.users = opts.users.filter((u) => u.id !== id);
        return { data: null, error: null };
      },
    },
  };
  return { client: { from, auth } as unknown as SupabaseClient, ops, likeCalls, state: opts };
}

const NOW = new Date("2026-10-18T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
function world() {
  return {
    tables: {
      organizations: [
        { id: "qa-1", slug: "qa-org-aaaaaa", created_at: hoursAgo(100) },
        { id: "qa-2", slug: "qa-tenant-bbbbbb", created_at: hoursAgo(1) },
        { id: "lc-old", slug: "lifecycle-org-cccccc", created_at: hoursAgo(49) },
        { id: "lc-old2", slug: "lifecycle-th-invite-dddddd", created_at: hoursAgo(72) },
        { id: "lc-new", slug: "lifecycle-org-eeeeee", created_at: hoursAgo(1) },
        { id: "lc-hand", slug: "lifecycle-academy", created_at: hoursAgo(500) },
        { id: "real", slug: "ambak", created_at: hoursAgo(5000) },
      ] as Row[],
      password_reset_otps: [
        { id: "o1", email: "qa+u-111111@example.test", created_at: hoursAgo(100) },
        { id: "o2", email: "lifecycle+u-222222@lifecycle.test", created_at: hoursAgo(100) },
        { id: "o3", email: "lifecycle+u-333333@lifecycle.test", created_at: hoursAgo(1) },
        { id: "o4", email: "jane@ambak.com", created_at: hoursAgo(100) },
      ] as Row[],
    },
    users: [
      { id: "u-qa", email: "qa+u-111111@example.test", created_at: hoursAgo(100) },
      { id: "u-lc-old", email: "lifecycle+u-222222@lifecycle.test", created_at: hoursAgo(100) },
      { id: "u-lc-new", email: "lifecycle+u-333333@lifecycle.test", created_at: hoursAgo(1) },
      { id: "u-real", email: "jane@ambak.com", created_at: hoursAgo(5000) },
    ],
  };
}
const ids = (rows: Row[]) => rows.map((r) => r.id as string).sort();

async function asyncCases() {
  console.log("\npurgeAllTestData against the fake: qa data only, whatever its age");
  {
    const f = fakeClient(world());
    const out = await purgeAllTestData(f.client);
    eq("orgs left: lifecycle, hand-made and real ones", ids(f.state.tables.organizations), ["lc-hand", "lc-new", "lc-old", "lc-old2", "real"]);
    eq("users left: lifecycle and real ones", f.state.users.map((u) => u.id).sort(), ["u-lc-new", "u-lc-old", "u-real"]);
    eq("otps left: lifecycle and real ones", ids(f.state.tables.password_reset_otps), ["o2", "o3", "o4"]);
    eq("the purge's like patterns are exactly the qa ones",
      f.likeCalls.map(([t, c, p]) => `${t}.${c} ${p}`).sort(),
      ["organizations.slug qa-%", "password_reset_otps.email qa+%@example.test"]);
    eq("its counts", out, { users: 1, orgs: 2, otps: 1 });
  }

  console.log("\ncleanupLifecycleData against the fake");
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
    {
      const f = fakeClient(world());
      let refused = false;
      try { await cleanupLifecycleData({ now: NOW, client: f.client }); } catch { refused = true; }
      eq("another project → refused before any call", [refused, f.ops.length], [true, 0]);
    }
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://zeaclbapadosqqttexxh.supabase.co";
    {
      const f = fakeClient(world());
      const r = await cleanupLifecycleData({ now: NOW, client: f.client, dryRun: true });
      eq("dry run: matches the expired generated orgs and users", [r.ids.orgs.sort(), r.ids.users], [["lc-old", "lc-old2"], ["u-lc-old"]]);
      eq("dry run: deletes nothing", [f.state.tables.organizations.length, f.state.users.length, f.state.tables.password_reset_otps.length, f.ops.filter((o) => o.kind === "delete").length], [7, 4, 4, 0]);
      eq("dry run: the hand-made lifecycle- org is counted as kept", r.orgs.kept, 1);
    }
    {
      const f = fakeClient(world());
      const r = await cleanupLifecycleData({ now: NOW, client: f.client });
      eq("orgs left: qa, new lifecycle, hand-made, real", ids(f.state.tables.organizations), ["lc-hand", "lc-new", "qa-1", "qa-2", "real"]);
      eq("users left: qa, new lifecycle, real", f.state.users.map((u) => u.id).sort(), ["u-lc-new", "u-qa", "u-real"]);
      eq("otps left: all but the expired lifecycle one", ids(f.state.tables.password_reset_otps), ["o1", "o3", "o4"]);
      eq("counts", [r.orgs, r.users, r.otps, r.capped, r.errors],
        [{ matched: 2, deleted: 2, failed: 0, kept: 1 }, { matched: 1, deleted: 1, failed: 0 }, { deleted: 1 }, [], []]);
      eq("the cleanup's like patterns are exactly the lifecycle ones",
        f.likeCalls.map(([t, c, p]) => `${t}.${c} ${p}`).sort(),
        ["organizations.slug lifecycle-%", "password_reset_otps.email lifecycle+%@lifecycle.test"]);
      const line = formatCleanup(r);
      eq("the log line holds counts only (no id, slug or email)",
        ["lc-old", "lifecycle-org", "u-lc-old", "@lifecycle.test", "@example.test"].filter((x) => line.includes(x)), []);
    }
    {
      const w = world();
      const f = fakeClient({ ...w, failOrgDelete: new Set(["lc-old2"]) });
      const r = await cleanupLifecycleData({ now: NOW, client: f.client });
      eq("a refused org delete is counted; the others still go", [r.orgs.deleted, r.orgs.failed, r.errors], [1, 1, ["orgs.delete:P0001"]]);
      eq("…and shows in the log line", /failed=1 .*errors=orgs\.delete:P0001/.test(formatCleanup(r)), true);
    }
    {
      // More expired orgs than one run may delete: the newest go first and
      // the run says it was capped; an old stuck org cannot block them.
      const many: Row[] = [];
      for (let i = 0; i < CLEANUP_MAX_ORGS + 5; i++) {
        many.push({ id: `m${String(i).padStart(3, "0")}`, slug: `lifecycle-org-${(0xa00000 + i).toString(16)}`, created_at: hoursAgo(49 + i) });
      }
      const f = fakeClient({ tables: { organizations: many, password_reset_otps: [] }, users: [], failOrgDelete: new Set(["m204"]) });
      const r = await cleanupLifecycleData({ now: NOW, client: f.client });
      eq("capped at the per-run bound", [r.orgs.matched, r.capped], [CLEANUP_MAX_ORGS, ["orgs"]]);
      eq("newest expired first: the 5 oldest (incl. the stuck one) wait for the next run",
        ids(f.state.tables.organizations), ["m200", "m201", "m202", "m203", "m204"]);
      eq("…and the line says capped", /; capped=orgs/.test(formatCleanup(r)), true);
    }
  } finally {
    if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
  }
}

// ---------------------------------------------------------------------------
// Static: tracked lifecycle files seed through ./data, never the e2e helper.
// ---------------------------------------------------------------------------
function staticCases() {
  console.log("\ntracked lifecycle files take their seeding helpers from ./data");
  const root = path.resolve(__dirname, "../..");
  let tracked: string[];
  try {
    tracked = execFileSync("git", ["ls-files", "tests/bot/lifecycle"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((f) => f.endsWith(".ts"));
  } catch {
    tracked = [];
  }
  eq("git lists the tracked lifecycle files", tracked.length > 20, true);
  const all = fs.readdirSync(path.join(root, "tests/bot/lifecycle")).filter((f) => f.endsWith(".ts")).map((f) => `tests/bot/lifecycle/${f}`);
  const SEEDERS = /\b(createOrg|createAuthUser|testEmail|testSlug)\b/;
  const offends = (rel: string) => {
    if (rel.endsWith("/data.ts")) return false; // the one binder
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    const re = /import\s+(type\s+)?(\{[\s\S]*?\}|\*\s+as\s+\w+)\s+from\s+["'][./]*e2e\/helpers\/supabase["']/g;
    for (const m of src.matchAll(re)) {
      if (m[1]) continue; // type-only
      if (m[2].startsWith("*") || SEEDERS.test(m[2])) return true;
    }
    return false;
  };
  eq("no tracked lifecycle file imports createOrg / createAuthUser / testEmail / testSlug (or the whole module) from e2e/helpers/supabase",
    tracked.filter(offends), []);
  const untracked = all.filter((f) => !tracked.includes(f) && offends(f));
  if (untracked.length) {
    console.log(`  note: ${untracked.length} untracked lifecycle file(s) still seed in the qa namespace (the e2e purge wipes their data); move them to ./data before committing: ${untracked.join(", ")}`);
  }
}

staticCases();
asyncCases()
  .catch((e) => { fail++; console.log(`  ✗ async cases threw: ${(e as Error).message}`); })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  });
