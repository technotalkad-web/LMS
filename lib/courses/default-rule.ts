/**
 * Explicit course default (ADR 0008 decision B, steps 9–15): the pure rules.
 * `courses.current_version_id` is the current version of the course's
 * DEFAULT SLOT (language package). Uploads and "Make current" move the
 * version within that slot; only "Set as default" moves the default to
 * another slot. The callers do the reads and writes; everything that decides
 * lives here so it is unit-tested (tests/unit/course-default.test.ts).
 *
 * Deliberately free of next/* and Supabase imports so unit tests can load it.
 */

/** A version row is ready when it is fully uploaded; undefined before 0077 = ready. */
export function isReadyVersion(uploadStatus: string | null | undefined): boolean {
  return !uploadStatus || uploadStatus === "ready";
}

/**
 * Step 9: does publishing `publishedPackageId`'s version move the course
 * default? Only when the course has none (i), or when its current default
 * version belongs to the same package (ii). A default whose package could
 * not be read never moves (fail closed: never cross slots).
 */
export function shouldMoveCourseDefault(args: {
  currentDefaultVersionId: string | null;
  /** package_id of the current default version; null when it could not be read. */
  currentDefaultPackageId: string | null;
  publishedPackageId: string;
}): boolean {
  if (!args.currentDefaultVersionId) return true;
  return !!args.currentDefaultPackageId && args.currentDefaultPackageId === args.publishedPackageId;
}

export type SetDefaultRefusal = {
  status: 409;
  error: "package_inactive" | "no_current_version" | "version_not_ready";
  message: string;
};

/**
 * Step 10: a package can become the course default only when it is active
 * and its current version is a ready version of this package.
 */
export function setDefaultRefusal(args: {
  packageActive: boolean;
  currentVersionId: string | null;
  /** The current version row was found on this course and package. */
  currentVersionFound: boolean;
  currentVersionUploadStatus?: string | null;
}): SetDefaultRefusal | null {
  if (!args.packageActive) {
    return {
      status: 409,
      error: "package_inactive",
      message: "This language is hidden from learners. Make it active before setting it as the default.",
    };
  }
  if (!args.currentVersionId || !args.currentVersionFound) {
    return {
      status: 409,
      error: "no_current_version",
      message: "This language has no current version yet. Upload a package to it first.",
    };
  }
  if (!isReadyVersion(args.currentVersionUploadStatus)) {
    return {
      status: 409,
      error: "version_not_ready",
      message: `This language's current version is not fully uploaded (it is ${args.currentVersionUploadStatus}).`,
    };
  }
  return null;
}

export type DeactivationRefusal = { status: 409; error: "default_slot"; message: string };

/**
 * Step 12: hiding the language that holds the course default is refused
 * while another active language with a ready current version exists (set
 * that one as the default first). The only active language may be hidden:
 * the course then has no launchable language until a default is set.
 */
export function deactivationRefusal(args: {
  /** The course default version belongs to this package. */
  holdsDefault: boolean;
  /** Another active package of the course has a ready current version. */
  otherActiveReadySlotExists: boolean;
}): DeactivationRefusal | null {
  if (args.holdsDefault && args.otherActiveReadySlotExists) {
    return {
      status: 409,
      error: "default_slot",
      message: "This language holds the course default. Set another language as the default first, then hide this one.",
    };
  }
  return null;
}

/**
 * Step 13: the launch page's fallback to `courses.current_version_id`
 * applies only to a course with no package rows at all (legacy). Packages
 * exist but none is active → back to the course page. Otherwise the
 * existing ?lang= / preference / single-active / picker resolution runs;
 * the default never chooses a learner's language.
 */
export function launchFallback(args: { packageCount: number; activeCount: number }): "legacy" | "redirect" | "resolve" {
  if (args.packageCount === 0) return "legacy";
  if (args.activeCount === 0) return "redirect";
  return "resolve";
}

/**
 * Step 14: a catalogue course is available when it is switched on, has a
 * default version, and that version's package is active. An unknown package
 * state (read failed, pre-0030) does not make it unavailable (fail-soft).
 */
export function catalogAvailable(args: {
  courseActive: boolean | null;
  defaultVersionId: string | null;
  /** is_active of the default version's package; undefined = unknown. */
  defaultPackageActive?: boolean | null;
}): boolean {
  return args.courseActive !== false && !!args.defaultVersionId && args.defaultPackageActive !== false;
}

export type DefaultSlotPackage = {
  id: string;
  is_active: boolean;
  current_version_id: string | null;
  /** The package's current version is ready (false when it has none). */
  currentReady: boolean;
};

export type DefaultSlotFinding =
  | { kind: "no_default" }
  | { kind: "default_hidden"; packageId: string }
  | { kind: "default_not_current"; packageId: string };

/**
 * Step 15 (Attention Center provider `default-slot`): what is wrong with a
 * course's default, if anything.
 *   - no_default: the default is null while an active slot has a ready version;
 *   - default_hidden: the default version's package is inactive;
 *   - default_not_current: the default version is not its package's current version.
 */
export function defaultSlotFinding(args: {
  defaultVersionId: string | null;
  /** package_id of the default version; null when unknown. */
  defaultPackageId: string | null;
  packages: DefaultSlotPackage[];
}): DefaultSlotFinding | null {
  if (!args.defaultVersionId) {
    return args.packages.some((p) => p.is_active && p.currentReady) ? { kind: "no_default" } : null;
  }
  const pkg = args.defaultPackageId ? args.packages.find((p) => p.id === args.defaultPackageId) : undefined;
  if (!pkg) return null;
  if (!pkg.is_active) return { kind: "default_hidden", packageId: pkg.id };
  if (pkg.current_version_id !== args.defaultVersionId) return { kind: "default_not_current", packageId: pkg.id };
  return null;
}
