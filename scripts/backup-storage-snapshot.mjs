#!/usr/bin/env node
/**
 * Snapshot of course packages in Supabase Storage, optionally copied to Backblaze B2.
 *
 * WHY: production stores course packages in Supabase Storage (STORAGE_DRIVER=supabase).
 * The nightly pg_dump (backup.yml) does not contain storage objects, and content-backup.yml
 * copies the R2 bucket, which production does not use. Until a scheduled backup from the
 * right source exists, this script is the backup. See docs/adr (record protection).
 *
 * SAFETY
 *  - Supabase: READ ONLY. It lists and downloads objects and reads course_versions. It never
 *    uploads, moves or deletes anything in Supabase.
 *  - B2: writes only under  storage-snapshots/<env>/<stamp>/  and never deletes. Re-runs
 *    with --resume skip objects already present with the same size.
 *  - B2 cost: existence checks and verification use paged bucket listings (Class C, 1,000 keys
 *    per call), not one HEAD per object (Class B). The free tier allows 2,500 Class B calls a
 *    day, fewer than one snapshot has objects; per-object HEADs are only a fallback when the
 *    endpoint cannot list. Only the three-object restore drill downloads (Class B).
 *  - Refuses to run unless SUPABASE_URL belongs to the project named by SNAPSHOT_ENV.
 *  - Never prints keys.
 *
 * USAGE (Git Bash, from the repo root)
 *   node --env-file=/d/LMS/backup-prod.env scripts/backup-storage-snapshot.mjs
 *   node --env-file=/d/LMS/backup-prod.env scripts/backup-storage-snapshot.mjs --resume 20261015T101500Z
 *   ... --skip-b2      local snapshot only
 *
 * ENV FILE (keep it outside the repo; never commit it)
 *   SNAPSHOT_ENV=prod                       # or staging
 *   SUPABASE_URL=https://<ref>.supabase.co  # NEXT_PUBLIC_SUPABASE_URL is also accepted
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   SNAPSHOT_BUCKETS=course-content         # comma list; add public-assets for logos/avatars
 *   SNAPSHOT_DIR=D:/LMS/backups/storage     # local copy root
 *   B2_BUCKET=...  B2_REGION=...  B2_KEY_ID=...  B2_APPLICATION_KEY=...
 *   B2_ENDPOINT=                            # optional override (default https://s3.<region>.backblazeb2.com)
 *
 * OUTPUT  <SNAPSHOT_DIR>/<env>/<stamp>/
 *   files/<bucket>/<key>     every object, byte for byte
 *   manifest.ndjson          one line per object: bucket, key, size, sha256, contentType, updated
 *   versions.json            course_versions rows (id, course, package, version, storage_prefix, driver, status)
 *   summary.json             counts, bytes, errors, versions with no stored files, B2 verification
 */
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROJECTS = { staging: "zeaclbapadosqqttexxh", prod: "alkfrcglmseksweqhwzq" };
const CONCURRENCY = 6;
const RETRIES = 3;

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

