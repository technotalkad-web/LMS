import Link from "next/link";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import {
  AdminPageHeader,
  KpiStrip,
  KpiCard,
} from "@/components/admin";
import {
  BookOpen,
  CheckCircle2,
  CircleSlash,
  Users as UsersIcon,
  FolderTree,
  Upload,
} from "lucide-react";
import { LibraryBrowser, type FolderLite, type CourseLite } from "./library-browser";

export default async function CoursesPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ folder?: string }>;
}) {
  const { org: slug } = await params;
  const { folder: folderParam } = await searchParams;
  const { org, role } = await requireOrgAccess(slug);
  const canManage = role === "super_owner" || role === "admin";

  const supabase = await createClient();

  // Folders are added by migration 0041 — read best-effort so the Library still
  // renders if the code is deployed before the migration is applied.
  let folders: FolderLite[] = [];
  const { data: folderRows } = await supabase
    .from("folders")
    .select("id, name, parent_id")
    .eq("organization_id", org.id)
    .order("name", { ascending: true });
  if (folderRows) folders = folderRows as FolderLite[];

  const { data: courses } = await supabase
    .from("courses")
    .select(
      "id, slug, title, description, status, updated_at, current_version_id, thumbnail_url, duration_minutes, is_active"
    )
    .eq("organization_id", org.id)
    .order("updated_at", { ascending: false });

  type CourseRow = Omit<CourseLite, "folder_id" | "enrolled"> & {
    slug: string;
    status: string;
    updated_at: string;
  };
  const list = (courses ?? []) as CourseRow[];
  const courseIds = list.map((c) => c.id);

  // folder_id is added by migration 0041 — read best-effort so the Library still
  // lists courses if the code is deployed before the migration is applied.
  const folderByCourse = new Map<string, string | null>();
  const { data: folderMap } = await supabase
    .from("courses")
    .select("id, folder_id")
    .eq("organization_id", org.id);
  if (folderMap) {
    for (const r of folderMap as Array<{ id: string; folder_id: string | null }>) {
      folderByCourse.set(r.id, r.folder_id ?? null);
    }
  }

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

  const courseList: CourseLite[] = list.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    current_version_id: c.current_version_id,
    thumbnail_url: c.thumbnail_url,
    duration_minutes: c.duration_minutes,
    is_active: c.is_active,
    folder_id: folderByCourse.get(c.id) ?? null,
    enrolled: enrolledByCourse.get(c.id)?.size ?? 0,
  }));

  const totalCourses = list.length;
  const activeCount = list.filter((c) => c.is_active).length;
  const inactiveCount = totalCourses - activeCount;
  const totalEnrollments = Array.from(enrolledByCourse.values()).reduce(
    (n, s) => n + s.size,
    0
  );

  // Validate the requested folder belongs to this org; otherwise treat as root.
  const currentFolderId =
    folderParam && folders.some((f) => f.id === folderParam) ? folderParam : null;

  return (
    <div className="max-w-7xl">
      <AdminPageHeader
        title="Library"
        description="Organise your course catalog into folders."
        action={
          canManage ? (
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
          label="Folders"
          value={folders.length}
          icon={<FolderTree className="w-4 h-4" />}
          accent="text-indigo-600"
        />
        <KpiCard
          label="Enrollments"
          value={totalEnrollments}
          icon={<UsersIcon className="w-4 h-4" />}
          accent="text-indigo-600"
        />
      </KpiStrip>

      <LibraryBrowser
        orgSlug={org.slug}
        canManage={canManage}
        currentFolderId={currentFolderId}
        folders={folders}
        courses={courseList}
      />
    </div>
  );
}
