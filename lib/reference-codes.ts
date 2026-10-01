/**
 * Human-readable reference codes (0079): MOD0015 / PTH0005 / JUR0002.
 *
 * The uuid stays the internal id everywhere; the code is a label people can
 * read, type, search and share. It lives in `reference_code` on courses,
 * learning paths and journey programmes, assigned by the database on insert
 * and never changed. Version and package codes are DERIVED here, not stored.
 *
 * Every reader goes through `fetchReferenceCodes`, which is fail-soft: on a
 * database that has not run 0079 yet it returns an empty map, so pages and
 * APIs keep working and codes simply appear once the migration is applied.
 */

// Any Supabase client (session or service role); the shapes used are tiny.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

export type ReferenceTable = "courses" | "learning_paths" | "journey_programs";

export const REFERENCE_PREFIX: Record<ReferenceTable, "MOD" | "PTH" | "JUR"> = {
  courses: "MOD",
  learning_paths: "PTH",
  journey_programs: "JUR",
};

const CODE_RE = /^(MOD|PTH|JUR)\d{4,}$/i;

/** True for a value shaped like a reference code (prefix + at least four digits). */
export function isReferenceCode(v: string): boolean {
  return CODE_RE.test(v.trim());
}

/** Canonical spelling: upper-case, trimmed. */
export function normalizeReferenceCode(v: string): string {
  return v.trim().toUpperCase();
}

/** id → code for the given rows. Empty map (never throws) when the column is absent. */
export async function fetchReferenceCodes(
  client: AnyClient,
  table: ReferenceTable,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(ids.filter(Boolean))];
  try {
    for (let i = 0; i < list.length; i += 300) {
      const { data, error } = await client
        .from(table)
        .select("id, reference_code")
        .in("id", list.slice(i, i + 300));
      if (error) return out;
      for (const r of (data ?? []) as Array<{ id: string; reference_code: string | null }>) {
        if (r.reference_code) out.set(r.id, r.reference_code);
      }
    }
  } catch {
    /* pre-0079 database */
  }
  return out;
}

/** code → id within one organisation (case-insensitive). Unknown codes are simply absent. */
export async function resolveReferenceCodes(
  client: AnyClient,
  orgId: string,
  table: ReferenceTable,
  codes: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(codes.map(normalizeReferenceCode))];
  if (wanted.length === 0) return out;
  try {
    const { data, error } = await client
      .from(table)
      .select("id, reference_code")
      .eq("organization_id", orgId)
      .in("reference_code", wanted);
    if (error) return out;
    for (const r of (data ?? []) as Array<{ id: string; reference_code: string | null }>) {
      if (r.reference_code) out.set(normalizeReferenceCode(r.reference_code), r.id);
    }
  } catch {
    /* pre-0079 database */
  }
  return out;
}

/**
 * Split a list of ids-or-codes into uuids and resolved code ids.
 * `unknown` lists codes that matched nothing, so a typo can be reported
 * instead of silently matching no rows.
 */
export async function resolveIdsOrCodes(
  client: AnyClient,
  orgId: string,
  table: ReferenceTable,
  values: string[]
): Promise<{ ids: string[]; unknown: string[] }> {
  const ids: string[] = [];
  const codes: string[] = [];
  for (const v of values) (isReferenceCode(v) ? codes : ids).push(v);
  const map = await resolveReferenceCodes(client, orgId, table, codes);
  const unknown: string[] = [];
  for (const c of codes) {
    const id = map.get(normalizeReferenceCode(c));
    if (id) ids.push(id);
    else unknown.push(c);
  }
  return { ids: [...new Set(ids)], unknown };
}

/** Course version code: MOD0015-V03, or MOD0015-HI-V02 when the course has several language packages. */
export function versionCode(
  courseCode: string | null | undefined,
  versionNumber: number | null | undefined,
  language: string | null | undefined,
  multiPackage: boolean
): string | null {
  if (!courseCode || !versionNumber) return null;
  const lang = multiPackage && language ? `-${language.toUpperCase()}` : "";
  return `${courseCode}${lang}-V${String(versionNumber).padStart(2, "0")}`;
}

/** Language package code: MOD0015-HI (the course code alone when the package has no language). */
export function packageCode(courseCode: string | null | undefined, language: string | null | undefined): string | null {
  if (!courseCode) return null;
  return language ? `${courseCode}-${language.toUpperCase()}` : courseCode;
}

/** Journey version code: JUR0002-V03. */
export function journeyVersionCode(journeyCode: string | null | undefined, versionNumber: number | null | undefined): string | null {
  if (!journeyCode || !versionNumber) return null;
  return `${journeyCode}-V${String(versionNumber).padStart(2, "0")}`;
}
