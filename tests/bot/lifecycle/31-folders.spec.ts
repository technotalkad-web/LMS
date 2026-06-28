/**
 * Library folders — end-to-end CRUD + safety guards.
 *
 * Drives the real folder APIs as an authenticated admin and asserts DB state:
 *   create → nest → move course → guards (cycle, cross-org) → delete-reparent.
 */
import { test, expect } from "@playwright/test";
import {
  addMember,
  createAuthUser,
  createOrg,
  svc,
} from "../../e2e/helpers/supabase";
import { authedContext, uploadCourse } from "./helpers";

test.describe.serial("Library folders — CRUD + guards", () => {
  const s: {
    org?: { id: string; slug: string };
    otherOrg?: { id: string; slug: string };
    admin?: { email: string; password: string };
    courseId?: string;
    otherFolderId?: string;
    folderA?: string;
    folderB?: string;
  } = {};

  test("seed org + admin + course; create folders", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Folders Org" });
    const admin = await createAuthUser({
      profile: { first_name: "Fold", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.org = org;
    s.admin = admin;

    const ctx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const course = await uploadCourse(ctx.request, org.slug, "scorm12.zip");
    s.courseId = course.courseId;

    // Create two folders at root.
    const a = await ctx.request.post("/api/folders", {
      data: { orgSlug: org.slug, name: "Compliance" },
    });
    expect(a.ok()).toBeTruthy();
    s.folderA = (await a.json()).folder.id;

    const b = await ctx.request.post("/api/folders", {
      data: { orgSlug: org.slug, name: "Security" },
    });
    expect(b.ok()).toBeTruthy();
    s.folderB = (await b.json()).folder.id;

    await ctx.close();
    expect(s.folderA).toBeTruthy();
    expect(s.folderB).toBeTruthy();
  });

  test("nest B under A, move course into A", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, s.admin!.email, s.admin!.password);

    const nest = await ctx.request.patch(`/api/folders/${s.folderB}`, {
      data: { orgSlug: s.org!.slug, parentId: s.folderA },
    });
    expect(nest.ok()).toBeTruthy();

    const mv = await ctx.request.patch(`/api/courses/${s.courseId}`, {
      data: { folder_id: s.folderA },
    });
    expect(mv.ok()).toBeTruthy();
    await ctx.close();

    const { data: b } = await svc()
      .from("folders")
      .select("parent_id")
      .eq("id", s.folderB!)
      .maybeSingle();
    expect(b?.parent_id).toBe(s.folderA);

    const { data: c } = await svc()
      .from("courses")
      .select("folder_id")
      .eq("id", s.courseId!)
      .maybeSingle();
    expect(c?.folder_id).toBe(s.folderA);
  });

  test("cycle guard: cannot move A into its own descendant B", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, s.admin!.email, s.admin!.password);
    const res = await ctx.request.patch(`/api/folders/${s.folderA}`, {
      data: { orgSlug: s.org!.slug, parentId: s.folderB },
    });
    expect(res.status()).toBe(400);
    await ctx.close();

    // A stays at root.
    const { data: a } = await svc()
      .from("folders")
      .select("parent_id")
      .eq("id", s.folderA!)
      .maybeSingle();
    expect(a?.parent_id).toBeNull();
  });

  test("cross-org guard: cannot file a course into another org's folder", async ({
    browser,
    baseURL,
  }) => {
    const otherOrg = await createOrg({ name: "QA Folders Other" });
    s.otherOrg = otherOrg;
    // Seed a folder in the other org directly.
    const { data: of } = await svc()
      .from("folders")
      .insert({ organization_id: otherOrg.id, name: "Foreign" })
      .select("id")
      .maybeSingle();
    s.otherFolderId = of!.id as string;

    const ctx = await authedContext(browser, baseURL!, s.admin!.email, s.admin!.password);
    const res = await ctx.request.patch(`/api/courses/${s.courseId}`, {
      data: { folder_id: s.otherFolderId },
    });
    expect(res.status()).toBe(404);
    await ctx.close();

    // Course still filed under A (unchanged).
    const { data: c } = await svc()
      .from("courses")
      .select("folder_id")
      .eq("id", s.courseId!)
      .maybeSingle();
    expect(c?.folder_id).toBe(s.folderA);
  });

  test("delete A reparents course + B to root; no course deleted", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await authedContext(browser, baseURL!, s.admin!.email, s.admin!.password);
    const res = await ctx.request.delete(`/api/folders/${s.folderA}`, {
      data: { orgSlug: s.org!.slug },
    });
    expect(res.ok()).toBeTruthy();
    await ctx.close();

    // Folder A is gone.
    const { data: a } = await svc()
      .from("folders")
      .select("id")
      .eq("id", s.folderA!)
      .maybeSingle();
    expect(a).toBeNull();

    // B reparented to root (A's parent was null).
    const { data: b } = await svc()
      .from("folders")
      .select("parent_id")
      .eq("id", s.folderB!)
      .maybeSingle();
    expect(b?.parent_id).toBeNull();

    // Course survives, reparented to root.
    const { data: c } = await svc()
      .from("courses")
      .select("id, folder_id")
      .eq("id", s.courseId!)
      .maybeSingle();
    expect(c?.id).toBe(s.courseId);
    expect(c?.folder_id).toBeNull();
  });
});
