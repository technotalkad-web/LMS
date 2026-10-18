import type { SupabaseClient } from "@supabase/supabase-js";
import type { ValidationCheck } from "./validate-package";

/**
 * Content-integrity check (ADR 0004 §2, D2): is this package another
 * course's module?
 *
 *   BLOCK  the package's course id (KIVO `urn:elearning-engine:<slug>`, a
 *          cmi5 course id, a tincan activity id, or COURSE_CONFIG.settings.
 *          xapiActivityId in the launch file) or its title already belongs to
 *          a DIFFERENT course in the same organisation. Verdict 'blocked'; a
 *          super_owner may override with a reason (step 3a).
 *   WARN   the id or title differs from the same package's previous version
 *          (a deliberate retitle or replacement); any admin confirms, recorded
 *          as today's acknowledgement. Never compared across slots of one
 *          course (language editions carry different KIVO slugs).
 *   WARN   `urn:elearning-engine:untitled-course`: "set a title before
 *          export"; that id never collides (two untitled exports in different
 *          courses must not block each other on the id); the title rule still
 *          applies.
 *
 * Rules are org-scoped. Titles are compared normalised (Unicode NFKC, trimmed,
 * whitespace collapsed, case-insensitive); ids trimmed, trailing slashes
 * dropped, case-insensitive. New versions persist the identity in
 * manifest_data.identity; older rows are read through manifest_data.raw.
 * courseId and manifest_data.title, so stored SCORM rows match on title only.
 *
 * Script and language detection (step 6) are informational only and live
 * here too: nothing gates on them.
 */

export type PackageIdentity = { kivoCourseId: string | null; title: string | null };

export const UNTITLED_KIVO_ID = "urn:elearning-engine:untitled-course";

export type IntegrityCollision = {
  courseId: string;
  courseTitle: string | null;
  versionId: string;
  matchedOn: Array<"id" | "title">;
};

export type IntegrityFindings = {
  version: 1;
  /** Where the lookup ran: the validate route, the multipart inline gate, or the direct-upload finalize on the stored bytes. */
  stage: "validate" | "inline" | "finalize";
  identity: PackageIdentity;
  /** The upload target the lookup excluded / compared against. Binds the validation to it. */
  context: { courseId: string | null; packageId: string | null };
  collisions: IntegrityCollision[];
  sameSlot: {
    versionId: string;
    versionNumber: number | null;
    previous: PackageIdentity;
    idChanged: boolean;
    titleChanged: boolean;
  } | null;
  untitledId: boolean;
  blocked: boolean;
  checkedAt: string;
};

