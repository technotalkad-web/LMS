import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { courseDaysOf, todayStr, DEFAULT_JOURNEY_TZ } from "@/lib/journey/journey";
import {
  JourneyAdminClient,
  type ProgramRow,
  type DayRow,
  type EnrollmentRow,
  type MemberOption,
  type CourseOption,
} from "./journey-client";

export const dynamic = "force-dynamic";

/**
 * Admin control center for the 90-Day Yoddha Journey: curriculum builder,
 * enrollment management (admin-driven by design) and program settings.
 */
export default async function JourneyAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{ program?: string }>;
}) {
  const { org: orgSlug } = await params;
  const sp = (await searchParams) ?? {};
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) redirect(`/${orgSlug}/dashboard?denied=1`);

  const supabase = await createClient();
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ALL journeys (multi-journey since 0063), highest priority rank first.
  // The DRAFT is always editable (even while paused — pausing is a setting).
  const { data: progRows } = await supabase
    .from("journey_programs")
    .select("*")
    .eq("organization_id", org.id)
    .order("created_at", { ascending: true });
  const programs = ((progRows ?? []) as ProgramRow[]).sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.name.localeCompare(b.name)
  );
  const program =
    programs.find((p) => p.id === sp.program) ?? programs[0] ?? null;

  let days: DayRow[] = [];
  let enrollments: EnrollmentRow[] = [];
  let currentVersion: { version_number: number; published_at: string } | null = null;
  if (program) {
    const [{ data: dayRows }, { data: enrRows }, { data: doneRows }, { data: verRows }] =
      await Promise.all([
        supabase
          .from("journey_days")
          .select("day_number, course_id, mission_title")
          .eq("program_id", program.id)
          .order("day_number", { ascending: true }),
        svc
          .from("journey_enrollments")
          .select("id, user_id, version_id, start_date, status, completed_at, created_at")
          .eq("program_id", program.id)
          .order("created_at", { ascending: false }),
        svc
          .from("journey_day_progress")
          .select("enrollment_id")
          .eq("organization_id", org.id),
        supabase
          .from("journey_versions")
          .select("id, version_number, published_at, days_total, count_sundays, days")
          .eq("program_id", program.id),
      ]);
    days = (dayRows ?? []) as DayRow[];
    const versions = (verRows ?? []) as Array<{
      id: string;
      version_number: number;
      published_at: string;
      days_total: number;
      count_sundays: boolean;
      days: unknown;
    }>;
    const verById = new Map(versions.map((v) => [v.id, v]));
    currentVersion = program.current_version_id
      ? (verById.get(program.current_version_id) ?? null)
      : null;
    const doneByEnr = new Map<string, number>();
    for (const r of (doneRows ?? []) as Array<{ enrollment_id: string }>) {
      doneByEnr.set(r.enrollment_id, (doneByEnr.get(r.enrollment_id) ?? 0) + 1);
    }
    enrollments = ((enrRows ?? []) as Array<
      Omit<
        EnrollmentRow,
        "completed_count" | "name" | "email" | "version_number" | "days_total" | "count_sundays"
      > & { version_id: string }
    >).map((e) => {
      const v = verById.get(e.version_id);
      return {
        ...e,
        completed_count: doneByEnr.get(e.id) ?? 0,
        name: "",
        email: "",
        version_number: v?.version_number ?? 0,
        days_total: v?.days_total ?? program.days_total,
        count_sundays: v?.count_sundays ?? program.count_sundays,
        // Behind/on-track math walks the pinned version's COURSE days.
        course_days: v ? courseDaysOf(v.days, v.days_total) : [],
      };
    });
  }

  // Members (picker + enrollment identity), names live from profiles.
  const { data: memRows } = await svc
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id)
    .eq("status", "active");
  const memberIds = ((memRows ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  const profiles = new Map<string, { name: string; email: string }>();
  for (let i = 0; i < memberIds.length; i += 150) {
    const { data } = await svc
      .from("profiles")
      .select("id, first_name, last_name, email")
      .in("id", memberIds.slice(i, i + 150));
    for (const p of (data ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>) {
      profiles.set(p.id, {
        name:
          [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
          (p.email ?? "").split("@")[0],
        email: p.email ?? "",
      });
    }
  }
  const members: MemberOption[] = memberIds
    .map((id) => ({ user_id: id, ...(profiles.get(id) ?? { name: id.slice(0, 8), email: "" }) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of enrollments) {
    const p = profiles.get(e.user_id);
    e.name = p?.name ?? e.user_id.slice(0, 8);
    e.email = p?.email ?? "";
  }

  const { data: courseRows } = await supabase
    .from("courses")
    .select("id, title")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .order("title", { ascending: true });
  const courses = (courseRows ?? []) as CourseOption[];

  const { data: gsRow } = await svc
    .from("gamification_settings")
    .select("timezone")
    .eq("organization_id", org.id)
    .maybeSingle();
  const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;

  // Day-by-day completion funnel (0059 RPC; admin-guarded inside). Fail-soft
  // to empty before the migration lands.
  let funnel: Array<{ day_number: number; learners: number }> = [];
  if (program) {
    const { data: funnelRows } = await supabase.rpc("journey_day_funnel", {
      p_program_id: program.id,
    });
    funnel = (funnelRows ?? []) as Array<{ day_number: number; learners: number }>;
  }

  // Audience editor data: governed master values (0055/0056) + teams.
  const { data: optRows } = await supabase
    .from("org_field_options")
    .select("field, value")
    .eq("organization_id", org.id)
    .order("value", { ascending: true });
  const audienceOptions: Record<string, string[]> = {};
  for (const r of (optRows ?? []) as Array<{ field: string; value: string }>) {
    (audienceOptions[r.field] ??= []).push(r.value);
  }
  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name", { ascending: true });
  const teams = (teamRows ?? []) as Array<{ id: string; name: string }>;

  // Custom Groups (0067) as journey audiences — fail-soft pre-migration.
  let orgGroups: Array<{ id: string; name: string }> = [];
  try {
    const { data } = await supabase
      .from("org_groups")
      .select("id, name")
      .eq("organization_id", org.id)
      .eq("is_active", true)
      .order("name", { ascending: true });
    orgGroups = (data ?? []) as Array<{ id: string; name: string }>;
  } catch {
    /* pre-0067 */
  }

  return (
    <JourneyAdminClient
      orgSlug={orgSlug}
      programs={programs.map((p) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        priority: p.priority ?? 100,
      }))}
      program={program}
      currentVersion={currentVersion}
      days={days}
      enrollments={enrollments}
      members={members}
      courses={courses}
      funnel={funnel}
      today={todayStr(tz)}
      audienceOptions={audienceOptions}
      teams={teams}
      orgGroups={orgGroups}
    />
  );
}
