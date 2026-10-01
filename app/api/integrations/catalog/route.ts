import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/integrations/auth";
import { readParams, pick, list, bool, int, iso } from "@/lib/integrations/params";
import { parseVersionDays } from "@/lib/journey/journey";

/**
 * Catalogue — what the organisation can assign and launch (the UpsideLMS
 * "Catalogue API" replacement).
 *
 *   GET|POST /api/integrations/catalog
 *   Authorization: Bearer ambk_...
 *   params: page (1), per_page (100, max 100),
 *           content_type  course | learning_path | journey  (list; default all)
 *           include_inactive  true → drafts, archived and switched-off items too
 *           updated_since     ISO / YYYY-MM-DD → only items changed since then
 *   → { success, current_page, per_page, total_records, total_pages,
 *       courses[], learning_paths[], journeys[] }
 *
 * Every item carries a `target` the CRM can pass straight to sso-link.
 * Ids are the LMS uuids used everywhere else in the integration
 * (learner-summary, progress, the completion webhook).
 */

type CatalogItem =
  | {
      type: "course";
      id: string;
      title: string;
      description: string | null;
      format: string | null;
      /** The current uploaded package version the learner launches (Version ID in the admin). */
      version_id: string | null;
      duration_minutes: number | null;
      status: "available" | "unavailable";
      is_active: boolean;
      has_content: boolean;
      thumbnail_url: string | null;
      created_at: string;
      updated_at: string;
      target: string;
    }
  | {
      type: "learning_path";
      id: string;
      title: string;
      description: string | null;
      status: "available" | "unavailable";
      is_active: boolean;
      steps_total: number;
      course_ids: string[];
      created_at: string;
      updated_at: string;
      target: string;
    }
  | {
      type: "journey";
      id: string;
      title: string;
      /** The published version new enrolments run on (Version ID in the admin). */
      version_id: string | null;
      status: "available" | "unavailable";
      is_active: boolean;
      days_total: number;
      days: Array<{ day: number; course_id: string | null; title: string | null; mission_title: string | null }>;
      published_at: string | null;
      created_at: string;
      updated_at: string;
      target: string;
    };

const TYPES = ["course", "learning_path", "journey"] as const;

