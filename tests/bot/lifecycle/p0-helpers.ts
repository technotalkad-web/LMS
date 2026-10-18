/**
 * Shared helpers for the P0 specs 50-53 (ADR 0003, ADR 0004): fixture
 * variants built from the committed zips, the 0098 probe, the direct-upload
 * API flow and the cmi5 auth handshake.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { svc } from "../../e2e/helpers/supabase";

export const FIXTURES = path.resolve(__dirname, "../fixtures");
export const XAPI_HEADERS = { "Content-Type": "application/json", "X-Experience-API-Version": "1.0.3" };
export const VERB = (v: string) => `http://adlnet.gov/expapi/verbs/${v}`;

let probe: boolean | null = null;
/**
 * Is migration 0098 applied on the target database? Its override columns on
 * package_validations come in the same file as the delete guard and the
 * freeze trigger, so one real select settles all of it (head/count probes
 * report missing columns as present).
 *
 * Fails closed like has0099(): only Postgres 42703 (undefined column) means
 * "not applied"; any other error (network, 5xx, auth) throws. A probe that
 * cached false on a transient error would skip the 0098 guard cases and
 * quietly take the weaker branch of the `if (await has0098())` blocks in
 * spec 52 for the rest of the worker, and the run would still be green.
 * The filter on an id no row has still makes Postgres validate the columns,
 * and no organisation's row is read.
 */
export async function has0098(): Promise<boolean> {
  if (probe !== null) return probe;
  const { error } = await svc()
    .from("package_validations")
    .select("override_reason, overridden_at")
    .eq("id", "00000000-0000-0000-0000-000000000000")
    .limit(1);
  if (error && error.code !== "42703") throw new Error(`has0098 probe failed: ${error.code ?? ""} ${error.message}`);
  probe = !error;
  return probe;
}
export const NEEDS_0098 = "needs 0098 on staging (migration not applied yet)";

let probe0099: boolean | null = null;
/**
 * Is migration 0099 (PostgREST write guards, ADR 0008 C + ADR 0009) applied?
 * Its section 3 adds v_course_attempt_summary.live_attempt_count in the same
 * transaction as the policy drops, so one real select of that column settles
 * all of it (ADR 0009 step 12). Postgres answers 42703 (undefined column)
 * before the apply; any other error is an environment problem and throws,
 * so a broken setup never silently skips every guard case. The filter on a
 * user id no account has still makes Postgres validate the column, and no
 * organisation's row is read.
 */
export async function has0099(): Promise<boolean> {
  if (probe0099 !== null) return probe0099;
  const { error } = await svc()
    .from("v_course_attempt_summary")
    .select("live_attempt_count")
    .eq("user_id", "00000000-0000-0000-0000-000000000000")
    .limit(1);
  if (error && error.code !== "42703") throw new Error(`has0099 probe failed: ${error.code ?? ""} ${error.message}`);
  probe0099 = !error;
  return probe0099;
}
export const NEEDS_0099 = "needs 0099";

/**
 * A PostgREST client carrying the user's own session (anon key + password
 * sign-in, the spec 50 pattern): what a learner or an admin can do with
 * their JWT outside any route.
 */
export async function sessionClient(u: { email: string; password: string }): Promise<SupabaseClient> {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  expect(error, "sign-in with the anon key").toBeNull();
  return c;
}

