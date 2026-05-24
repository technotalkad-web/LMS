import { test, expect, newAuthedContext } from "../helpers/fixtures";
import {
  createOrg,
  createAuthUser,
  addMember,
  svc,
} from "../helpers/supabase";

/**
 * Tier-1 security smoke test: an admin of Org A must NOT be able to read
 * or write Org B's data via the public API.
 *
 * If this test ever fails, halt the launch. Cross-tenant leakage is the
 * single most catastrophic class of bug a B2B multi-tenant SaaS can ship.
 *
 * Note: this is a SMOKE check at the API layer. The DB-layer truth is
 * RLS itself — for full coverage, add a SQL-level RLS audit job that
 * iterates every table with `organization_id` and verifies cross-tenant
 * SELECT/UPDATE/DELETE return zero. We exercise the API surface here
 * because that's where bugs typically land (a missing org-membership
 * check, a service-role client used without a guard).
 */

test.describe("cross-tenant isolation", () => {
  test("Org A admin cannot list Org B users", async ({ browser, baseURL }) => {
    const orgA = await createOrg({ name: "QA Org A iso" });
    const orgB = await createOrg({ name: "QA Org B iso" });

    const adminA = await createAuthUser({ profile: { first_name: "AdminA" } });
    await addMember({
      organizationId: orgA.id,
      userId: adminA.id,
      role: "admin",
    });

    // Seed a user inside Org B so there's data TO leak.
    const userB = await createAuthUser({ profile: { first_name: "InsideB" } });
    await addMember({
      organizationId: orgB.id,
      userId: userB.id,
      role: "member",
    });

    const ctx = await newAuthedContext(browser, baseURL!, adminA.email, adminA.password);

    // Try to query Org B's user list as Org A's admin.
    const res = await ctx.request.get(
      `/api/organization-members?orgSlug=${orgB.slug}`
    );
    // The endpoint should reject with 403 or 404 — definitely not 200 with rows.
    if (res.status() === 200) {
      const body = await res.json();
      const items = Array.isArray(body) ? body : body.items ?? [];
      expect(items).toEqual([]);
    } else {
      expect([401, 403, 404]).toContain(res.status());
    }

    await ctx.close();
  });

  test("Org A admin cannot create a user in Org B (cross-tenant write)", async ({
    browser,
    baseURL,
  }) => {
    const orgA = await createOrg({ name: "QA Org A iso write" });
    const orgB = await createOrg({ name: "QA Org B iso write" });

    const adminA = await createAuthUser({ profile: { first_name: "AdminA" } });
    await addMember({
      organizationId: orgA.id,
      userId: adminA.id,
      role: "admin",
    });

    const ctx = await newAuthedContext(browser, baseURL!, adminA.email, adminA.password);

    const res = await ctx.request.post(`/api/users`, {
      data: {
        orgSlug: orgB.slug, // <-- targeting OTHER tenant
        first_name: "Cross",
        last_name: "Tenant",
        email: `qa+cross-${Date.now()}@example.test`,
        employee_id: `EMP-${Date.now()}`,
        lms_role: "user",
        node_id: "root",
      },
    });
    expect([401, 403, 404]).toContain(res.status());

    // Belt and suspenders: even if status was wrong, confirm no member row landed.
    const { data: rows } = await svc()
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", orgB.id);
    // Should only contain test users we explicitly added (zero in this case).
    expect(rows?.length ?? 0).toBe(0);

    await ctx.close();
  });

  test("Org A admin cannot suspend Org B (platform-owner-only action)", async ({
    browser,
    baseURL,
  }) => {
    const orgA = await createOrg();
    const orgB = await createOrg();

    const adminA = await createAuthUser({ profile: { first_name: "AdminA" } });
    await addMember({
      organizationId: orgA.id,
      userId: adminA.id,
      role: "admin",
    });

    const ctx = await newAuthedContext(browser, baseURL!, adminA.email, adminA.password);

    const res = await ctx.request.patch(`/api/super/tenants/${orgB.id}`, {
      data: { action: "suspend" },
    });
    expect([401, 403]).toContain(res.status());
    await ctx.close();
  });


  test("unauthenticated request to a protected route is not 200 with data", async ({
    request,
  }) => {
    // Next.js middleware redirects unauth to /login (a 307). Playwright
    // follows redirects by default, so we'd see 200 with the login HTML —
    // disabling redirect-following surfaces the real status code.
    const res = await request.get(
      `/api/organization-members?orgSlug=any-slug`,
      { maxRedirects: 0 }
    );
    expect([301, 302, 303, 307, 308, 401, 403, 404]).toContain(res.status());
  });
});
