import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { loadFieldOptionRows } from "@/lib/org/field-options";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  AssignSection,
  type AssignmentRow,
  type AssignableMember,
  type AssignableTeam,
} from "./assign-section";
import { ReminderSection, type ReminderSettings } from "./reminder-section";
import { DetailsForm, type CourseDetails } from "./details-form";
import { ScopePicker } from "../../_components/scope-picker";
import { loadScopesFor } from "@/lib/content/scopes";
import { LanguagesSection, type LanguagePackage } from "./languages-section";
import { ValidateExistingButton } from "./validate-existing-button";
import { ScoringRulesCard } from "@/components/scoring/scoring-rules-card";
import { fetchScoringRule, resolvePolicy } from "@/lib/scoring/resolve";
import { loadEnrolledCourseStatus } from "@/lib/scoring/status";
import {
  ActivateVersionButton,
  DiscardUploadButton,
  RerunCertificationButton,
  RestartVersionButton,
} from "./version-actions";
import { languageDisplay } from "@/lib/i18n/languages";
import { IdChip } from "@/components/ui/id-chip";
import { packageCode, versionCode } from "@/lib/reference-codes";
import { isReadyVersion } from "@/lib/courses/default-rule";
import { aldsP4Enabled } from "@/lib/alds/flag";
import { canRerunCertification } from "@/lib/alds/guardian";
import type { VersionTierColumns } from "@/lib/alds/rpc";
import { TierBadge } from "@/components/alds/tier-badge";

/** 0100 adds analytics_tier & co.; select("*") reads undefined before it (no badge). */
type Version = VersionTierColumns & {
  id: string;
  package_id?: string | null;
  version_number: number;
  manifest_type: "scorm12" | "cmi5" | "xapi";
  launch_url: string;
  manifest_data: { title?: string; description?: string; masteryScore?: number };
  uploaded_at: string;
  /** 0077 — undefined before the migration (= ready). */
  upload_status?: "uploading" | "ready" | "failed";
  storage_driver?: "supabase" | "r2";
  file_count?: number | null;
};

type Course = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  current_version_id: string | null;
  organization_id: string;
  duration_minutes: number | null;
  is_active: boolean;
  thumbnail_url: string | null;
  thumbnail_fit: string | null;
  thumbnail_pos_x: number | null;
  thumbnail_pos_y: number | null;
  visibility: "private" | "org_public";
  /** 0072 — optional so pre-migration rows read as "visible". */
  show_attempts_history?: boolean;
};

type TeamRow = { id: string; name: string; slug: string };

