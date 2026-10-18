/**
 * Package Guardian: the static certification gate of ADR 0005 step 5, as
 * decided in the note of 2026-10-19 items (d)–(f).
 *
 * runPackageGuardian() runs as the last step of every finalize path, after
 * publishVersion(), the forced restart and the update notification: the
 * three multipart routes that call lib/courses/upload.ts
 * uploadCoursePackage (app/api/courses/upload, …/packages and
 * …/packages/[packageId]/versions) and lib/courses/direct-upload.ts
 * finalizeDirectUpload; and from the super_owner re-run route
 * (canRerunCertification). It is WARN-ONLY: it never throws, never blocks
 * or fails an upload, and nothing reads the tier for grading, completion,
 * scores, the Report Card, CRM or journeys (D1). With ALDS_P4 off it returns
 * before any read; with 0100 absent it logs once and skips.
 *
 *   no root alds-manifest.json → nothing written (the version stays `unverified`)
 *   manifest                → package_certifications row `pending`, the tier
 *                             `pending`, then checkPackage over the stored
 *                             bytes + the allowlist leg + the package digest
 *                             under a 20 s deadline and a 60 MB byte budget
 *                             → `certified` or `uncertified` (with a reason)
 *   deadline / storage error / exception → `uncertified` (check_error)
 *
 * The tier moves only through lib/alds/tier-writer.ts (the security-definer
 * RPC); this file is the only writer of package_certifications
 * (tests/unit/alds-tier-read-sites.test.ts). Never imports from lib/courses
 * (the upload paths import this file).
 */
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { getStorageFor, type StorageAdapter } from "@/lib/storage";
import bundlesRegistry from "./bundles/bundles.json";
import engineAllowlistFile from "./engine-allowlist.json";
import { aldsP4Enabled, isAldsSchemaMissing, logAldsSkip } from "./flag";
import { checkPackage } from "./rules/package";
import type { CheckResult, Finding } from "./rules/findings";
import { TIER_REASON, type AnalyticsTier, type TierReasonCode } from "./tier";
import { setVersionTier } from "./tier-writer";
import type { AldsPackageManifest } from "./types";

export const GUARDIAN_DEADLINE_MS = 20_000;
export const GUARDIAN_DIGEST_BUDGET_BYTES = 60 * 1024 * 1024;
export const ALDS_MANIFEST_NAME = "alds-manifest.json";

/**
 * Certified packages are KIVO cmi5 packages only (ADR 0002 decision 2, ADR
 * 0005 step 1; lib/alds/rules/package.ts header). An alias of the
 * TIER_REASON entry, kept for the unit tests.
 */
export const REASON_MANIFEST_TYPE_NOT_CERTIFIABLE = TIER_REASON.manifestTypeNotCertifiable;

/** One text object (alds-manifest.json, cmi5.xml, …) larger than this is a check_error. */
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
/** Parallel storage reads for the digest (validate-stored.ts uses the same). */
const FETCH_CONCURRENCY = 6;

// ---------------------------------------------------------------- allowlist

/** One reviewed entry of lib/alds/engine-allowlist.json (ADR 0005 step 4, note (d)). */
export interface AllowlistEntry {
  engineDigest: string;
  rulesBundleHash: string;
  certifiedKinds: string[];
  editorVersion: string;
  registeredAt: string;
  reference: string;
}

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function isAllowlistEntry(e: unknown): e is AllowlistEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.engineDigest === "string" && SHA256_RE.test(o.engineDigest) &&
    typeof o.rulesBundleHash === "string" && SHA256_RE.test(o.rulesBundleHash) &&
    Array.isArray(o.certifiedKinds) && o.certifiedKinds.every((k) => typeof k === "string") &&
    typeof o.editorVersion === "string" &&
    typeof o.registeredAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.registeredAt) &&
    typeof o.reference === "string"
  );
}

/** The shipped allowlist; a malformed entry is dropped (it can never certify). */
export function loadEngineAllowlist(): readonly AllowlistEntry[] {
  const engines = (engineAllowlistFile as { engines?: unknown }).engines;
  return Array.isArray(engines) ? engines.filter(isAllowlistEntry) : [];
}