async function handle(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  const { svc, orgId, orgSlug } = auth;
  const p = await readParams(request);

  const page = int(pick(p, "page"), 1, 1, 100000);
  const perPage = int(pick(p, "per_page"), 100, 1, 100);
  const includeInactive = bool(pick(p, "include_inactive"));
  const types = list(pick(p, "content_type")).map((t) => t.toLowerCase().replace(/[\s-]+/g, "_"));
  for (const t of types) {
    if (!(TYPES as readonly string[]).includes(t)) {
      return NextResponse.json({ error: `content_type must be one of ${TYPES.join(", ")}` }, { status: 400 });
    }
  }
  const want = new Set<string>(types.length ? types : TYPES);
  const since = iso(pick(p, "updated_since"), "from");
  if (since === "invalid") return NextResponse.json({ error: "updated_since must be an ISO 8601 date" }, { status: 400 });

  const items: CatalogItem[] = [];
  const titleOf = new Map<string, string>();

  // ---- courses ----
  type CourseRow = {
    id: string; title: string; description: string | null; status: string; is_active: boolean | null;
    duration_minutes: number | null; thumbnail_url: string | null; current_version_id: string | null;
    created_at: string; updated_at: string;
  };
  const { data: cRows, error: cErr } = await svc
    .from("courses")
    .select("id, title, description, status, is_active, duration_minutes, thumbnail_url, current_version_id, created_at, updated_at")
    .eq("organization_id", orgId)
    .order("title");
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
  const courses = (cRows ?? []) as CourseRow[];
  for (const c of courses) titleOf.set(c.id, c.title);
  const verIds = courses.map((c) => c.current_version_id).filter((v): v is string => !!v);
  const formatOf = new Map<string, string>();
  for (let i = 0; i < verIds.length; i += 300) {
    const { data } = await svc.from("course_versions").select("id, manifest_type").in("id", verIds.slice(i, i + 300));
    for (const v of (data ?? []) as Array<{ id: string; manifest_type: string }>) formatOf.set(v.id, v.manifest_type);
  }
  if (want.has("course")) {
    for (const c of courses) {
      // Launchable = switched on AND has an uploaded package. (courses.status
      // stays "draft" after upload; the learner UI keys on is_active only.)
      const available = c.is_active !== false && !!c.current_version_id;
      if (!includeInactive && !available) continue;
      if (since && c.updated_at < since) continue;
      items.push({
        type: "course",
        id: c.id,
        title: c.title,
        description: c.description,
        format: c.current_version_id ? formatOf.get(c.current_version_id) ?? null : null,
        version_id: c.current_version_id,
        duration_minutes: c.duration_minutes,
        status: available ? "available" : "unavailable",
        is_active: c.is_active !== false,
        has_content: !!c.current_version_id,
        thumbnail_url: c.thumbnail_url,
        created_at: c.created_at,
        updated_at: c.updated_at,
        target: `/${orgSlug}/courses/${c.id}/launch`,
      });
    }
  }

  // ---- learning paths ----
  if (want.has("learning_path")) {
    type PathRow = { id: string; name: string; description: string | null; is_active: boolean | null; created_at: string; updated_at: string };
    const { data: pRows, error: pErr } = await svc
      .from("learning_paths")
      .select("id, name, description, is_active, created_at, updated_at")
      .eq("organization_id", orgId)
      .order("name");
    if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
    const paths = (pRows ?? []) as PathRow[];
    const stepsOf = new Map<string, string[]>();
    const pathIds = paths.map((x) => x.id);
    for (let i = 0; i < pathIds.length; i += 300) {
      const { data } = await svc
        .from("learning_path_courses")
        .select("path_id, course_id, step_number")
        .in("path_id", pathIds.slice(i, i + 300))
        .order("step_number");
      for (const r of (data ?? []) as Array<{ path_id: string; course_id: string }>) {
        stepsOf.set(r.path_id, [...(stepsOf.get(r.path_id) ?? []), r.course_id]);
      }
    }
    for (const lp of paths) {
      const available = lp.is_active !== false;
      if (!includeInactive && !available) continue;
      if (since && lp.updated_at < since) continue;
      const ids = stepsOf.get(lp.id) ?? [];
      items.push({
        type: "learning_path",
        id: lp.id,
        title: lp.name,
        description: lp.description,
        status: available ? "available" : "unavailable",
        is_active: available,
        steps_total: ids.length,
        course_ids: ids,
        created_at: lp.created_at,
        updated_at: lp.updated_at,
        target: `/${orgSlug}/paths/${lp.id}`,
      });
    }
  }

  // ---- journeys (day-wise programmes) ----
  if (want.has("journey")) {
    type ProgRow = { id: string; name: string; is_active: boolean | null; days_total: number; current_version_id: string | null; created_at: string; updated_at: string };
    try {
      const { data: jRows } = await svc
        .from("journey_programs")
        .select("id, name, is_active, days_total, current_version_id, created_at, updated_at")
        .eq("organization_id", orgId)
        .order("name");
      const progs = (jRows ?? []) as ProgRow[];
      const versionIds = progs.map((j) => j.current_version_id).filter((v): v is string => !!v);
      const versions = new Map<string, { days: unknown; days_total: number; published_at: string | null }>();
      if (versionIds.length) {
        const { data } = await svc.from("journey_versions").select("id, days, days_total, published_at").in("id", versionIds);
        for (const v of (data ?? []) as Array<{ id: string; days: unknown; days_total: number; published_at: string | null }>) versions.set(v.id, v);
      }
      for (const j of progs) {
        const v = j.current_version_id ? versions.get(j.current_version_id) : undefined;
        const available = j.is_active !== false && !!v;
        if (!includeInactive && !available) continue;
        const changedAt = v?.published_at && v.published_at > j.updated_at ? v.published_at : j.updated_at;
        if (since && changedAt < since) continue;
        const days = v
          ? [...parseVersionDays(v.days).values()]
              .filter((d) => d.day <= v.days_total)
              .sort((a, b) => a.day - b.day)
              .map((d) => ({
                day: d.day,
                course_id: d.course_id,
                title: d.course_id ? titleOf.get(d.course_id) ?? null : null,
                mission_title: d.mission_title,
              }))
          : [];
        items.push({
          type: "journey",
          id: j.id,
          title: j.name,
          version_id: j.current_version_id,
          status: available ? "available" : "unavailable",
          is_active: j.is_active !== false,
          days_total: v?.days_total ?? j.days_total,
          days,
          published_at: v?.published_at ?? null,
          created_at: j.created_at,
          updated_at: j.updated_at,
          target: `/${orgSlug}/journey`,
        });
      }
    } catch {
      /* pre-journey database: no journeys to list */
    }
  }

  const total = items.length;
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return NextResponse.json({
    success: true,
    current_page: page,
    per_page: perPage,
    total_records: total,
    total_pages: Math.max(1, Math.ceil(total / perPage)),
    courses: slice.filter((i) => i.type === "course"),
    learning_paths: slice.filter((i) => i.type === "learning_path"),
    journeys: slice.filter((i) => i.type === "journey"),
  });
}

export const GET = handle;
export const POST = handle;
