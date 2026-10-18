/**
 * Unit test for the Package Guardian static gate (lib/alds/guardian.ts; ADR
 * 0005 step 5, note (d)–(f) of 2026-10-19). No database, no storage, no
 * network: a recording fake stands in for the supabase-js service client
 * (tables and the alds_set_version_tier RPC) and for the storage adapter,
 * and the synthetic packages are built from the golden fixture
 * tests/unit/alds-fixtures/base.json.
 *
 *   - the pure pieces: packageDigest (vector), decideTier (every reason, in
 *     order), findAllowlistEntry, the shipped empty allowlist, key lookup,
 *     error scrubbing, who may re-run (canRerunCertification, note (f));
 *   - the flow: flag off → nothing read or written; no manifest → nothing
 *     written (and in the direct path not even a listing); a manifest with an
 *     engine outside the allowlist → uncertified engine_not_allowlisted;
 *     checkPackage errors → uncertified <rule>:<code>; a storage error or the
 *     deadline → uncertified check_error (and a late completion writes
 *     nothing); 0100 absent → skipped schema_missing (never throws); an
 *     allowlisted engine → certified; kinds outside the entry and the byte
 *     budget → uncertified with their codes.
 *
 * Run:  npx tsx tests/unit/alds-guardian.test.ts   (or npm run test:unit)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "../../lib/alds/rules/findings";
import type { AldsPackageManifest } from "../../lib/alds/types";

// The guardian's test doubles are honoured only under NODE_ENV=test; set it
// before the module is loaded (dynamic import below).
(process.env as Record<string, string>).NODE_ENV = "test";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const base = JSON.parse(fs.readFileSync(path.join(root, "tests/unit/alds-fixtures/base.json"), "utf8")) as {
  manifest: AldsPackageManifest;
  cmi5Xml: string;
};
const bundles = JSON.parse(fs.readFileSync(path.join(root, "lib/alds/bundles/bundles.json"), "utf8")) as {
  bundles: Array<{ n: number; rulesBundleHash: string }>;
};
const LATEST = bundles.bundles[bundles.bundles.length - 1];
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const sha256 = (s: string | Uint8Array) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The golden base manifest under the registered rules bundle (so U5 passes). */
function goodManifest(): AldsPackageManifest {
  const m = clone(base.manifest);
  (m as { rulesBundleHash: string }).rulesBundleHash = LATEST.rulesBundleHash;
  return m;
}
const KINDS = [...new Set(goodManifest().questions.map((q) => q.authoringKind).filter((k): k is string => !!k))];

/* ---------------- fake supabase service client ---------------- */

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
type Rpc = { name: string; args: Record<string, unknown> };
type Answer = { data?: unknown; error?: unknown };
type World = {
  version?: Record<string, unknown> | null;
  versionError?: unknown;
  courseInOrg?: boolean;
  slotLanguage?: string | null;
  insertError?: unknown;
  updateError?: unknown;
  rpcError?: (args: Record<string, unknown>) => unknown;
  throwOnFrom?: boolean;
};
const ORG = "org-1";
const V = "ver-1";
const C = "course-1";
const P = "pkg-1";
const PREFIX = `courses/${C}/${P}/v1/`;
const RUN = "run-1";

function fakeSvc(w: World) {
  const queries: Query[] = [];
  const rpcs: Rpc[] = [];
  const has = (q: Query, op: string) => q.ops.some((o) => o.op === op);
  const respond = (q: Query): Answer => {
    if (q.table === "course_versions") {
      if (w.versionError) return { error: w.versionError };
      return { data: w.version === undefined ? defaultVersion() : w.version };
    }
    if (q.table === "courses") {
      const org = q.ops.find((o) => o.op === "eq" && o.args[0] === "organization_id")?.args[1];
      return { data: w.courseInOrg === false || org !== ORG ? null : { id: C } };
    }
    if (q.table === "course_packages") return { data: { language: w.slotLanguage === undefined ? "en" : w.slotLanguage } };
    if (q.table === "package_certifications" && has(q, "insert")) return w.insertError ? { error: w.insertError } : { data: { id: RUN } };
    if (q.table === "package_certifications" && has(q, "update")) return w.updateError ? { error: w.updateError } : { data: null };
    return {};
  };
  const client = {
    from(table: string) {
      if (w.throwOnFrom) throw new Error("client exploded");
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "insert", "eq", "in", "is", "order", "limit"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const settle = () => Promise.resolve({ data: null, error: null, ...respond(q) });
      b.maybeSingle = () => settle();
      b.single = () => settle();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      const err = w.rpcError?.(args);
      if (err) return Promise.resolve({ data: null, error: err });
      return Promise.resolve({
        data: { version_id: args.p_version_id, analytics_tier: args.p_tier, analytics_tier_reason: args.p_reason ?? null, certified_at: null, certification_id: args.p_certification_id ?? null },
        error: null,
      });
    },
  };
  const writes = () => queries.filter((q) => has(q, "insert") || has(q, "update"));
  const argOf = (q: Query, op: string) => q.ops.find((o) => o.op === op)?.args[0] as Record<string, unknown> | undefined;
  return { client: client as never, queries, rpcs, writes, argOf };
}