export function findAllowlistEntry(
  list: readonly AllowlistEntry[],
  engineDigest: string | null | undefined,
  rulesBundleHash: string | null | undefined
): AllowlistEntry | null {
  if (!engineDigest || !rulesBundleHash) return null;
  return list.find((e) => e.engineDigest === engineDigest && e.rulesBundleHash === rulesBundleHash) ?? null;
}

// ---------------------------------------------------------------- pure pieces

type BundleEntry = { n: number; rulesBundleHash: string };
const BUNDLES = ((bundlesRegistry as { bundles?: BundleEntry[] }).bundles ?? []) as BundleEntry[];

/** The rulesBundleHash values U5 knows (lib/alds/bundles/bundles.json). */
export function knownBundleHashes(): string[] {
  return BUNDLES.map((b) => b.rulesBundleHash);
}

function latestBundle(): BundleEntry | null {
  return BUNDLES.length ? BUNDLES[BUNDLES.length - 1] : null;
}

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/**
 * The package digest (ADR 0005 step 5): sha256 over the lines
 * `${path}\n${sha256 of the object bytes}`, sorted by path (code-unit order),
 * joined with "\n". Result `sha256:<hex>`.
 */
export async function packageDigest(entries: Iterable<{ path: string; sha256Hex: string }>): Promise<string> {
  const lines = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}\n${e.sha256Hex}`);
  return `sha256:${await sha256HexOf(new TextEncoder().encode(lines.join("\n")))}`;
}

export interface TierDecision {
  tier: "certified" | "uncertified";
  reasonCode: string | null;
  reason: string | null;
}

/**
 * The tier decision of note (e): the first `error` finding wins
 * (`<rule>:<code>: <message>`); then the package type (cmi5 only), the
 * self-check stamp, the allowlist, the certified kinds and the digest, in
 * that order; otherwise `certified`. `manifestType` is the version's
 * (course_versions.manifest_type); omitted, the manifest's own is used.
 */
export function decideTier(input: {
  check: CheckResult;
  manifest: AldsPackageManifest | null;
  allowlist: AllowlistEntry | null;
  digestCode: TierReasonCode | null;
  selfCheckPresent: boolean;
  manifestType?: string | null;
}): TierDecision {
  const firstError: Finding | undefined = input.check.findings.find((f) => f.severity === "error");
  if (firstError) {
    const code = `${firstError.rule}:${firstError.code}`;
    return { tier: "uncertified", reasonCode: code, reason: oneLine(`${code}: ${firstError.message}`) };
  }
  const uncertified = (code: string, text: string): TierDecision => ({
    tier: "uncertified",
    reasonCode: code,
    reason: oneLine(`${code}: ${text}`),
  });
  const type = input.manifestType ?? input.manifest?.manifestType ?? null;
  if (type !== "cmi5") {
    return uncertified(
      REASON_MANIFEST_TYPE_NOT_CERTIFIABLE,
      `only KIVO cmi5 packages can be certified (this package is ${type ?? "of an unknown type"})`
    );
  }
  if (!input.selfCheckPresent || !input.manifest?.selfCheck) {
    return uncertified(TIER_REASON.selfCheckMissing, "alds-manifest.json carries no selfCheck stamp from the editor's export self-check");
  }
  if (!input.allowlist) {
    return uncertified(
      TIER_REASON.engineNotAllowlisted,
      `engine ${short(input.manifest.selfCheck.engineDigest)} with rules bundle ${short(input.manifest.rulesBundleHash)} is not in the certified engine allowlist`
    );
  }
  const kinds = authoringKindsOf(input.manifest);
  const outside = [...new Set(kinds.filter((k) => !input.allowlist!.certifiedKinds.includes(k)))];
  if (outside.length > 0) {
    return uncertified(TIER_REASON.kindNotCertified, `${outside.join(", ")} outside the certified kinds of this engine`);
  }
  if (input.digestCode) {
    return uncertified(
      input.digestCode,
      input.digestCode === TIER_REASON.packageDigestBudget
        ? `the stored files exceed the ${GUARDIAN_DIGEST_BUDGET_BYTES / (1024 * 1024)} MB digest budget`
        : "the package digest could not be computed"
    );
  }
  return { tier: "certified", reasonCode: null, reason: null };
}

function authoringKindsOf(manifest: AldsPackageManifest | null): string[] {
  return (manifest?.questions ?? [])
    .map((q) => q.authoringKind)
    .filter((k): k is string => typeof k === "string" && k !== "");
}

const short = (h: string | null | undefined) => (h ? `${h.slice(0, 19)}…` : "(none)");

function oneLine(s: string, max = 500): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** No URLs (signed storage links carry tokens), no bearer-like strings, one line. */
export function scrubErrorMessage(message: string): string {
  return oneLine(
    message
      .replace(/https?:\/\/\S+/gi, "<url>")
      .replace(/\b(token|signature|sig|key|apikey|authorization)=\S+/gi, "$1=<redacted>")
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>"),
    300
  );
}

/** The shortest listed key ending in `/<name>` (case-insensitive), as finalizeIntegrity picks manifests. */
export function findPackageKey(keys: readonly string[], name: string): string | null {
  const suffix = `/${name.toLowerCase()}`;
  return (
    keys
      .filter((k) => k.toLowerCase().endsWith(suffix))
      .sort((a, b) => a.length - b.length)[0] ?? null
  );
}

function launchManifestName(manifestType: string): string {
  return manifestType === "cmi5" ? "cmi5.xml" : manifestType === "xapi" ? "tincan.xml" : "imsmanifest.xml";
}

/**
 * The package's own alds-manifest.json: the one at the package root, which
 * is the directory of the version's launch manifest (cmi5.xml, tincan.xml or
 * imsmanifest.xml by the same shortest-key rule; uploads keep a zip's top
 * folder, so the root may be one folder down), or the storage prefix itself
 * when no launch manifest is listed. A copy anywhere else is not the
 * package manifest: the version stays `unverified` with nothing written
 * (ADR 0005 note (e), "no root alds-manifest.json"; step 1, "no manifest →
 * unverified"). The file name compares case-insensitively, as
 * findPackageKey does.
 */
export function rootAldsManifestKey(keys: readonly string[], prefix: string, manifestType: string): string | null {
  const launchKey = findPackageKey(keys, launchManifestName(manifestType));
  const dir = launchKey ? launchKey.slice(0, launchKey.lastIndexOf("/")) : prefix.replace(/\/$/, "");
  const want = `${dir}/${ALDS_MANIFEST_NAME}`.toLowerCase();
  return keys.find((k) => k.toLowerCase() === want) ?? null;
}

/**
 * Who may re-run the check (ADR 0005 note (f)): the certify route's
 * permission predicate, on the caller's RAW organization_members.role as
 * requireOrgAdminApi reads it. super_owner only: an admin, the legacy
 * "owner" alias (which requireOrgAccess normalises to super_owner for
 * pages) and an impersonation without a membership row are refused. The
 * Library course page offers "Re-run check" through this same function on
 * the same raw role, so the button shows only where the route answers.
 */
export function canRerunCertification(membershipRole: string | null | undefined): boolean {
  return membershipRole === "super_owner";
}

// ---------------------------------------------------------------- the gate

export type GuardianSkip =
  | "flag_off"
  | "no_manifest"
  | "schema_missing"
  | "not_ready"
  /** the version does not exist or belongs to another organisation */
  | "not_found"
  /** a read, or the first write, failed with an error that is not a missing 0100 object; no tier written */
  | "unavailable";

export type GuardianOutcome =
  | { skipped: GuardianSkip }
  | { tier: AnalyticsTier; reasonCode: string | null; reason: string | null; certificationId: string };

export interface GuardianInput {
  versionId: string;
  organizationId: string;
  trigger: "upload" | "rerun";
  /** null = the upload gate; otherwise the super_owner of a re-run */
  requestedBy?: string | null;
  /** The direct-upload finalize's listing of the prefix (saves the second listing). */
  listedKeys?: string[];
}

type VersionRow = {
  id: string;
  course_id: string;
  package_id: string | null;
  manifest_type: "cmi5" | "xapi" | "scorm12";
  storage_prefix: string;
  storage_driver?: string | null;
  upload_status?: string | null;
};

export async function runPackageGuardian(input: GuardianInput): Promise<GuardianOutcome> {
  if (!aldsP4Enabled()) return { skipped: "flag_off" };
  const { versionId, organizationId } = input;
  // The direct path already listed the prefix: a Level 1 upload costs nothing.
  // A cheap pre-filter (no alds-manifest.json at any depth); the root rule
  // (rootAldsManifestKey) needs the version's type and runs after its read.
  if (input.listedKeys && !findPackageKey(input.listedKeys, ALDS_MANIFEST_NAME)) return { skipped: "no_manifest" };

  let svc: SupabaseClient | null = null;
  let certificationId: string | null = null;
  try {
    svc = serviceClient();

    // ---- the version, in the caller's organisation (course_versions has no organization_id)
    const { data: vData, error: vErr } = await svc.from("course_versions").select("*").eq("id", versionId).maybeSingle();
    if (vErr) return skipFor(vErr, "version_unreadable", versionId);
    const v = vData as VersionRow | null;
    if (!v) return { skipped: "not_found" };
    const { data: cData, error: cErr } = await svc
      .from("courses")
      .select("id")
      .eq("id", v.course_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (cErr) return skipFor(cErr, "course_unreadable", versionId);
    if (!cData) return { skipped: "not_found" };
    // Before 0077 there is no upload_status: the row is ready.
    if (v.upload_status && v.upload_status !== "ready") return { skipped: "not_ready" };

    // ---- the stored files
    const storage = await storageFor(v.storage_driver ?? null);
    const prefix = v.storage_prefix.replace(/\/$/, "");
    let keys: string[];
    try {
      keys = input.listedKeys ?? (await storage.list(prefix));
    } catch (e) {
      logAldsSkip("guardian", `listing_failed: ${scrubErrorMessage(errMessage(e))}`, { versionId });
      return { skipped: "unavailable" };
    }
    const manifestKey = rootAldsManifestKey(keys, prefix, v.manifest_type);
    if (!manifestKey) return { skipped: "no_manifest" };

    let slotLanguage: string | null = null;
    if (v.package_id) {
      const { data: pkg } = await svc.from("course_packages").select("language").eq("id", v.package_id).maybeSingle();
      slotLanguage = (pkg as { language?: string | null } | null)?.language ?? null; // a read error skips R4 only
    }

    // ---- the run row, then `pending`
    const bundle = latestBundle();
    const { data: run, error: runErr } = await svc
      .from("package_certifications")
      .insert({
        organization_id: organizationId,
        course_version_id: versionId,
        status: "pending",
        rules_bundle_hash: bundle?.rulesBundleHash ?? null,
        rules_version: bundle ? String(bundle.n) : null,
        requested_by: input.requestedBy ?? null,
      })
      .select("id")
      .single();
    if (runErr || !run) return skipFor(runErr, "certification_insert_failed", versionId);
    certificationId = (run as { id: string }).id;

    const pending = await setVersionTier(svc, {
      p_version_id: versionId,
      p_tier: "pending",
      p_reason_code: TIER_REASON.checkRunning,
      p_reason: "static check running",
      p_certification_id: certificationId,
    });
    if (!pending.ok) {
      if (pending.schemaMissing) {
        logAldsSkip("guardian", "schema_missing", { versionId, certificationId });
        return { skipped: "schema_missing" };
      }
      // No tier was written: close the run as history and leave the version as it was.
      await updateRun(svc, certificationId, organizationId, {
        status: "uncertified",
        reason_code: TIER_REASON.checkError,
        reason: `check_error: the tier could not be set (${pending.error.code ?? "error"})`,
        finished_at: new Date().toISOString(),
      });
      logAldsSkip("guardian", `tier_write_failed: ${pending.error.code ?? "error"}`, { versionId, certificationId });
      return { skipped: "unavailable" };
    }

    // ---- the check, under the deadline
    const result = await underDeadline(currentDeadlineMs(), (state) =>
      checkAndRecord(state, {
        svc: svc!,
        storage,
        version: v,
        prefix,
        keys,
        manifestKey,
        slotLanguage,
        certificationId: certificationId!,
        organizationId,
      })
    );
    if (result.kind === "done") return report(versionId, result.outcome);
    const message =
      result.kind === "timeout"
        ? `the static check did not finish within ${currentDeadlineMs() / 1000} s`
        : result.message;
    return report(versionId, await recordCheckError(svc, { versionId, organizationId, certificationId }, message));
  } catch (e) {
    if (isAldsSchemaMissing(asDbError(e))) {
      logAldsSkip("guardian", "schema_missing", { versionId });
      return { skipped: "schema_missing" };
    }
    if (svc && certificationId) {
      try {
        return report(versionId, await recordCheckError(svc, { versionId, organizationId, certificationId }, errMessage(e)));
      } catch {
        /* fall through */
      }
    }
    logAldsSkip("guardian", `error: ${scrubErrorMessage(errMessage(e))}`, { versionId, certificationId });
    return { skipped: "unavailable" };
  }
}

type DeadlineState = { expired: boolean; finalizing: boolean };
type WorkResult = { kind: "done"; outcome: GuardianOutcome } | { kind: "error"; message: string } | { kind: "timeout" };

/**
 * Runs `work` against a wall-clock deadline. When the deadline passes before
 * the work has started its final writes, `expired` is set (the work stops
 * fetching and never writes) and the caller records check_error. Once the
 * work sets `finalizing`, the deadline no longer applies, so a late
 * completion can never overwrite the check_error result or vice versa.
 */
async function underDeadline(ms: number, work: (state: DeadlineState) => Promise<GuardianOutcome>): Promise<WorkResult> {
  const state: DeadlineState = { expired: false, finalizing: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<WorkResult>((resolve) => {
    timer = setTimeout(() => {
      if (state.finalizing) return;
      state.expired = true;
      resolve({ kind: "timeout" });
    }, ms);
  });
  try {
    return await Promise.race([
      work(state).then(
        (outcome): WorkResult => ({ kind: "done", outcome }),
        (e): WorkResult => ({ kind: "error", message: errMessage(e) })
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class DeadlineExpired extends Error {
  constructor() {
    super("deadline expired");
  }
}

async function checkAndRecord(
  state: DeadlineState,
  ctx: {
    svc: SupabaseClient;
    storage: StorageAdapter;
    version: VersionRow;
    prefix: string;
    keys: string[];
    manifestKey: string;
    slotLanguage: string | null;
    certificationId: string;
    organizationId: string;
  }
): Promise<GuardianOutcome> {
  const { svc, storage, version, prefix, keys, manifestKey, certificationId, organizationId } = ctx;
  const live = () => {
    if (state.expired) throw new DeadlineExpired();
  };
  const budget = { used: 0, limit: currentBudgetBytes() };
  const fetched = new Map<string, Uint8Array>();

  // The manifest and the launch manifest of the type (same shortest-key rule).
  const manifestText = decodeText(await readText(storage, manifestKey, budget, fetched));
  live();
  const launchKey = findPackageKey(keys, launchManifestName(version.manifest_type));
  const launchXml = launchKey ? decodeText(await readText(storage, launchKey, budget, fetched)) : null;
  live();

  const check = checkPackage({
    manifestText,
    manifestType: version.manifest_type,
    cmi5Xml: version.manifest_type === "cmi5" ? launchXml : null,
    tincanXml: version.manifest_type === "xapi" ? launchXml : null,
    imsManifestXml: version.manifest_type === "scorm12" ? launchXml : null,
    knownBundleHashes: knownBundleHashes(),
    slotLanguage: ctx.slotLanguage,
  });
  const manifest = check.manifest;
  const selfCheckPresent = !!manifest?.selfCheck;
  const allowlist = manifest?.selfCheck
    ? findAllowlistEntry(currentAllowlist(), manifest.selfCheck.engineDigest, manifest.rulesBundleHash)
    : null;

  // The package digest over every stored object (bytes already read are reused).
  const digest = await digestObjects(storage, keys, prefix, budget, fetched, state);
  live();

  const decision = decideTier({
    check,
    manifest,
    allowlist,
    digestCode: digest.code,
    selfCheckPresent,
    manifestType: version.manifest_type,
  });
  const kinds = authoringKindsOf(manifest);

  live();
  state.finalizing = true;
  const runErr = await updateRun(svc, certificationId, organizationId, {
    status: decision.tier,
    reason_code: decision.reasonCode,
    reason: decision.reason,
    finished_at: new Date().toISOString(),
    engine_digest: manifest?.selfCheck?.engineDigest ?? null,
    package_digest: digest.digest,
    static_report: {
      findings: check.findings,
      checked: check.checked,
      gate: { manifestType: version.manifest_type, selfCheckPresent, allowlisted: !!allowlist, digestCode: digest.code },
    },
    coverage: { kindsCovered: manifest?.selfCheck?.kindsCovered ?? [], authoringKinds: kinds },
  });
  if (runErr) throw new Error(`package_certifications update failed: ${runErr}`);
  const written = await setVersionTier(svc, {
    p_version_id: version.id,
    p_tier: decision.tier,
    p_reason_code: decision.reasonCode,
    p_reason: decision.reason,
    p_certification_id: certificationId,
    p_manifest: manifest ?? null,
    p_standard_version: manifest ? "2.0" : null,
    p_engine_version: manifest?.engineVersion ?? null,
    p_conformance_level: manifest ? 2 : 1,
  });
  if (!written.ok) throw new Error(`alds_set_version_tier failed: ${written.error.code ?? written.error.message}`);
  return { tier: decision.tier, reasonCode: decision.reasonCode, reason: decision.reason, certificationId };
}

/** Read one text object (≤ 16 MB), counting it against the budget; the bytes are kept for the digest. */
async function readText(
  storage: StorageAdapter,
  key: string,
  budget: { used: number; limit: number },
  fetched: Map<string, Uint8Array>
): Promise<Uint8Array> {
  const obj = await storage.getObject(key);
  if (!obj?.body) throw new Error(`stored object missing: ${key}`);
  if (obj.size > MAX_TEXT_BYTES) {
    await obj.body.cancel().catch(() => undefined);
    throw new Error(`${key} is larger than ${MAX_TEXT_BYTES / (1024 * 1024)} MB`);
  }
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`${key} is larger than ${MAX_TEXT_BYTES / (1024 * 1024)} MB`);
  budget.used += bytes.length;
  fetched.set(key, bytes);
  return bytes;
}

const decodeText = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

/**
 * sha256 of every object under the prefix, at most FETCH_CONCURRENCY reads
 * at a time. Over the byte budget → `package_digest_budget` (no digest; no
 * further reads start). A storage error throws (→ check_error).
 */
async function digestObjects(
  storage: StorageAdapter,
  keys: string[],
  prefix: string,
  budget: { used: number; limit: number },
  fetched: Map<string, Uint8Array>,
  state: DeadlineState
): Promise<{ digest: string | null; code: TierReasonCode | null }> {
  const entries: Array<{ path: string; sha256Hex: string }> = [];
  let over = budget.used > budget.limit;
  let cursor = 0;
  const rel = (k: string) => (k.startsWith(`${prefix}/`) ? k.slice(prefix.length + 1) : k);
  const worker = async () => {
    while (!over && !state.expired && cursor < keys.length) {
      const key = keys[cursor++];
      let bytes = fetched.get(key);
      if (!bytes) {
        const obj = await storage.getObject(key);
        if (!obj?.body) throw new Error(`stored object missing: ${rel(key)}`);
        if (obj.size > 0 && budget.used + obj.size > budget.limit) {
          over = true;
          await obj.body.cancel().catch(() => undefined);
          return;
        }
        bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
        budget.used += bytes.length;
        if (budget.used > budget.limit) {
          over = true;
          return;
        }
      }
      entries.push({ path: rel(key), sha256Hex: await sha256HexOf(bytes) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, keys.length) }, worker));
  if (state.expired) throw new DeadlineExpired();
  if (over) return { digest: null, code: TIER_REASON.packageDigestBudget };
  return { digest: await packageDigest(entries), code: null };
}

/** check_error: the run row and the tier say `uncertified`, re-runnable (ADR 0005 step 1). */
async function recordCheckError(
  svc: SupabaseClient,
  ids: { versionId: string; organizationId: string; certificationId: string },
  message: string
): Promise<GuardianOutcome> {
  const reason = `${TIER_REASON.checkError}: ${scrubErrorMessage(message)}`;
  await updateRun(svc, ids.certificationId, ids.organizationId, {
    status: "uncertified",
    reason_code: TIER_REASON.checkError,
    reason,
    finished_at: new Date().toISOString(),
  });
  const written = await setVersionTier(svc, {
    p_version_id: ids.versionId,
    p_tier: "uncertified",
    p_reason_code: TIER_REASON.checkError,
    p_reason: reason,
    p_certification_id: ids.certificationId,
  });
  if (!written.ok) {
    if (written.schemaMissing) {
      logAldsSkip("guardian", "schema_missing", { versionId: ids.versionId, certificationId: ids.certificationId });
      return { skipped: "schema_missing" };
    }
    logAldsSkip("guardian", `check_error_not_recorded: ${written.error.code ?? "error"}`, {
      versionId: ids.versionId,
      certificationId: ids.certificationId,
    });
  }
  return { tier: "uncertified", reasonCode: TIER_REASON.checkError, reason, certificationId: ids.certificationId };
}

/** The one package_certifications update site; returns the error message or null. */
async function updateRun(
  svc: SupabaseClient,
  certificationId: string,
  organizationId: string,
  patch: Record<string, unknown>
): Promise<string | null> {
  const { error } = await svc
    .from("package_certifications")
    .update(patch)
    .eq("id", certificationId)
    .eq("organization_id", organizationId);
  if (error) {
    console.warn("[alds] guardian: run row update failed", { certificationId, code: error.code ?? null });
    return error.code ?? error.message ?? "error";
  }
  return null;
}

function report(versionId: string, outcome: GuardianOutcome): GuardianOutcome {
  if ("tier" in outcome) {
    console.warn("[alds] guardian", {
      versionId,
      certificationId: outcome.certificationId,
      tier: outcome.tier,
      reasonCode: outcome.reasonCode,
    });
  }
  return outcome;
}

function skipFor(error: unknown, why: string, versionId: string): GuardianOutcome {
  if (isAldsSchemaMissing(asDbError(error))) {
    logAldsSkip("guardian", "schema_missing", { versionId });
    return { skipped: "schema_missing" };
  }
  const code = asDbError(error)?.code ?? null;
  logAldsSkip("guardian", code ? `${why}: ${code}` : why, { versionId });
  return { skipped: "unavailable" };
}

function asDbError(e: unknown): { code?: string | null; message?: string | null } | null {
  return e && typeof e === "object" ? (e as { code?: string | null; message?: string | null }) : null;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

// ---------------------------------------------------------------- clients and test doubles

/**
 * Unit tests (NODE_ENV=test) replace the service client, the storage
 * adapter, the deadline, the byte budget and the allowlist; production
 * always uses the real ones.
 */
const testDoubles: {
  svc: SupabaseClient | null;
  storageFor: ((driver: string | null) => Promise<StorageAdapter>) | null;
  deadlineMs: number | null;
  budgetBytes: number | null;
  allowlist: readonly AllowlistEntry[] | null;
} = { svc: null, storageFor: null, deadlineMs: null, budgetBytes: null, allowlist: null };

export function setGuardianTestDoubles(d: Partial<typeof testDoubles>): void {
  if (process.env.NODE_ENV !== "test") throw new Error("setGuardianTestDoubles is for unit tests only");
  Object.assign(testDoubles, d);
}

const testing = () => process.env.NODE_ENV === "test";

function serviceClient(): SupabaseClient {
  if (testing() && testDoubles.svc) return testDoubles.svc;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

function storageFor(driver: string | null): Promise<StorageAdapter> {
  if (testing() && testDoubles.storageFor) return testDoubles.storageFor(driver);
  return getStorageFor(driver);
}

function currentDeadlineMs(): number {
  return testing() && testDoubles.deadlineMs !== null ? testDoubles.deadlineMs : GUARDIAN_DEADLINE_MS;
}

function currentBudgetBytes(): number {
  return testing() && testDoubles.budgetBytes !== null ? testDoubles.budgetBytes : GUARDIAN_DIGEST_BUDGET_BYTES;
}

function currentAllowlist(): readonly AllowlistEntry[] {
  return testing() && testDoubles.allowlist ? testDoubles.allowlist : loadEngineAllowlist();
}