// No process.exit(): on Windows, Node 24 can abort with a libuv assertion (UV_HANDLE_CLOSING)
// when it exits while HTTP keep-alive sockets close. A STOP throws; the handler prints it and sets
// the exit code, and the process ends on its own.
class Stop extends Error {}
process.on("uncaughtException", (e) => {
  console.error(e instanceof Stop ? `\nSTOP: ${e.message}` : `\nSTOP: unexpected error: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
function fail(msg) { throw new Stop(msg); }
// Backblaze refuses calls above the account's daily cap (Caps & Alerts) with "... cap exceeded".
const isCapError = (e) => /cap exceeded/i.test(String(e?.message ?? e));
const CAP_HELP = "Backblaze daily free limit reached (B2 > Caps & Alerts). The files on this PC are kept. Re-run after 00:00 UTC with --resume and the same stamp: nothing is downloaded again and only missing files are uploaded.";
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(label, fn) {
  let last;
  for (let i = 1; i <= RETRIES; i++) {
    try { return await fn(); } catch (e) { last = e; if (isCapError(e)) break; if (i < RETRIES) await sleep(1000 * i * i); }
  }
  throw new Error(`${label}: ${last?.message ?? last}`);
}
async function pool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  });
  await Promise.all(workers);
}

// ---- configuration and guards --------------------------------------------------------------
const placeholders = Object.entries(process.env).filter(([k, v]) => /^(SNAPSHOT_|SUPABASE_|NEXT_PUBLIC_SUPABASE_URL|B2_)/.test(k) && /PASTE_/.test(v ?? "")).map(([k]) => k);
if (placeholders.length) fail(`fill in the env file first; still placeholders: ${placeholders.join(", ")}`);
const env = (process.env.SNAPSHOT_ENV ?? "").trim();
if (!PROJECTS[env]) fail(`SNAPSHOT_ENV must be one of: ${Object.keys(PROJECTS).join(", ")}`);
const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
let host = "";
try { host = new URL(url).host; } catch { fail("SUPABASE_URL is missing or not a URL"); }
if (host !== `${PROJECTS[env]}.supabase.co`) fail(`SUPABASE_URL (${host}) does not belong to the ${env} project`);
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (!key) fail("SUPABASE_SERVICE_ROLE_KEY is missing");
// Storage lists come back EMPTY (not an error) for a key without service rights, so refuse
// anything that is not the service-role / secret key before listing.
if (key.startsWith("sb_publishable_")) fail("SUPABASE_SERVICE_ROLE_KEY holds the publishable (anon) key; use the secret / service_role key (Project Settings -> API keys)");
if (key.startsWith("eyJ")) {
  let role = null;
  try { role = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")).role ?? null; } catch {}
  if (role !== "service_role") fail(`SUPABASE_SERVICE_ROLE_KEY is a JWT for role "${role ?? "unknown"}", not service_role; use the service_role key`);
}
const buckets = (process.env.SNAPSHOT_BUCKETS ?? "course-content").split(",").map((s) => s.trim()).filter(Boolean);
const root = process.env.SNAPSHOT_DIR ?? "D:/LMS/backups/storage";
const stamp = opt("--resume") ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
if (!/^\d{8}T\d{6}Z$/.test(stamp)) fail(`bad --resume stamp ${stamp}`);
const outDir = path.join(root, env, stamp);
const filesDir = path.join(outDir, "files");
const b2Wanted = !flag("--skip-b2");
const b2 = {
  bucket: process.env.B2_BUCKET, region: process.env.B2_REGION,
  keyId: process.env.B2_KEY_ID, appKey: process.env.B2_APPLICATION_KEY,
  endpoint: process.env.B2_ENDPOINT || (process.env.B2_REGION ? `https://s3.${process.env.B2_REGION}.backblazeb2.com` : undefined),
};
if (b2Wanted && !(b2.bucket && b2.region && b2.keyId && b2.appKey)) fail("B2_BUCKET, B2_REGION, B2_KEY_ID and B2_APPLICATION_KEY are required (or pass --skip-b2)");
const b2Prefix = `storage-snapshots/${env}/${stamp}/`;

console.log(`Snapshot  env=${env}  project=${PROJECTS[env]}  buckets=${buckets.join(",")}`);
console.log(`Local     ${outDir}`);
console.log(`B2        ${b2Wanted ? `s3://${b2.bucket}/${b2Prefix}` : "skipped"}`);
fs.mkdirSync(filesDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ env, stamp, ok: false, status: "running", startedAt: new Date().toISOString() }, null, 1));

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ---- 1. list every object (recursive, paginated) ------------------------------------------
async function listAll(bucket, prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await retry(`list ${bucket}/${prefix}`, async () => {
      const r = await sb.storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      if (r.error) throw r.error;
      return r;
    });
    if (error) throw error;
    for (const e of data) {
      const k = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) out.push(...(await listAll(bucket, k)));
      else out.push({ bucket, key: k, size: e.metadata?.size ?? null, contentType: e.metadata?.mimetype ?? null, updated: e.updated_at ?? e.created_at ?? null });
    }
    if (data.length < 1000) break;
  }
  return out;
}