function defaultVersion(over: Record<string, unknown> = {}) {
  return {
    id: V, course_id: C, package_id: P, manifest_type: "cmi5", storage_prefix: PREFIX, storage_driver: "supabase",
    upload_status: "ready", ...over,
  };
}

/* ---------------- fake storage adapter ---------------- */

function fakeStorage(files: Record<string, string | Uint8Array>, opts: { delayMs?: number; throwOn?: string; throwMessage?: string } = {}) {
  const calls = { list: 0, getObject: [] as string[], drivers: [] as Array<string | null> };
  const adapter = {
    async list(prefix: string) {
      calls.list++;
      return Object.keys(files).map((rel) => `${prefix}/${rel}`);
    },
    async getObject(key: string) {
      calls.getObject.push(key);
      if (opts.delayMs) await sleep(opts.delayMs);
      if (opts.throwOn && key.endsWith(opts.throwOn)) throw new Error(opts.throwMessage ?? "storage down");
      const rel = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
      const v = files[rel];
      if (v === undefined) return null;
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
      return {
        body: new Response(bytes as Uint8Array<ArrayBuffer>).body,
        status: 200 as const,
        contentLength: bytes.length,
        size: bytes.length,
        contentRange: null,
        contentType: null,
        etag: null,
      };
    },
  };
  return { calls, storageFor: async (driver: string | null) => { calls.drivers.push(driver); return adapter as never; } };
}

function packageFiles(manifest: AldsPackageManifest | string | null, extra: Record<string, string> = {}) {
  const f: Record<string, string> = { "cmi5.xml": base.cmi5Xml, "index.html": "<html>KIVO</html>", "assets/app.js": "console.log(1)", ...extra };
  if (manifest !== null) f["alds-manifest.json"] = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
  return f;
}

