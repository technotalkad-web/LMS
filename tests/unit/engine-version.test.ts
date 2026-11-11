/**
 * Unit tests for ADR 0017 steps 3, 4 and 5: the engine stamp, the floor, the
 * verdict, the stamping on both upload paths and the lazy read.
 *
 * Fixtures: tests/unit/engine-version-fixtures/. The two `real-*` heads are the
 * first bytes of a real export's launch file, cut right after the generator meta,
 * with the spaces of its blank comment lines removed: the engine body is not in
 * this repository. The `simulated-*` heads exercise the
 * config key, which a real export carries further down.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/engine-version.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import {
  ENGINE_READ_ERRORS,
  OUTCOME_FINAL_FLOOR,
  compareEngineVersion,
  engineVersionForManifest,
  extractEngineStamp,
  isKivoLaunch,
  isKivoStamped,
  outcomeFinalVerdict,
  parseEngineVersion,
} from "../../lib/courses/engine-version";
import { analyzeLaunchHtml } from "../../lib/courses/validation/validate-package";
import { manifestData, uploadCoursePackage } from "../../lib/courses/upload";
import { finalizeDirectUpload, setDirectUploadTestDoubles } from "../../lib/courses/direct-upload";
import { ensureEngineVersion, readLaunchFileForStamp, type LaunchFileRead, type VersionLite } from "../../lib/courses/progress";
import { MAX_LAUNCH_READ_BYTES, launchBodyAllowed } from "../../lib/courses/units";
import type { StorageAdapter } from "../../lib/storage";
import type { ParsedManifest } from "../../lib/courses/manifest/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const FX = path.join(__dirname, "engine-version-fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(FX, name), "utf8");
const FIXTURES = fs.readdirSync(FX).sort();

/* ---------------- recording fake client (the failed-uploads.test.ts shape) ---------------- */
type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
type Responder = (q: Query) => { data?: unknown; error?: unknown };
function fakeClient(respond: Responder = () => ({})) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "insert", "delete", "upsert", "eq", "neq", "in", "is", "not", "order", "limit", "range"]) {
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
  };
  return { client: client as never, queries };
}
const has = (q: Query, op: string) => q.ops.some((o) => o.op === op);
const arg = (q: Query, op: string) => q.ops.find((o) => o.op === op)?.args;
const sel = (q: Query) => arg(q, "select")?.[0];
const versionWrites = (qs: Query[]) =>
  qs.filter((q) => q.table === "course_versions" && has(q, "update")).map((q) => (arg(q, "update") as [Record<string, unknown>])[0]);

async function capture(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const realWarn = console.warn;
  const lines: Array<Record<string, unknown>> = [];
  console.warn = (...a: unknown[]) => {
    const s = String(a[0]);
    if (s.startsWith("{")) lines.push(JSON.parse(s) as Record<string, unknown>);
  };
  try {
    await run();
  } finally {
    console.warn = realWarn;
  }
  return lines;
}

