import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { adminHome } from "@/lib/auth/permissions";

/**
 * Bare organisation address (/ambak). There was no page here, so anyone who
 * typed it — or was sent back to it after signing in (the middleware
 * redirects unauthenticated /ambak to /ambak/login?next=/ambak) — landed on
 * a 404. Admins land on the Attention Center (what needs their attention
 * first), Data Analysts on Learner Analytics; everyone else lands on the
 * learner dashboard. requireOrgAccess
 * handles the auth/membership redirects. Unauthenticated visitors never reach
 * this page: the middleware redirects them to the org's login first.
 */
export default async function OrgRootPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const { role } = await requireOrgAccess(org);
  redirect(`/${org}/${adminHome(role)?.path ?? "dashboard"}`);
}