async function main() {
  const g = await import("../../lib/alds/guardian");
  const { TIER_REASON } = await import("../../lib/alds/tier");
  const okCheck: CheckResult = { ok: true, findings: [], checked: ["U1", "U2", "U3"] };
  const entry = (over: Partial<import("../../lib/alds/guardian").AllowlistEntry> = {}) => ({
    engineDigest: goodManifest().selfCheck!.engineDigest,
    rulesBundleHash: LATEST.rulesBundleHash,
    certifiedKinds: KINDS,
    editorVersion: "2.0.0",
    registeredAt: "2026-10-19",
    reference: "unit test",
    ...over,
  });

  /* ---------------- constants ---------------- */
  console.log("\nconstants (note (e), (k))");
  eq("deadline 20 s", g.GUARDIAN_DEADLINE_MS, 20_000);
  eq("digest budget 60 MB", g.GUARDIAN_DIGEST_BUDGET_BYTES, 60 * 1024 * 1024);
  eq("manifest name", g.ALDS_MANIFEST_NAME, "alds-manifest.json");

  /* ---------------- packageDigest ---------------- */
  console.log("\npackageDigest (sha256 over sorted `path\\nsha256` lines)");
  {
    const a = { path: "index.html", sha256Hex: sha256("<html>") };
    const b = { path: "assets/app.js", sha256Hex: sha256("js") };
    const c = { path: "cmi5.xml", sha256Hex: sha256("xml") };
    const want = `sha256:${sha256([b, c, a].map((e) => `${e.path}\n${e.sha256Hex}`).join("\n"))}`;
    eq("known vector (node:crypto over the joined, path-sorted lines)", await g.packageDigest([a, b, c]), want);
    eq("input order does not matter", await g.packageDigest([c, a, b]), want);
    eq("two entries in reverse order hash as sorted", await g.packageDigest([a, b]), await g.packageDigest([b, a]));
    eq("a changed object changes the digest", (await g.packageDigest([a, { ...b, sha256Hex: sha256("js2") }, c])) === want, false);
    eq("a renamed path changes the digest", (await g.packageDigest([a, { ...b, path: "assets/App.js" }, c])) === want, false);
    eq("empty package", await g.packageDigest([]), `sha256:${sha256("")}`);
  }

  /* ---------------- decideTier ---------------- */
  console.log("\ndecideTier (first error, then cmi5, selfCheck, allowlist, kinds, digest)");
  {
    const m = goodManifest();
    const errCheck: CheckResult = {
      ok: false,
      findings: [
        { rule: "U4", code: "language_not_canonical", severity: "info", attribution: "package", message: "info only" },
        { rule: "U3", code: "content_hash_mismatch", severity: "error", attribution: "package", message: "questions[0].contentHash does not recompute" },
        { rule: "U5", code: "rules_bundle_unknown", severity: "error", attribution: "package", message: "second error" },
      ],
      checked: ["U3", "U4", "U5"],
    };
    eq("an error finding wins over an allowlisted engine (first error, rule:code: message)",
      g.decideTier({ check: errCheck, manifest: m, allowlist: entry(), digestCode: null, selfCheckPresent: true, manifestType: "cmi5" }),
      { tier: "uncertified", reasonCode: "U3:content_hash_mismatch", reason: "U3:content_hash_mismatch: questions[0].contentHash does not recompute" });
    const warnOnly: CheckResult = { ok: true, findings: [{ rule: "U1", code: "authoring_kind_unknown", severity: "warn", attribution: "package", message: "w" }], checked: ["U1"] };
    eq("a warning alone does not uncertify",
      g.decideTier({ check: warnOnly, manifest: m, allowlist: entry(), digestCode: null, selfCheckPresent: true, manifestType: "cmi5" }).tier, "certified");
    const notCmi5 = g.decideTier({ check: okCheck, manifest: m, allowlist: entry(), digestCode: null, selfCheckPresent: true, manifestType: "xapi" });
    eq("a non-cmi5 package is never certified", [notCmi5.tier, notCmi5.reasonCode], ["uncertified", g.REASON_MANIFEST_TYPE_NOT_CERTIFIABLE]);
    const noSc = clone(m); delete (noSc as { selfCheck?: unknown }).selfCheck;
    const r1 = g.decideTier({ check: okCheck, manifest: noSc, allowlist: entry(), digestCode: null, selfCheckPresent: false, manifestType: "cmi5" });
    eq("self_check_missing", [r1.tier, r1.reasonCode, r1.reason?.startsWith("self_check_missing: ")], ["uncertified", TIER_REASON.selfCheckMissing, true]);
    const r1b = g.decideTier({ check: okCheck, manifest: noSc, allowlist: entry(), digestCode: null, selfCheckPresent: true, manifestType: "cmi5" });
    eq("selfCheckPresent true without a selfCheck still → self_check_missing", r1b.reasonCode, TIER_REASON.selfCheckMissing);
    const r2 = g.decideTier({ check: okCheck, manifest: m, allowlist: g.findAllowlistEntry([], m.selfCheck!.engineDigest, m.rulesBundleHash), digestCode: null, selfCheckPresent: true, manifestType: "cmi5" });
    eq("engine_not_allowlisted (empty allowlist)", [r2.tier, r2.reasonCode, r2.reason?.startsWith("engine_not_allowlisted: ")], ["uncertified", TIER_REASON.engineNotAllowlisted, true]);
    const r3 = g.decideTier({ check: okCheck, manifest: m, allowlist: entry({ certifiedKinds: KINDS.filter((k) => k !== "hotspot" && k !== "dialogue") }), digestCode: null, selfCheckPresent: true, manifestType: "cmi5" });
    eq("kind_not_certified names the kinds outside the entry", [r3.tier, r3.reasonCode, r3.reason], ["uncertified", TIER_REASON.kindNotCertified, "kind_not_certified: dialogue, hotspot outside the certified kinds of this engine"]);
    const r4 = g.decideTier({ check: okCheck, manifest: m, allowlist: entry(), digestCode: TIER_REASON.packageDigestBudget, selfCheckPresent: true, manifestType: "cmi5" });
    eq("package_digest_budget", [r4.tier, r4.reasonCode, r4.reason], ["uncertified", TIER_REASON.packageDigestBudget, "package_digest_budget: the stored files exceed the 60 MB digest budget"]);
    eq("all clear with an allowlist entry → certified, no reason",
      g.decideTier({ check: okCheck, manifest: m, allowlist: entry(), digestCode: null, selfCheckPresent: true, manifestType: "cmi5" }),
      { tier: "certified", reasonCode: null, reason: null });
    eq("manifestType omitted → the manifest's own (cmi5) is used",
      g.decideTier({ check: okCheck, manifest: m, allowlist: entry(), digestCode: null, selfCheckPresent: true }).tier, "certified");
    eq("no manifest at all is never certified",
      g.decideTier({ check: okCheck, manifest: null, allowlist: entry(), digestCode: null, selfCheckPresent: true }).tier, "uncertified");
  }

  /* ---------------- allowlist ---------------- */
  console.log("\nengine allowlist (note (d)): shipped empty");
  {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "lib/alds/engine-allowlist.json"), "utf8"));
    eq("the shipped file parses and has engines: []", raw.engines, []);
    eq("the shipped file documents the entry shape", typeof raw.$comment === "string" && /engineDigest/.test(raw.$comment) && /certifiedKinds/.test(raw.$comment), true);
    eq("loadEngineAllowlist() is empty", g.loadEngineAllowlist(), []);
    const m = goodManifest();
    eq("findAllowlistEntry on the shipped file → null for the fixture engine", g.findAllowlistEntry(g.loadEngineAllowlist(), m.selfCheck!.engineDigest, m.rulesBundleHash), null);
    eq("… and for any digest", g.findAllowlistEntry(g.loadEngineAllowlist(), `sha256:${"0".repeat(64)}`, LATEST.rulesBundleHash), null);
    const list = [entry()];
    eq("an entry is found by (engineDigest, rulesBundleHash)", g.findAllowlistEntry(list, m.selfCheck!.engineDigest, LATEST.rulesBundleHash)?.reference, "unit test");
    eq("same engine under another bundle → null", g.findAllowlistEntry(list, m.selfCheck!.engineDigest, `sha256:${"1".repeat(64)}`), null);
    eq("missing digest → null", g.findAllowlistEntry(list, null, LATEST.rulesBundleHash), null);
  }

  /* ---------------- helpers ---------------- */
  console.log("\nhelpers: key lookup and error scrubbing");
  eq("shortest key ending in /alds-manifest.json", g.findPackageKey(["p/sub/alds-manifest.json", "p/alds-manifest.json", "p/x.js"], "alds-manifest.json"), "p/alds-manifest.json");
  eq("case-insensitive", g.findPackageKey(["p/ALDS-Manifest.JSON"], "alds-manifest.json"), "p/ALDS-Manifest.JSON");
  eq("a name that only ends the same is not a match", g.findPackageKey(["p/my-alds-manifest.json"], "alds-manifest.json"), null);
  {
    const s = g.scrubErrorMessage("fetch https://x.supabase.co/storage/v1/object/sign/c/a.js?token=eyJabc.def.ghi failed\n token=abc123 key=zzz");
    eq("no URL survives", /https?:\/\//.test(s), false);
    eq("no token survives", /abc123|eyJabc|zzz/.test(s), false);
    eq("one line", s.includes("\n"), false);
  }

  /* ---------------- who may re-run ---------------- */
  console.log("\ncanRerunCertification (note (f)): the certify route's predicate, on the RAW membership role");
  eq("super_owner → allowed", g.canRerunCertification("super_owner"), true);
  eq("the legacy owner alias → refused (pages normalise it to super_owner; the route does not)", g.canRerunCertification("owner"), false);
  for (const r of ["admin", "data_analyst", "user", "member", "", "Super_Owner", " super_owner"]) {
    eq(`${JSON.stringify(r)} → refused`, g.canRerunCertification(r), false);
  }
  eq("no membership row (e.g. an impersonation) → refused", [g.canRerunCertification(null), g.canRerunCertification(undefined)], [false, false]);

  /* ---------------- the flow ---------------- */
  const env = process.env as Record<string, string | undefined>;
  const run = async (w: World, files: Record<string, string | Uint8Array>, opts: Parameters<typeof fakeStorage>[1] = {}, input: Partial<import("../../lib/alds/guardian").GuardianInput> = {}, doubles: Parameters<typeof g.setGuardianTestDoubles>[0] = {}) => {
    const svc = fakeSvc(w);
    const st = fakeStorage(files, opts);
    g.setGuardianTestDoubles({ svc: svc.client, storageFor: st.storageFor, deadlineMs: 2_000, budgetBytes: null, allowlist: null, ...doubles });
    let threw: unknown = null;
    let outcome: unknown = null;
    try {
      outcome = await g.runPackageGuardian({ versionId: V, organizationId: ORG, trigger: "upload", ...input });
    } catch (e) {
      threw = e;
    }
    return { outcome: outcome as Record<string, unknown>, threw, svc, st };
  };
  const tierWrites = (r: { svc: ReturnType<typeof fakeSvc> }) => r.svc.rpcs.map((x) => [x.args.p_tier, x.args.p_reason_code ?? null]);

  console.log("\nflag off → nothing read, nothing written");
  {
    delete env.ALDS_P4;
    const r = await run({}, packageFiles(goodManifest()));
    eq("skipped flag_off", r.outcome, { skipped: "flag_off" });
    eq("no query, no RPC, no storage", [r.svc.queries.length, r.svc.rpcs.length, r.st.calls.list, r.st.calls.getObject.length, r.st.calls.drivers.length], [0, 0, 0, 0, 0]);
    env.ALDS_P4 = "off";
    const r2 = await run({}, packageFiles(goodManifest()));
    eq("ALDS_P4=off is off too", [r2.outcome, r2.svc.rpcs.length], [{ skipped: "flag_off" }, 0]);
  }
  env.ALDS_P4 = "on";

  console.log("\nno alds-manifest.json → unverified, nothing written");
  {
    const r = await run({}, packageFiles(null));
    eq("multipart path: skipped no_manifest", r.outcome, { skipped: "no_manifest" });
    eq("one listing, no byte fetched", [r.st.calls.list, r.st.calls.getObject.length], [1, 0]);
    eq("no insert, no update, no RPC", [r.svc.writes().length, r.svc.rpcs.length], [0, 0]);
    eq("reads go to the version's storage driver", r.st.calls.drivers, ["supabase"]);
    const keys = Object.keys(packageFiles(null)).map((k) => `${PREFIX}${k}`);
    const d = await run({}, packageFiles(null), {}, { listedKeys: keys });
    eq("direct path (listedKeys): skipped no_manifest", d.outcome, { skipped: "no_manifest" });
    eq("direct path: no query, no listing, no fetch", [d.svc.queries.length, d.st.calls.list, d.st.calls.getObject.length], [0, 0, 0]);
  }

  console.log("\nonly the ROOT alds-manifest.json counts (note (e)); a nested copy → unverified, nothing written");
  {
    const nested = { "cmi5.xml": base.cmi5Xml, "index.html": "<html>KIVO</html>", "assets/app.js": "console.log(1)", "assets/alds-manifest.json": JSON.stringify(goodManifest()) };
    const r = await run({}, nested);
    eq("multipart path: skipped no_manifest", r.outcome, { skipped: "no_manifest" });
    eq("multipart path: no insert, no update, no RPC, no byte fetched", [r.svc.writes().length, r.svc.rpcs.length, r.st.calls.getObject.length], [0, 0, 0]);
    const d = await run({}, nested, {}, { listedKeys: Object.keys(nested).map((k) => `${PREFIX}${k}`) });
    eq("direct path: skipped no_manifest (the pre-filter passes, the root rule refuses)", d.outcome, { skipped: "no_manifest" });
    eq("direct path: no insert, no update, no RPC, no listing, no byte fetched", [d.svc.writes().length, d.svc.rpcs.length, d.st.calls.list, d.st.calls.getObject.length], [0, 0, 0, 0]);
    eq("rootAldsManifestKey: next to the launch manifest",
      g.rootAldsManifestKey(["p/v1/cmi5.xml", "p/v1/alds-manifest.json", "p/v1/x/alds-manifest.json"], "p/v1/", "cmi5"), "p/v1/alds-manifest.json");
    eq("rootAldsManifestKey: a zip's top folder is the root when the launch manifest is there",
      g.rootAldsManifestKey(["p/v1/Course/cmi5.xml", "p/v1/Course/ALDS-Manifest.json"], "p/v1", "cmi5"), "p/v1/Course/ALDS-Manifest.json");
    eq("rootAldsManifestKey: nested only → null",
      g.rootAldsManifestKey(["p/v1/cmi5.xml", "p/v1/x/alds-manifest.json"], "p/v1/", "cmi5"), null);
    eq("rootAldsManifestKey: no launch manifest → the prefix itself",
      [g.rootAldsManifestKey(["p/v1/alds-manifest.json"], "p/v1/", "cmi5"), g.rootAldsManifestKey(["p/v1/x/alds-manifest.json"], "p/v1", "cmi5")], ["p/v1/alds-manifest.json", null]);
    eq("rootAldsManifestKey: the version's type picks the launch manifest",
      g.rootAldsManifestKey(["p/v1/cmi5.xml", "p/v1/t/tincan.xml", "p/v1/t/alds-manifest.json"], "p/v1", "xapi"), "p/v1/t/alds-manifest.json");
    const top = { "Course/cmi5.xml": base.cmi5Xml, "Course/index.html": "<html>KIVO</html>", "Course/alds-manifest.json": JSON.stringify(goodManifest()) };
    const t = await run({}, top);
    eq("a top-folder package with its manifest beside cmi5.xml is checked (pending first)", ["tier" in t.outcome, tierWrites(t)[0]], [true, ["pending", "check_running"]]);
  }

  console.log("\nmanifest, engine not in the (empty) allowlist → uncertified engine_not_allowlisted");
  {
    const files = packageFiles(goodManifest());
    const r = await run({}, files);
    eq("outcome", r.outcome, { tier: "uncertified", reasonCode: "engine_not_allowlisted", reason: r.outcome.reason, certificationId: RUN });
    eq("the reason starts with the code", String(r.outcome.reason).startsWith("engine_not_allowlisted: "), true);
    eq("tier writes: pending (check_running), then uncertified", tierWrites(r), [["pending", "check_running"], ["uncertified", "engine_not_allowlisted"]]);
    eq("the RPC is alds_set_version_tier with the run id", r.svc.rpcs.map((x) => [x.name, x.args.p_version_id, x.args.p_certification_id]), [["alds_set_version_tier", V, RUN], ["alds_set_version_tier", V, RUN]]);
    const ins = r.svc.queries.find((q) => q.table === "package_certifications" && q.ops.some((o) => o.op === "insert"))!;
    eq("run row: pending, latest bundle, upload gate (requested_by null), org-scoped", r.svc.argOf(ins, "insert"), {
      organization_id: ORG, course_version_id: V, status: "pending", rules_bundle_hash: LATEST.rulesBundleHash, rules_version: String(LATEST.n), requested_by: null,
    });
    const upd = r.svc.queries.filter((q) => q.table === "package_certifications" && q.ops.some((o) => o.op === "update"));
    eq("one run-row update, by id and organization_id", upd.map((q) => q.ops.filter((o) => o.op === "eq").map((o) => o.args)), [[["id", RUN], ["organization_id", ORG]]]);
    const patch = r.svc.argOf(upd[0], "update")!;
    eq("run row final: status, reason_code, engine digest, a package digest", [patch.status, patch.reason_code, patch.engine_digest, /^sha256:[0-9a-f]{64}$/.test(String(patch.package_digest))], ["uncertified", "engine_not_allowlisted", goodManifest().selfCheck!.engineDigest, true]);
    const wantDigest = await g.packageDigest(Object.entries(files).map(([p, t]) => ({ path: p, sha256Hex: sha256(t) })));
    eq("package digest = sorted path + object sha256 over every stored object", patch.package_digest, wantDigest);
    eq("static_report.gate", (patch.static_report as { gate: unknown }).gate, { manifestType: "cmi5", selfCheckPresent: true, allowlisted: false, digestCode: null });
    eq("coverage", patch.coverage, { kindsCovered: goodManifest().selfCheck!.kindsCovered, authoringKinds: goodManifest().questions.map((q) => q.authoringKind).filter(Boolean) });
    eq("each object fetched once (manifest and cmi5.xml reused for the digest)", r.st.calls.getObject.length, Object.keys(files).length);
    const fin = r.svc.rpcs[1].args;
    eq("final RPC carries the manifest, 2.0, the engine version, level 2", [fin.p_manifest !== null, fin.p_standard_version, fin.p_engine_version, fin.p_conformance_level], [true, "2.0", goodManifest().engineVersion, 2]);
    eq("no write to course_versions outside the RPC", r.svc.queries.some((q) => q.table === "course_versions" && q.ops.some((o) => o.op === "update" || o.op === "insert")), false);
    eq("never throws", r.threw, null);
  }

  console.log("\ncheckPackage errors → uncertified with the rule id");
  {
    const r = await run({}, packageFiles('{"standardVersion": "2.0",'));
    eq("unparseable manifest → U1:manifest_unparseable", [r.outcome.tier, r.outcome.reasonCode], ["uncertified", "U1:manifest_unparseable"]);
    const fin = r.svc.rpcs[1].args;
    eq("level 1, no manifest stored", [fin.p_conformance_level, fin.p_manifest, fin.p_standard_version], [1, null, null]);
    const bad = goodManifest();
    bad.questions[0].prompt = "edited without rehash";
    const r2 = await run({}, packageFiles(bad));
    eq("edited question → U3:content_hash_mismatch", [r2.outcome.tier, r2.outcome.reasonCode], ["uncertified", "U3:content_hash_mismatch"]);
    const r3 = await run({ slotLanguage: "hi" }, packageFiles(goodManifest()));
    eq("slot language differs → R4", r3.outcome.reasonCode, "R4:declared_language_differs_from_slot");
    const r4 = await run({}, { "alds-manifest.json": JSON.stringify(goodManifest()), "index.html": "x" });
    eq("cmi5.xml absent → U2:launch_manifest_missing", r4.outcome.reasonCode, "U2:launch_manifest_missing");
  }

  console.log("\nstorage error, exception or deadline → uncertified check_error");
  {
    const r = await run({}, packageFiles(goodManifest()), { throwOn: "assets/app.js", throwMessage: "fetch https://x.supabase.co/storage/v1/object/sign/a?token=eyJa.b.c failed" });
    eq("storage error → check_error", [r.outcome.tier, r.outcome.reasonCode], ["uncertified", "check_error"]);
    eq("the reason has no URL or token", /https?:|token=eyJ/.test(String(r.outcome.reason)), false);
    eq("tier writes: pending then uncertified check_error", tierWrites(r), [["pending", "check_running"], ["uncertified", "check_error"]]);
    const upd = r.svc.queries.filter((q) => q.table === "package_certifications" && q.ops.some((o) => o.op === "update"));
    eq("the run row records check_error", upd.map((q) => [r.svc.argOf(q, "update")!.status, r.svc.argOf(q, "update")!.reason_code]), [["uncertified", "check_error"]]);

    const slow = await run({}, packageFiles(goodManifest()), { delayMs: 120 }, {}, { deadlineMs: 40 });
    eq("deadline → check_error", [slow.outcome.tier, slow.outcome.reasonCode], ["uncertified", "check_error"]);
    eq("the reason names the deadline", /did not finish within/.test(String(slow.outcome.reason)), true);
    const rpcsAtDeadline = slow.svc.rpcs.length;
    const writesAtDeadline = slow.svc.writes().length;
    await sleep(400);
    eq("a late completion writes nothing after the deadline", [slow.svc.rpcs.length, slow.svc.writes().length], [rpcsAtDeadline, writesAtDeadline]);
    eq("… and the last tier write stays check_error", tierWrites(slow).at(-1), ["uncertified", "check_error"]);
    eq("… and no fetch starts after the deadline (at most one per worker)", slow.st.calls.getObject.length <= 6, true);

    const missing = await run({}, packageFiles(goodManifest()), {}, { listedKeys: [...Object.keys(packageFiles(goodManifest())).map((k) => `${PREFIX}${k}`), `${PREFIX}gone.js`] });
    eq("a listed object that is gone → check_error", [missing.outcome.tier, missing.outcome.reasonCode], ["uncertified", "check_error"]);
    eq("direct path: the listing is reused (no second list)", missing.st.calls.list, 0);
  }

  console.log("\n0100 absent → logged and skipped, never throws");
  {
    const r = await run({ insertError: { code: "42P01", message: 'relation "public.package_certifications" does not exist' } }, packageFiles(goodManifest()));
    eq("insert 42P01 → skipped schema_missing", r.outcome, { skipped: "schema_missing" });
    eq("no RPC after it", r.svc.rpcs.length, 0);
    const r2 = await run({ rpcError: () => ({ code: "PGRST202", message: "Could not find the function public.alds_set_version_tier in the schema cache" }) }, packageFiles(goodManifest()));
    eq("RPC PGRST202 → skipped schema_missing", r2.outcome, { skipped: "schema_missing" });
    eq("one RPC attempt (pending), nothing after it", r2.svc.rpcs.length, 1);
    const r3 = await run({ versionError: { code: "42703", message: 'column "analytics_tier" does not exist' } }, packageFiles(goodManifest()));
    eq("a 42703 on the version read → skipped schema_missing", r3.outcome, { skipped: "schema_missing" });
    eq("never throws", [r.threw, r2.threw, r3.threw], [null, null, null]);
  }

  console.log("\nother refusals and failures (no tier written)");
  {
    const nr = await run({ version: defaultVersion({ upload_status: "uploading" }) }, packageFiles(goodManifest()));
    eq("not ready → skipped not_ready, nothing written, nothing listed", [nr.outcome, nr.svc.writes().length, nr.st.calls.list], [{ skipped: "not_ready" }, 0, 0]);
    const other = await run({ courseInOrg: false }, packageFiles(goodManifest()));
    eq("another organisation's version → skipped not_found, nothing written", [other.outcome, other.svc.writes().length, other.st.calls.list], [{ skipped: "not_found" }, 0, 0]);
    const gone = await run({ version: null }, packageFiles(goodManifest()));
    eq("no version → skipped not_found", gone.outcome, { skipped: "not_found" });
    const denied = await run({ insertError: { code: "42501", message: "permission denied for table package_certifications" } }, packageFiles(goodManifest()));
    eq("a missing grant (42501) → skipped unavailable, no tier written", [denied.outcome, denied.svc.rpcs.length], [{ skipped: "unavailable" }, 0]);
    const rpcDenied = await run({ rpcError: (a) => (a.p_tier === "pending" ? { code: "42501", message: "permission denied for function" } : null) }, packageFiles(goodManifest()));
    eq("the pending write refused (42501) → skipped unavailable, run row closed", [rpcDenied.outcome, rpcDenied.svc.rpcs.length], [{ skipped: "unavailable" }, 1]);
    const exploded = await run({ throwOnFrom: true }, packageFiles(goodManifest()));
    eq("a client that throws → skipped unavailable, never throws", [exploded.outcome, exploded.threw], [{ skipped: "unavailable" }, null]);
    const rerun = await run({}, packageFiles(goodManifest()), {}, { trigger: "rerun", requestedBy: "super-1" });
    const ins = rerun.svc.queries.find((q) => q.table === "package_certifications" && q.ops.some((o) => o.op === "insert"))!;
    eq("a re-run records requested_by", rerun.svc.argOf(ins, "insert")!.requested_by, "super-1");
  }

  console.log("\nan allowlisted engine (test allowlist) → certified; kinds and budget");
  {
    const r = await run({}, packageFiles(goodManifest()), {}, {}, { allowlist: [entry()] });
    eq("certified, no reason", [r.outcome.tier, r.outcome.reasonCode, r.outcome.reason], ["certified", null, null]);
    eq("tier writes: pending then certified", tierWrites(r), [["pending", "check_running"], ["certified", null]]);
    const k = await run({}, packageFiles(goodManifest()), {}, {}, { allowlist: [entry({ certifiedKinds: ["choice"] })] });
    eq("a kind outside the entry → kind_not_certified", [k.outcome.tier, k.outcome.reasonCode], ["uncertified", "kind_not_certified"]);
    const files = packageFiles(goodManifest(), { "media/video.mp4": "x".repeat(4096) });
    const textBytes = files["alds-manifest.json"].length + files["cmi5.xml"].length;
    const b = await run({}, files, {}, {}, { allowlist: [entry()], budgetBytes: textBytes + 100 });
    eq("over the byte budget → package_digest_budget", [b.outcome.tier, b.outcome.reasonCode], ["uncertified", "package_digest_budget"]);
    const upd = b.svc.queries.filter((q) => q.table === "package_certifications" && q.ops.some((o) => o.op === "update"));
    eq("… no package digest stored", b.svc.argOf(upd[0], "update")!.package_digest, null);
    const x = await run({ version: defaultVersion({ manifest_type: "xapi" }) }, { ...packageFiles(goodManifest()), "tincan.xml": "<tincan/>" }, {}, {}, { allowlist: [entry()] });
    eq("an xapi version with a manifest is never certified (U1 type mismatch first)", [x.outcome.tier, x.outcome.reasonCode], ["uncertified", "U1:manifest_type_mismatch"]);
  }

  g.setGuardianTestDoubles({ svc: null, storageFor: null, deadlineMs: null, budgetBytes: null, allowlist: null });
  delete env.ALDS_P4;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