const objects = [];
const emptyBuckets = [];
for (const b of buckets) {
  let list;
  try { list = await listAll(b); }
  catch (e) { fail(`could not list bucket "${b}": ${e.message ?? e}. Check SNAPSHOT_BUCKETS and the key. Nothing was copied.`); }
  console.log(`Listed    ${b}: ${list.length} objects`);
  if (list.length === 0) {
    // Storage answers an empty list (no error) both for a missing bucket and for a key without
    // service rights; the bucket list tells the two apart.
    const { data: all, error: bErr } = await sb.storage.listBuckets();
    const names = (all ?? []).map((x) => x.name);
    if (bErr || names.length === 0) fail(`bucket "${b}" listed 0 objects and no bucket is visible to this key${bErr ? ` (${bErr.message})` : ""}: the key has no service rights. Nothing was copied.`);
    if (!names.includes(b)) fail(`bucket "${b}" does not exist in this project. Buckets here: ${names.join(", ")}. Set SNAPSHOT_BUCKETS to the right names. Nothing was copied.`);
    // The key sees the buckets, so this is a genuinely empty bucket (production had no course
    // packages on 2026-10-17): note it and copy the others. Ready versions without files are
    // still reported from course_versions below.
    console.log(`NOTE      bucket "${b}" exists and is empty; nothing to copy from it.`);
    emptyBuckets.push(b);
  }
  objects.push(...list);
}
if (objects.length === 0) fail(`every bucket is empty (${buckets.join(", ")}): nothing to back up.`);

// ---- 2. download + hash -------------------------------------------------------------------
const manifestPath = path.join(outDir, "manifest.ndjson");
const done = new Map();
if (fs.existsSync(manifestPath)) {
  for (const line of fs.readFileSync(manifestPath, "utf8").split("\n").filter(Boolean)) {
    const m = JSON.parse(line); done.set(`${m.bucket}/${m.key}`, m);
  }
}
const manifest = fs.createWriteStream(manifestPath, { flags: "a" });
const errors = [];
let downloaded = 0, bytes = 0;
await pool(objects, CONCURRENCY, async (o) => {
  const id = `${o.bucket}/${o.key}`;
  const local = path.join(filesDir, o.bucket, ...o.key.split("/"));
  const prev = done.get(id);
  if (prev && fs.existsSync(local) && fs.statSync(local).size === prev.size) { o.sha256 = prev.sha256; o.size = prev.size; bytes += prev.size; return; }
  try {
    const buf = await retry(`download ${id}`, async () => {
      const { data, error } = await sb.storage.from(o.bucket).download(o.key);
      if (error) throw error;
      return Buffer.from(await data.arrayBuffer());
    });
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, buf);
    o.size = buf.length; o.sha256 = sha256(buf);
    manifest.write(JSON.stringify({ bucket: o.bucket, key: o.key, size: o.size, sha256: o.sha256, contentType: o.contentType, updated: o.updated }) + "\n");
    done.set(id, o);
    downloaded++; bytes += o.size;
    if (downloaded % 200 === 0) console.log(`  downloaded ${downloaded}`);
  } catch (e) { errors.push({ stage: "download", id, error: String(e.message ?? e) }); }
});
await new Promise((r) => manifest.end(r));
console.log(`Downloaded ${downloaded} new, ${objects.length - errors.length} total present, ${(bytes / 1048576).toFixed(1)} MB, errors ${errors.length}`);

