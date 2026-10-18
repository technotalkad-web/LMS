/**
 * ADR 0003 step 13 — record guard: learner history is never deleted, a
 * ready version is write-once, and two concurrent multipart uploads to one
 * language can never overwrite each other.
 *
 *   - course DELETE with learner attempts → 409 (route count, decision 3)
 *   - an attempt by a user since removed from the org still blocks
 *   - staff-only attempts do not block (decision 3's definition)
 *   - delete of a course_versions row with learner attempts through an
 *     admin session → learner_history_exists, for a current member's attempt
 *     and for a removed member's attempt (no membership = learner)
 *                                                          (needs 0098)
 *   - update of storage_prefix or launch_url on a ready version →
 *     course_version_frozen; storage_driver stays writable  (needs 0098)
 *   - a test org with learner attempts deleted through the service client
 *     by cascade succeeds (the path of the e2e purge of qa-* orgs and of the
 *     48 h lifecycle cleanup of lifecycle-* orgs, ./cleanup.ts; meaningful
 *     once 0098's guard exists, harmless before)
 *   - the lifecycle cleanup's real queries (dry run, clock moved 49 h on)
 *     match a freshly seeded lifecycle org and user, and delete nothing
 *   - concurrent multipart uploads to one package → 409 for the losers, and
 *     every stored launch file is its own upload's bytes (reserve-first)
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { addMember, createAuthUser, createOrg, isLifecycleSlug, svc } from "./data";
import { assignCourse, authedContext } from "./helpers";
import { NEEDS_0098, has0098, scormZip, sha256, uploadNew, zipFile } from "./p0-helpers";
import { cleanupLifecycleData } from "./cleanup";

type User = { id: string; email: string; password: string };

test.describe.serial("ADR 0003 — record guard", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: User;
    adminCtx?: BrowserContext;
    learner?: User;
    leaver?: User;
    courseA?: string; // learner attempt
    courseB?: string; // attempt by a member who is later removed
    courseC?: string; // staff attempt only
  } = {};

  test.afterAll(async () => {
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: three courses; a learner, a leaver and the admin each launch one", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Record Guard" });
    const admin = await createAuthUser({ profile: { first_name: "Guard", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const learner = await createAuthUser({ profile: { first_name: "Guard", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    const leaver = await createAuthUser({ profile: { first_name: "Guard", last_name: "Leaver", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: leaver.id, role: "member" });
    Object.assign(s, { org, admin, learner, leaver });
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;

    // Three distinct titles: the integrity check (ADR 0004) blocks a second
    // course carrying another course's title.
    const ids: string[] = [];
    for (const t of ["QA Guard A", "QA Guard B", "QA Guard C"]) {
      const r = await uploadNew(areq, org.slug, `${t}.zip`, await scormZip({ title: t }));
      expect(r.ok(), `upload ${t} → ${r.status()}: ${await r.text()}`).toBeTruthy();
      ids.push((await r.json()).courseId as string);
    }
    [s.courseA, s.courseB, s.courseC] = ids;
    await assignCourse(areq, org.slug, s.courseA!, learner.id);
    await assignCourse(areq, org.slug, s.courseB!, leaver.id);

    for (const [u, cid] of [[learner, s.courseA!], [leaver, s.courseB!]] as Array<[User, string]>) {
      const ctx = await authedContext(browser, baseURL!, u.email, u.password);
      const r = await ctx.request.get(`/${org.slug}/courses/${cid}/launch`);
      expect(r.ok(), `launch → ${r.status()}`).toBeTruthy();
      await ctx.close();
    }
    const r = await areq.get(`/${org.slug}/courses/${s.courseC}/launch`);
    expect(r.ok(), `admin preview launch → ${r.status()}`).toBeTruthy();
  });

  test("course DELETE with a learner attempt → 409, nothing deleted", async () => {
    const res = await s.adminCtx!.request.delete(`/api/courses/${s.courseA}`);
    expect(res.status(), await res.text()).toBe(409);
    const j = await res.json();
    expect(j.error).toMatch(/Cannot delete: 1 learner attempts exist .*Deactivate instead/);
    expect(j.attempt_count).toBe(1);
    const { data } = await svc().from("courses").select("id").eq("id", s.courseA!).maybeSingle();
    expect(data, "course A still exists").toBeTruthy();
  });

  test("an attempt by a user since removed from the org still blocks", async () => {
    const rm = await s.adminCtx!.request.delete(`/api/organization-members/${s.leaver!.id}?orgSlug=${s.org!.slug}`);
    expect(rm.ok(), `remove member → ${rm.status()}: ${await rm.text()}`).toBeTruthy();
    const res = await s.adminCtx!.request.delete(`/api/courses/${s.courseB}`);
    expect(res.status(), await res.text()).toBe(409);
    expect((await res.json()).attempt_count).toBe(1);
  });

  test("staff-only attempts do not block: course C deletes", async () => {
    // The case only means something if course C really holds the admin's attempt.
    const { data: cVersions } = await svc().from("course_versions").select("id").eq("course_id", s.courseC!);
    const { data: cAttempts } = await svc()
      .from("course_attempts")
      .select("user_id")
      .in("course_version_id", ((cVersions ?? []) as Array<{ id: string }>).map((v) => v.id));
    expect(((cAttempts ?? []) as Array<{ user_id: string }>).map((a) => a.user_id), "course C holds exactly the admin's attempt").toEqual([s.admin!.id]);
    const res = await s.adminCtx!.request.delete(`/api/courses/${s.courseC}`);
    expect(res.status(), await res.text()).toBe(200);
    const { data } = await svc().from("courses").select("id").eq("id", s.courseC!).maybeSingle();
    expect(data).toBeNull();
  });

  test("deleting a version with learner attempts through an admin session → learner_history_exists", async ({ browser, baseURL }) => {
    test.skip(!(await has0098()), NEEDS_0098);
    // A PostgREST delete with the admin's own JWT (admins may delete versions
    // under RLS), the path the route-level count does not cover.
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
    });
    const { error: signErr } = await anon.auth.signInWithPassword({ email: s.admin!.email, password: s.admin!.password });
    expect(signErr).toBeNull();
    // Course A: a current member's attempt. Course B: the attempt of the
    // member removed above (a missing membership counts as a learner).
    for (const [courseId, who] of [[s.courseA!, "a current member"], [s.courseB!, "a removed member"]] as Array<[string, string]>) {
      const { data: c } = await svc().from("courses").select("current_version_id").eq("id", courseId).single();
      const versionId = (c as { current_version_id: string }).current_version_id;
      const { error } = await anon.from("course_versions").delete().eq("id", versionId);
      expect(error?.message ?? "", `the delete guard refuses (attempt by ${who})`).toMatch(/learner_history_exists/);
      const { data: still } = await svc().from("course_versions").select("id").eq("id", versionId).maybeSingle();
      expect(still, `course ${courseId === s.courseA ? "A" : "B"}'s version still exists`).toBeTruthy();
    }
    void browser; void baseURL;
  });

  test("a ready version's storage_prefix is frozen → course_version_frozen", async () => {
    test.skip(!(await has0098()), NEEDS_0098);
    const { data: c } = await svc().from("courses").select("current_version_id").eq("id", s.courseA!).single();
    const versionId = (c as { current_version_id: string }).current_version_id;
    const { data: before } = await svc().from("course_versions").select("storage_prefix").eq("id", versionId).single();
    // Service role: the trigger has no exemption (write-once for everyone).
    const { error } = await svc()
      .from("course_versions")
      .update({ storage_prefix: `${(before as { storage_prefix: string }).storage_prefix}moved/` })
      .eq("id", versionId);
    expect(error?.message ?? "").toMatch(/course_version_frozen/);
    const { data: after } = await svc().from("course_versions").select("storage_prefix").eq("id", versionId).single();
    expect(after).toEqual(before);
  });

  test("a ready version's launch_url is frozen too; storage_driver stays writable", async () => {
    test.skip(!(await has0098()), NEEDS_0098);
    const { data: c } = await svc().from("courses").select("current_version_id").eq("id", s.courseA!).single();
    const versionId = (c as { current_version_id: string }).current_version_id;
    const { data: before } = await svc().from("course_versions").select("launch_url, storage_driver").eq("id", versionId).single();
    const row = before as { launch_url: string; storage_driver: string };
    const { error } = await svc().from("course_versions").update({ launch_url: `${row.launch_url}?moved=1` }).eq("id", versionId);
    expect(error?.message ?? "").toMatch(/course_version_frozen/);
    // The R2 copy script flips storage_driver after verification: the trigger
    // must let it through. Written with its current value, so nothing changes.
    const { error: driverErr } = await svc().from("course_versions").update({ storage_driver: row.storage_driver }).eq("id", versionId);
    expect(driverErr, "storage_driver is not frozen").toBeNull();
    const { data: after } = await svc().from("course_versions").select("launch_url, storage_driver").eq("id", versionId).single();
    expect(after).toEqual(before);
  });

  test("purge path: a test org with learner attempts deletes by cascade through the service client", async ({ browser, baseURL }) => {
    // The e2e purge (qa-* orgs) and the lifecycle cleanup (lifecycle-* orgs,
    // ./cleanup.ts) both delete this way; the 0098 exemption is the
    // service_role claim, not the slug.
    const org = await createOrg({ name: "QA Guard Purge" });
    expect(isLifecycleSlug(org.slug)).toBeTruthy();
    const admin = await createAuthUser({ profile: { first_name: "Purge", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const learner = await createAuthUser({ profile: { first_name: "Purge", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    const actx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const up = await uploadNew(actx.request, org.slug, "purge.zip", await scormZip({ title: "QA Guard Purge Course" }));
    expect(up.ok(), await up.text()).toBeTruthy();
    const courseId = (await up.json()).courseId as string;
    await assignCourse(actx.request, org.slug, courseId, learner.id);
    await actx.close();
    const lctx = await authedContext(browser, baseURL!, learner.email, learner.password);
    expect((await lctx.request.get(`/${org.slug}/courses/${courseId}/launch`)).ok()).toBeTruthy();
    await lctx.close();
    const { count: before } = await svc()
      .from("course_attempts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id);
    expect(before).toBe(1);

    const { error } = await svc().from("organizations").delete().eq("id", org.id);
    expect(error, "the service-role cascade is exempt from the delete guard").toBeNull();
    const { data: gone } = await svc().from("courses").select("id").eq("id", courseId).maybeSingle();
    expect(gone).toBeNull();
    if (!(await has0098())) test.info().annotations.push({ type: "note", description: `cascade passed; the exemption itself is only exercised once 0098 is applied (${NEEDS_0098})` });
  });

  test("lifecycle cleanup, dry run: its real queries match a fresh lifecycle org and user, and delete nothing", async () => {
    // The 48 h cleanup (./cleanup.ts) runs in every lifecycle global setup;
    // this checks its PostgREST select (like + lt + order + limit) and its
    // paged auth listing against the database. Dry run with the clock moved
    // 49 h on, so the rows just seeded count as expired: never a live delete
    // with a shifted clock (it would delete this run's data).
    const org = await createOrg({ name: "QA Cleanup Probe" });
    const user = await createAuthUser({ profile: { first_name: "Cleanup", last_name: "Probe", must_change_password: false } });
    const r = await cleanupLifecycleData({ dryRun: true, now: new Date(Date.now() + 49 * 3_600_000) });
    expect(r.errors, "no query error").toEqual([]);
    expect(r.orgs.matched, "expired lifecycle orgs").toBeGreaterThanOrEqual(1);
    expect(r.users.matched, "expired lifecycle users").toBeGreaterThanOrEqual(1);
    // Newest first, so the org just seeded is inside the per-run bound.
    expect(r.ids.orgs.includes(org.id), "the seeded org is matched").toBeTruthy();
    if (!r.capped.includes("users")) expect(r.ids.users.includes(user.id), "the seeded user is matched").toBeTruthy();
    expect([r.orgs.deleted, r.users.deleted, r.otps.deleted], "a dry run deletes nothing").toEqual([0, 0, 0]);
    const { data: still } = await svc().from("organizations").select("id").eq("id", org.id).maybeSingle();
    expect(still, "the seeded org still exists").toBeTruthy();
    const { data: u } = await svc().auth.admin.getUserById(user.id);
    expect(u?.user?.id, "the seeded user still exists").toBe(user.id);
  });

  test("concurrent multipart uploads to one package: losers get 409, no upload overwrites another", async () => {
    const areq = s.adminCtx!.request;
    const { data: pkg } = await svc().from("course_packages").select("id, current_version_id").eq("course_id", s.courseA!).single();
    const pkgId = (pkg as { id: string }).id;
    const v1 = (pkg as { current_version_id: string }).current_version_id;
    const v1Prefix = ((await svc().from("course_versions").select("storage_prefix").eq("id", v1).single()).data as { storage_prefix: string }).storage_prefix;
    const download = async (key: string) => {
      const { data, error } = await svc().storage.from("course-content").download(key);
      expect(error, `download ${key}`).toBeNull();
      return Buffer.from(await data!.arrayBuffer());
    };
    const v1Before = sha256(await download(`${v1Prefix}index.html`));

    // Fire bursts of concurrent replacements, each with its own bytes, until
    // the race happens (the version-number read and the reserving insert
    // overlap); every winner must hold exactly its own launch file.
    let conflicts = 0;
    for (let burst = 0; burst < 4 && conflicts === 0; burst++) {
      const markers = [0, 1, 2, 3].map((i) => `RG-${burst}-${i}-${Date.now()}`);
      const bodies = await Promise.all(markers.map((m) => scormZip({ title: "QA Guard A", marker: m })));
      const results = await Promise.all(
        bodies.map((b, i) =>
          areq.post(`/api/courses/${s.courseA}/packages/${pkgId}/versions`, {
            multipart: { orgSlug: s.org!.slug, mode: "grandfather", file: zipFile(`race-${i}.zip`, b) },
          })
        )
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status() === 409) {
          conflicts++;
          expect((await r.json()).error).toMatch(/Another upload to this language is in progress/);
          continue;
        }
        expect(r.ok(), `race upload ${i} → ${r.status()}: ${await r.text()}`).toBeTruthy();
        const versionId = (await r.json()).version_id as string;
        const { data: v } = await svc().from("course_versions").select("storage_prefix, upload_status").eq("id", versionId).single();
        const row = v as { storage_prefix: string; upload_status: string };
        expect(row.upload_status).toBe("ready");
        expect((await download(`${row.storage_prefix}version.txt`)).toString()).toBe(markers[i]);
        expect((await download(`${row.storage_prefix}index.html`)).toString()).toContain(markers[i]);
      }
      // Losers leave no reserved rows behind.
      const { count: uploading } = await svc()
        .from("course_versions")
        .select("id", { count: "exact", head: true })
        .eq("package_id", pkgId)
        .eq("upload_status", "uploading");
      expect(uploading).toBe(0);
    }
    expect(conflicts, "at least one concurrent upload hit the reserved version (409)").toBeGreaterThan(0);
    expect(sha256(await download(`${v1Prefix}index.html`)), "v1's launch file is unchanged").toBe(v1Before);
  });
});
