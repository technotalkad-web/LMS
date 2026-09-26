import { redirect } from "next/navigation";

/**
 * Bare organisation address (/ambak). There was no page here, so anyone who
 * typed it — or was sent back to it after signing in (the middleware
 * redirects unauthenticated /ambak to /ambak/login?next=/ambak) — landed on
 * a 404. The signed-in home everywhere else is the dashboard (login pages,
 * workspace picker), so send them there. Unauthenticated visitors never
 * reach this page: the middleware redirects them to the org's login first.
 */
export default async function OrgRootPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  redirect(`/${org}/dashboard`);
}