export default async function AdminCourseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; courseId: string }>;
  /** ?showFailed=1: list failed uploads too (hidden by default, ADR 0008 D1). */
  searchParams: Promise<{ showFailed?: string }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const showFailed = (await searchParams).showFailed === "1";
  const { org, role, user } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const supabase = await createClient();
  // select("*") for 0072 deploy safety (show_attempts_history).
  const { data: course } = await supabase
    .from("courses")
    .select("*")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) redirect(`/${orgSlug}/library`);
  const c = course as Course;

  // select("*") for 0077 deploy safety (upload_status, storage_driver, file_count).
  const { data: versions } = await supabase
    .from("course_versions")
    .select("*")
    .eq("course_id", c.id)
    .order("version_number", { ascending: false });
  const list = ((versions ?? []) as Version[]).filter(
    (v) => !v.upload_status || v.upload_status === "ready" || canManage(role)
  );
  // Without a course default, the header describes the newest finished
  // version, never an unfinished or failed upload.
  const current = list.find((v) => v.id === c.current_version_id) ?? list.find((v) => isReadyVersion(v.upload_status));
  // Failed uploads keep their row (ADR 0008 D1: the version number and folder
  // are never reused); the version list hides them unless asked.
  const failedCount = list.filter((v) => v.upload_status === "failed").length;
  // ALDS P4 (ADR 0005 note (g)): the analytics-tier badge per version, read
  // from the select("*") above; flag off or column absent → no badge.
  const showTiers = aldsP4Enabled();
  // "Re-run check" shows on exactly the roles the certify route accepts:
  // the same predicate (canRerunCertification) on the same input, the RAW
  // membership role the route reads through requireOrgAdminApi (`role`
  // above is normalised: the legacy "owner" and an impersonation read as
  // super_owner, and the route refuses both). Read only with the flag on.
  let rerunAllowed = false;
  if (showTiers) {
    const { data: membership } = await supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", org.id)
      .eq("user_id", user.id)
      .maybeSingle();
    rerunAllowed = canRerunCertification((membership as { role?: string | null } | null)?.role);
  }


  // Language packages (#158 Phase 1c). Sorted by language code so the
  // "Unlabeled (legacy)" NULL row floats to the top — it's the one
  // admins most commonly want to promote.
  const { data: pkgRows } = await supabase
    .from("course_packages")
    .select("id, language, display_name, is_active, current_version_id")
    .eq("course_id", c.id)
    .order("language", { ascending: true, nullsFirst: true });
  // current_version_ready: "Set as default" needs a fully uploaded current
  // version (ADR 0008 steps 10–11).
  const readyIds = new Set(list.filter((v) => !v.upload_status || v.upload_status === "ready").map((v) => v.id));
  const languagePackages = ((pkgRows ?? []) as Omit<LanguagePackage, "current_version_ready">[]).map((p) => ({
    ...p,
    current_version_ready: !!p.current_version_id && readyIds.has(p.current_version_id),
  })) as LanguagePackage[];

  // Group versions by language package (0030: versions belong to packages and
  // are numbered per package). "Current" is the package's own pointer; the
  // course-level pointer is the course DEFAULT: the current version of the
  // default slot, moved between slots only by "Set as default" (ADR 0008).
  const pkgById = new Map(languagePackages.map((p) => [p.id, p]));
  const defaultVersion = c.current_version_id ? list.find((v) => v.id === c.current_version_id) : undefined;
  const defaultPkg = defaultVersion?.package_id ? pkgById.get(defaultVersion.package_id) : undefined;
  const slotName = (p: { language: string | null; display_name: string | null }) =>
    p.display_name?.trim() || (p.language ? languageDisplay(p.language, "english") ?? p.language : "Unlabeled (legacy)");
  const versionGroups = (() => {
    const groups = new Map<string, { key: string; label: string; code: string | null; currentVersionId: string | null; order: number; versions: Version[] }>();
    for (const v of list) {
      if (v.upload_status === "failed" && !showFailed) continue;
      const pkg = v.package_id ? pkgById.get(v.package_id) : undefined;
      const key = v.package_id ?? "legacy";
      if (!groups.has(key)) {
        const label = pkg
          ? pkg.display_name?.trim() ||
            (pkg.language ? languageDisplay(pkg.language, "english") ?? pkg.language : "Unlabeled (legacy)")
          : "Unlabeled (legacy)";
        groups.set(key, {
          key,
          label,
          code: pkg?.language ?? null,
          currentVersionId: pkg?.current_version_id ?? (pkg ? null : c.current_version_id),
          order: pkg?.language === null || !pkg ? 0 : 1,
          versions: [],
        });
      }
      groups.get(key)!.versions.push(v);
    }
    return [...groups.values()]
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map((g) => ({ ...g, versions: g.versions.sort((a, b) => b.version_number - a.version_number) }));
  })();

  // Human-readable codes (0079): MOD0015 on the course; versions and
  // packages derive MOD0015-HI-V02 / MOD0015-HI. Null before the migration.
  const refCode = (c as { reference_code?: string | null }).reference_code ?? null;
  const multiPackage = versionGroups.length > 1;
  const currentCode = current
    ? versionCode(
        refCode,
        current.version_number,
        current.package_id ? pkgById.get(current.package_id)?.language ?? null : null,
        multiPackage
      )
    : null;

  // Assignments — select("*") for 0069 deploy safety (group_id).
  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select("*")
    .eq("course_id", c.id);

  // Reminder settings
  const { data: reminderRow } = await supabase
    .from("course_reminder_settings")
    .select("enabled, cadence_days, cap_days")
    .eq("course_id", c.id)
    .maybeSingle();
  const reminderSettings: ReminderSettings = {
    enabled: (reminderRow?.enabled as boolean | undefined) ?? false,
    cadence_days: (reminderRow?.cadence_days as number | undefined) ?? 1,
    cap_days: (reminderRow?.cap_days as number | undefined) ?? 30,
  };
  const assignments = (assignmentRows ?? []) as AssignmentRow[];

  // Latest accepted package validation (0070) — fail-soft pre-migration.
  type StoredCheck = { id: string; label: string; status: string; detail: string };
  let latestValidation: {
    verdict: string;
    acknowledged_warnings: boolean;
    created_at: string;
    checks: StoredCheck[];
  } | null = null;
  try {
    const { data: pv } = await supabase
      .from("package_validations")
      .select("verdict, acknowledged_warnings, created_at, report")
      .eq("course_id", c.id)
      .eq("status", "accepted")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pv) {
      const row = pv as {
        verdict: string;
        acknowledged_warnings: boolean;
        created_at: string;
        report?: { checks?: StoredCheck[] };
      };
      latestValidation = {
        verdict: row.verdict,
        acknowledged_warnings: row.acknowledged_warnings === true,
        created_at: row.created_at,
        checks: Array.isArray(row.report?.checks) ? row.report.checks : [],
      };
    }
  } catch {
    // package_validations not migrated yet
  }

  // employee_id is selected so the assignment combobox can let admins
  // search by it. The actual profile name (first_name/last_name) is
  // fetched separately below via the service-role client.
  const { data: memberRows } = await supabase
    .from("organization_members")
    .select("user_id, role, employee_id")
    .eq("organization_id", org.id);

  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name, slug")
    .eq("organization_id", org.id);
  const teamList = (teamRows ?? []) as TeamRow[];

  const { data: teamMemberRows } = await supabase
    .from("team_members")
    .select("team_id, user_id")
    .in(
      "team_id",
      teamList.map((t) => t.id)
    );
  const teamMemberCounts = new Map<string, number>();
  for (const r of teamMemberRows ?? []) {
    const tid = r.team_id as string;
    teamMemberCounts.set(tid, (teamMemberCounts.get(tid) ?? 0) + 1);
  }

  const teams: AssignableTeam[] = teamList.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    member_count: teamMemberCounts.get(t.id) ?? 0,
  }));

  // Custom Groups (0067) as assignees (0069). Fail-soft: pre-0067 databases
  // simply render no group option.
  let groupList: Array<{
    id: string;
    name: string;
    group_type: "static" | "dynamic";
    member_count: number | null;
  }> = [];
  try {
    const { data: groupRows } = await supabase
      .from("org_groups")
      .select("id, name, group_type, member_count, is_active")
      .eq("organization_id", org.id)
      .eq("is_active", true)
      .order("name");
    groupList = (
      (groupRows ?? []) as Array<{
        id: string;
        name: string;
        group_type: "static" | "dynamic";
        member_count: number | null;
      }>
    ).map((g) => ({
      id: g.id,
      name: g.name,
      group_type: g.group_type,
      member_count: g.member_count,
    }));
  } catch {
    // org_groups not migrated yet
  }

  // 0096: where this course belongs + the master data for the pickers.
  const scopes = await loadScopesFor(supabase, org.id, "course", c.id);
  const { data: optRows } = await loadFieldOptionRows(supabase, org.id).then((rows) => ({ data: rows }));
  const optList = (optRows ?? []) as Array<{ id: string; field: string; value: string; parent_id?: string | null }>;
  const verticalById = new Map(optList.filter((o) => o.field === "business_vertical").map((o) => [o.id, o.value]));
  const departmentsByVertical: Record<string, string[]> = {};
  for (const o of optList) {
    if (o.field !== "department" || !o.parent_id) continue;
    const v = verticalById.get(o.parent_id);
    if (v) (departmentsByVertical[v] ??= []).push(o.value);
  }
  const scopeOptions = { verticals: [...verticalById.values()].sort(), departmentsByVertical };

  // Resolve emails for everyone we might mention.
  const allUserIds = new Set<string>();
  for (const m of memberRows ?? []) allUserIds.add(m.user_id);
  for (const a of assignments) if (a.user_id) allUserIds.add(a.user_id);

  const emailByUser = new Map<string, string>();
  // Profile rows so the assignment combobox can show real names + match
  // searches by first/last name (in addition to email/employee_id).
  // Note: profiles PK is `id` per migration 0027.
  const profileByUser = new Map<
    string,
    { first_name: string | null; last_name: string | null }
  >();
  if (allUserIds.size > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    // perPage bumped to 1500 (was 500) — at 500, large orgs would silently
    // miss recently-created users in the combobox candidate list. Their
    // membership row exists, but their email never gets mapped, so the
    // combobox renders them as a UUID prefix and search doesn't match.
    // 1500 covers single-tenant orgs up to ~Fortune-500 size; switch to
    // multi-page accumulation if a tenant ever exceeds that.
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1500 });
    for (const u of data?.users ?? []) {
      if (u.email && allUserIds.has(u.id)) emailByUser.set(u.id, u.email);
    }
    const userIdList = Array.from(allUserIds);
    const { data: profileRows } = await svc
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", userIdList);
    for (const p of (profileRows ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
    }>) {
      profileByUser.set(p.id, {
        first_name: p.first_name,
        last_name: p.last_name,
      });
    }
  }

  const normalizeRole = (raw: string) => {
    if (raw === "owner") return "super_owner";
    if (raw === "member") return "user";
    return raw;
  };

  const members: AssignableMember[] = (memberRows ?? []).map((m) => {
    const p = profileByUser.get(m.user_id as string);
    return {
      user_id: m.user_id as string,
      email: emailByUser.get(m.user_id as string) ?? (m.user_id as string).slice(0, 8),
      role: normalizeRole(m.role as string) as AssignableMember["role"],
      employee_id: (m.employee_id as string | null | undefined) ?? null,
      first_name: p?.first_name ?? null,
      last_name: p?.last_name ?? null,
    };
  });

  const teamNameById = new Map(teamList.map((t) => [t.id, t.name]));
  const groupNameById = new Map(groupList.map((g) => [g.id, g.name]));
  for (const a of assignments) {
    if (a.user_id) a.user_email = emailByUser.get(a.user_id) ?? null;
    if (a.team_id) a.team_name = teamNameById.get(a.team_id) ?? null;
    if (a.group_id) a.group_name = groupNameById.get(a.group_id) ?? null;
  }

  // ----- Enrolled summary -----
  // Totals (total / completed / failed / in progress / not started) from each
  // learner's OFFICIAL attempt (decision 1), through the one loader the
  // course Reports tab uses, so the two pages always agree: assignments
  // expanded and attempts read completely (paged, chunked), a learner whose
  // only attempts were reset reads as not started. The per-learner table
  // lives at /[org]/library/[courseId]/learners.
  const { summary: enrSummary } = await loadEnrolledCourseStatus(
    supabase,
    org.id,
    courseId,
    list.map((v) => v.id)
  );

  const initialDetails: CourseDetails = {
    title: c.title,
    description: c.description ?? "",
    duration_minutes: c.duration_minutes,
    is_active: c.is_active,
    thumbnail_url: c.thumbnail_url,
    thumbnail_fit: c.thumbnail_fit === "contain" ? "contain" : "cover",
    thumbnail_pos_x: c.thumbnail_pos_x ?? 50,
    thumbnail_pos_y: c.thumbnail_pos_y ?? 50,
    visibility: c.visibility ?? "private",
    show_attempts_history: c.show_attempts_history !== false,
    pass_required: (c as { pass_required?: boolean | null }).pass_required === true,
  };

  // 0073: attempt scoring rules — the module's own rule plus what actually
  // applies after path/journey inheritance. Fail-soft pre-migration.
  const [scoringRule, effectivePolicy] = await Promise.all([
    fetchScoringRule(supabase, "course", c.id),
    resolvePolicy(supabase, c.id),
  ]);

  return (
    <div className="max-w-4xl space-y-10">
      <div>
        <Link
          href={`/${orgSlug}/library`}
          className="text-muted text-sm hover:text-ink transition-colors"
        >
          ← Library
        </Link>

        <div className="flex flex-wrap items-baseline justify-between mt-2 mb-1 gap-x-4 gap-y-3">
          <h1 className="serif text-3xl sm:text-5xl break-words min-w-0">{c.title}</h1>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Link
              href={`/${orgSlug}/courses/${c.id}`}
              className="px-3 py-2 text-sm border border-line rounded-lg hover:border-ink transition-colors"
            >
              View as learner
            </Link>
            {current && (
              <Link
                href={`/${orgSlug}/courses/${c.id}/launch`}
                className="px-5 py-2.5 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 transition-opacity"
              >
                Preview launch
              </Link>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-xs text-muted">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wide ${
              c.is_active
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-line bg-canvas text-muted"
            }`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                c.is_active ? "bg-emerald-500" : "bg-muted"
              }`}
            />
            {c.is_active ? "Active" : "Inactive"}
          </span>
          <span className="capitalize">{c.status}</span>
          {current && <span>· {current.manifest_type}</span>}
          {c.duration_minutes !== null && (
            <span>· {c.duration_minutes} min</span>
          )}
          <span>· {enrSummary.total.toLocaleString()} enrolled</span>
          {languagePackages.length > 0 && (
            <span data-testid="default-language">
              · Default language:{" "}
              {defaultPkg ? (
                <>
                  <span className="text-ink">{slotName(defaultPkg)}</span>
                  {!defaultPkg.is_active && " (hidden from learners)"}
                </>
              ) : (
                "none set"
              )}
            </span>
          )}
        </div>
        {/* System ids, copyable: integrations (Yoddha CRM) key on these. */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {refCode && <IdChip label="Code" value={refCode} />}
          <IdChip label="Course ID" value={c.id} />
          {currentCode && <IdChip label="Code" value={currentCode} />}
          {current && <IdChip label="Version ID" value={current.id} />}
        </div>
      </div>

      {/* Package quality — latest validation (0070). Courses uploaded before
          the gate have no report yet; "Validate now" re-scans the stored
          files and produces one on demand. */}
      {!latestValidation && (
        <div className="border border-line rounded-lg bg-paper px-5 py-3 text-sm flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="font-medium">Package quality</span>
            <span className="block text-xs text-muted mt-0.5">
              No validation report yet — this course was uploaded before the
              quality gate existed. Scan its stored files to get one.
            </span>
          </div>
          <ValidateExistingButton orgSlug={orgSlug} courseId={c.id} hasReport={false} />
        </div>
      )}
      {latestValidation && (
        <details className="border border-line rounded-lg bg-paper px-5 py-3 text-sm">
          <summary className="cursor-pointer select-none flex flex-wrap items-center gap-2.5">
            <span className="font-medium">Package quality</span>
            <span
              className={`px-2 py-0.5 rounded-full text-[11px] font-bold tracking-wide ${
                latestValidation.verdict === "pass"
                  ? "bg-emerald-100 text-emerald-800"
                  : latestValidation.verdict === "warning"
                    ? "bg-amber-100 text-amber-900"
                    : "bg-red-100 text-red-800"
              }`}
            >
              {latestValidation.verdict.toUpperCase()}
            </span>
            {latestValidation.acknowledged_warnings && (
              <span className="text-xs text-muted">accepted with acknowledged issues</span>
            )}
            <span className="text-xs text-muted">
              validated {latestValidation.created_at.slice(0, 10)}
            </span>
          </summary>
          <ul className="mt-3 space-y-1.5 text-xs">
            {latestValidation.checks.map((ck) => (
              <li key={ck.id}>
                <span
                  className={
                    ck.status === "pass"
                      ? "text-emerald-700 font-semibold"
                      : ck.status === "warning"
                        ? "text-amber-700 font-semibold"
                        : ck.status === "fail"
                          ? "text-red-700 font-semibold"
                          : "text-muted font-semibold"
                  }
                >
                  {ck.status.toUpperCase()}
                </span>{" "}
                <span className="font-medium">{ck.label}:</span>{" "}
                <span className="text-muted">{ck.detail}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <ValidateExistingButton orgSlug={orgSlug} courseId={c.id} hasReport={true} />
          </div>
        </details>
      )}

      {/* Editable details */}
      <DetailsForm orgSlug={orgSlug} courseId={c.id} initial={initialDetails} />

      {/* Belongs to (0096): Business Vertical + Department mapping */}
      <section className="bg-paper border border-line rounded-xl p-5">
        <h2 className="serif text-2xl mb-1">Belongs to</h2>
        <ScopePicker orgSlug={orgSlug} items={[{ type: "course", id: c.id }]} initial={scopes} options={scopeOptions} />
      </section>

      {/* Attempt scoring rules (0073) */}
      <ScoringRulesCard
        orgSlug={orgSlug}
        scope="course"
        targetId={c.id}
        initialRule={scoringRule}
        inherited={effectivePolicy}
      />

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Stat label="Status" value={c.is_active ? "Active" : "Inactive"} />
        <Stat label="Standard" value={current?.manifest_type ?? "—"} />
        <Stat
          label="Mastery"
          value={
            typeof current?.manifest_data?.masteryScore === "number"
              ? `${Math.round(current.manifest_data.masteryScore * 100)}%`
              : "—"
          }
        />
        <Stat
          label="Duration"
          value={
            c.duration_minutes !== null ? `${c.duration_minutes} min` : "—"
          }
        />
      </div>

      {/* Assignments */}
      <AssignSection
        orgSlug={orgSlug}
        courseId={c.id}
        isAdmin={true}
        assignments={assignments}
        members={members}
        teams={teams}
        groups={groupList}
        scopeOptions={scopeOptions}
        scopes={scopes}
      />

      {/* Reminders */}
      <ReminderSection courseId={c.id} initial={reminderSettings} />

      {/* Enrolled learners — summary card.
          The full per-learner table (with search, filters, pagination,
          sort) lives at /[org]/library/[courseId]/learners. Keeping it
          off the detail page means course settings stay accessible
          regardless of how many learners are enrolled. */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="serif text-2xl">Enrolled learners</h2>
          <div className="flex items-center gap-2">
            <Link
              href={`/${orgSlug}/library/${c.id}/reports`}
              className="text-xs px-3 py-1.5 border border-line rounded hover:border-ink transition-colors"
              title="Full performance report for this course"
            >
              View reports →
            </Link>
            <Link
              href={`/${orgSlug}/library/${c.id}/learners`}
              className="text-xs px-3 py-1.5 border border-line rounded hover:border-ink transition-colors"
            >
              View all learners →
            </Link>
          </div>
        </div>
        {enrSummary.total === 0 ? (
          <div className="border border-line rounded-2xl bg-paper p-8 text-muted text-sm text-center">
            No learners are enrolled yet. Add some in the Assignments section
            above.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <Stat
              label="Total enrolled"
              value={enrSummary.total.toLocaleString()}
              testId="sum-total"
            />
            <Stat
              label="Completed"
              value={enrSummary.completed.toLocaleString()}
              testId="sum-completed"
            />
            <Stat
              label="Failed"
              value={enrSummary.failed.toLocaleString()}
              testId="sum-failed"
            />
            <Stat
              label="In progress"
              value={enrSummary.inProgress.toLocaleString()}
              testId="sum-in-progress"
            />
            <Stat
              label="Not started"
              value={enrSummary.notStarted.toLocaleString()}
              testId="sum-not-started"
            />
          </div>
        )}
      </section>

      {/* Languages (#158 Phase 1c) */}
      <LanguagesSection
        // Remount on fresh server data (router.refresh keeps client state):
        // the default badge and the slot rows always match the database.
        key={[c.current_version_id ?? "-", ...languagePackages.map((p) => `${p.id}:${p.is_active}:${p.current_version_id ?? "-"}`)].join("|")}
        orgSlug={orgSlug}
        courseId={c.id}
        packages={languagePackages}
        defaultVersionId={c.current_version_id}
      />

      {/* Versions */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="serif text-2xl">Versions</h2>
          <div className="flex items-baseline gap-3">
            {/* Failed uploads keep their version number (ADR 0008 D1); they are
                history, not choices, so they stay out of the list by default. */}
            {failedCount > 0 && (
              <Link
                href={showFailed ? `/${orgSlug}/library/${c.id}` : `/${orgSlug}/library/${c.id}?showFailed=1`}
                scroll={false}
                className="text-xs text-muted hover:text-ink underline underline-offset-2"
                data-testid="toggle-failed-uploads"
              >
                {showFailed
                  ? "Hide failed uploads"
                  : `Show failed uploads (${failedCount})`}
              </Link>
            )}
            <Link
              href={`/${orgSlug}/library/upload?courseId=${c.id}`}
              className="text-xs px-3 py-1.5 border border-line rounded hover:border-ink"
            >
              Upload new version
            </Link>
          </div>
        </div>
        {/* One block per language package: versions are numbered and made
            current PER PACKAGE, so "current" is judged against the package's
            pointer, not the course's single legacy pointer. */}
        <div className="space-y-4">
          {versionGroups.map((g) => (
            <div key={g.key} className="border border-line rounded-2xl bg-paper overflow-hidden">
              <div className="px-5 py-2.5 bg-canvas border-b border-line flex items-baseline justify-between gap-3">
                <div className="text-sm font-medium flex flex-wrap items-center gap-2">
                  <span>
                    {g.label}
                    {g.code && <span className="ml-2 text-xs text-muted font-normal">{g.code}</span>}
                  </span>
                  {refCode && g.code && <IdChip label="Code" value={packageCode(refCode, g.code) ?? ""} />}
                  {g.key !== "legacy" && <IdChip label="Package ID" value={g.key} />}
                </div>
                <div className="text-[11px] text-muted">
                  {g.versions.length} version{g.versions.length === 1 ? "" : "s"}
                </div>
              </div>
              <ul className="divide-y divide-line">
                {g.versions.map((v) => {
                  const isCurrent = v.id === g.currentVersionId;
                  // ADR 0008 step 6: restart one version's in-progress learners —
                  // a ready version that is not its package's current one, or
                  // the current version of a package that is no longer active.
                  const isReady = !v.upload_status || v.upload_status === "ready";
                  const canRestart =
                    !!v.package_id && isReady && (!isCurrent || pkgById.get(v.package_id)?.is_active === false);
                  // ADR 0005 note (f): super_owner re-runs the static check
                  // on a version that is pending, uncertified or revoked.
                  const tier = showTiers ? v.analytics_tier : undefined;
                  const canRerun =
                    rerunAllowed &&
                    !!v.package_id &&
                    isReady &&
                    (tier === "pending" || tier === "uncertified" || tier === "revoked");
                  return (
                    <li
                      key={v.id}
                      className="px-5 py-3 flex items-baseline justify-between gap-4"
                      data-testid="version-row"
                      data-version-id={v.id}
                      data-upload-status={v.upload_status ?? "ready"}
                    >
                      <div className="min-w-0">
                        <div className="font-medium">
                          v{v.version_number}
                          {v.upload_status === "uploading" && (
                            <span className="ml-2 px-2 py-0.5 bg-amber-100 text-amber-800 border border-amber-200 rounded-full uppercase tracking-wide text-[10px]">
                              uploading
                            </span>
                          )}
                          {v.upload_status === "failed" && (
                            <span className="ml-2 px-2 py-0.5 bg-red-100 text-red-800 border border-red-200 rounded-full uppercase tracking-wide text-[10px]">
                              failed
                            </span>
                          )}
                          {v.id === c.current_version_id && (
                            <span
                              className="ml-2 px-2 py-0.5 bg-canvas text-ink border border-line rounded-full uppercase tracking-wide text-[10px]"
                              title="The course default: the catalogue and integrations report this version"
                              data-testid="course-default-version"
                            >
                              course default
                            </span>
                          )}
                          {tier && (
                            <TierBadge
                              tier={tier}
                              reason={v.analytics_tier_reason}
                              certificationId={v.certification_id}
                              className="ml-2"
                            />
                          )}
                        </div>
                        <div className="text-xs text-muted break-all">
                          {v.manifest_type} - launch:{" "}
                          <span className="font-mono">{v.launch_url}</span>
                          {typeof v.file_count === "number" && <> · {v.file_count} files</>}
                          {v.storage_driver && <> · {v.storage_driver === "r2" ? "R2" : "Supabase Storage"}</>}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          {versionCode(refCode, v.version_number, g.code, multiPackage) && (
                            <IdChip label="Code" value={versionCode(refCode, v.version_number, g.code, multiPackage) ?? ""} />
                          )}
                          <IdChip label="Version ID" value={v.id} />
                        </div>
                      </div>
                      <div className="text-xs text-muted shrink-0 flex items-center gap-2">
                        {canRerun && v.package_id && (
                          <RerunCertificationButton
                            orgSlug={orgSlug}
                            courseId={c.id}
                            packageId={v.package_id}
                            versionId={v.id}
                            versionNumber={v.version_number}
                          />
                        )}
                        {canRestart && v.package_id && (
                          <RestartVersionButton
                            orgSlug={orgSlug}
                            courseId={c.id}
                            packageId={v.package_id}
                            versionId={v.id}
                            versionNumber={v.version_number}
                          />
                        )}
                        {isCurrent ? (
                          <span className="px-2 py-0.5 bg-accent text-canvas rounded-full uppercase tracking-wide text-[10px]">
                            current
                          </span>
                        ) : v.upload_status === "uploading" ? (
                          <DiscardUploadButton orgSlug={orgSlug} versionId={v.id} versionNumber={v.version_number} />
                        ) : v.upload_status === "failed" ? null : (
                          v.package_id && (
                            <ActivateVersionButton
                              orgSlug={orgSlug}
                              courseId={c.id}
                              packageId={v.package_id}
                              versionId={v.id}
                              versionNumber={v.version_number}
                            />
                          )
                        )}
                        {new Date(v.uploaded_at).toISOString().slice(0, 10)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="border border-line rounded-xl bg-paper p-4">
      <div className="text-[10px] text-muted uppercase tracking-wide">
        {label}
      </div>
      <div className="serif text-xl mt-1" data-testid={testId}>{value}</div>
    </div>
  );
}