// ---- 3. course_versions (read-only) for mapping folders back to versions -------------------
const versions = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("course_versions")
    .select("*") // production may predate 0077 (no storage_driver / upload_status): never name optional columns
    .order("id").range(from, from + 999);
  if (error) { errors.push({ stage: "versions", error: error.message }); break; }
  versions.push(...data.map((v) => ({
    id: v.id, course_id: v.course_id, package_id: v.package_id ?? null, version_number: v.version_number,
    storage_prefix: v.storage_prefix, storage_driver: v.storage_driver ?? "supabase", upload_status: v.upload_status ?? "ready",
    manifest_type: v.manifest_type, launch_url: v.launch_url, uploaded_at: v.uploaded_at, size_bytes: v.size_bytes ?? null,
  })));
  if (data.length < 1000) break;
}
fs.writeFileSync(path.join(outDir, "versions.json"), JSON.stringify(versions, null, 1));
const keysByPrefix = (p) => objects.some((o) => o.bucket === "course-content" && o.key.startsWith(p));
const versionsWithoutFiles = buckets.includes("course-content")
  ? versions.filter((v) => (v.storage_driver ?? "supabase") === "supabase" && v.upload_status === "ready" && !keysByPrefix(v.storage_prefix)).map((v) => ({ id: v.id, storage_prefix: v.storage_prefix }))
  : [];
const drivers = versions.reduce((m, v) => { const d = v.storage_driver ?? "supabase"; m[d] = (m[d] ?? 0) + 1; return m; }, {});

// ---- 4. copy to B2 + verify (paged listing; HEAD per object only as a fallback) -------------
const b2Report = { enabled: b2Wanted };
const s3 = b2Wanted
  ? new S3Client({ region: b2.region, endpoint: b2.endpoint, forcePathStyle: true, credentials: { accessKeyId: b2.keyId, secretAccessKey: b2.appKey } })
  : null;
