# Course content storage — R2, direct uploads, streaming delivery

Course packages (SCORM 1.2, cmi5, xAPI: every file inside them, including
audio, video and images) live in **Cloudflare R2**. They get there **straight
from the admin's browser** with short-lived signed URLs, and reach learners
through the auth-gated content route, **streamed with range support and cached
at the Cloudflare edge**. The Worker never buffers a media byte in either
direction, so package size and file count are bounded by storage, not by
per-request limits (the 100 MB request body, 128 MB memory and 50/1,000
subrequest ceilings that broke uploads before).

Small public assets (thumbnails, logos, backgrounds, creatives) stay in the
Supabase Storage `public-assets` bucket; nothing changes there.

## The flow

```mermaid
sequenceDiagram
  participant A as Admin browser
  participant W as Worker (app)
  participant R as R2
  participant L as Learner browser
  A->>A: unzip package (JSZip)
  A->>W: POST /api/courses/validate-package (bundle: manifest + launch + text files + __package.json)
  W-->>A: validation report (pending row)
  A->>W: POST /api/courses/upload/init (validation_id, manifest xml, file list)
  W->>W: gate + quotas; course/package/version rows, upload_status=uploading
  W-->>A: version id + signing batch size
  loop per batch (R2: whole package; Supabase Storage: 32 files)
    A->>W: POST /api/courses/upload/sign (paths)
    W-->>A: signed PUT URLs (15 min)
    A->>R: PUT each file, 6 at a time, 3 attempts
  end
  A->>W: POST /api/courses/upload/finalize (versionId)
  W->>R: HEAD launch file, list prefix, read launch file (unit count)
  W->>W: upload_status=ready; package + course current_version_id → this version
  L->>W: GET /{org}/courses/{id}/content/{path} [Range]
  W->>R: GetObject (Range)
  W-->>L: 200 / 206 stream; whole files cached at the edge
```

A version is **never current until finalise succeeds**. An interrupted upload
leaves an `uploading` row that the nightly reaper deletes (files first) after
24 hours; the admin can also press Cancel (abort endpoint). The replace-package
and add-language dialogs use the same path.

**What the validator sees.** The browser sends a bundle: the manifest, the
launch file (up to 16 MB), every non-media file up to 3 MB each and 60 MB in
total, plus `__package.json` listing every file with its size. Size, file
count, executable/Flash detection and the size warning therefore cover the
whole package; media is checked by name and size. The report notes how many
files were skipped. The direct-upload gate binds the accepted report to the
package by standard + launch file and a 6-hour freshness window (there are no
zip bytes to re-hash on the server).

**Legacy path.** `POST /api/courses/upload` with a multipart zip still works
for API callers, tests and CI; it uploads through the Worker and is subject
to the old limits. The admin UI no longer uses it.

## Storage layout and drivers

`courses/{courseId}/{packageId}/v{n}/…` — one immutable folder per version.
Files are never overwritten or moved; rollback is a pointer change. Keys are
sanitised the same way on write and read (`lib/storage/keys.ts`).

`course_versions.storage_driver` (`supabase` | `r2`, migration 0077) records
where each version's files are. The content route reads each version from its
own driver, so a mixed estate during migration is normal and invisible to
learners. `STORAGE_DRIVER` on the Worker decides where **new** uploads go.

| Env var | Purpose |
| --- | --- |
| `STORAGE_DRIVER` | `r2` for new uploads (default `supabase`) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | R2 credentials (S3 API token with object read/write on that bucket) |
| `R2_ENDPOINT` | Optional S3-compatible endpoint override (local `scripts/dev-s3.mjs`, Supabase S3 gateway) |
| `SUPABASE_STORAGE_BUCKET` | Legacy bucket for `supabase` versions (default `course-content`) |

## Limits now

| Limit | Value | Where |
| --- | --- | --- |
| Files per package | 5,000 | `DIRECT_UPLOAD_LIMITS` |
| Package size | 2 GB (1 GB per file) | `DIRECT_UPLOAD_LIMITS` |
| Validation bundle | 60 MB of text files, 16 MB launch file | client bundle builder |
| Edge-cached whole files | up to 100 MB each, 1 year (immutable path) | content route |
| Signed upload URL life | 15 minutes | `DIRECT_UPLOAD_LIMITS` |
| Signing batch | R2: whole package (local signature); Supabase Storage: 32 per request, one network call each, kept under a free-plan Worker's 50 subrequests | `DIRECT_UPLOAD_LIMITS.signBatch` |
| Tenant storage quota | per plan, checked on declared bytes at init | `checkQuota` |

