import { createHash } from "crypto";
import JSZip from "jszip";
import { parseManifestFromZip } from "../manifest/detect";
import type { ParsedManifest } from "../manifest/types";

/**
 * Static package validation — the quality-control gate that runs BEFORE a
 * package upload commits. It answers, from the zip alone: does this package
 * carry the wiring the LMS needs for tracking, completion, scoring, resume,
 * and interactions — and will it even play?
 *
 * HONESTY CONTRACT (reflected in every check's wording): static analysis
 * proves ABSENCE with certainty (zero SCORM/xAPI calls anywhere = the
 * package cannot possibly track — the classic AI-generated-HTML failure)
 * and provides strong EVIDENCE of presence (real API calls + a known
 * authoring tool), but only a live run proves runtime behavior. Checks are
 * therefore "detected / not detected", never "works / broken" — the live
 * test-drive probe is the planned phase 2.
 */

export type CheckStatus = "pass" | "warning" | "fail" | "info";

export type ValidationCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

export type PackageValidationReport = {
  version: 1;
  package: {
    type: "scorm12" | "cmi5" | "unknown";
    title: string | null;
    launchUrl: string | null;
    sizeBytes: number;
    fileCount: number;
    tool: string | null;
    /** "stored" = re-scanned from extracted storage files, not the zip. */
    source?: "upload" | "stored";
  };
  verdict: "pass" | "warning" | "fail" | "unplayable";
  checks: ValidationCheck[];
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Text-scan budget: enough for any real authoring-tool output, bounded so a
// pathological zip can't blow the Worker CPU budget.
const MAX_TEXT_FILE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_SCAN_BYTES = 60 * 1024 * 1024;
const TEXT_EXT = /\.(js|mjs|html?|xml|json|css)$/i;

type Signals = {
  scormApi: number; // LMSInitialize/LMSSetValue/LMSCommit/LMSFinish
  apiDiscovery12: boolean; // window.API lookup
  apiDiscovery2004: boolean; // API_1484_11 lookup
  scorm2004Data: number; // cmi.completion_status / cmi.success_status
  completion: number; // cmi.core.lesson_status
  score: number; // cmi.core.score.raw / cmi.score.scaled
  resume: number; // cmi.suspend_data / cmi.core.lesson_location
  interactions: number; // cmi.interactions
  xapi: number; // sendStatement / XAPIWrapper / cmi5.js
  httpRefs: number; // http:// references (mixed content on https)
  swfFiles: string[];
  execFiles: string[];
  viewportInLaunch: boolean | null; // null = launch html not scanned
  tool: string | null;
};

async function scanZip(
  zip: JSZip,
  launchPath: string | null
): Promise<Signals> {
  const s: Signals = {
    scormApi: 0,
    apiDiscovery12: false,
    apiDiscovery2004: false,
    scorm2004Data: 0,
    completion: 0,
    score: 0,
    resume: 0,
    interactions: 0,
    xapi: 0,
    httpRefs: 0,
    swfFiles: [],
    execFiles: [],
    viewportInLaunch: null,
    tool: null,
  };

  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);

  // Authoring-tool fingerprints from the file tree alone.
  const tree = paths.join("\n").toLowerCase();
  if (/story_content\//.test(tree) || /story\.html/.test(tree)) s.tool = "Articulate Storyline";
  else if (/scormcontent\//.test(tree) || /\brise\b/.test(tree)) s.tool = "Articulate Rise";
  else if (/scormdriver\//.test(tree)) s.tool = "SCORM Driver (Rustici)";
  else if (/ispring/.test(tree)) s.tool = "iSpring";
  else if (/\bcpm\.js\b|captivate/.test(tree)) s.tool = "Adobe Captivate";

  const launchLower = launchPath?.toLowerCase() ?? null;
  let scanned = 0;
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (/\.swf$/.test(lower)) s.swfFiles.push(path);
    if (/\.(exe|bat|cmd|msi|dll|sh)$/.test(lower)) s.execFiles.push(path);
    if (!TEXT_EXT.test(lower)) continue;
    if (scanned >= MAX_TOTAL_SCAN_BYTES) continue;

    const entry = zip.files[path];
    let text: string;
    try {
      const bytes = await entry.async("uint8array");
      if (bytes.length > MAX_TEXT_FILE_BYTES) continue;
      scanned += bytes.length;
      text = Buffer.from(bytes).toString("utf8");
    } catch {
      continue;
    }

    s.scormApi += count(text, /LMS(Initialize|SetValue|GetValue|Commit|Finish)/g);
    if (/["'](API)["']|window\.API\b|parent\.API\b/.test(text)) s.apiDiscovery12 = true;
    if (/API_1484_11/.test(text)) s.apiDiscovery2004 = true;
    s.scorm2004Data += count(text, /cmi\.(completion_status|success_status)\b/g);
    s.completion += count(text, /cmi\.core\.lesson_status/g);
    s.score += count(text, /cmi\.core\.score\.raw|cmi\.score\.scaled/g);
    s.resume += count(text, /cmi\.suspend_data|cmi\.core\.lesson_location/g);
    s.interactions += count(text, /cmi\.interactions/g);
    s.xapi += count(text, /sendStatement|XAPIWrapper|\bcmi5\.js\b|"actor"\s*:/g);
    // Mixed-content scan only where the browser actually fetches URLs.
    // XML/JSON are full of namespace/schema identifiers (xmlns:adlcp=
    // "http://www.adlnet.org/…") that are never requested — skip them.
    if (/\.(html?|js|mjs|css)$/i.test(lower)) {
      s.httpRefs += count(text, /["'=(]http:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org|schemas?\.|adlnet\.|imsglobal|purl\.org)/g);
    }

    if (launchLower && lower.endsWith(launchLower.split("/").pop() ?? "")) {
      if (s.viewportInLaunch === null) {
        s.viewportInLaunch = /<meta[^>]+viewport/i.test(text);
      }
    }
  }
  return s;
}

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** Does the manifest's launch file actually exist in the zip? */
function launchFileExists(zip: JSZip, launchUrl: string): boolean {
  const clean = launchUrl.split("?")[0].split("#")[0].toLowerCase();
  return Object.keys(zip.files).some(
    (p) => !zip.files[p].dir && (p.toLowerCase() === clean || p.toLowerCase().endsWith(`/${clean}`))
  );
}

export async function validatePackage(
  zipBytes: Uint8Array
): Promise<PackageValidationReport> {
  const checks: ValidationCheck[] = [];
  const push = (id: string, label: string, status: CheckStatus, detail: string) =>
    checks.push({ id, label, status, detail });

  // ---- 1. Structure: manifest + launch file (unplayable gates) ----
  let manifest: ParsedManifest | null = null;
  let zip: JSZip | null = null;
  let fileCount = 0;
  try {
    const parsed = await parseManifestFromZip(zipBytes);
    manifest = parsed.manifest;
    zip = parsed.zip;
    fileCount = Object.keys(zip.files).filter((p) => !zip!.files[p].dir).length;
    push(
      "manifest",
      "Package manifest",
      "pass",
      `Detected ${manifest.type === "cmi5" ? "cmi5 (cmi5.xml)" : "SCORM 1.2 (imsmanifest.xml)"} — "${manifest.title}".`
    );
  } catch (e) {
    push(
      "manifest",
      "Package manifest",
      "fail",
      e instanceof Error ? e.message : "No supported manifest found."
    );
    return {
      version: 1,
      package: {
        type: "unknown",
        title: null,
        launchUrl: null,
        sizeBytes: zipBytes.length,
        fileCount: 0,
        tool: null,
      },
      verdict: "unplayable",
      checks,
    };
  }

  const launchOk = launchFileExists(zip, manifest.launchUrl);
  push(
    "launch",
    "Launch file",
    launchOk ? "pass" : "fail",
    launchOk
      ? `"${manifest.launchUrl}" found in the package.`
      : `Manifest points at "${manifest.launchUrl}" but that file is not in the zip — the course cannot open.`
  );
  if (!launchOk) {
    return {
      version: 1,
      package: {
        type: manifest.type,
        title: manifest.title,
        launchUrl: manifest.launchUrl,
        sizeBytes: zipBytes.length,
        fileCount,
        tool: null,
      },
      verdict: "unplayable",
      checks,
    };
  }

  // ---- 2. Scan content for tracking wiring ----
  const s = await scanZip(zip, manifest.launchUrl);
  if (s.tool) {
    push("tool", "Authoring tool", "info", `${s.tool} signatures detected — a known-good tracking implementation.`);
  }

  const isCmi5 = manifest.type === "cmi5";
  if (isCmi5) {
    const hasXapi = s.xapi > 0;
    push(
      "api",
      "xAPI runtime wiring",
      hasXapi ? "pass" : "fail",
      hasXapi
        ? `xAPI statement calls detected (${s.xapi} references) — completion, score, and interactions report through statements at runtime.`
        : "No xAPI statement calls found anywhere in the package — this cmi5 package cannot report any learner data."
    );
    const raw = manifest.raw as Record<string, unknown>;
    const moveOn = typeof raw?.moveOn === "string" ? (raw.moveOn as string) : null;
    push(
      "moveon",
      "Completion criteria (moveOn)",
      moveOn ? "pass" : "warning",
      moveOn
        ? `moveOn="${moveOn}" — the LMS knows exactly when this AU counts as done.`
        : "cmi5.xml does not declare moveOn — completion semantics are ambiguous; the LMS will fall back to Completed-or-Passed."
    );
  } else {
    const hasApi = s.scormApi > 0;
    push(
      "api",
      "SCORM API wiring",
      hasApi ? "pass" : "fail",
      hasApi
        ? `${s.scormApi} SCORM API calls detected (LMSInitialize/SetValue/Commit).`
        : "Zero SCORM API calls found anywhere in the package — it will play as plain HTML with NO tracking at all (a common defect in AI-generated exports)."
    );
    // Only meaningful to grade the rest if the API is wired at all.
    push(
      "completion",
      "Completion & pass/fail reporting",
      s.completion > 0 ? "pass" : hasApi ? "warning" : "fail",
      s.completion > 0
        ? `cmi.core.lesson_status writes detected (${s.completion} references).`
        : hasApi
          ? "No lesson_status references found — completion may never report; learners could finish without the LMS knowing."
          : "Cannot report completion without SCORM API wiring."
    );
    push(
      "score",
      "Score tracking",
      s.score > 0 ? "pass" : hasApi ? "warning" : "fail",
      s.score > 0
        ? `Score writes detected (${s.score} references to cmi.core.score).`
        : hasApi
          ? "No score references found — fine for content without a quiz; a problem if this package is meant to assess."
          : "Cannot report scores without SCORM API wiring."
    );
    push(
      "resume",
      "Resume / bookmarking",
      s.resume > 0 ? "pass" : hasApi ? "warning" : "fail",
      s.resume > 0
        ? `suspend_data / lesson_location usage detected (${s.resume} references) — learners should continue where they left off.`
        : hasApi
          ? "No suspend_data or lesson_location references — learners will likely restart from the beginning every launch."
          : "Cannot resume without SCORM API wiring."
    );
    push(
      "interactions",
      "Question/interaction tracking",
      s.interactions > 0 ? "pass" : "info",
      s.interactions > 0
        ? `cmi.interactions usage detected (${s.interactions} references) — question-level analytics will populate.`
        : "No interaction reporting detected — the per-question analytics (hardest questions, wrong answers) will stay empty for this course."
    );
    push(
      "mastery",
      "Mastery score (pass threshold)",
      manifest.masteryScore != null ? "pass" : "warning",
      manifest.masteryScore != null
        ? `imsmanifest declares masteryscore ${Math.round((manifest.masteryScore ?? 0) * 100)}%.`
        : "No masteryscore in the manifest — pass/fail depends entirely on what the package itself reports."
    );
    // SCORM-2004-only runtime discovery on a 1.2 player = tracking never connects.
    if (s.apiDiscovery2004 && !s.apiDiscovery12 && s.scormApi === 0) {
      push(
        "scorm2004",
        "SCORM version compatibility",
        "fail",
        "The package looks for the SCORM 2004 runtime (API_1484_11) and never the SCORM 1.2 API this platform provides — tracking will not connect. Re-export as SCORM 1.2."
      );
    } else if (s.scorm2004Data > 0 && s.completion === 0) {
      push(
        "scorm2004",
        "SCORM version compatibility",
        "warning",
        "SCORM 2004 data-model fields (cmi.completion_status/success_status) detected without 1.2 equivalents — verify completion with a test launch before assigning widely."
      );
    }
  }

  // ---- 3. Hygiene & compatibility (all types) ----
  if (s.swfFiles.length > 0) {
    push(
      "flash",
      "Flash content",
      "fail",
      `${s.swfFiles.length} .swf file(s) found (e.g. ${s.swfFiles[0]}). Flash cannot run in any modern browser — this content will not play.`
    );
  }
  if (s.execFiles.length > 0) {
    push(
      "exec",
      "Executable files",
      "fail",
      `Package contains executable files (${s.execFiles.slice(0, 3).join(", ")}) — not allowed in course content.`
    );
  }
  if (s.httpRefs > 0) {
    push(
      "mixed",
      "Insecure http:// references",
      "warning",
      `${s.httpRefs} plain http:// reference(s) found. The LMS is served over HTTPS, so browsers will block these resources (broken images/media).`
    );
  }
  if (s.viewportInLaunch === false) {
    push(
      "mobile",
      "Mobile readiness",
      "warning",
      "The launch page has no viewport meta tag — the course may render desktop-sized on phones. Most of the field team learns on mobile."
    );
  }
  const raw = manifest.raw as Record<string, unknown>;
  const itemCount = Array.isArray(raw?.items) ? (raw.items as unknown[]).length : null;
  if (itemCount !== null && itemCount > 1) {
    push(
      "sequencing",
      "Sequential progression",
      "info",
      `${itemCount} SCOs in the manifest. Note: enforced ORDER between modules is controlled by this LMS (learning-path strict mode / journey days), not by SCORM 1.2 packages.`
    );
  }

  // ---- 4. Aggregate verdict ----
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warning");
  const verdict = hasFail ? "fail" : hasWarn ? "warning" : "pass";

  return {
    version: 1,
    package: {
      type: manifest.type,
      title: manifest.title,
      launchUrl: manifest.launchUrl,
      sizeBytes: zipBytes.length,
      fileCount,
      tool: s.tool,
    },
    verdict,
    checks,
  };
}
