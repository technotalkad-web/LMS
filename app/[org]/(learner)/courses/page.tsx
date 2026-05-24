import { redirect } from "next/navigation";

/**
 * Index redirect for /{org}/courses.
 *
 * WHY THIS EXISTS:
 *   The learner nav (both desktop layout.tsx and mobile-nav.tsx) links to
 *   `/{org}/courses` as the "Courses" tab, but the real listing page was
 *   never built — only the dynamic children exist (`/courses/{courseId}`,
 *   `/courses/{courseId}/launch`, `/courses/{courseId}/attempts/...`).
 *   Without this file, every learner clicking the "Courses" tab hit a
 *   bare Next.js 404. Discovered during pre-launch tenant smoke test
 *   on 2026-05-23.
 *
 *   Until a proper "All my enrolled courses" page is built (which would
 *   live in this same file), the dashboard already shows enrolled-course
 *   cards, so we redirect there. This preserves any external links or
 *   bookmarks to /{org}/courses without breaking them.
 *
 * REPLACE THIS POST-LAUNCH:
 *   When the real listing page ships, swap the `redirect()` body for the
 *   actual page implementation — filters (in-progress / completed /
 *   not-started), progress bars, search, etc. Reuse the course-card
 *   components from the dashboard.
 */
export const dynamic = "force-dynamic";

export default async function CoursesIndexPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  redirect(`/${org}/dashboard`);
}
