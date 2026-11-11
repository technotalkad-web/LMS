/**
 * ADR 0022 G item 18 (L6): the Package Guardian's write path on a real
 * database, from a synthetic KIVO 2.0-shaped package whose alds-manifest.json
 * names the newest rules bundle and whose selfCheck.engineDigest equals the
 * digest of its own stub launch file (tests/unit/alds-fixtures/kivo2-stub.ts;
 * no engine bytes). The first package_certifications rows ever written, by
 * the real upload paths, and every Uncertified and Certified surface:
 *
 *   uploads  1  multipart, course A (root manifest)         → uncertified engine_not_allowlisted
 *            2  browser-direct, A v2 (same package)          → the same for A-v2
 *            3  multipart, course C (manifest one folder down) → no run row, tier unverified
 *            4  browser-direct, C v2                         → no run row, tier unverified
 *   then     1-3 the run rows and the version rows; the Library course page (badges, the
 *            super_owner's "Re-run check"), the Library list, Reports, the catalog; the
 *            certify route (403 admin, 400 reasons, 200 super_owner with a new run row and
 *            its audit row, 409 no_manifest); a service-role Certified case through
 *            alds_set_version_tier, seen on every surface and then reverted; nothing else
 *            moved (no attempt, no statement, the write-once columns, two courses).
 *
 * The spec never skips: a target without 0100, with ALDS_P4 off, whose gate skipped
 * (a failed listing, read or run-row insert) or with a build older than this
 * checkout's rules bundle fails with a message that says which.
 * It targets Cloud Run staging or an in-runner build (scripts/lifecycle-nightly.sh),
 * never the Workers staging, whose free plan cannot finish a Guardian run (ADR 0022
 * item 20): the seed refuses a *.workers.dev host before anything is written.
 * STAGING only (the lifecycle global setup refuses other projects); its
 * organisation is lifecycle-* test data. Nothing here is graded or assigned.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { authedContext } from "./helpers";
import { directUpload, uploadNew } from "./p0-helpers";
import { engineDigest } from "../../../lib/alds/rules/engine-digest";
import { D1_SENTENCE } from "../../../lib/alds/tier";
import { buildKivo2Stub, latestRulesBundle, zipOf, type Kivo2Stub } from "../../unit/alds-fixtures/kivo2-stub";

type User = { id: string; email: string; password: string };
type Row = Record<string, unknown>;
type RunRow = {
  id: string;
  organization_id: string;
  course_version_id: string;
  status: string;
  reason_code: string | null;
  reason: string | null;
  rules_version: string | null;
  rules_bundle_hash: string | null;
  engine_digest: string | null;
  package_digest: string | null;
  static_report: { gate?: Row; [k: string]: unknown } | null;
  coverage: { kindsCovered?: string[]; authoringKinds?: string[] } | null;
  requested_at: string;
  finished_at: string | null;
  requested_by: string | null;
};
type VersionRow = {
  id: string;
  version_number: number;
  package_id: string;
  storage_prefix: string;
  launch_url: string;
  manifest_type: string;
  manifest_data: Row;
  analytics_tier: string;
  analytics_tier_reason: string | null;
  certified_at: string | null;
  certification_id: string | null;
  conformance_level: number;
  standard_version: string | null;
  engine_version: string | null;
  alds_manifest: Row | null;
};
type CatalogItem = { id: string; version_id: string | null; analytics_tier?: string };

const LATEST = latestRulesBundle();
const C_IDS = { courseUlid: "01JAH7Q4ZB8K3T6W2M9XRV5C3N", title: "Home Loan Basics copy C" };
const RERUN_REASON = "spec 66 re-run";
const CERTIFIED_CASE_REASON = "spec 66: service-role certified case, not a certification (no engine row exists)";

/**
 * No run row and tier unverified: the gate returned before its run row. The seed already proved 0100 on this
 * database, so the causes left are the ones guardian.ts can return or throw there; the target's server log names
 * which (logAldsSkip writes `[alds] guardian skipped: <why>`, the upload paths `[alds] guardian failed`).
 */
