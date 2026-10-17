/**
 * Unit test for the explicit course default rules (ADR 0008 decision B,
 * steps 9–15): when a publish moves the course default, the Set-as-default
 * and deactivation refusals, the launch fallback, the catalogue
 * availability rule and the Attention Center findings.
 *
 * Run:  npx tsx tests/unit/course-default.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import {
  catalogAvailable,
  deactivationRefusal,
  defaultSlotFinding,
  isReadyVersion,
  launchFallback,
  setDefaultRefusal,
  shouldMoveCourseDefault,
} from "../../lib/courses/default-rule";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("\npublish moves the default (step 9)");
eq("new course (no default) → moves",
  shouldMoveCourseDefault({ currentDefaultVersionId: null, currentDefaultPackageId: null, publishedPackageId: "en" }), true);
eq("replace / Make current in the default slot → follows",
  shouldMoveCourseDefault({ currentDefaultVersionId: "en-v1", currentDefaultPackageId: "en", publishedPackageId: "en" }), true);
eq("new slot on an existing course → unchanged",
  shouldMoveCourseDefault({ currentDefaultVersionId: "en-v1", currentDefaultPackageId: "en", publishedPackageId: "hi" }), false);
eq("replace / Make current in another slot → unchanged",
  shouldMoveCourseDefault({ currentDefaultVersionId: "en-v2", currentDefaultPackageId: "en", publishedPackageId: "gu" }), false);
eq("default's package unreadable → never moves (fail closed)",
  shouldMoveCourseDefault({ currentDefaultVersionId: "en-v1", currentDefaultPackageId: null, publishedPackageId: "en" }), false);

console.log("\nready versions");
eq("ready", isReadyVersion("ready"), true);
eq("pre-0077 (no column) = ready", isReadyVersion(undefined), true);
eq("null = ready", isReadyVersion(null), true);
eq("uploading", isReadyVersion("uploading"), false);
eq("failed", isReadyVersion("failed"), false);

console.log("\nSet as default refusals (step 10)");
eq("active slot with a ready current version → allowed",
  setDefaultRefusal({ packageActive: true, currentVersionId: "hi-v1", currentVersionFound: true, currentVersionUploadStatus: "ready" }), null);
eq("pre-0077 current version → allowed",
  setDefaultRefusal({ packageActive: true, currentVersionId: "hi-v1", currentVersionFound: true, currentVersionUploadStatus: undefined }), null);
eq("inactive slot → 409 package_inactive",
  setDefaultRefusal({ packageActive: false, currentVersionId: "hi-v1", currentVersionFound: true, currentVersionUploadStatus: "ready" })?.error,
  "package_inactive");
eq("inactive is judged before the version",
  setDefaultRefusal({ packageActive: false, currentVersionId: null, currentVersionFound: false })?.error, "package_inactive");
eq("no current version → 409 no_current_version",
  setDefaultRefusal({ packageActive: true, currentVersionId: null, currentVersionFound: false })?.error, "no_current_version");
eq("current version not on this package/course → 409 no_current_version",
  setDefaultRefusal({ packageActive: true, currentVersionId: "x", currentVersionFound: false })?.error, "no_current_version");
eq("current version still uploading → 409 version_not_ready",
  setDefaultRefusal({ packageActive: true, currentVersionId: "hi-v2", currentVersionFound: true, currentVersionUploadStatus: "uploading" })?.error,
  "version_not_ready");
eq("refusals are 409",
  setDefaultRefusal({ packageActive: false, currentVersionId: null, currentVersionFound: false })?.status, 409);

console.log("\ndeactivation guard (step 12)");
eq("default slot while another active ready slot exists → 409 default_slot",
  deactivationRefusal({ holdsDefault: true, otherActiveReadySlotExists: true })?.error, "default_slot");
eq("the only active (ready) slot may be hidden",
  deactivationRefusal({ holdsDefault: true, otherActiveReadySlotExists: false }), null);
eq("a slot that does not hold the default may be hidden",
  deactivationRefusal({ holdsDefault: false, otherActiveReadySlotExists: true }), null);

console.log("\nlaunch fallback (step 13)");
eq("no package rows → legacy course.current_version_id", launchFallback({ packageCount: 0, activeCount: 0 }), "legacy");
eq("packages but none active → course page", launchFallback({ packageCount: 2, activeCount: 0 }), "redirect");
eq("one active → resolve as before", launchFallback({ packageCount: 2, activeCount: 1 }), "resolve");
eq("several active → resolve as before", launchFallback({ packageCount: 3, activeCount: 3 }), "resolve");

console.log("\ncatalogue availability (step 14)");
eq("active course, default on an active slot → available",
  catalogAvailable({ courseActive: true, defaultVersionId: "v", defaultPackageActive: true }), true);
eq("default slot hidden → unavailable",
  catalogAvailable({ courseActive: true, defaultVersionId: "v", defaultPackageActive: false }), false);
eq("package state unknown → fail-soft available",
  catalogAvailable({ courseActive: true, defaultVersionId: "v", defaultPackageActive: undefined }), true);
eq("course switched off → unavailable",
  catalogAvailable({ courseActive: false, defaultVersionId: "v", defaultPackageActive: true }), false);
eq("is_active null (pre-column) counts as on",
  catalogAvailable({ courseActive: null, defaultVersionId: "v", defaultPackageActive: true }), true);
eq("no default version → unavailable",
  catalogAvailable({ courseActive: true, defaultVersionId: null, defaultPackageActive: undefined }), false);

console.log("\nAttention findings (step 15)");
const P = (id: string, is_active: boolean, current_version_id: string | null, currentReady = !!current_version_id) =>
  ({ id, is_active, current_version_id, currentReady });
eq("healthy default → nothing",
  defaultSlotFinding({ defaultVersionId: "en-v2", defaultPackageId: "en", packages: [P("en", true, "en-v2"), P("hi", true, "hi-v1")] }), null);
eq("null default while an active slot has a ready version → no_default",
  defaultSlotFinding({ defaultVersionId: null, defaultPackageId: null, packages: [P("en", true, "en-v1")] }), { kind: "no_default" });
eq("null default, no active ready slot → nothing",
  defaultSlotFinding({ defaultVersionId: null, defaultPackageId: null, packages: [P("en", false, "en-v1"), P("hi", true, null)] }), null);
eq("null default, active slot whose current is not ready → nothing",
  defaultSlotFinding({ defaultVersionId: null, defaultPackageId: null, packages: [P("en", true, "en-v1", false)] }), null);
eq("default on a hidden slot → default_hidden",
  defaultSlotFinding({ defaultVersionId: "gu-v1", defaultPackageId: "gu", packages: [P("en", true, "en-v1"), P("gu", false, "gu-v1")] }),
  { kind: "default_hidden", packageId: "gu" });
eq("default is an older version of its slot → default_not_current",
  defaultSlotFinding({ defaultVersionId: "en-v1", defaultPackageId: "en", packages: [P("en", true, "en-v2")] }),
  { kind: "default_not_current", packageId: "en" });
eq("hidden is reported before not-current",
  defaultSlotFinding({ defaultVersionId: "en-v1", defaultPackageId: "en", packages: [P("en", false, "en-v2")] }),
  { kind: "default_hidden", packageId: "en" });
eq("default's package unknown → nothing (no guess)",
  defaultSlotFinding({ defaultVersionId: "x", defaultPackageId: null, packages: [P("en", true, "en-v1")] }), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
