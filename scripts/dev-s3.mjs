#!/usr/bin/env node
/**
 * Local S3-compatible server for developing/testing the R2 storage driver
 * without Cloudflare credentials. Uses s3rver (npm) with CORS open to the
 * dev server so browser-direct PUTs work exactly as they do against R2.
 *
 *   npm i -g s3rver      (or: npx s3rver)
 *   node scripts/dev-s3.mjs [--port 9000] [--bucket lms-content] [--dir .s3-local]
 *
 * Then run the app with:
 *   STORAGE_DRIVER=r2 R2_ENDPOINT=http://localhost:9000 R2_BUCKET=lms-content
 *   R2_ACCESS_KEY_ID=S3RVER R2_SECRET_ACCESS_KEY=S3RVER
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt("--port", 9000));
const bucket = opt("--bucket", "lms-content");
const dir = path.resolve(opt("--dir", ".s3-local"));
fs.mkdirSync(dir, { recursive: true });

let S3rver;
try {
  S3rver = createRequire(import.meta.url)("s3rver");
} catch {
  try {
    S3rver = createRequire(path.join(process.cwd(), "package.json"))("s3rver");
  } catch {
    console.error("s3rver is not installed. Run: npm i -D s3rver   (or npx s3rver)");
    process.exit(1);
  }
}

const cors = `<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
  </CORSRule>
</CORSConfiguration>`;

const server = new S3rver({
  port,
  address: "127.0.0.1",
  silent: true,
  directory: dir,
  allowMismatchedSignatures: true,
  configureBuckets: [{ name: bucket, configs: [cors] }],
});
await server.run();
console.log(`s3rver listening on http://127.0.0.1:${port}  bucket=${bucket}  dir=${dir}`);