const NO_RUN_ROW =
  "the gate wrote no run row: ALDS_P4 off on the target (flag_off), or the gate skipped (unavailable: listing_failed, " +
  "version_unreadable, course_unreadable or certification_insert_failed; no_manifest: the root alds-manifest.json was not " +
  "found; not_ready; not_found) or threw; the target's log line `[alds] guardian skipped: <why>` or `[alds] guardian failed` says which";

const EXPECTED_GATE =
  "uncertified with engine_not_allowlisted expected; U5:rules_bundle_unknown means the deployed build does not carry rules bundle " +
  `${LATEST.n} (redeploy Cloud Run at main >= 8a440ef); no run row and tier unverified means ${NO_RUN_ROW}`;

/** 0100 on the target: real selects of its columns and its table (the filter on a nil id reads no organisation's row). */
async function requires0100(): Promise<void> {
  const NIL = "00000000-0000-0000-0000-000000000000";
  const v = await svc()
    .from("course_versions")
    .select("analytics_tier, analytics_tier_reason, certified_at, certification_id, alds_manifest")
    .eq("id", NIL)
    .limit(1);
  if (v.error) throw new Error(`0100 is not applied on this database (course_versions tier columns: ${v.error.code ?? ""} ${v.error.message})`);
  const c = await svc().from("package_certifications").select("id, status, engine_digest, package_digest, static_report").eq("id", NIL).limit(1);
  if (c.error) throw new Error(`0100 is not applied on this database (package_certifications: ${c.error.code ?? ""} ${c.error.message})`);
}

const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/**
 * The package digest of guardian.ts packageDigest() over the zip's entries: sha256
 * over the lines `${path}\n${sha256 of the bytes}`, sorted by path in code-unit
 * order, joined with "\n". The zip has no top folder, so its entry paths are the
 * stored paths relative to the version's prefix.
 */
async function packageDigestOfZip(zipBytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(zipBytes);
  const entries = await Promise.all(
    Object.entries(zip.files)
      .filter(([, e]) => !e.dir)
      .map(async ([p, e]) => ({ path: p, hex: sha256Hex(await e.async("uint8array")) }))
  );
  const lines = entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((e) => `${e.path}\n${e.hex}`);
  return `sha256:${sha256Hex(Buffer.from(lines.join("\n"), "utf8"))}`;
}

async function runsOf(versionId: string): Promise<RunRow[]> {
  const { data, error } = await svc().from("package_certifications").select("*").eq("course_version_id", versionId).order("requested_at");
  expect(error, error?.message).toBeNull();
  return (data ?? []) as RunRow[];
}

async function versionRow(versionId: string): Promise<VersionRow> {
  const { data, error } = await svc().from("course_versions").select("*").eq("id", versionId).single();
  expect(error, error?.message).toBeNull();
  return data as VersionRow;
}

async function currentVersionOf(courseId: string): Promise<string> {
  const { data, error } = await svc().from("courses").select("current_version_id").eq("id", courseId).single();
  expect(error, error?.message).toBeNull();
  return (data as { current_version_id: string }).current_version_id;
}

async function packageOf(courseId: string): Promise<{ id: string; language: string | null }> {
  const { data, error } = await svc().from("course_packages").select("id, language").eq("course_id", courseId).single();
  expect(error, error?.message).toBeNull();
  return data as { id: string; language: string | null };
}

async function rerunAudits(versionId: string) {
  const { data, error } = await svc()
    .from("platform_audit_log")
    .select("actor_user_id, target_type, target_id, metadata")
    .eq("action", "course.version.certification_rerun")
    .eq("target_id", versionId);
  expect(error, error?.message).toBeNull();
  return (data ?? []) as Array<{ actor_user_id: string; target_type: string; target_id: string; metadata: Row }>;
}

/** Why the gate's result is not the expected one, in the words of the plan's failure table (never a skip). */
async function gateDiagnosis(versionId: string): Promise<string> {
  const runs = await runsOf(versionId);
  const v = await versionRow(versionId);
  const last = runs[runs.length - 1];
  if (!last) {
    return v.analytics_tier === "unverified"
      ? `${NO_RUN_ROW}. Expected: uncertified with engine_not_allowlisted`
      : `no run row while the tier reads ${v.analytics_tier}. ${EXPECTED_GATE}`;
  }
  if (last.reason_code === "U5:rules_bundle_unknown") {
    return `U5:rules_bundle_unknown: the deployed build does not carry rules bundle ${LATEST.n}; redeploy Cloud Run at main >= 8a440ef`;
  }
  if (last.status === "pending" || !last.finished_at || v.analytics_tier === "pending") {
    return "the run never finished (pending, check_running): spec 66 targets Cloud Run or an in-runner build, never the Workers staging (ADR 0022 item 20)";
  }
  if (last.reason_code === "check_error") return `check_error on the target: ${last.reason ?? ""}`;
  if (/^U[123]:/.test(last.reason_code ?? "")) return `kivo2-stub.ts and base.json disagree: ${last.reason ?? ""}`;
  return `${EXPECTED_GATE}; the run row reads ${last.status} ${last.reason_code ?? "(no code)"}`;
}