export function sha256(bytes: Uint8Array | Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Every entry these builders write carries this fixed date, so the same
 * inputs always give the same bytes (JSZip stamps a replaced entry with the
 * current time otherwise, which changes the zip's sha256 between builds and
 * breaks any re-POST bound to a stored validation by sha256).
 */
const FIXED_ENTRY_DATE = new Date("2026-01-01T00:00:00Z");
const fixed = { date: FIXED_ENTRY_DATE };

/** scorm12.zip retitled, with an optional marker in index.html and version.txt. */
export async function scormZip(opts: { title?: string; marker?: string } = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIXTURES, "scorm12.zip")));
  if (opts.title) {
    const m = await zip.file("imsmanifest.xml")!.async("string");
    zip.file("imsmanifest.xml", m.replace("<title>QA Bot SCORM 1.2 Course</title>", `<title>${opts.title}</title>`), fixed);
  }
  if (opts.marker) {
    const html = await zip.file("index.html")!.async("string");
    zip.file("index.html", html.replace("</body>", `<!-- ${opts.marker} --></body>`), fixed);
    zip.file("version.txt", opts.marker, fixed);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/** cmi5.zip with its course id and title replaced (the AU id stays https://qa.bot/cmi5/au1). */
export async function cmi5Zip(opts: { courseId?: string; title?: string; marker?: string } = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIXTURES, "cmi5.zip")));
  let xml = await zip.file("cmi5.xml")!.async("string");
  if (opts.courseId) xml = xml.replace('<course id="https://qa.bot/cmi5/course">', `<course id="${opts.courseId}">`);
  if (opts.title) {
    xml = xml.replace(
      '<title><langstring lang="en">QA Bot cmi5 Course</langstring></title>',
      `<title><langstring lang="en">${opts.title}</langstring></title>`
    );
  }
  zip.file("cmi5.xml", xml, fixed);
  if (opts.marker) zip.file("version.txt", opts.marker, fixed);
  return zip.generateAsync({ type: "nodebuffer" });
}

export const zipFile = (name: string, buffer: Buffer) => ({ name, mimeType: "application/zip", buffer });

/** Multipart upload of a new course; returns the raw response. */
export async function uploadNew(req: APIRequestContext, orgSlug: string, name: string, buffer: Buffer, extra: Record<string, string> = {}) {
  return req.post("/api/courses/upload", { multipart: { orgSlug, ...extra, file: zipFile(name, buffer) } });
}

/**
 * The browser-direct path through its API (what the Library UI does):
 * validate (whole zip as the bundle) → init → sign → PUT every file →
 * finalize. Returns each step's outcome; stops at the first refusal.
 */