function stampAndVerdicts() {
  console.log("\nparseEngineVersion");
  for (const [input, want] of [
    ["2026.10.28", [2026, 10, 28, 0]],
    ["2026.10.28.3", [2026, 10, 28, 3]],
    ["2026.9.1", null],
    ["unknown", null],
    ["sketch-g2", null],
    ["", null],
    [undefined, null],
    [null, null],
    ["2026.10.28.", null],
    ["x2026.10.28", null],
    ["2026.10.28x", null],
  ] as Array<[string | null | undefined, unknown]>) {
    eq(`parse ${JSON.stringify(input)}`, parseEngineVersion(input), want);
  }

  console.log("\ncompareEngineVersion");
  eq("a missing .N reads 0", compareEngineVersion("2026.10.28", "2026.10.28.0"), 0);
  eq("2026.10.28.10 is above 2026.10.28.9 (numeric, not text)", compareEngineVersion("2026.10.28.10", "2026.10.28.9") > 0, true);
  eq("…and the reverse is below", compareEngineVersion("2026.10.28.9", "2026.10.28.10") < 0, true);
  eq("the year decides first", compareEngineVersion("2027.01.01", "2026.12.31") > 0, true);
  eq("the month next", compareEngineVersion("2026.11.01", "2026.10.31") > 0, true);
  eq("the day next", compareEngineVersion("2026.10.29", "2026.10.28") > 0, true);
  eq("an older one is below", compareEngineVersion("2026.10.20", "2026.10.28") < 0, true);
  eq("a string that does not parse sorts below one that does", [compareEngineVersion("unknown", "2026.10.28") < 0, compareEngineVersion("2026.10.28", "unknown") > 0], [true, true]);
  eq("two that do not parse compare equal", compareEngineVersion("unknown", "sketch-g2"), 0);

  console.log("\nisKivoStamped: the cached stamp only (ADR 0019 step 8)");
  eq("a parseable stamp reads as a KIVO build", isKivoStamped({ engineVersion: "2026.10.28" }), true);
  eq("the literal `unknown` reads as a KIVO build", isKivoStamped({ engineVersion: "unknown" }), true);
  eq("null (read, not a KIVO build) reads false", isKivoStamped({ engineVersion: null }), false);
  eq("an absent key (never read) reads false", isKivoStamped({ masteryScore: 0.8 }), false);
  eq("no manifest_data at all reads false", [isKivoStamped(null), isKivoStamped(undefined), isKivoStamped("2026.10.28")], [false, false, false]);
  eq("a non-string stamp reads false", isKivoStamped({ engineVersion: 20261028 }), false);

  console.log("\nthe pinned floor");
  eq("OUTCOME_FINAL_FLOOR is the literal 2026.10.28", OUTCOME_FINAL_FLOOR, "2026.10.28");

  console.log("\noutcomeFinalVerdict: only `final` guards");
  for (const [i, want] of [
    [{ stamp: "2026.10.20" }, "older"],
    [{ stamp: "2026.10.27.99" }, "older"],
    [{ stamp: "2026.10.28" }, "final"],
    [{ stamp: "2026.10.28.1" }, "final"],
    [{ stamp: "2027.01.01" }, "final"],
    [{ stamp: null }, "non_kivo"],
    [{ stamp: "unknown" }, "unknown"],
    [{ stamp: "sketch-g2" }, "unknown"],
    [{ stamp: null, readError: "no_object" }, "unreadable"],
    [{ stamp: null, readError: "too_large" }, "unreadable"],
    [{ stamp: "2026.10.28", readError: "boom" }, "unreadable"],
    [{ stamp: null, readError: null }, "non_kivo"],
    [{ stamp: null, readError: "" }, "non_kivo"],
  ] as Array<[{ stamp: string | null; readError?: string | null }, string]>) {
    eq(`verdict ${JSON.stringify(i)}`, outcomeFinalVerdict(i), want);
  }

  console.log("\nextractEngineStamp");
  eq("the fixtures are there", FIXTURES.length, 7);
  for (const name of FIXTURES) {
    const html = fixture(name);
    eq(`${name}: equal to analyzeLaunchHtml().engineVersion`, extractEngineStamp(html), analyzeLaunchHtml(html).engineVersion);
    eq(`${name}: no carriage return, final newline`, [html.includes("\r"), html.endsWith("\n")], [false, true]);
  }
  eq("the real A.1 head reads 2026.10.28", extractEngineStamp(fixture("real-a1-head.html")), "2026.10.28");
  eq("…and is final", outcomeFinalVerdict({ stamp: extractEngineStamp(fixture("real-a1-head.html")) }), "final");
  eq("the real 2026.10.20 head reads 2026.10.20", extractEngineStamp(fixture("real-2026.10.20-head.html")), "2026.10.20");
  eq("…and is older", outcomeFinalVerdict({ stamp: extractEngineStamp(fixture("real-2026.10.20-head.html")) }), "older");
  eq("the simulated heads read the config key", [extractEngineStamp(fixture("simulated-a1-minified.html")), extractEngineStamp(fixture("simulated-a1-pretty.html"))], ["2026.10.28", "2026.10.28"]);
  eq("a third-party generator meta still reads a version (today's report text)", extractEngineStamp(fixture("non-kivo.html")), "4.5.6");
  eq("null and empty → null", [extractEngineStamp(null), extractEngineStamp("")], [null, null]);
  eq("the first match wins: the config key before the meta",
    extractEngineStamp(`<meta name="engineVersion" content="1.1.1"><script>x={engineVersion:"2.2.2"}</script>`), "2.2.2");
  eq("then the meta, name before content",
    extractEngineStamp(`<meta name="engine-version" content="3.3.3"><html data-engine-version="4.4.4">`), "3.3.3");
  eq("then the meta, content before name",
    extractEngineStamp(`<meta content="5.5.5" name="kivo_version"><html data-kivo-version="6.6.6">`), "5.5.5");
  eq("then the data attribute",
    extractEngineStamp(`<html data-kivo-version="6.6.6"><meta name="generator" content="KIVO engine 2026.10.28">`), "6.6.6");
  eq("then the generator meta",
    extractEngineStamp(`<meta name="generator" content="KIVO engine 2026.10.28.2">`), "2026.10.28.2");
  eq("the i flag is kept on the markup regexes",
    extractEngineStamp(`<META NAME="ENGINEVERSION" CONTENT="7.7.7">`), "7.7.7");
  eq("a comment without quotes is skipped", extractEngineStamp(` * engineVersion: 2026.10.28\n`), null);

  console.log("\nengineVersionForManifest: the four states");
  eq("the launch file was not read → undefined", engineVersionForManifest(null), undefined);
  eq("a real A.1 head → the stamp", engineVersionForManifest(fixture("real-a1-head.html")), "2026.10.28");
  eq("a real 2026.10.20 head → the stamp", engineVersionForManifest(fixture("real-2026.10.20-head.html")), "2026.10.20");
  eq("a simulated A.1 export, minified → the stamp", engineVersionForManifest(fixture("simulated-a1-minified.html")), "2026.10.28");
  eq("a simulated A.1 export, pretty → the stamp", engineVersionForManifest(fixture("simulated-a1-pretty.html")), "2026.10.28");
  eq("a KIVO file with the unknown literal → unknown", engineVersionForManifest(fixture("simulated-kivo-unknown.html")), "unknown");
  eq("a KIVO file with no stamp → unknown", engineVersionForManifest(fixture("simulated-kivo-no-stamp.html")), "unknown");
  eq("a third-party file → null, whatever its generator says", engineVersionForManifest(fixture("non-kivo.html")), null);
  eq("an empty file was read: not KIVO → null", engineVersionForManifest(""), null);
  console.log("\nisKivoLaunch: the validator's own test");
  eq("the config alone is not KIVO", isKivoLaunch("<script>var COURSE_CONFIG = {};</script>"), false);
  eq("a marker alone is not KIVO", isKivoLaunch("<!-- KIVO elearning-engine cmi5LaunchActive -->"), false);
  eq("the config and any marker are", ["elearning-engine", "KIVO", "cmi5LaunchActive"].map((m) => isKivoLaunch(`var COURSE_CONFIG = {}; // ${m}`)), [true, true, true]);
  for (const name of ["real-a1-head.html", "simulated-kivo-unknown.html", "simulated-kivo-no-stamp.html", "non-kivo.html"]) {
    eq(`${name}: the same answer as the validator`, isKivoLaunch(fixture(name)), analyzeLaunchHtml(fixture(name)).kivo);
  }

  console.log("\nmanifestData: the fifth argument");
  const manifest = { title: "T", launchUrl: "index.html", type: "cmi5", raw: {} } as unknown as ParsedManifest;
  eq("a string → the key", manifestData(manifest, 3, undefined, 2, "2026.10.28").engineVersion, "2026.10.28");
  eq("null → the key, null", manifestData(manifest, 3, undefined, 2, null).engineVersion, null);
  eq("undefined → no key", "engineVersion" in manifestData(manifest, 3, undefined, 2, undefined), false);
  eq("not passed → no key (the reserve-first insert)", "engineVersion" in manifestData(manifest, null), false);
  eq("the fourth argument is untouched", manifestData(manifest, 3, undefined, 2, "x").unitCountAlgo, 2);
}