async function catalog(request: APIRequestContext, apiKey: string): Promise<CatalogItem[]> {
  const res = await request.get("/api/integrations/catalog?content_type=course&include_inactive=true", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  expect(res.status(), `catalog → ${res.status()}`).toBe(200);
  return ((await res.json()).courses ?? []) as CatalogItem[];
}

async function withPage<T>(ctx: BrowserContext, url: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url);
    expect(res?.status() ?? 0, `${url} → ${res?.status()}`).toBeLessThan(400);
    return await fn(page);
  } finally {
    await page.close();
  }
}

const versionBadge = (page: Page, versionId: string) =>
  page.locator(`li[data-testid="version-row"][data-version-id="${versionId}"] [data-testid="analytics-tier"]`);
const versionRerun = (page: Page, versionId: string) =>
  page.locator(`li[data-testid="version-row"][data-version-id="${versionId}"] [data-testid="rerun-certification"]`);
/** A course's row in the Reports course table (the one with the Question analytics column); other tables link courses too. */
const reportsCourseRow = (page: Page, orgSlug: string, courseId: string) =>
  page
    .locator("table", { has: page.getByTestId("question-analytics-header") })
    .locator("tr", { has: page.locator(`a[href="/${orgSlug}/library/${courseId}"]`) });

test.describe.serial("ADR 0022 G item 18: the Package Guardian's write path with a fixture manifest", () => {
  const s: {
    org?: { id: string; slug: string };
    owner?: User;
    admin?: User;
    ownerCtx?: BrowserContext;
    adminCtx?: BrowserContext;
    apiKey?: string;
    stubA?: Kivo2Stub;
    stubC?: Kivo2Stub;
    zipA?: Buffer;
    zipC?: Buffer;
    digestA?: string;
    courseA?: string;
    pkgA?: string;
    a1?: string;
    a2?: string;
    courseC?: string;
    pkgC?: string;
    c1?: string;
    c2?: string;
    runA1?: RunRow;
    runA2?: RunRow;
    rerun?: { id: string; reason: string };
    /** storage_prefix, launch_url, manifest_type of each version as the upload left them. */
    written?: Record<string, { storage_prefix: string; launch_url: string; manifest_type: string }>;
  } = { written: {} };
  const slug = () => s.org!.slug;

  test.afterAll(async () => {
    await s.ownerCtx?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  async function remember(versionId: string) {
    const v = await versionRow(versionId);
    s.written![versionId] = { storage_prefix: v.storage_prefix, launch_url: v.launch_url, manifest_type: v.manifest_type };
  }

  /** Item 1 (and item 3 for A-v2): the one gate run row of an upload. */
  async function expectGateRun(versionId: string, stub: Kivo2Stub): Promise<RunRow> {
    const why = await gateDiagnosis(versionId);
    const runs = await runsOf(versionId);
    expect(runs.length, `exactly one run row for the upload. ${why}`).toBe(1);
    const r = runs[0];
    expect(r.status, why).toBe("uncertified");
    expect(r.reason_code, why).toBe("engine_not_allowlisted");
    expect(r.reason ?? "", why).toMatch(/^engine_not_allowlisted: /);
    expect(r.organization_id).toBe(s.org!.id);
    expect(r.course_version_id).toBe(versionId);
    expect(r.requested_by, "the upload gate writes requested_by null").toBeNull();
    expect(r.rules_bundle_hash, why).toBe(LATEST.rulesBundleHash);
    expect(r.rules_version, why).toBe(String(LATEST.n));
    expect(r.engine_digest, "engine_digest = the stub's digest (its claim today; the computed value after L2: equal by construction)").toBe(stub.digest);
    expect(r.package_digest ?? "").toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      r.package_digest,
      "package_digest = sha256 over the sorted `path\\nsha256` lines of the zip's entries; a difference means a stored object that is not a zip entry (list the version's prefix and report it)"
    ).toBe(s.digestA);
    expect(r.finished_at, why).toBeTruthy();
    expect(Date.parse(r.finished_at!)).toBeGreaterThanOrEqual(Date.parse(r.requested_at));
    const gate = (r.static_report?.gate ?? {}) as Row;
    expect(gate.manifestType).toBe("cmi5");
    expect(gate.selfCheckPresent).toBe(true);
    expect(gate.allowlisted).toBe(false);
    expect(gate.digestCode).toBeNull();
    expect(r.coverage?.kindsCovered).toEqual(stub.manifest.selfCheck!.kindsCovered);
    expect(r.coverage?.authoringKinds).toEqual(
      stub.manifest.questions.map((q) => q.authoringKind).filter((k): k is string => typeof k === "string" && k !== "")
    );
    return r;
  }

  /** Item 2 (and item 3 for A-v2): the version row the gate wrote. */
  async function expectVersionRow(versionId: string, run: RunRow, stub: Kivo2Stub, slides: number) {
    const v = await versionRow(versionId);
    expect(v.analytics_tier, await gateDiagnosis(versionId)).toBe("uncertified");
    expect(v.analytics_tier_reason).toBe(run.reason);
    expect(v.certification_id).toBe(run.id);
    expect(v.certified_at).toBeNull();
    expect(v.conformance_level).toBe(2);
    expect(v.standard_version).toBe("2.0");
    expect(v.engine_version).toBe(stub.manifest.engineVersion);
    expect(v.alds_manifest, "alds_manifest = the manifest as the Guardian read it").toEqual(stub.manifest);
    expect(v.manifest_data.unitCount, "manifest_data.unitCount = the slides of the stub's COURSE_CONFIG").toBe(slides);
    expect(v.manifest_data.engineVersion, "ADR 0017's stamp, from data-engine-version").toBe(stub.manifest.engineVersion);
    expect(v.manifest_data.identity).toEqual({ kivoCourseId: stub.manifest.publisherIds.course, title: stub.manifest.courseTitle });
    return v;
  }

  const slidesOf = (stub: Kivo2Stub) => {
    const open = 'data-kivo="COURSE_CONFIG">';
    const at = stub.indexHtml.indexOf(open) + open.length;
    return (JSON.parse(stub.indexHtml.slice(at, stub.indexHtml.indexOf("</script>", at))) as { slides: unknown[] }).slides.length;
  };

  test("seed: 0100 on the target, the stub's contract, then an organisation with a super owner (API key) and an admin", async ({ browser, baseURL }) => {
    expect(
      new URL(baseURL!).hostname.endsWith(".workers.dev"),
      "ADR 0022 item 20: spec 66 targets Cloud Run staging or an in-runner build, never a Workers host (its free plan cannot finish a Guardian run)"
    ).toBe(false);
    await requires0100();

    // The builder's contract, pinned before anything is written to the target.
    s.stubA = buildKivo2Stub();
    s.stubC = buildKivo2Stub({ ids: C_IDS, manifestAt: "nested" });
    for (const stub of [s.stubA, s.stubC]) {
      const d = engineDigest(stub.indexHtml);
      expect(d.ok, "the stub page has an engine digest").toBe(true);
      expect(stub.manifest.selfCheck?.engineDigest, "the stub's claim = the digest of its own launch file").toBe(d.ok ? d.digest : "none");
      expect(stub.digest).toBe(d.ok ? d.digest : "none");
      expect(stub.manifest.rulesBundleHash).toBe(LATEST.rulesBundleHash);
    }
    const A = s.stubA.manifest;
    expect(Object.keys(s.stubA.files).sort()).toEqual(["alds-manifest.json", "cmi5.xml", "index.html", "tincan-min.js", "vendor/lottie_light.min.js"]);
    expect(Object.keys(s.stubC.files).sort()).toEqual(["assets/alds-manifest.json", "cmi5.xml", "index.html", "tincan-min.js", "vendor/lottie_light.min.js"]);
    // C differs from A only by its ids and title (and so its digest, the head's title being inside it) and the manifest's place.
    const asA = (t: string) => t.split(C_IDS.courseUlid).join(A.courseUlid).split(C_IDS.title).join(A.courseTitle).split(s.stubC!.digest).join(s.stubA!.digest);
    for (const f of ["cmi5.xml", "index.html", "tincan-min.js", "vendor/lottie_light.min.js"]) {
      expect(asA(s.stubC.files[f]), `${f}: C differs from A only where intended`).toBe(s.stubA.files[f]);
    }
    expect(asA(s.stubC.files["assets/alds-manifest.json"]), "the manifests differ only by the ids, the title and the claim").toBe(s.stubA.files["alds-manifest.json"]);
    expect(s.stubC.files["cmi5.xml"]).not.toBe(s.stubA.files["cmi5.xml"]);
    s.zipA = await zipOf(s.stubA.files);
    s.zipC = await zipOf(s.stubC.files);
    s.digestA = await packageDigestOfZip(s.zipA);

    const org = await createOrg({ name: "Lifecycle ALDS Guardian" });
    s.org = org;
    const mk = async (last: string, role: "super_owner" | "admin") => {
      const u = await createAuthUser({ profile: { first_name: "Guardian", last_name: last, must_change_password: false } });
      await addMember({ organizationId: org.id, userId: u.id, role });
      return u as User;
    };
    s.owner = await mk("Owner", "super_owner");
    s.admin = await mk("Admin", "admin");
    s.ownerCtx = await authedContext(browser, baseURL!, s.owner.email, s.owner.password);
    s.adminCtx = await authedContext(browser, baseURL!, s.admin.email, s.admin.password);
    const keyRes = await s.ownerCtx.request.post("/api/org/api-keys", { data: { orgSlug: org.slug, name: "Spec 66 catalog" } });
    expect(keyRes.ok(), `api key → ${keyRes.status()}`).toBeTruthy();
    s.apiKey = (await keyRes.json()).key as string;
  });

  test("1. upload 1 (multipart, course A) wrote the first package_certifications row", async () => {
    const up = await uploadNew(s.adminCtx!.request, slug(), "spec66-home-loan-basics.zip", s.zipA!);
    expect(up.ok(), `upload 1 → ${up.status()}: ${(await up.text()).slice(0, 300)}`).toBeTruthy();
    const body = (await up.json()) as { courseId: string; versionId: string };
    s.courseA = body.courseId;
    s.a1 = await currentVersionOf(s.courseA);
    expect(body.versionId).toBe(s.a1);
    s.pkgA = (await packageOf(s.courseA)).id;
    await remember(s.a1);
    s.runA1 = await expectGateRun(s.a1, s.stubA!);
  });

  test("2. the version row of A-v1", async () => {
    await expectVersionRow(s.a1!, s.runA1!, s.stubA!, slidesOf(s.stubA!));
    const pkg = await packageOf(s.courseA!);
    expect((pkg.language ?? "").split("-")[0], "a new course without a language takes the declared en-IN's slot: R4 does not fire").toBe("en");
  });

  test("3. upload 2 (browser-direct, A v2) wrote the same for A-v2", async () => {
    const r = await directUpload(s.adminCtx!.request, {
      orgSlug: slug(),
      buffer: s.zipA!,
      name: "spec66-home-loan-basics-v2.zip",
      courseId: s.courseA,
      packageId: s.pkgA,
      acknowledge: true,
    });
    expect(r.finalize?.status, `validate ${r.validate?.status ?? "-"} · init ${r.init?.status ?? "-"} · finalize ${r.finalize?.status ?? "-"}`).toBe(200);
    s.a2 = r.finalize!.body.versionId as string;
    expect(s.a2).toBe(r.versionId);
    await remember(s.a2);
    expect(await currentVersionOf(s.courseA!), "courses.current_version_id = A-v2").toBe(s.a2);
    s.runA2 = await expectGateRun(s.a2, s.stubA!);
    expect(s.runA2.id).not.toBe(s.runA1!.id);
    const v = await expectVersionRow(s.a2, s.runA2, s.stubA!, slidesOf(s.stubA!));
    expect(v.version_number).toBe(2);
    expect(v.package_id).toBe(s.pkgA);
  });

  test("uploads 3 and 4 (course C, the manifest one folder down): no run row, tier unverified", async () => {
    const up = await uploadNew(s.adminCtx!.request, slug(), "spec66-home-loan-basics-copy-c.zip", s.zipC!);
    expect(up.ok(), `upload 3 → ${up.status()}: ${(await up.text()).slice(0, 300)}`).toBeTruthy();
    s.courseC = ((await up.json()) as { courseId: string }).courseId;
    s.c1 = await currentVersionOf(s.courseC);
    s.pkgC = (await packageOf(s.courseC)).id;
    await remember(s.c1);
    const r = await directUpload(s.adminCtx!.request, {
      orgSlug: slug(),
      buffer: s.zipC!,
      name: "spec66-home-loan-basics-copy-c-v2.zip",
      courseId: s.courseC,
      packageId: s.pkgC,
      acknowledge: true,
    });
    expect(r.finalize?.status, `validate ${r.validate?.status ?? "-"} · init ${r.init?.status ?? "-"} · finalize ${r.finalize?.status ?? "-"}`).toBe(200);
    s.c2 = r.finalize!.body.versionId as string;
    await remember(s.c2);
    expect(await currentVersionOf(s.courseC)).toBe(s.c2);
    for (const id of [s.c1, s.c2]) {
      expect(await runsOf(id), "no root alds-manifest.json: the gate writes nothing (skipped no_manifest)").toEqual([]);
      const v = await versionRow(id);
      expect(v.analytics_tier).toBe("unverified");
      expect(v.certification_id).toBeNull();
      expect(v.conformance_level).toBe(1);
      expect(v.alds_manifest).toBeNull();
    }
  });

  test("4. the Library course page: a badge per version; Re-run check for the super owner only", async () => {
    const v1 = await versionRow(s.a1!);
    const v2 = await versionRow(s.a2!);
    await withPage(s.adminCtx!, `/${slug()}/library/${s.courseA}`, async (page) => {
      for (const v of [v1, v2]) {
        const badge = versionBadge(page, v.id);
        await expect(badge).toHaveAttribute("data-tier", "uncertified");
        await expect(badge).toHaveText("Uncertified");
        await expect(badge).toHaveAttribute("title", v.analytics_tier_reason!);
        await expect(badge).toHaveAttribute("data-certification-id", v.certification_id!);
      }
      await expect(page.locator('[data-testid="rerun-certification"]'), "an admin is never offered Re-run check").toHaveCount(0);
    });
    await withPage(s.ownerCtx!, `/${slug()}/library/${s.courseA}`, async (page) => {
      for (const v of [v1, v2]) {
        await expect(versionBadge(page, v.id)).toHaveAttribute("data-tier", "uncertified");
        await expect(versionRerun(page, v.id), "the super owner may re-run an uncertified version").toHaveCount(1);
      }
    });
  });

  test("5. the Library list: course A's card carries its default version's badge", async () => {
    await withPage(s.adminCtx!, `/${slug()}/library`, async (page) => {
      const badge = page.locator(`a[href="/${slug()}/library/${s.courseA}"] [data-testid="analytics-tier"]`);
      await expect(badge).toHaveAttribute("data-tier", "uncertified");
      await expect(badge).toHaveText("Uncertified");
    });
  });

  test("6. Reports: course A's question analytics read Unverified, with the D1 sentence", async () => {
    await withPage(s.adminCtx!, `/${slug()}/reports`, async (page) => {
      const row = reportsCourseRow(page, slug(), s.courseA!);
      await expect(row.locator('[data-testid="question-analytics"]')).toHaveText("Unverified");
      await expect(page.getByTestId("question-analytics-d1")).toContainText(D1_SENTENCE);
    });
  });

  test("7. the catalog: A's default version uncertified, C's unverified", async ({ request }) => {
    const items = await catalog(request, s.apiKey!);
    const a = items.find((c) => c.id === s.courseA);
    const c = items.find((x) => x.id === s.courseC);
    expect(a, "course A is in the catalog").toBeTruthy();
    expect(a!.version_id).toBe(s.a2);
    expect(a!.analytics_tier).toBe("uncertified");
    expect(c, "course C is in the catalog").toBeTruthy();
    expect(c!.analytics_tier, "unverified is a tier: present").toBe("unverified");
  });

  test("8. the certify route: 403 admin, 400 reasons, 200 super owner (new run row, audit row), 409 no_manifest", async () => {
    const certify = (req: APIRequestContext, courseId: string, packageId: string, versionId: string, reason: string) =>
      req.post(`/api/courses/${courseId}/packages/${packageId}/versions/${versionId}/certify`, { data: { orgSlug: slug(), reason } });
    const before = (await runsOf(s.a2!)).map((r) => r.id);

    const asAdmin = await certify(s.adminCtx!.request, s.courseA!, s.pkgA!, s.a2!, RERUN_REASON);
    expect(asAdmin.status()).toBe(403);
    expect(await asAdmin.json()).toEqual({ error: "super_owner_required" });
    expect((await runsOf(s.a2!)).map((r) => r.id), "no run row for a refused re-run").toEqual(before);
    expect(await rerunAudits(s.a2!), "no audit row for the admin").toEqual([]);

    for (const reason of ["x".repeat(501), ""]) {
      const res = await certify(s.ownerCtx!.request, s.courseA!, s.pkgA!, s.a2!, reason);
      expect(res.status(), `reason of ${reason.length} characters`).toBe(400);
    }
    expect(await rerunAudits(s.a2!), "no audit row for a refused reason (the audit write follows the reason check)").toEqual([]);
    expect((await runsOf(s.a2!)).map((r) => r.id)).toEqual(before);

    const ok = await certify(s.ownerCtx!.request, s.courseA!, s.pkgA!, s.a2!, RERUN_REASON);
    expect(ok.status(), `re-run → ${ok.status()}`).toBe(200);
    const out = (await ok.json()) as { tier: string; reasonCode: string; reason: string; certificationId: string };
    expect(out.tier, await gateDiagnosis(s.a2!)).toBe("uncertified");
    expect(out.reasonCode).toBe("engine_not_allowlisted");
    expect(before, "the re-run wrote a new run row").not.toContain(out.certificationId);
    const runs = await runsOf(s.a2!);
    expect(runs.map((r) => r.id)).toEqual([...before, out.certificationId]);
    const rerun = runs[runs.length - 1];
    expect(rerun.requested_by).toBe(s.owner!.id);
    expect(rerun.rules_bundle_hash).toBe(LATEST.rulesBundleHash);
    expect(rerun.status).toBe("uncertified");
    expect(rerun.reason_code).toBe("engine_not_allowlisted");
    expect(rerun.reason).toBe(out.reason);
    expect(rerun.engine_digest).toBe(s.stubA!.digest);
    expect((await versionRow(s.a2!)).certification_id).toBe(out.certificationId);
    const audits = await rerunAudits(s.a2!);
    expect(audits.length, "one audit row").toBe(1);
    expect(audits[0].actor_user_id).toBe(s.owner!.id);
    expect(audits[0].target_type).toBe("course_version");
    expect(audits[0].target_id).toBe(s.a2);
    expect(audits[0].metadata.reason).toBe(RERUN_REASON);
    s.rerun = { id: out.certificationId, reason: out.reason };

    const noManifest = await certify(s.ownerCtx!.request, s.courseC!, s.pkgC!, s.c1!, RERUN_REASON);
    expect(noManifest.status()).toBe(409);
    expect(await noManifest.json()).toEqual({ error: "no_manifest" });
    expect((await rerunAudits(s.c1!)).length, "the audit row is written before the run").toBe(1);
    expect(await runsOf(s.c1!)).toEqual([]);
  });

  test("9. the service-role Certified case on every surface, then reverted", async ({ request }) => {
    const rpc = (p_tier: string, p_reason_code: string | null, p_reason: string | null, p_certification_id: string) =>
      svc().rpc("alds_set_version_tier", { p_version_id: s.a2, p_tier, p_reason_code, p_reason, p_certification_id });

    const foreign = await rpc("certified", null, null, randomUUID());
    expect(foreign.error?.code, "a certification id that is not a run of the version is refused").toBe("23503");
    expect((await versionRow(s.a2!)).analytics_tier).toBe("uncertified");

    const { data: ins, error: insErr } = await svc()
      .from("package_certifications")
      .insert({
        organization_id: s.org!.id,
        course_version_id: s.a2,
        status: "certified",
        reason_code: null,
        reason: CERTIFIED_CASE_REASON,
        rules_bundle_hash: LATEST.rulesBundleHash,
        rules_version: String(LATEST.n),
        engine_digest: s.stubA!.digest,
        package_digest: s.digestA,
        finished_at: new Date().toISOString(),
        static_report: { spec: 66 },
      })
      .select("id")
      .single();
    expect(insErr, insErr?.message).toBeNull();
    const certifiedRun = (ins as { id: string }).id;

    let reverted: Awaited<ReturnType<typeof rpc>> | null = null;
    try {
      const set = await rpc("certified", null, null, certifiedRun);
      expect(set.error, set.error?.message).toBeNull();
      expect((set.data as Row).certified_at).toBeTruthy();
      expect((set.data as Row).certification_id).toBe(certifiedRun);
      const v = await versionRow(s.a2!);
      expect(v.analytics_tier).toBe("certified");
      expect(v.certified_at).toBeTruthy();
      await withPage(s.adminCtx!, `/${slug()}/library/${s.courseA}`, async (page) => {
        const badge = versionBadge(page, s.a2!);
        await expect(badge).toHaveAttribute("data-tier", "certified");
        await expect(badge).toHaveText("Certified");
      });
      await withPage(s.adminCtx!, `/${slug()}/library`, async (page) => {
        await expect(page.locator(`a[href="/${slug()}/library/${s.courseA}"] [data-testid="analytics-tier"]`)).toHaveAttribute("data-tier", "certified");
      });
      await withPage(s.adminCtx!, `/${slug()}/reports`, async (page) => {
        const row = reportsCourseRow(page, slug(), s.courseA!);
        await expect(row.locator('[data-testid="question-analytics"]')).toHaveText("Certified");
      });
      const a = (await catalog(request, s.apiKey!)).find((c) => c.id === s.courseA);
      expect(a?.analytics_tier).toBe("certified");
    } finally {
      // No lifecycle version stays Certified: back to the gate's result of item 8. A killed worker runs no
      // finally (nor afterAll): A-v2 then stays Certified in this lifecycle-* org, which holds no attempt and is
      // visible to no other org, until the global setup's 48 h cleanup deletes the org and its rows by cascade.
      reverted = await rpc("uncertified", "engine_not_allowlisted", s.rerun!.reason, s.rerun!.id);
    }
    expect(reverted?.error ?? null, reverted?.error?.message).toBeNull();
    const back = await versionRow(s.a2!);
    expect(back.analytics_tier).toBe("uncertified");
    expect(back.certified_at).toBeNull();
    expect(back.certification_id).toBe(s.rerun!.id);
    expect(back.analytics_tier_reason).toBe(s.rerun!.reason);
    await withPage(s.adminCtx!, `/${slug()}/library/${s.courseA}`, async (page) => {
      await expect(versionBadge(page, s.a2!)).toHaveAttribute("data-tier", "uncertified");
    });
    const kept = (await runsOf(s.a2!)).find((r) => r.id === certifiedRun);
    expect(kept?.status, "the inserted run row stays as history").toBe("certified");
    expect(kept?.reason).toBe(CERTIFIED_CASE_REASON);
  });

  test("10. nothing else moved: no attempt or statement, the write-once columns, two courses", async () => {
    const { data: attempts, error } = await svc().from("course_attempts").select("id").eq("organization_id", s.org!.id);
    expect(error, error?.message).toBeNull();
    expect(attempts ?? [], "no course_attempts in the organisation, so no xapi_statements (they belong to attempts)").toEqual([]);
    for (const [id, want] of Object.entries(s.written!)) {
      const v = await versionRow(id);
      expect({ storage_prefix: v.storage_prefix, launch_url: v.launch_url, manifest_type: v.manifest_type }, `version ${id}`).toEqual(want);
    }
    expect(Object.keys(s.written!).length).toBe(4);
    const { data: courses, error: cErr } = await svc().from("courses").select("id").eq("organization_id", s.org!.id);
    expect(cErr, cErr?.message).toBeNull();
    expect(((courses ?? []) as Array<{ id: string }>).map((c) => c.id).sort()).toEqual([s.courseA, s.courseC].sort());
  });
});