export async function directUpload(
  req: APIRequestContext,
  opts: {
    orgSlug: string;
    buffer: Buffer;
    name: string;
    courseId?: string;
    packageId?: string;
    language?: string;
    acknowledge?: boolean;
    /** Use this validation instead of validating again (e.g. after an override). */
    validationId?: string;
    /** PUT these bytes instead of the validated package (the stored-bytes binding test). */
    filesFrom?: Buffer;
    /** Stop after init: the version stays 'uploading' (spec 54: a slot without a ready version). */
    initOnly?: boolean;
    /** Replace-package semantics sent to finalize (ADR 0011 step 13); omitted = the route's default, grandfather. */
    mode?: "grandfather" | "force_restart";
  }
): Promise<{
  validate: { status: number; body: Record<string, unknown> } | null;
  init?: { status: number; body: Record<string, unknown> };
  versionId?: string;
  finalize?: { status: number; body: Record<string, unknown> };
}> {
  let validationId = opts.validationId ?? null;
  let validate: { status: number; body: Record<string, unknown> } | null = null;
  if (!validationId) {
    const v = await req.post("/api/courses/validate-package", {
      multipart: {
        orgSlug: opts.orgSlug,
        ...(opts.courseId ? { courseId: opts.courseId } : {}),
        ...(opts.courseId && opts.packageId ? { packageId: opts.packageId } : {}),
        file: zipFile(opts.name, opts.buffer),
      },
    });
    validate = { status: v.status(), body: (await v.json().catch(() => ({}))) as Record<string, unknown> };
    validationId = (validate.body.validation_id as string | null) ?? null;
    if (!v.ok() || !validationId) return { validate };
  }
  const zip = await JSZip.loadAsync(opts.buffer);
  const entries = Object.entries(zip.files).filter(([, e]) => !e.dir);
  const files = await Promise.all(entries.map(async ([p, e]) => ({ path: p, size: (await e.async("uint8array")).length })));
  const manifestName = ["cmi5.xml", "imsmanifest.xml", "tincan.xml"].find((n) => zip.file(n))!;
  const init = await req.post("/api/courses/upload/init", {
    data: {
      orgSlug: opts.orgSlug,
      courseId: opts.courseId,
      packageId: opts.packageId,
      language: opts.language,
      validation_id: validationId,
      acknowledge: opts.acknowledge ?? false,
      manifest: { fileName: manifestName, xml: await zip.file(manifestName)!.async("string") },
      files,
    },
  });
  const initBody = (await init.json().catch(() => ({}))) as Record<string, unknown>;
  if (!init.ok()) return { validate, init: { status: init.status(), body: initBody } };
  const versionId = initBody.versionId as string;
  if (opts.initOnly) return { validate, init: { status: init.status(), body: initBody }, versionId };
  const sign = await req.post("/api/courses/upload/sign", {
    data: { orgSlug: opts.orgSlug, versionId, files: files.map((f) => ({ path: f.path })) },
  });
  expect(sign.ok(), `sign → ${sign.status()}: ${await sign.text()}`).toBeTruthy();
  const signed = (await sign.json()) as { uploads: Array<{ path: string; url: string; headers: Record<string, string> }> };
  const source = opts.filesFrom ? await JSZip.loadAsync(opts.filesFrom) : zip;
  for (const u of signed.uploads) {
    const put = await req.put(u.url, { headers: u.headers, data: await source.file(u.path)!.async("nodebuffer") });
    expect(put.ok(), `PUT ${u.path} → ${put.status()}`).toBeTruthy();
  }
  const fin = await req.post("/api/courses/upload/finalize", {
    data: { orgSlug: opts.orgSlug, versionId, ...(opts.mode ? { mode: opts.mode } : {}) },
  });
  return {
    validate,
    init: { status: init.status(), body: initBody },
    versionId,
    finalize: { status: fin.status(), body: (await fin.json().catch(() => ({}))) as Record<string, unknown> },
  };
}

/** Exchange the attempt's newest fetch token for its cmi5 auth token. */
export async function authTokenFor(req: APIRequestContext, attemptId: string): Promise<string> {
  const { data: tok } = await svc()
    .from("cmi5_launch_tokens")
    .select("fetch_token")
    .eq("attempt_id", attemptId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  const res = await req.post(`/api/xapi/fetch?fetch_token=${(tok as { fetch_token: string }).fetch_token}`);
  expect(res.ok(), `xapi/fetch → ${res.status()}`).toBeTruthy();
  return (await res.json())["auth-token"] as string;
}

export async function inProgressAttempt(userId: string, versionId: string): Promise<string> {
  const { data } = await svc()
    .from("course_attempts")
    .select("id")
    .eq("user_id", userId)
    .eq("course_version_id", versionId)
    .eq("status", "in_progress")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  expect(data, `an in-progress attempt on ${versionId}`).toBeTruthy();
  return (data as { id: string }).id;
}

export async function attemptStatuses(userId: string, versionId: string): Promise<string[]> {
  const { data } = await svc()
    .from("course_attempts")
    .select("status")
    .eq("course_version_id", versionId)
    .eq("user_id", userId)
    .order("started_at", { ascending: true });
  return ((data ?? []) as Array<{ status: string }>).map((r) => r.status);
}

/**
 * GET without following redirects. A server redirect arrives either as a 3xx
 * Location or, once a loading boundary has streamed, as a redirect marker in
 * the 200 body; `redirectedTo` covers both.
 */
export async function getNoFollow(req: APIRequestContext, url: string) {
  const res = await req.get(url, { maxRedirects: 0 });
  const location = res.headers()["location"] ?? "";
  const body = res.status() === 200 ? await res.text() : "";
  return {
    status: res.status(),
    body,
    redirectedTo: (target: string) => location.includes(target) || body.includes(target),
  };
}
