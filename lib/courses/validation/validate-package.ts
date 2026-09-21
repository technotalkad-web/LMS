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
  /** External <script src> hosts referenced by html files (CDN dependencies). */
  externalScriptHosts: string[];
  /** Launch-file findings (read separately — single-file engines exceed the text cap). */
  launch: LaunchFindings;
};

export type LaunchFindings = {
  scanned: boolean;
  /** In-house KIVO single-file engine build. */
  kivo: boolean;
  engineVersion: string | null;
  /** cmi5 state is fetched on launch but never applied (engine template defect). */
  cmi5ResumeNeverApplied: boolean;
  /** cmi5 state save/restore code present at all. */
  cmi5StateApi: boolean;
  /** Authoring setting: resumePrompt = "never" — always restarts. */
  resumePromptNever: boolean;
  /** Sends the LMS token as "Basic <Bearer …>" instead of verbatim. */
  basicBearerAuth: boolean;
  /** Third-party LRS credentials embedded in client-side content. */
  embeddedLrsSecret: boolean;
  /** Course-level completion/pass signal is emitted (cmi5). */
  courseLevelOutcome: boolean;
  terminatedOnExit: boolean;
};

/** Launch files of single-file engines run to several MB — read up to this. */
const MAX_LAUNCH_FILE_BYTES = 16 * 1024 * 1024;