## Security

- Bucket is private; no public URLs. Every learner read passes the org and
  course checks in the content route before storage is touched, and the
  edge cache is consulted only after those checks.
- Signed PUT URLs are issued only to a signed-in org admin, bound to one exact
  key under the version's own prefix, with the content type in the signature,
  and expire in 15 minutes. They cannot list, read or delete.
- Declared sizes drive the quota check; finalise verifies the launch file and
  the object count from storage before anything becomes current. An admin
  under-declaring sizes only cheats their own tenant quota by the difference;
  R2 usage is billed on real bytes.
- Paths are rejected if they contain `..`, are absolute or have empty segments.
- The R2 bucket needs a CORS rule allowing `PUT` from the app origin(s); see
  Deployment.

## Backup and rollback

- **Content backup:** `.github/workflows/content-backup.yml` runs nightly at
  02:30 UTC and `rclone sync`s `courses/` from R2 to Backblaze B2 under
  `content/courses`, next to the database dumps. `--immutable` never
  overwrites an existing object, because version folders never change.
- **Restore a version's files:** copy `content/courses/{course}/{package}/v{n}/`
  from B2 back to R2 with `rclone copy` (or `aws s3 sync`); no database change
  is needed because the row still points at that prefix.
- **Roll a course back to an earlier version:** Library → course → Versions →
  **Make current** on any fully uploaded version. This repoints the language
  package (and the course) at that version; learners get it on their next
  launch; attempts already in progress keep the version they started on. The
  action is audit-logged (`course.version.activated`) and reversible the same
  way. API: `POST /api/courses/{courseId}/packages/{packageId}/versions/{versionId}/activate`.
- **Roll back the app:** Cloudflare Workers → Deployments → rollback, as before.

## Deployment (staging, then production)

1. Apply migration `0077_direct_uploads.sql` in the Supabase SQL editor.
   Nothing changes yet: existing versions read `storage_driver = 'supabase'`.
2. Create the R2 bucket (one per environment, e.g. `lms-content-staging`,
   `lms-content-prod`) and an S3 API token with **Object Read & Write** on it.
3. Put a CORS rule on the bucket (Cloudflare dashboard → R2 → bucket →
   Settings → CORS policy):
   ```json
   [{"AllowedOrigins":["https://my-lms.mentora.workers.dev"],
     "AllowedMethods":["PUT","GET","HEAD"],
     "AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]
   ```
   Use the production app origin for the production bucket (and the custom
   domain when one is added).
4. Worker secrets: `wrangler secret put R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY` (add `--env production` for prod). Vars in
   `wrangler.toml` `[vars]` / `[env.production.vars]`: `R2_ACCOUNT_ID`,
   `R2_BUCKET`. Keep `STORAGE_DRIVER = "supabase"` for the moment.
5. Deploy the release. Learner delivery now streams with range support and
   edge caching for both drivers; uploads still go to Supabase Storage.
6. Copy existing content: `node scripts/migrate-content-to-r2.mjs --dry-run`,
   then without `--dry-run`. Each version is flipped to `r2` only after every
   object is verified in R2. Re-runnable.
7. Set `STORAGE_DRIVER = "r2"` and redeploy. New uploads go straight to R2.
8. Add the four R2 secrets to GitHub Actions and enable the content backup
   workflow; run it once by hand and check the B2 size output.
9. After a week without incident, the Supabase `course-content` bucket can be
   emptied (keep the B2 copy).

Local development: `node scripts/dev-s3.mjs` starts an S3-compatible server
on port 9000 with CORS open; run the app with
`STORAGE_DRIVER=r2 R2_ENDPOINT=http://localhost:9000 R2_BUCKET=lms-content R2_ACCESS_KEY_ID=S3RVER R2_SECRET_ACCESS_KEY=S3RVER`.

## Tests

- `tests/bot/lifecycle/44-direct-upload.spec.ts` — the whole loop in a real
  browser: upload a 160-file media package through the admin UI (progress
  bar), validation report, publish, learner launch, content served with
  `206` on a range request and an edge-cache header, second version upload,
  **Make current** rollback to v1 and the learner seeing v1 again, and abort
  cleaning up. Needs an S3 endpoint the browser can reach (`scripts/dev-s3.mjs`
  locally, or the real R2 bucket on staging) and migration 0077.
- Adapter harness (presigned PUT, head, range, 416, list, delete) runs
  against `scripts/dev-s3.mjs`.
