/**
 * Scheduled-release semantics, in one place: a NULL or past release_at means
 * "released". Both gates (course_assignments.release_at and
 * learning_path_courses.release_at) are compared at request time — no cron.
 */

/** True when the content is available (null/invalid/past timestamps release). */
export function isReleased(releaseAt: string | null | undefined, now = Date.now()): boolean {
  if (!releaseAt) return true;
  const t = new Date(releaseAt).getTime();
  return Number.isNaN(t) || t <= now;
}

/** The later of two release timestamps; null only when both gates are open. */
export function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}