export function analyzeLaunchHtml(html: string | null): LaunchFindings {
  const none: LaunchFindings = {
    scanned: false, kivo: false, engineVersion: null, cmi5ResumeNeverApplied: false,
    cmi5StateApi: false, resumePromptNever: false, basicBearerAuth: false,
    embeddedLrsSecret: false, courseLevelOutcome: false, terminatedOnExit: false,
  };
  if (!html) return none;
  const kivo = /COURSE_CONFIG\b/.test(html) && /elearning-engine|KIVO|cmi5LaunchActive/.test(html);
  const cmi5StateApi = /cmi5GetState\s*\(|activities\/state/.test(html);
  // The defect: state fetched in the handshake, but loadBookmark() only ever
  // runs behind `if (scormApi)` and never after the async fetch.
  const fetchRe = /cmi5InitialState\s*=\s*await\s+cmi5GetState\s*\(\)/;
  const fetchesState = fetchRe.test(html);
  const appliesAfterFetch = (() => {
    const m = fetchRe.exec(html);
    if (!m) return false;
    // Only the handshake body counts: from the fetch up to the mandatory
    // initialized statement. A CALL to the resume routine there (not its
    // definition elsewhere) means the state is applied.
    const end = html.indexOf("cmi5SendInitialized", m.index);
    const after = html.slice(m.index, end > 0 ? end : m.index + 1500);
    return /(?<!function\s)(?:loadBookmark|applyBookmarkToState)\s*\(/.test(after);
  })();
  const bookmarkGatedBySco =
    /if\s*\(\s*scormApi\s*\)\s*\{\s*resumedFromBookmark\s*=\s*loadBookmark\s*\(\)/.test(html);
  const cmi5ResumeNeverApplied = fetchesState && !appliesAfterFetch && bookmarkGatedBySco;
  const engineVersion = (/["']engineVersion["']\s*:\s*["']([^"']+)["']/.exec(html) ?? [])[1] ?? null;
  const resumePromptNever = /["']?resumePrompt["']?\s*:\s*["']never["']/.test(html);
  const basicBearerAuth = /xapiLmsAuth\s*=\s*['"]Basic ['"]\s*\+\s*token/.test(html);
  const embeddedLrsSecret = /["']lrsApi(Secret|Key)["']\s*:\s*["'][^"']{6,}["']/.test(html);
  const courseLevelOutcome =
    /xapiSend\s*\(\s*['"](passed|failed|completed)['"]/.test(html) ||
    /verbs\/(passed|failed|completed)/.test(html);
  const terminatedOnExit = /verbs\/terminated|['"]terminated['"]/.test(html);
  return {
    scanned: true, kivo, engineVersion, cmi5ResumeNeverApplied, cmi5StateApi,
    resumePromptNever, basicBearerAuth, embeddedLrsSecret, courseLevelOutcome, terminatedOnExit,
  };
}

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
    externalScriptHosts: [],
    launch: analyzeLaunchHtml(null),
  };

  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);

  // Launch file: read on its own with a larger cap so single-file engines
  // (5–10 MB html) still get inspected for resume/auth/completion wiring.
  if (launchPath) {
    const clean = launchPath.replace(/^\/+/, "").split("?")[0].split("#")[0].toLowerCase();
    const lp = paths.find((p) => p.toLowerCase() === clean || p.toLowerCase().endsWith(`/${clean}`));
    if (lp) {
      try {
        const bytes = await zip.files[lp].async("uint8array");
        if (bytes.length <= MAX_LAUNCH_FILE_BYTES) {
          const html = Buffer.from(bytes).toString("utf8");
          s.launch = analyzeLaunchHtml(html);
          if (s.launch.kivo) s.tool = "KIVO (in-house engine)";
          s.viewportInLaunch = /<meta[^>]+viewport/i.test(html);
          s.xapi += count(html, /sendStatement|XAPIWrapper|\bcmi5\.js\b|"actor"\s*:|xapiSend\s*\(/g);
          collectExternalScripts(html, s);
        }
      } catch {
        /* unreadable launch file — the manifest/launch checks already cover it */
      }
    }
  }

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

    if (/\.html?$/i.test(lower)) collectExternalScripts(text, s);
    if (launchLower && lower.endsWith(launchLower.split("/").pop() ?? "")) {
      if (s.viewportInLaunch === null) {
        s.viewportInLaunch = /<meta[^>]+viewport/i.test(text);
      }
    }
  }
  s.externalScriptHosts = [...new Set(s.externalScriptHosts)];
  return s;
}

function collectExternalScripts(html: string, s: Signals) {
  const re = /<script[^>]+src=["']https?:\/\/([^/"']+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) s.externalScriptHosts.push(m[1].toLowerCase());
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
    if (moveOn && /Passed/i.test(moveOn) && manifest.masteryScore == null) {
      push(
        "mastery",
        "Mastery score (pass threshold)",
        "warning",
        `moveOn="${moveOn}" requires a pass, but cmi5.xml declares no masteryScore — the package decides pass/fail on its own and the LMS cannot verify the threshold.`
      );
    }
    const L = s.launch;
    if (L.scanned) {
      // Resume: the one that sent learners back to slide 1.
      if (L.cmi5ResumeNeverApplied) {
        push(
          "cmi5-resume",
          "Resume (cmi5 saved state)",
          "fail",
          "This build saves the learner's position to the LMS but NEVER restores it on relaunch (its resume routine only runs for SCORM launches and before the cmi5 state has arrived). Every learner will restart from slide 1. Rebuild with the fixed engine template before assigning."
        );
      } else if (L.cmi5StateApi) {
        push(
          "cmi5-resume",
          "Resume (cmi5 saved state)",
          "pass",
          "Saves and restores learner state through the xAPI State API — learners continue where they left off."
        );
      } else {
        push(
          "cmi5-resume",
          "Resume (cmi5 saved state)",
          "warning",
          "No State API usage found — this package does not save the learner's position; learners restart from the beginning on every launch."
        );
      }
      if (L.resumePromptNever) {
        push(
          "resume-setting",
          "Resume setting",
          "warning",
          'Authored with resumePrompt = "never" — the module deliberately ignores saved progress and always starts at slide 1. Change it to "auto" or "ask" before assigning unless that is intended.'
        );
      }
      push(
        "cmi5-outcome",
        "Course-level completion signal",
        L.courseLevelOutcome ? "pass" : "fail",
        L.courseLevelOutcome
          ? "Emits completed / passed / failed for the course activity — the LMS marks the module complete only on that signal."
          : "No course-level completed / passed / failed statement found — the LMS will never mark this module Completed (per-screen statements only feed progress %)."
      );
      if (!L.terminatedOnExit) {
        push(
          "cmi5-terminated",
          "Session close (terminated)",
          "warning",
          "No terminated statement on exit — sessions are never closed cleanly; progress is still saved on navigation but exit time is not recorded."
        );
      }
      if (L.basicBearerAuth) {
        push(
          "cmi5-auth",
          "LMS auth header format",
          "info",
          'Sends the LMS token as "Basic <Bearer …>" instead of verbatim. This LMS tolerates it; strict LRSs reject it — fix in the engine template.'
        );
      }
      if (L.kivo && !L.engineVersion) {
        push(
          "engine-version",
          "Engine version stamp",
          "info",
          "This in-house engine build carries no engineVersion — the LMS cannot tell whether it includes the resume fix. Ask the engine team to stamp exports."
        );
      }
    }
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
  if (s.launch.embeddedLrsSecret) {
    push(
      "secrets",
      "Embedded credentials",
      "warning",
      "Third-party LRS API credentials are embedded in the package's client-side code — anyone who opens the module can read them. Remove them and let the LMS forward statements instead."
    );
  }
  if (s.externalScriptHosts.length > 0) {
    push(
      "external",
      "External script dependencies",
      "warning",
      `Scripts load from ${s.externalScriptHosts.slice(0, 3).join(", ")} at runtime — the module breaks if that host is down or blocked on the office network, and on poor mobile connections. Bundle dependencies inside the package.`
    );
  }
  if (zipBytes.length > 90 * 1024 * 1024) {
    push(
      "size",
      "Package size",
      "warning",
      `${Math.round(zipBytes.length / 1024 / 1024)} MB — close to the upload limit and slow to open on mobile data. Compress media (video ≤ 720p, images ≤ 200 KB) or host large video externally.`
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
