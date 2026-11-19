import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/db/chunked";

/**
 * Who belongs to an organisation (ADR 0030): the one place that answers it.
 *
 * A membership counts only when its `status` is `active` and its
 * organisation's `deleted_at` is null. A membership that does not count
 * grants nothing: no page, no route, no administrator rights and no
 * organisation mail. Every role is read from a membership that counts.
 *
 * Rules of the module:
 *   - it uses the client it is given and creates none;
 *   - it sends nothing, writes nothing and logs no address;
 *   - nothing is cached between requests: every call reads the rows again;
 *   - a caller never treats "unreadable" as "none": mail is not sent and a
 *     route answers 503;
 *   - it reads no impersonation, no host and no domain.
 *
 * The test is made here in code, on every client: the service role reads a
 * deleted organisation and an inactive row like any other, so row security
 * is never what decides it.
 */

/** The roles that administer an organisation: the same list as is_org_admin (0056). */
export const ADMIN_ROLES = ["super_owner", "owner", "admin"] as const;

/** The two columns of a membership row the rule reads. */
export type MembershipRow = { role?: string | null; status?: string | null };
/** The column of an organisation row the rule reads. */
export type OrganisationRow = { deleted_at?: string | null };

/**
 * True only when the row's `status` is `active` and the organisation's
 * `deleted_at` is null. A row or an organisation that is missing, or read
 * without those columns, does not count.
 */
export function membershipCounts(
  member: MembershipRow | null | undefined,
  organisation: OrganisationRow | null | undefined
): boolean {
  return !!member && !!organisation && member.status === "active" && organisation.deleted_at === null;
}

/** True when this row gives administrator rights today: it counts, and its role is an administrator's. */
export function grantsAdminRights(
  member: MembershipRow | null | undefined,
  organisation: OrganisationRow | null | undefined
): boolean {
  return membershipCounts(member, organisation) && (ADMIN_ROLES as readonly string[]).includes(member?.role ?? "");
}

/** An organisation named by its id or by its slug. */
export type OrgRef = { id: string } | { slug: string };

/** A membership that counts: the organisation (the columns asked for) and the role as stored. */
export type CountingMembership<O> = { org: O; role: string };

/**
 * "none": no row, a row that is inactive or suspended, a deleted
 * organisation or an unknown one, all one answer. "unreadable": a read
 * failed, so nobody knows.
 */
export type MembershipAnswer<O> = CountingMembership<O> | "none" | "unreadable";

/** The organisation's select: always its id and `deleted_at`, plus the columns the caller asks for. */
function orgSelect(columns: string): string {
  const extra = columns
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c && c !== "id" && c !== "deleted_at");
  return ["id", ...extra, "deleted_at"].join(", ");
}

/**
 * The caller's membership in one organisation, read now: the organisation
 * (with `deleted_at` and `orgColumns`) and that person's own row (with
 * `role` and `status`). Answers the organisation and the role when the
 * membership counts, else "none", or "unreadable" when a read failed.
 *
 * The role is returned as stored (the legacy "owner" and "member" are not
 * renamed); the page guard normalises it for its own callers.
 */
export async function resolveOrgMembership<O extends { id: string } = { id: string }>(
  client: SupabaseClient,
  organisation: OrgRef,
  userId: string,
  orgColumns = "id"
): Promise<MembershipAnswer<O>> {
  const memberRead = (orgId: string) =>
    client
      .from("organization_members")
      .select("role, status")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .maybeSingle();
  const orgRead = client.from("organizations").select(orgSelect(orgColumns));

  let org: (O & OrganisationRow) | null;
  let member: { data: unknown; error: unknown };
  if ("id" in organisation) {
    // Both rows are keyed on the id: read them together.
    const [o, m] = await Promise.all([orgRead.eq("id", organisation.id).maybeSingle(), memberRead(organisation.id)]);
    if (o.error) return "unreadable";
    org = (o.data as (O & OrganisationRow) | null) ?? null;
    member = m;
  } else {
    const o = await orgRead.eq("slug", organisation.slug).maybeSingle();
    if (o.error) return "unreadable";
    org = (o.data as (O & OrganisationRow) | null) ?? null;
    if (!org || org.deleted_at !== null) return "none";
    member = await memberRead(org.id);
  }
  if (!org || org.deleted_at !== null) return "none";
  if (member.error) return "unreadable";
  const row = member.data as MembershipRow | null;
  if (!row || !membershipCounts(row, org)) return "none";
  return { org, role: row.role ?? "" };
}

/** One organisation of a person's, that counts, with the role they hold there (as stored). */
export type CountingOrganisation = { id: string; name: string; slug: string; role: string };

/**
 * That person's organisations that count, each with its role, in the order
 * the organisations read returns them; or "unreadable" when a read failed.
 */
export async function listCountingMemberships(
  client: SupabaseClient,
  userId: string
): Promise<CountingOrganisation[] | "unreadable"> {
  const { data: rows, error } = await client
    .from("organization_members")
    .select("organization_id, role, status")
    .eq("user_id", userId);
  if (error) return "unreadable";
  const mine = ((rows ?? []) as Array<MembershipRow & { organization_id: string }>).filter((r) => r.status === "active");
  const ids = [...new Set(mine.map((r) => r.organization_id))];
  if (ids.length === 0) return [];
  const { data: orgs, error: orgError } = await client
    .from("organizations")
    .select("id, name, slug, deleted_at")
    .in("id", ids);
  if (orgError) return "unreadable";
  const out: CountingOrganisation[] = [];
  for (const o of (orgs ?? []) as Array<{ id: string; name: string; slug: string } & OrganisationRow>) {
    const row = mine.find((r) => r.organization_id === o.id);
    if (row && membershipCounts(row, o)) out.push({ id: o.id, name: o.name, slug: o.slug, role: row.role ?? "" });
  }
  return out;
}

/**
 * The ids of the organisation's members that count (only those holding one
 * of `roles`, when given); an empty set for a deleted or unknown
 * organisation; or "unreadable" when a read failed. One call reads the
 * organisation once and its active rows page by page, for one request or
 * one run.
 */
export async function countingMemberIds(
  serviceClient: SupabaseClient,
  organisationId: string,
  roles?: readonly string[]
): Promise<Set<string> | "unreadable"> {
  const { data: org, error } = await serviceClient
    .from("organizations")
    .select("id, deleted_at")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) return "unreadable";
  const o = org as OrganisationRow | null;
  if (!o || o.deleted_at !== null) return new Set();
  let rows: Array<MembershipRow & { user_id: string }>;
  try {
    rows = await fetchAll<MembershipRow & { user_id: string }>(
      serviceClient,
      "organization_members",
      "user_id, role, status",
      (q) => {
        const active = q.eq("organization_id", organisationId).eq("status", "active");
        return roles ? active.in("role", [...roles]) : active;
      },
      "user_id"
    );
  } catch {
    return "unreadable";
  }
  const out = new Set<string>();
  for (const r of rows) {
    if (membershipCounts(r, o) && (!roles || roles.includes(r.role ?? ""))) out.add(r.user_id);
  }
  return out;
}