async function headSize(k) {
  try { return (await s3.send(new HeadObjectCommand({ Bucket: b2.bucket, Key: k }))).ContentLength ?? null; }
  catch (e) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound" || e?.name === "NoSuchKey") return null; throw e; }
}
// Sizes of the objects already under this snapshot's prefix (key -> size).
async function b2Sizes(keys) {
  try {
    const sizes = new Map();
    let token;
    do {
      const r = await retry("b2 list", () => s3.send(new ListObjectsV2Command({ Bucket: b2.bucket, Prefix: b2Prefix, ContinuationToken: token, MaxKeys: 1000 })));
      for (const o of r.Contents ?? []) sizes.set(o.Key, o.Size ?? null);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return sizes;
  } catch (e) {
    if (isCapError(e)) throw e;
    console.log(`B2        listing unavailable (${e.message ?? e}); checking ${keys.length} objects one by one`);
    const sizes = new Map();
    await pool(keys, CONCURRENCY, async (k) => { sizes.set(k, await retry(`b2 head ${k}`, () => headSize(k))); });
    return sizes;
  }
}
if (b2Wanted) {
  try {
    const toUpload = objects.filter((o) => o.sha256);
    const keyOf = (o) => `${b2Prefix}files/${o.bucket}/${o.key}`;
    // A fresh stamp is a new prefix, so nothing can be there yet: only --resume checks.
    const present = opt("--resume") ? await b2Sizes(toUpload.map(keyOf)) : new Map();
    let uploaded = 0, skipped = 0;
    await pool(toUpload, CONCURRENCY, async (o) => {
      const k = keyOf(o);
      if (present.get(k) === o.size) { skipped++; return; }
      try {
        const body = fs.readFileSync(path.join(filesDir, o.bucket, ...o.key.split("/")));
        await retry(`b2 put ${k}`, () => s3.send(new PutObjectCommand({ Bucket: b2.bucket, Key: k, Body: body, ContentType: o.contentType ?? undefined, Metadata: { sha256: o.sha256 } })));
        uploaded++;
        if (uploaded % 200 === 0) console.log(`  uploaded ${uploaded}`);
      } catch (e) { errors.push({ stage: "b2-put", id: k, error: String(e.message ?? e) }); }
    });
    for (const f of ["manifest.ndjson", "versions.json"]) {
      await retry(`b2 put ${f}`, () => s3.send(new PutObjectCommand({ Bucket: b2.bucket, Key: `${b2Prefix}${f}`, Body: fs.readFileSync(path.join(outDir, f)) })));
    }
    // verify: every object present in B2 with the right size, then a restore drill on three objects
    const after = await b2Sizes(toUpload.map(keyOf));
    const missing = toUpload.filter((o) => after.get(keyOf(o)) !== o.size).map((o) => `${o.bucket}/${o.key}`);
    const sorted = [...toUpload].sort((a, b) => (a.key < b.key ? -1 : 1));
    const drill = [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]].filter(Boolean);
    const drillResults = [];
    for (const o of drill) {
      const r = await retry("b2 get", () => s3.send(new GetObjectCommand({ Bucket: b2.bucket, Key: keyOf(o) })));
      const got = sha256(Buffer.from(await r.Body.transformToByteArray()));
      drillResults.push({ key: `${o.bucket}/${o.key}`, ok: got === o.sha256 });
    }
    Object.assign(b2Report, { bucket: b2.bucket, prefix: b2Prefix, uploaded, skipped, verified: toUpload.length - missing.length, missingOrWrongSize: missing.length, missingSample: missing.slice(0, 10), restoreDrill: drillResults });
    console.log(`B2        uploaded ${uploaded}, already there ${skipped}, verified ${toUpload.length - missing.length}/${toUpload.length}, drill ${drillResults.length && drillResults.every((d) => d.ok) ? "OK" : "FAILED"}`);
  } catch (e) {
    errors.push({ stage: "b2", error: String(e.message ?? e) });
    Object.assign(b2Report, { failed: true, capExceeded: isCapError(e), missingOrWrongSize: -1, restoreDrill: [] });
    console.log(`B2        FAILED: ${e.message ?? e}`);
    if (isCapError(e)) console.log(`          ${CAP_HELP}`);
  }
}

// ---- 5. summary -----------------------------------------------------------------------------
const summary = {
  status: "finished", env, project: PROJECTS[env], stamp, buckets, emptyBuckets, local: outDir,
  objectsListed: objects.length, objectsSaved: objects.filter((o) => o.sha256).length, bytes,
  versions: versions.length, versionsByDriver: drivers,
  versionsReadyWithoutFiles: versionsWithoutFiles.length, versionsReadyWithoutFilesSample: versionsWithoutFiles.slice(0, 20),
  b2: b2Report, errors,
  ok: errors.length === 0 && objects.every((o) => o.sha256) && (!b2Wanted || (b2Report.missingOrWrongSize === 0 && b2Report.restoreDrill.length > 0 && b2Report.restoreDrill.every((d) => d.ok))),
};
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
if (b2Wanted && !b2Report.failed) {
  await retry("b2 put summary", () => s3.send(new PutObjectCommand({ Bucket: b2.bucket, Key: `${b2Prefix}summary.json`, Body: fs.readFileSync(path.join(outDir, "summary.json")) })))
    .catch((e) => console.log(`B2        summary upload failed: ${e.message ?? e}`));
}
if (drivers.r2) console.log(`NOTE      ${drivers.r2} version(s) use the R2 driver; their files are not in Supabase Storage and need the R2 backup.`);
if (versionsWithoutFiles.length) console.log(`NOTE      ${versionsWithoutFiles.length} ready version(s) have no stored files (see summary.json).`);
console.log(summary.ok ? `\nRESULT    OK — snapshot ${stamp} complete` : `\nRESULT    INCOMPLETE — ${errors.length} error(s); re-run with --resume ${stamp}`);
process.exitCode = summary.ok ? 0 : 2;