/* ---------------- both upload paths ---------------- */
const MANIFEST_XML = (href: string) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="qa.stamp" version="1.0" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="O"><organization identifier="O"><title>Stamp</title><item identifier="I" identifierref="R"><title>M</title></item></organization></organizations>
  <resources><resource identifier="R" type="webcontent" adlcp:scormtype="sco" href="${href}"><file href="${href}"/></resource></resources>
</manifest>`;

async function uploadWith(launch: { name: string; href?: string; html: string | null }): Promise<Record<string, unknown>> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", MANIFEST_XML(launch.href ?? launch.name));
  if (launch.html !== null) zip.file(launch.name, launch.html);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const { client } = fakeClient((q) => {
    if (q.table === "course_versions" && has(q, "insert")) return { data: { id: "v1", version_number: 1 } };
    return {};
  });
  const patches: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/storage/v1/")) return new Response(JSON.stringify({ Key: "k" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/rest/v1/course_versions" && (init?.method ?? "GET").toUpperCase() === "PATCH") {
      patches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify([{ id: "v1" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await uploadCoursePackage({ zipBytes: bytes, organizationId: "o1", uploaderId: "u1", courseId: "c1", packageId: "p1", supabase: client });
  } finally {
    globalThis.fetch = realFetch;
  }
  eq(`multipart ${launch.name}: one ready write`, patches.map((p) => p.upload_status), ["ready"]);
  return patches[0].manifest_data as Record<string, unknown>;
}

async function uploadPaths() {
  console.log("\nuploadCoursePackage (multipart): the four states");
  const a = await uploadWith({ name: "index.html", html: fixture("simulated-a1-minified.html") });
  eq("a stamped KIVO file → the string", a.engineVersion, "2026.10.28");
  eq("…beside PR 2's marker", a.unitCountAlgo, 2);
  const real = await uploadWith({ name: "index.html", html: fixture("real-a1-head.html") });
  eq("the real A.1 head → the string", real.engineVersion, "2026.10.28");
  const unknown = await uploadWith({ name: "index.html", html: fixture("simulated-kivo-unknown.html") });
  eq("a KIVO file with the unknown literal → unknown", unknown.engineVersion, "unknown");
  const none = await uploadWith({ name: "index.html", html: fixture("simulated-kivo-no-stamp.html") });
  eq("a KIVO file with no stamp → unknown", none.engineVersion, "unknown");
  const third = await uploadWith({ name: "index.html", html: fixture("non-kivo.html") });
  eq("a third-party file → null, the key present", ["engineVersion" in third, third.engineVersion], [true, null]);
  const absent = await uploadWith({ name: "index.html", href: "missing.html", html: fixture("simulated-a1-minified.html") });
  eq("the launch path is unmatched → the key absent", "engineVersion" in absent, false);

  console.log("\nfinalizeDirectUpload (direct): the four states");
  const PREFIX = "courses/c1/p1/v3/";
  const finalizeWith = async (html: string, size?: number) => {
    const files: Record<string, string> = {
      [`${PREFIX}imsmanifest.xml`]: MANIFEST_XML("index.html"),
      [`${PREFIX}index.html`]: html,
    };
    const adapter = {
      async head(k: string) { return files[k] ? { size: size ?? files[k].length, contentType: null, etag: null } : null; },
      async list(p: string) { return Object.keys(files).filter((k) => k.startsWith(p)); },
      async getObject(k: string) { return files[k] ? { body: files[k] } : null; },
    } as unknown as StorageAdapter;
    const row = {
      id: "v3", course_id: "c1", package_id: "p1", version_number: 3, manifest_type: "scorm12", launch_url: "index.html",
      storage_prefix: PREFIX, storage_driver: "supabase", upload_status: "uploading", file_count: 2, manifest_data: { title: "Stamp" },
    };
    const { client, queries } = fakeClient((q) => {
      const s = sel(q);
      if (q.table === "course_versions" && s === "*") return { data: { ...row } };
      if (q.table === "courses" && typeof s === "string" && s.startsWith("id, organization_id")) return { data: { id: "c1", organization_id: "o1", current_version_id: null, title: "T" } };
      if (q.table === "course_packages" && s === "id, current_version_id") return { data: { id: "p1", current_version_id: null } };
      if (q.table === "course_versions" && has(q, "update")) return { data: [{ id: "v3" }] };
      if (q.table === "courses" && has(q, "update")) return { data: [{ id: "c1" }] };
      if (q.table === "course_versions") return { data: [] };
      return {};
    });
    setDirectUploadTestDoubles({ svc: client, storageFor: async () => adapter });
    const r = await finalizeDirectUpload({
      supabase: client, org: { id: "o1", slug: "qa", name: "QA" }, userId: "u1", origin: "", notify: {} as never, versionId: "v3", notifyUpdate: false, restartMode: "grandfather",
    });
    eq("finalize ok", r.ok, true);
    return versionWrites(queries)[0].manifest_data as Record<string, unknown>;
  };
  eq("a stamped KIVO file → the string", (await finalizeWith(fixture("simulated-a1-pretty.html"))).engineVersion, "2026.10.28");
  eq("a KIVO file with the unknown literal → unknown", (await finalizeWith(fixture("simulated-kivo-unknown.html"))).engineVersion, "unknown");
  eq("a KIVO file with no stamp → unknown", (await finalizeWith(fixture("simulated-kivo-no-stamp.html"))).engineVersion, "unknown");
  const thirdDirect = await finalizeWith(fixture("non-kivo.html"));
  eq("a third-party file → null, the key present", ["engineVersion" in thirdDirect, thirdDirect.engineVersion], [true, null]);
  const overCap = await finalizeWith(fixture("simulated-a1-minified.html"), MAX_LAUNCH_READ_BYTES + 1);
  eq("a file over the read cap → the key absent", "engineVersion" in overCap, false);
  eq("…beside PR 2's marker", overCap.unitCountAlgo, 2);
}

/* ---------------- the lazy read ---------------- */
const VERSION = { id: "v1", storage_prefix: "courses/c/p/v1/", launch_url: "/index.html?x=1#y", storage_driver: "r2" };

async function lazyRead() {
  console.log("\nensureEngineVersion: cached values read nothing");
  const reader = (answer: LaunchFileRead | (() => never)) => {
    const calls: unknown[] = [];
    return {
      calls,
      readLaunchFile: async (v: unknown) => {
        calls.push(v);
        if (typeof answer === "function") return answer();
        return answer;
      },
    };
  };
  for (const [what, md, want] of [
    ["a cached string", { engineVersion: "2026.10.28" }, { stamp: "2026.10.28", cached: true }],
    ["a cached unknown", { engineVersion: "unknown" }, { stamp: "unknown", cached: true }],
    ["a cached null", { engineVersion: null }, { stamp: null, cached: true }],
    ["too_large under the same cap", { engineVersionRead: { too_large: true, cap: MAX_LAUNCH_READ_BYTES } }, { stamp: null, cached: true, error: "too_large" }],
  ] as Array<[string, Record<string, unknown>, unknown]>) {
    const f = fakeClient();
    const r = reader({ kind: "ok", html: "x" });
    const lines = await capture(async () => {
      eq(`${what}: the answer`, await ensureEngineVersion(f.client, { ...VERSION, manifest_data: md }, r), want);
    });
    eq(`${what}: no read, no write, no log`, [r.calls.length, f.queries.length, lines.length], [0, 0, 0]);
  }
  eq("the verdicts of the cached values", [
    outcomeFinalVerdict({ stamp: "2026.10.28" }),
    outcomeFinalVerdict({ stamp: "unknown" }),
    outcomeFinalVerdict({ stamp: null }),
    outcomeFinalVerdict({ stamp: null, readError: "too_large" }),
  ], ["final", "unknown", "non_kivo", "unreadable"]);

  console.log("\nensureEngineVersion: the read");
  const md = { title: "T", unitCount: 3 };
  for (const [what, html, stamp] of [
    ["a stamp found", fixture("real-a1-head.html"), "2026.10.28"],
    ["KIVO, no parseable stamp", fixture("simulated-kivo-no-stamp.html"), "unknown"],
    ["not KIVO", fixture("non-kivo.html"), null],
  ] as Array<[string, string, string | null]>) {
    const f = fakeClient();
    const r = reader({ kind: "ok", html });
    const lines = await capture(async () => {
      eq(`${what}: the answer`, await ensureEngineVersion(f.client, { ...VERSION, manifest_data: md }, r), { stamp, cached: true });
    });
    eq(`${what}: one read`, r.calls.length, 1);
    eq(`${what}: the update carries {...md, engineVersion}`, versionWrites(f.queries), [{ manifest_data: { ...md, engineVersion: stamp } }]);
    eq(`${what}: on the version`, arg(f.queries[0], "eq"), ["id", "v1"]);
    eq(`${what}: one engine_version_cached line, ids only`, lines, [{ event: "engine_version_cached", version_id: "v1", engine_version: stamp }]);
  }
  {
    const f = fakeClient();
    const r = reader({ kind: "too_large", size: MAX_LAUNCH_READ_BYTES + 1 });
    const lines = await capture(async () => {
      eq("too_large: unreadable, cached", await ensureEngineVersion(f.client, { ...VERSION, manifest_data: md }, r), { stamp: null, cached: true, error: "too_large" });
    });
    eq("too_large: the update carries {...md, engineVersionRead}, never engineVersion", versionWrites(f.queries), [{ manifest_data: { ...md, engineVersionRead: { too_large: true, cap: MAX_LAUNCH_READ_BYTES } } }]);
    eq("too_large: one engine_version_cached line", lines.map((l) => [l.event, l.version_id, l.engine_version]), [["engine_version_cached", "v1", "too_large"]]);
  }
  {
    const f = fakeClient();
    const r = reader({ kind: "ok", html: fixture("real-a1-head.html") });
    const smaller = { engineVersionRead: { too_large: true, cap: MAX_LAUNCH_READ_BYTES - 1 } };
    eq("too_large under another cap: read again", (await capture(async () => {
      eq("…the stamp", (await ensureEngineVersion(f.client, { ...VERSION, manifest_data: smaller }, r)).stamp, "2026.10.28");
    })).length, 1);
    eq("…one read", r.calls.length, 1);
  }
  for (const [what, answer, error, detail] of [
    ["a null head", { kind: "no_object" }, "no_object", undefined],
    ["a failed fetch", { kind: "failed", error: "fetch_failed", detail: "fetch 500" }, "fetch_failed", "fetch 500"],
    ["a head with no usable size", { kind: "failed", error: "bad_size", detail: "size 0" }, "bad_size", "size 0"],
    ["storage throws", () => { throw new Error("storage down"); }, "storage_error", "storage down"],
  ] as Array<[string, LaunchFileRead | (() => never), string, string | undefined]>) {
    const f = fakeClient();
    const r = reader(answer);
    const lines = await capture(async () => {
      const got = await ensureEngineVersion(f.client, { ...VERSION, manifest_data: md }, r);
      eq(`${what}: nothing cached, the class returned`, got, { stamp: null, cached: false, error });
      eq(`${what}: reads unreadable`, outcomeFinalVerdict({ stamp: got.stamp, readError: got.error }), "unreadable");
    });
    eq(`${what}: no version write`, f.queries.length, 0);
    eq(`${what}: one engine_version_unreadable line, the raw text in the log and nowhere else`, lines, [{ event: "engine_version_unreadable", version_id: "v1", error, ...(detail ? { detail } : {}) }]);
  }
  {
    // Nothing to read: never the cached null of the unit count, which would read non_kivo.
    const f = fakeClient();
    for (const [what, version] of [
      ["no version", null],
      ["no id", { id: "", manifest_data: {} }],
    ] as Array<[string, never]>) {
      const lines = await capture(async () => {
        eq(`${what}: unreadable, never non_kivo`, await ensureEngineVersion(f.client, version), { stamp: null, cached: false, error: "no_object" });
      });
      eq(`${what}: logged`, lines.map((l) => l.event), ["engine_version_unreadable"]);
    }
    eq("no version, no id: no write", f.queries.length, 0);
  }
  {
    // The write failing: the verdict still stands, and nothing claims a cache.
    const f = fakeClient(() => ({ error: { message: "timeout" } }));
    const r = reader({ kind: "ok", html: fixture("real-a1-head.html") });
    const lines = await capture(async () => {
      eq("the cache write failing: the stamp, not cached, no error", await ensureEngineVersion(f.client, { ...VERSION, manifest_data: md }, r), { stamp: "2026.10.28", cached: false });
    });
    eq("…no engine_version_cached line", lines.length, 0);
  }

  console.log("\nensureEngineVersion: a read that never answers");
  {
    const f = fakeClient();
    const signals: Array<AbortSignal | undefined> = [];
    const started = Date.now();
    const lines = await capture(async () => {
      eq("a stall: read as a failed read, nothing cached",
        await ensureEngineVersion(f.client, { ...VERSION, manifest_data: { title: "T" } }, {
          readTimeoutMs: 20,
          readLaunchFile: (_v: VersionLite, signal?: AbortSignal) => {
            signals.push(signal);
            return new Promise<LaunchFileRead>(() => {});
          },
        }),
        { stamp: null, cached: false, error: "timeout" });
    });
    eq("…at the bound the caller gave", Date.now() - started < 3000, true);
    eq("…no version write", f.queries.length, 0);
    eq("…engine_version_unreadable, with the reason", lines, [{ event: "engine_version_unreadable", version_id: "v1", error: "timeout" }]);
    eq("…the reader's signal is aborted, so the fetch is let go", signals.map((sg) => sg?.aborted), [true]);
    eq("…which reads as unreadable", outcomeFinalVerdict({ stamp: null, readError: "timeout" }), "unreadable");
  }
  {
    const f = fakeClient();
    let settle: (r: LaunchFileRead) => void = () => {};
    await capture(async () => {
      await ensureEngineVersion(f.client, { ...VERSION, manifest_data: {} }, {
        readTimeoutMs: 10,
        readLaunchFile: () => new Promise<LaunchFileRead>((res) => { settle = res; }),
      });
      settle({ kind: "ok", html: fixture("real-a1-head.html") });
      await new Promise((res) => setTimeout(res, 20));
    });
    eq("a late answer writes nothing", f.queries.length, 0);
  }
  {
    const f = fakeClient();
    let reject: (e: Error) => void = () => {};
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    await capture(async () => {
      await ensureEngineVersion(f.client, { ...VERSION, manifest_data: {} }, {
        readTimeoutMs: 10,
        readLaunchFile: () => new Promise<LaunchFileRead>((_res, rej) => { reject = rej; }),
      });
      reject(new Error("late"));
      await new Promise((res) => setTimeout(res, 20));
    });
    process.off("unhandledRejection", onUnhandled);
    eq("a late failure is not an unhandled rejection", unhandled, []);
  }
  {
    const f = fakeClient();
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    await capture(async () => {
      eq("a read that answers in time: as before",
        (await ensureEngineVersion(f.client, { ...VERSION, manifest_data: {} }, { readTimeoutMs: 60_000, readLaunchFile: async () => ({ kind: "ok", html: fixture("real-a1-head.html") }) })).stamp, "2026.10.28");
    });
    eq("…and the bound leaves no timer behind", timers(), before);
    const throwing = fakeClient();
    await capture(async () => {
      eq("a read that throws: the failed read, as before",
        (await ensureEngineVersion(throwing.client, { ...VERSION, manifest_data: {} }, { readTimeoutMs: 60_000, readLaunchFile: async () => { throw new Error("storage down"); } })).error, "storage_error");
    });
    eq("…and no timer either", timers(), before);
  }
  {
    // The default reader on the real adapter, under a stubbed fetch: a stall at the head,
    // where no signal can reach, and at the signed fetch, where the signal lets go of it.
    const realFetch = globalThis.fetch;
    let stallAt: "head" | "body" = "head";
    let bodySignal: AbortSignal | null | undefined;
    const jsonAnswer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/storage/v1/object/list/")) {
        if (stallAt === "head") return new Promise<Response>(() => {});
        return jsonAnswer([{ name: "index.html", metadata: { size: 100, mimetype: "text/html" } }]);
      }
      if (url.includes("token=t")) {
        bodySignal = init?.signal;
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      }
      if (url.includes("/storage/v1/object/sign/")) return jsonAnswer({ signedURL: "/object/sign/x?token=t" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      const real = { id: "v1", storage_prefix: "courses/c/p/v1/", launch_url: "index.html", storage_driver: "supabase", manifest_data: {} };
      for (const at of ["head", "body"] as const) {
        stallAt = at;
        const f = fakeClient();
        await capture(async () => {
          eq(`the default reader stalled at the ${at}: timeout, nothing cached`, await ensureEngineVersion(f.client, real, { readTimeoutMs: 40 }), { stamp: null, cached: false, error: "timeout" });
        });
        eq("…no version write", f.queries.length, 0);
      }
      eq("the signed fetch got the signal, and it was aborted", bodySignal?.aborted, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\nreadLaunchFileForStamp: head, cap, signed fetch");
  const storage = (head: { size: number } | null | "throw") => {
    const calls: string[] = [];
    return {
      calls,
      adapter: {
        async head(k: string) {
          calls.push(`head ${k}`);
          if (head === "throw") throw new Error("storage down");
          return head && { size: head.size, contentType: null, etag: null };
        },
        async getSignedDownloadUrl(k: string, s: number) {
          calls.push(`sign ${k} ${s}`);
          return "http://stub.storage.test/launch";
        },
      } as unknown as Pick<StorageAdapter, "head" | "getSignedDownloadUrl">,
    };
  };
  const realFetch = globalThis.fetch;
  let fetches: string[] = [];
  const fetchAnswer = (status: number, body: string) => {
    fetches = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return new Response(body, { status });
    }) as typeof fetch;
  };
  try {
    {
      const s = storage({ size: 100 });
      fetchAnswer(200, "<html>");
      eq("an object: ok with the text", await readLaunchFileForStamp(VERSION, s.adapter), { kind: "ok", html: "<html>" });
      eq("…the head, then the signed URL, on the key of ensureUnitCount", s.calls, ["head courses/c/p/v1/index.html", "sign courses/c/p/v1/index.html 300"]);
      eq("…one fetch", fetches, ["http://stub.storage.test/launch"]);
    }
    {
      const s = storage(null);
      fetchAnswer(200, "x");
      eq("a null head: no_object", await readLaunchFileForStamp(VERSION, s.adapter), { kind: "no_object" });
      eq("…no signed URL, no fetch", [s.calls.length, fetches.length], [1, 0]);
    }
    {
      const s = storage({ size: MAX_LAUNCH_READ_BYTES + 1 });
      fetchAnswer(200, "x");
      eq("a head over the cap: too_large with the size", await readLaunchFileForStamp(VERSION, s.adapter), { kind: "too_large", size: MAX_LAUNCH_READ_BYTES + 1 });
      eq("…launchBodyAllowed agrees", launchBodyAllowed(MAX_LAUNCH_READ_BYTES + 1, MAX_LAUNCH_READ_BYTES), false);
      eq("…no signed URL, no fetch", [s.calls.length, fetches.length], [1, 0]);
    }
    {
      const s = storage({ size: MAX_LAUNCH_READ_BYTES });
      fetchAnswer(200, "x");
      eq("a head at the cap: read", (await readLaunchFileForStamp(VERSION, s.adapter)).kind, "ok");
    }
    // Supabase and R2 answer 0 for a size they do not know, so 0 says nothing about the
    // file, and a cached too_large would stand until the cap changes: a failed read.
    for (const [what, size] of [
      ["0", 0],
      ["a negative number", -1],
      ["NaN", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY],
      ["a string", "12"],
      ["undefined", undefined],
      ["null", null],
    ] as Array<[string, unknown]>) {
      const s = storage({ size } as { size: number });
      fetchAnswer(200, "x");
      const read = await readLaunchFileForStamp(VERSION, s.adapter);
      eq(`a head of size ${what}: a failed read`, [read.kind, read.kind === "failed" ? read.error : null], ["failed", "bad_size"]);
      eq("…no signed URL, no fetch", [s.calls.length, fetches.length], [1, 0]);
    }
    {
      const s = storage({ size: 0 });
      const f = fakeClient();
      const version = { ...VERSION, manifest_data: { title: "T" } as Record<string, unknown> };
      const deps = { readLaunchFile: (v: VersionLite) => readLaunchFileForStamp(v, s.adapter) };
      const lines = await capture(async () => {
        const got = await ensureEngineVersion(f.client, version, deps);
        eq("a head of size 0, through ensureEngineVersion: nothing cached, the class returned", got, { stamp: null, cached: false, error: "bad_size" });
        eq("…the verdict is unreadable", outcomeFinalVerdict({ stamp: got.stamp, readError: got.error }), "unreadable");
      });
      eq("…no version write, so the next candidate reads again", f.queries.length, 0);
      eq("…logged", lines, [{ event: "engine_version_unreadable", version_id: "v1", error: "bad_size", detail: "size 0" }]);
      await capture(async () => {
        await ensureEngineVersion(f.client, version, deps);
      });
      eq("…and it does read again", s.calls.filter((c) => c.startsWith("head")).length, 2);
    }
    {
      const s = storage({ size: MAX_LAUNCH_READ_BYTES + 1 });
      const f = fakeClient();
      const lines = await capture(async () => {
        eq("a head over the cap, through ensureEngineVersion: cached as too_large",
          await ensureEngineVersion(f.client, { ...VERSION, manifest_data: {} }, { readLaunchFile: (v) => readLaunchFileForStamp(v, s.adapter) }),
          { stamp: null, cached: true, error: "too_large" });
      });
      eq("…the marker, with the cap", versionWrites(f.queries).map((w) => (w.manifest_data as Record<string, unknown>).engineVersionRead), [{ too_large: true, cap: MAX_LAUNCH_READ_BYTES }]);
      eq("…engine_version_cached", lines.map((l) => [l.event, l.engine_version]), [["engine_version_cached", "too_large"]]);
    }
    {
      const s = storage({ size: 100 });
      fetchAnswer(503, "nope");
      eq("the fetch not ok: fetch_failed, the status in the detail", await readLaunchFileForStamp(VERSION, s.adapter), { kind: "failed", error: "fetch_failed", detail: "fetch 503" });
    }
    {
      const s = storage({ size: 100 });
      globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
      eq("the fetch rejecting: fetch_failed", await readLaunchFileForStamp(VERSION, s.adapter), { kind: "failed", error: "fetch_failed", detail: "fetch failed" });
      globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => { throw new Error("body lost"); } })) as unknown as typeof fetch;
      eq("the body failing: fetch_failed", await readLaunchFileForStamp(VERSION, s.adapter), { kind: "failed", error: "fetch_failed", detail: "body lost" });
    }
    {
      const s = storage({ size: 100 });
      const controller = new AbortController();
      let seen: AbortSignal | null | undefined;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal;
        return new Response("<html>", { status: 200 });
      }) as typeof fetch;
      await readLaunchFileForStamp(VERSION, s.adapter, controller.signal);
      eq("the signal reaches the signed fetch", seen === controller.signal, true);
    }
    {
      const s = storage("throw");
      const f = fakeClient();
      const got = await capture(async () => {
        eq("the head throwing, through ensureEngineVersion: nothing cached, the class returned",
          await ensureEngineVersion(f.client, { ...VERSION, manifest_data: {} }, { readLaunchFile: (v) => readLaunchFileForStamp(v, s.adapter) }),
          { stamp: null, cached: false, error: "storage_error" });
      });
      eq("…no version write", [f.queries.length, got.map((l) => l.event)], [0, ["engine_version_unreadable"]]);
    }
    {
      // A learner reads their own row through the Data API, and the stores' errors name the key.
      const key = "courses/c/p/v1/index.html";
      const f = fakeClient();
      const lines = await capture(async () => {
        const got = await ensureEngineVersion(f.client, { ...VERSION, manifest_data: {} }, { readLaunchFile: async () => { throw new Error(`Supabase head failed (${key}): denied`); } });
        eq("a raw error naming the storage key: what comes back is the class", got.error, "storage_error");
      });
      eq("…the raw text stays in the server's log line", [lines[0].error, lines[0].detail], ["storage_error", `Supabase head failed (${key}): denied`]);
    }
    {
      const s = storage({ size: 100 });
      fetchAnswer(200, "x");
      eq("no storage_prefix: no_object, storage not asked", [await readLaunchFileForStamp({ id: "v1", launch_url: "index.html" }, s.adapter), s.calls.length], [{ kind: "no_object" }, 0]);
      eq("no launch_url: no_object, storage not asked", [await readLaunchFileForStamp({ id: "v1", storage_prefix: "p/" }, s.adapter), s.calls.length], [{ kind: "no_object" }, 0]);
    }
    {
      // Key absent, a trailing exit commit: the lazy read runs once and caches.
      const s = storage({ size: 100 });
      fetchAnswer(200, fixture("real-a1-head.html"));
      const f = fakeClient();
      const version = { ...VERSION, manifest_data: { title: "T" } as Record<string, unknown> };
      const deps = { readLaunchFile: (v: VersionLite) => readLaunchFileForStamp(v, s.adapter) };
      await capture(async () => {
        eq("the first read: the stamp", (await ensureEngineVersion(f.client, version, deps)).stamp, "2026.10.28");
        version.manifest_data = versionWrites(f.queries)[0].manifest_data as Record<string, unknown>;
        eq("the next, on the cached row: the stamp", (await ensureEngineVersion(f.client, version, deps)).stamp, "2026.10.28");
      });
      eq("…one head, one fetch, one write", [s.calls.filter((c) => c.startsWith("head")).length, fetches.length, f.queries.length], [1, 1, 1]);
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("\nthe error classes");
  eq("the list", ENGINE_READ_ERRORS, ["no_object", "too_large", "bad_size", "timeout", "fetch_failed", "storage_error"]);
  eq("each reads as unreadable", ENGINE_READ_ERRORS.map((e) => outcomeFinalVerdict({ stamp: null, readError: e })), ENGINE_READ_ERRORS.map(() => "unreadable"));

  console.log("\nthe source");
  const progress = fs.readFileSync(path.join(root, "lib/courses/progress.ts"), "utf8");
  eq("the storage is resolved through getStorageFor with the version's own driver", /getStorageFor\(version\.storage_driver \?\? null\)/.test(progress), true);
  eq("the cap is imported from ./units", /import \{[^}]*MAX_LAUNCH_READ_BYTES[^}]*\} from "\.\/units";/.test(progress), true);
  eq("ensureUnitCount's reader still reads through the active driver", /async function readLaunchHtmlFromStorage[\s\S]*?const storage = await getStorage\(\);/.test(progress), true);
  const engine = fs.readFileSync(path.join(root, "lib/courses/engine-version.ts"), "utf8");
  eq("engine-version.ts imports nothing: no next/*, no Supabase, not the validator", /^import /m.test(engine), false);
  eq("its header says the floor never moves", /It NEVER moves\./.test(engine), true);
  const validator = fs.readFileSync(path.join(root, "lib/courses/validation/validate-package.ts"), "utf8");
  eq("the validator takes the stamp from the helper", /const engineVersion = extractEngineStamp\(html\);/.test(validator), true);
  eq("the validator takes the KIVO test from the helper", /const kivo = isKivoLaunch\(html\);/.test(validator) && !/COURSE_CONFIG/.test(validator), true);
  eq("the bound is the webhook's own: 5 s", /const ENGINE_READ_TIMEOUT_MS = 5000;/.test(progress), true);
  eq("the regexes moved: none left in the validator", /engine\[-_\]\?version/.test(validator), false);
  eq("the validator's own cap stays private", /^const MAX_LAUNCH_FILE_BYTES = /m.test(validator), true);
}

async function main() {
  (process.env as Record<string, string>).NODE_ENV = "test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  stampAndVerdicts();
  await uploadPaths();
  await lazyRead();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
