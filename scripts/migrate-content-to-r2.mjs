#!/usr/bin/env node
/**
 * Copy course content from Supabase Storage to Cloudflare R2, one version at
 * a time, and flip each version's storage_driver once its files are verified.
 * Safe to re-run: objects already in R2 with the same size are skipped, and a
 * version is only flipped after every object under its prefix is present.
 *
 *   node scripts/migrate-content-to-r2.mjs [--dry-run] [--course <id>] [--concurrency 8]
 *
 * Env (same names the app uses):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET (default course-content)
 *   R2_ACCOUNT_ID | R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *
 * Order of operations for a live environment:
 *   1. Apply migration 0077 (adds storage_driver, default 'supabase').
 *   2. Run this script (reads from Supabase, writes to R2, flips rows).
 *   3. Set STORAGE_DRIVER=r2 on the Worker so NEW uploads go to R2.
 *   Learners are never affected: each version is read from its own driver.
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { S3Client, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const onlyCourse = args.includes("--course") ? args[args.indexOf("--course") + 1] : null;
const CONC = Number(args.includes("--concurrency") ? args[args.indexOf("--concurrency") + 1] : 8);

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(1); } return v; };
const SUPA = need("NEXT_PUBLIC_SUPABASE_URL"), SVC = need("SUPABASE_SERVICE_ROLE_KEY");
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "course-content";
const R2_BUCKET = need("R2_BUCKET");
const endpoint = process.env.R2_ENDPOINT?.trim() || `https://${need("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;

const supa = createClient(SUPA, SVC, { auth: { persistSession: false } });
const s3 = new S3Client({
  region: "auto",
  endpoint,
  forcePathStyle: !!process.env.R2_ENDPOINT,
  credentials: { accessKeyId: need("R2_ACCESS_KEY_ID"), secretAccessKey: need("R2_SECRET_ACCESS_KEY") },
});

async function listSupabase(prefix) {
  const out = [];
  const stack = [prefix.replace(/\/$/, "")];
  while (stack.length) {
    const folder = stack.pop();
    let offset = 0;
    for (;;) {
      const { data, error } = await supa.storage.from(BUCKET).list(folder, { limit: 1000, offset });
      if (error) throw new Error(`list ${folder}: ${error.message}`);
      for (const e of data ?? []) {
        const p = `${folder}/${e.name}`;
        if (e.id === null || e.metadata === null) stack.push(p);
        else out.push({ key: p, size: Number(e.metadata?.size ?? 0), type: e.metadata?.mimetype ?? undefined });
      }
      if ((data ?? []).length < 1000) break;
      offset += 1000;
    }
  }
  return out;
}

async function r2Head(key) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { size: r.ContentLength ?? 0 };
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return null;
    throw e;
  }
}

async function copyOne(obj) {
  const existing = await r2Head(obj.key);
  if (existing && existing.size === obj.size) return "skipped";
  if (DRY) return "would-copy";
  const { data, error } = await supa.storage.from(BUCKET).download(obj.key);
  if (error || !data) throw new Error(`download ${obj.key}: ${error?.message}`);
  const body = Buffer.from(await data.arrayBuffer());
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: obj.key, Body: body, ContentType: obj.type }));
  return "copied";
}

async function mapConcurrent(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const { data: versions, error } = await supa
  .from("course_versions")
  .select("id, course_id, version_number, storage_prefix, storage_driver, upload_status, file_count")
  .eq("storage_driver", "supabase")
  .order("uploaded_at", { ascending: true });
if (error) { console.error(error.message); process.exit(1); }

let total = { versions: 0, copied: 0, skipped: 0, bytes: 0, flipped: 0 };
for (const v of versions ?? []) {
  if (onlyCourse && v.course_id !== onlyCourse) continue;
  if (v.upload_status && v.upload_status !== "ready") { console.log(`- ${v.id} v${v.version_number}: ${v.upload_status}, skipped`); continue; }
  const objs = await listSupabase(v.storage_prefix);
  if (objs.length === 0) { console.log(`- ${v.id} v${v.version_number}: no objects in Supabase, left as is`); continue; }
  const results = await mapConcurrent(objs, CONC, copyOne);
  const copied = results.filter((r) => r === "copied" || r === "would-copy").length;
  const skipped = results.filter((r) => r === "skipped").length;
  const bytes = objs.reduce((a, o) => a + o.size, 0);
  // Verify every object before flipping the row.
  const missing = [];
  if (!DRY) for (const o of objs) { const h = await r2Head(o.key); if (!h || h.size !== o.size) missing.push(o.key); }
  if (missing.length) {
    console.log(`! ${v.id} v${v.version_number}: ${missing.length} object(s) missing in R2 after copy, NOT flipped (e.g. ${missing[0]})`);
    continue;
  }
  if (!DRY) {
    const { error: upErr } = await supa.from("course_versions").update({ storage_driver: "r2" }).eq("id", v.id);
    if (upErr) { console.log(`! ${v.id}: flip failed: ${upErr.message}`); continue; }
    total.flipped++;
  }
  total.versions++; total.copied += copied; total.skipped += skipped; total.bytes += bytes;
  console.log(`${DRY ? "~" : "✓"} ${v.id} v${v.version_number}: ${objs.length} files, ${(bytes / 1048576).toFixed(1)} MB, ${copied} copied, ${skipped} already there${DRY ? "" : ", driver=r2"}`);
}
console.log(`\n${DRY ? "DRY RUN — " : ""}versions: ${total.versions}, copied: ${total.copied}, skipped: ${total.skipped}, ${(total.bytes / 1048576).toFixed(1)} MB, flipped: ${total.flipped}`);
