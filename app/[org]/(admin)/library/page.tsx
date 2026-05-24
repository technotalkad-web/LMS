import Link from "next/link";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import {
  AdminPageHeader,
  KpiStrip,
  KpiCard,
  Card,
  EmptyState,
  StatusPill,
} from "@/components/admin";
import {
  BookOpen,
  CheckCircle2,
  CircleSlash,
  Users as UsersIcon,
  Clock,
  Pencil,
  Upload,
} from "lucide-react";

type CourseRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  updated_at: string;
  current_version_id: string | null;
  thumbnail_url: string | null;
  duration_minutes: number | null;
  is_active: boolean;
};

function formatDuration(mins: number | null): string | null {
  if (mins === null || mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default async function CoursesPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const { org, role } = await requireOrgAccess(slug);
  const canUpload = role === "super_owner" || role === "admin";

  const supabase = await createClient();
  const { data: courses } = await supabase
    .from("courses")
    .select(
      "id, slug, title, description, status, updated_at, current_version_id, thumbnail_url, duration_minutes, is_active"
    )
    .eq("organization_id", org.id)
    .order("updated_at", { ascending: false });

  const list = (courses ?? []) as CourseRow[];
  const courseIds = list.map((c) => c.id);

  type AssignmentLite = {
    course_id: string;
    assignee_type: "user" | "team" | "org";
    user_id: string | null;
    team_id: string | null;
  };

  const [
    { data: assignmentRows },
    { data: teamMemberRows },
    { data: orgMemberRows },
  ] = await Promise.all([
    courseIds.length
      ? supabase
          .from("course_assignments")
          .select("course_id, assignee_type, user_id, team_id")
          .in("course_id", courseIds)
      : Promise.resolve({ data: [] as AssignmentLite[] }),
    supabase.from("team_members").select("team_id, user_id"),
    supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id),
  ]);

  const teamUsers = new Map<string, string[]>();
  for (const r of (teamMemberRows ?? []) as Array<{
    team_id: string;
    user_id: string;
  }>) {
    const arr = teamUsers.get(r.team_id) ?? [];
    arr.push(r.user_id);
    teamUsers.set(r.team_id, arr);
  }
  const orgMemberIds = ((orgMemberRows ?? []) as Array<{ user_id: string }>).map(
    (m) => m.user_id
  );

  const enrolledByCourse = new Map<string, Set<string>>();
  for (const a of (assignmentRows ?? []) as AssignmentLite[]) {
    const set = enrolledByCourse.get(a.course_id) ?? new Set<string>();
    if (a.assignee_type === "user" && a.user_id) set.add(a.user_id);
    else if (a.assignee_type === "team" && a.team_id) {
      for (const uid of teamUsers.get(a.team_id) ?? []) set.add(uid);
    } else if (a.assignee_type === "org") {
      for (const uid of orgMemberIds) set.add(uid);
    }
    enrolledByCourse.set(a.course_id, set);
  }

  const totalCourses = list.length;
  const activeCount = list.filter((c) => c.is_active).length;
  const inactiveCount = totalCourses - activeCount;
  const totalEnrollments = Array.from(enrolledByCourse.values()).reduce(
    (n, s) => n + s.size,
    0
  );

  return (
    <div className="max-w-7xl">
      <AdminPageHeader
        title="Library"
        description="Your course catalog."
        action={
          canUpload ? (
            <Link
              href={`/${org.slug}/library/upload`}
              className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Upload className="w-4 h-4" />
              Upload course
            </Link>
          ) : undefined
        }
      />

      <KpiStrip>
        <KpiCard
          label="Total"
          value={totalCourses}
          icon={<BookOpen className="w-4 h-4" />}
        />
        <KpiCard
          label="Active"
          value={activeCount}
          icon={<CheckCircle2 className="w-4 h-4" />}
          accent="text-emerald-600"
        />
        <KpiCard
          label="Inactive"
          value={inactiveCount}
          icon={<CircleSlash className="w-4 h-4" />}
          accent="text-slate-500"
        />
        <KpiCard
          label="Enrollments"
          value={totalEnrollments}
          icon={<UsersIcon className="w-4 h-4" />}
          accent="text-indigo-600"
        />
      </KpiStrip>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen className="w-5 h-5" />}
            title="No courses yet"
            description="Upload a SCORM 1.2 or cmi5 .zip package to get started."
            action={
              canUpload ? (
                <Link
                  href={`/${org.slug}/library/upload`}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  <Upload className="w-4 h-4" />
                  Upload your first course
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {list.map((c) => {
            const enrolled = enrolledByCourse.get(c.id)?.size ?? 0;
            const duration = formatDuration(c.duration_minutes);
            return (
              <Link
                key={c.id}
                href={`/${org.slug}/library/${c.id}`}
                className="group bg-paper border border-line rounded-xl overflow-hidden transition-all hover:border-ink/30 hover:shadow-sm flex flex-col"
              >
                {c.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.thumbnail_url}
                    alt=""
                    className="aspect-video w-full object-cover rounded-t-xl"
                  />
                ) : (
                  <div className="aspect-video w-full bg-canvas rounded-t-xl flex items-center justify-center text-muted">
                    <BookOpen className="w-8 h-8 opacity-40" />
                  </div>
                )}
                <div className="p-4 flex-1 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="serif text-lg leading-snug text-ink line-clamp-2">
                      {c.title}
                    </h3>
                    <span
                      className="shrink-0 text-muted opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-hidden
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </span>
                  </div>
                  {c.description ? (
                    <p className="text-sm text-muted line-clamp-2">
                      {c.description}
                    </p>
                  ) : (
                    <p className="text-sm text-muted italic">No description</p>
                  )}
                  <div className="mt-auto pt-3 flex items-center justify-between gap-2 flex-wrap">
                    <StatusPill tone={c.is_active ? "active" : "neutral"}>
                      {c.is_active ? "Active" : "Inactive"}
                    </StatusPill>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      {duration && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {duration}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <UsersIcon className="w-3 h-3" />
                        {enrolled}
                      </span>
                      {!c.current_version_id && (
                        <span className="text-amber-700">no version</span>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