export function normalizeIdentityId(id: string | null | undefined): string | null {
  const s = (id ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return s || null;
}

export function normalizeTitle(title: string | null | undefined): string | null {
  const s = (title ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return s || null;
}

/** KIVO single-file engine: COURSE_CONFIG.settings.xapiActivityId, when set. */
export function kivoIdFromLaunchHtml(html: string | null | undefined): string | null {
  if (!html || !/COURSE_CONFIG\b/.test(html)) return null;
  const m = /["']?xapiActivityId["']?\s*:\s*["']([^"'\s][^"']*)["']/.exec(html);
  return m?.[1]?.trim() || null;
}

/**
 * The identity of a package from its manifest (cmi5 course id, tincan
 * activity id, the manifest title) and, when the launch file's bytes are at
 * hand, the KIVO COURSE_CONFIG activity id.
 */
export function packageIdentity(
  manifest: { type: string; title?: string | null; raw?: Record<string, unknown> | null },
  launchHtml?: string | null
): PackageIdentity {
  const raw = (manifest.raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  let id: string | null = null;
  if (manifest.type === "cmi5") id = str(raw.courseId);
  else if (manifest.type === "xapi") id = str(raw.activityId) ?? str(raw.courseId);
  if (!id) id = kivoIdFromLaunchHtml(launchHtml);
  return { kivoCourseId: id, title: str(manifest.title) };
}

/** Identity of a stored version (manifest_data.identity, else the legacy fields). */
export function storedIdentity(md: {
  identity?: Partial<PackageIdentity> | null;
  title?: string | null;
  rawCourseId?: string | null;
}): PackageIdentity {
  const i = md.identity ?? null;
  return {
    kivoCourseId: (i?.kivoCourseId as string | null | undefined) ?? md.rawCourseId ?? null,
    title: (i?.title as string | null | undefined) ?? md.title ?? null,
  };
}

/**
 * What a stored identity shares with the incoming package (the collision
 * rule of ADR 0004 steps 3 and 5): the same normalised course id, unless
 * either side is the untitled KIVO id (that id never collides); and/or the
 * same normalised title (the title rule applies to untitled exports too).
 */
export function matchedOn(incoming: PackageIdentity, other: PackageIdentity): Array<"id" | "title"> {
  const id = normalizeIdentityId(incoming.kivoCourseId);
  const idForMatch = id === UNTITLED_KIVO_ID ? null : id;
  const title = normalizeTitle(incoming.title);
  const otherId = normalizeIdentityId(other.kivoCourseId);
  const out: Array<"id" | "title"> = [];
  if (idForMatch && otherId && otherId !== UNTITLED_KIVO_ID && otherId === idForMatch) out.push("id");
  if (title && normalizeTitle(other.title) === title) out.push("title");
  return out;
}

type VersionIdentityRow = {
  id: string;
  course_id: string;
  version_number?: number | null;
  identity: Partial<PackageIdentity> | null;
  mtitle: string | null;
  raw_course_id: string | null;
  courses?: { title?: string | null } | Array<{ title?: string | null }> | null;
};

const VERSION_IDENTITY_SELECT =
  "id, course_id, version_number, identity:manifest_data->identity, mtitle:manifest_data->>title, raw_course_id:manifest_data->raw->>courseId";

/**
 * The one org-scoped collision lookup (plus the same-slot drift check).
 * `svc` must see every course of the organisation (service role).
 */
export async function checkIntegrity(
  svc: SupabaseClient,
  args: {
    organizationId: string;
    /** The course being uploaded into (excluded from the collision lookup); null for a new course. */
    courseId: string | null;
    /** The language slot being replaced (same-slot drift); null for a new slot. */
    packageId: string | null;
    identity: PackageIdentity;
    stage: IntegrityFindings["stage"];
    /** The version being finalized (direct path): never its own "previous version". */
    excludeVersionId?: string | null;
  }
): Promise<IntegrityFindings> {
  const id = normalizeIdentityId(args.identity.kivoCourseId);
  const title = normalizeTitle(args.identity.title);
  const untitledId = id === UNTITLED_KIVO_ID;
  const idForMatch = untitledId ? null : id;

  const collisions = new Map<string, IntegrityCollision>();
  if (idForMatch || title) {
    // ADR 0008 D1: a failed upload keeps its row (and its manifest identity)
    // but holds no content, so it is never a collision. Before 0077 there is
    // no upload_status column (and no failed row): the lookup runs without
    // the filter.
    let excludeFailed = true;
    for (let from = 0; ; from += 1000) {
      const page = (withStatusFilter: boolean) => {
        let q = svc
          .from("course_versions")
          .select(`${VERSION_IDENTITY_SELECT}, courses!course_versions_course_id_fkey!inner(organization_id, title)`)
          .eq("courses.organization_id", args.organizationId)
          .order("id")
          .range(from, from + 999);
        if (args.courseId) q = q.neq("course_id", args.courseId);
        if (withStatusFilter) q = q.neq("upload_status", "failed");
        return q;
      };
      let { data, error } = await page(excludeFailed);
      if (error && excludeFailed && /upload_status|schema cache/i.test(error.message)) {
        excludeFailed = false;
        ({ data, error } = await page(false));
      }
      if (error) throw new Error(`integrity lookup failed: ${error.message}`);
      const rows = (data ?? []) as unknown as VersionIdentityRow[];
      for (const r of rows) {
        const other = storedIdentity({ identity: r.identity, title: r.mtitle, rawCourseId: r.raw_course_id });
        const matched = matchedOn(args.identity, other);
        if (matched.length === 0) continue;
        const course = Array.isArray(r.courses) ? r.courses[0] : r.courses;
        const prev = collisions.get(r.course_id);
        if (prev) {
          for (const m of matched) if (!prev.matchedOn.includes(m)) prev.matchedOn.push(m);
        } else {
          collisions.set(r.course_id, {
            courseId: r.course_id,
            courseTitle: course?.title ?? null,
            versionId: r.id,
            matchedOn: matched,
          });
        }
      }
      if (rows.length < 1000) break;
    }
  }

  // Same slot: compare with that package's current (else latest) version.
  let sameSlot: IntegrityFindings["sameSlot"] = null;
  if (args.packageId) {
    const { data: pkg } = await svc
      .from("course_packages")
      .select("id, current_version_id")
      .eq("id", args.packageId)
      .maybeSingle();
    const currentId = (pkg as { current_version_id?: string | null } | null)?.current_version_id ?? null;
    let q = svc.from("course_versions").select(VERSION_IDENTITY_SELECT).eq("package_id", args.packageId);
    if (args.excludeVersionId) q = q.neq("id", args.excludeVersionId);
    // Without a current version: the latest finished one (an in-flight
    // upload is not a "previous version").
    q = currentId && currentId !== args.excludeVersionId
      ? q.eq("id", currentId)
      : q.eq("upload_status", "ready").order("version_number", { ascending: false }).limit(1);
    const { data: prevRows } = await q;
    const prev = ((prevRows ?? []) as unknown as VersionIdentityRow[])[0];
    if (prev) {
      const previous = storedIdentity({ identity: prev.identity, title: prev.mtitle, rawCourseId: prev.raw_course_id });
      const pid = normalizeIdentityId(previous.kivoCourseId);
      const ptitle = normalizeTitle(previous.title);
      sameSlot = {
        versionId: prev.id,
        versionNumber: prev.version_number ?? null,
        previous,
        idChanged: !!id && !!pid && id !== pid,
        titleChanged: !!title && !!ptitle && title !== ptitle,
      };
    }
  }

  const list = [...collisions.values()];
  return {
    version: 1,
    stage: args.stage,
    identity: args.identity,
    context: { courseId: args.courseId, packageId: args.packageId },
    collisions: list,
    sameSlot,
    untitledId,
    blocked: list.length > 0,
    checkedAt: new Date().toISOString(),
  };
}

/** The report lines the findings add (ids all start with "integrity"). */
export function integrityChecks(f: IntegrityFindings): ValidationCheck[] {
  const out: ValidationCheck[] = [];
  if (f.blocked) {
    const names = f.collisions
      .slice(0, 3)
      .map((c) => `"${c.courseTitle ?? c.courseId.slice(0, 8)}" (matched on ${c.matchedOn.join(" and ")})`)
      .join(", ");
    const more = f.collisions.length > 3 ? ` and ${f.collisions.length - 3} more` : "";
    out.push({
      id: "integrity",
      label: "Content integrity (wrong-course check)",
      status: "fail",
      detail: `This module already belongs to a different course in this organisation: ${names}${more}. Uploading it here would serve another course's module to learners. Upload it to that course instead, or ask a super owner to override with a reason.`,
    });
  } else {
    out.push({
      id: "integrity",
      label: "Content integrity (wrong-course check)",
      status: "pass",
      detail: "No other course in this organisation carries this module's course id or title.",
    });
  }
  const s = f.sameSlot;
  if (s && (s.idChanged || s.titleChanged)) {
    const parts: string[] = [];
    if (s.titleChanged) parts.push(`title "${s.previous.title}" → "${f.identity.title}"`);
    if (s.idChanged) parts.push(`course id ${s.previous.kivoCourseId} → ${f.identity.kivoCourseId}`);
    out.push({
      id: "integrity-slot",
      label: "Change against this language's current version",
      status: "warning",
      detail: `Differs from the version learners get today${s.versionNumber ? ` (v${s.versionNumber})` : ""}: ${parts.join("; ")}. Confirm only if this is a deliberate retitle or replacement.`,
    });
  }
  if (f.untitledId) {
    out.push({
      id: "integrity-untitled",
      label: "Course title",
      status: "warning",
      detail: `Exported as an untitled course (${UNTITLED_KIVO_ID}). Set a title in the editor before export, so the module keeps a stable course id.`,
    });
  }
  return out;
}

/** Verdict over a set of checks (same rule as validatePackage). */
function verdictOf(checks: ValidationCheck[]): "pass" | "warning" | "fail" {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warning")) return "warning";
  return "pass";
}

/**
 * Merge the findings into a validation report: the integrity lines replace
 * any earlier ones, the findings ride along as `report.integrity`, and the
 * verdict becomes 'blocked' on a collision ('unplayable' still wins).
 */
export function applyIntegrity<
  R extends { verdict: string; checks: ValidationCheck[]; integrity?: IntegrityFindings | null }
>(report: R, f: IntegrityFindings): R {
  const checks = report.checks.filter((c) => !c.id.startsWith("integrity")).concat(integrityChecks(f));
  const verdict =
    report.verdict === "unplayable" ? "unplayable" : f.blocked ? "blocked" : verdictOf(checks);
  return { ...report, checks, verdict, integrity: f };
}

/** A stored validation row as the upload gates read it (select("*"), deploy-safe). */
export type GateValidationRow = {
  verdict: string;
  overridden_at?: string | null;
  report?: { integrity?: { context?: { courseId?: string | null } | null } | null } | null;
};

/** 'blocked' and not (yet) overridden by a super_owner → the gates refuse it. */
export function isUnresolvedBlock(row: GateValidationRow): boolean {
  return row.verdict === "blocked" && !row.overridden_at;
}

/**
 * The validation was run for another upload target than this one (its
 * collision lookup excluded a different course), so it cannot vouch for
 * this upload. Reports without a recorded target bind to nothing.
 */
export function validatedForOtherCourse(row: GateValidationRow, courseId: string | null): boolean {
  const bound = row.report?.integrity?.context?.courseId ?? null;
  return bound !== null && bound !== (courseId ?? null);
}

export const BLOCKED_UPLOAD_ERROR =
  "This module already belongs to a different course in this organisation, so the upload is blocked. Upload it to that course, or ask a super owner to override the block with a reason.";

// ---------------------------------------------------------------------------
// Script / language detection (informational only — ADR 0004 step 6)
// ---------------------------------------------------------------------------

const HINGLISH_WORDS = new Set([
  "hai", "hain", "ka", "ki", "ke", "ko", "se", "mein", "aur", "nahi", "nahin", "kya", "aap", "hum", "ham",
  "yeh", "ye", "woh", "wo", "toh", "bhi", "par", "kaise", "kyun", "kyon", "apna", "apne", "apni",
  "karna", "karein", "kare", "karo", "hota", "hoti", "hote", "tha", "thi", "ek", "sab", "jab", "agar",
]);
const ENGLISH_WORDS = new Set([
  "the", "and", "is", "are", "of", "in", "you", "your", "for", "with", "this", "that", "it", "on", "be",
  "can", "will", "what", "how", "when", "if", "or", "not", "a", "an", "we", "our", "they", "from", "by",
]);
// Ambiguous romanised forms are left out of the Hinglish set ("to", and "the"
// = were, which is counted as English).

export type ScriptDetection = {
  letters: number;
  latinPct: number;
  devanagariPct: number;
  gujaratiPct: number;
  otherPct: number;
  dominant: "Latin" | "Devanagari" | "Gujarati" | "Other" | null;
  hinglishWords: number;
  englishWords: number;
  /** hinglish / (hinglish + english) function words, 0–1; null without a signal. */
  hinglishScore: number | null;
};

/** Natural-language text of a launch file: tag text plus prose-like string literals. */
function proseOf(html: string): string {
  const src = html.length > 3 * 1024 * 1024 ? html.slice(0, 3 * 1024 * 1024) : html;
  const parts: string[] = [];
  // Text between tags (outside <script>/<style>).
  const noCode = src.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  parts.push(noCode.replace(/<[^>]+>/g, " "));
  // String literals inside scripts (single-file engines keep slide text there).
  const lit = /"((?:[^"\\\n]|\\.){4,600})"|'((?:[^'\\\n]|\\.){4,600})'/g;
  let m: RegExpExecArray | null;
  let budget = 20000;
  while ((m = lit.exec(src)) !== null && budget-- > 0) {
    const s = (m[1] ?? m[2] ?? "").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (!/\s/.test(s) || /https?:|function\s*\(|=>|[{};<>]|\$\{/.test(s)) continue;
    parts.push(s);
  }
  return parts.join(" ");
}

export function detectScript(html: string | null | undefined): ScriptDetection | null {
  if (!html) return null;
  const text = proseOf(html);
  let latin = 0, deva = 0, guj = 0, other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) latin++;
    else if (cp >= 0x900 && cp <= 0x97f) deva++;
    else if (cp >= 0xa80 && cp <= 0xaff) guj++;
    else if (/\p{L}/u.test(ch)) other++;
  }
  const letters = latin + deva + guj + other;
  if (letters === 0) return null;
  const pct = (n: number) => Math.round((n / letters) * 1000) / 10;
  const counts: Array<[ScriptDetection["dominant"], number]> = [["Latin", latin], ["Devanagari", deva], ["Gujarati", guj], ["Other", other]];
  const dominant = counts.sort((a, b) => b[1] - a[1])[0][0];
  let h = 0, e = 0;
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (HINGLISH_WORDS.has(w)) h++;
    else if (ENGLISH_WORDS.has(w)) e++;
  }
  return {
    letters,
    latinPct: pct(latin),
    devanagariPct: pct(deva),
    gujaratiPct: pct(guj),
    otherPct: pct(other),
    dominant,
    hinglishWords: h,
    englishWords: e,
    hinglishScore: h + e > 0 ? Math.round((h / (h + e)) * 100) / 100 : null,
  };
}

/** The informational report line for the detection (never gates). */
export function scriptCheck(d: ScriptDetection | null): ValidationCheck | null {
  if (!d) return null;
  const share =
    d.dominant === "Latin" ? d.latinPct : d.dominant === "Devanagari" ? d.devanagariPct : d.dominant === "Gujarati" ? d.gujaratiPct : d.otherPct;
  const lexical =
    d.hinglishScore === null
      ? "no Hinglish/English function words found"
      : `Hinglish/English lexical score ${d.hinglishScore.toFixed(2)} (${d.hinglishWords} Hinglish vs ${d.englishWords} English function words)`;
  return {
    id: "script",
    label: "Detected script",
    status: "info",
    detail: `Detected script: ${d.dominant} (${share} %) in the launch file's text; ${lexical}. Informational only — the language slot and its display name decide what learners see.`,
  };
}
