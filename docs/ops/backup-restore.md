# Restoring from a nightly backup

The `Nightly Supabase backup` workflow (`.github/workflows/backup.yml`)
runs at 02:00 UTC daily and produces:

- **B2 `daily/lms-prod-YYYY-MM-DDTHH-MM-SSZ.sql.gz.asc`** — durable, kept until you delete (or until a B2 Lifecycle Rule expires it).
- **B2 `latest/lms-prod.sql.gz.asc`** — stable pointer to the most recent successful dump. Restore tooling can hit this without knowing the timestamp.

Every dump is GPG-encrypted to the `BACKUP_GPG_PUBKEY` secret: without a usable key the workflow fails and uploads nothing, so it never uploads plaintext. Objects ending in plain `.sql.gz` predate that rule and are plaintext. Nothing is published as a GitHub artifact: the repository is public, so any signed-in GitHub user could download one.

The dump bucket must stay private: never make it public, never put a public URL in front of it, and never monitor it through one. Check freshness with the workflow's failure email or an authenticated `aws s3 ls "s3://${B2_BUCKET}/daily/" --endpoint-url "${B2_ENDPOINT}"`.

---

## Scenario 1 — Restore to a fresh Supabase project

This is what you'd do after, say, accidentally dropping a critical table on prod and needing to roll back. **The destination project must be empty** (Supabase's "Database" page should show no user tables in `public`).

### Step 1: Fetch the backup

**From Backblaze B2** (recommended for full integrity):

```bash
# Configure AWS CLI for B2 (one-time):
aws configure set aws_access_key_id "<B2_KEY_ID>"
aws configure set aws_secret_access_key "<B2_APPLICATION_KEY>"
aws configure set region "<B2_REGION>"        # e.g. us-west-002

B2_REGION="us-west-002"                       # match the value above
B2_ENDPOINT="https://s3.${B2_REGION}.backblazeb2.com"
B2_BUCKET="lms-backups"

# Latest:
aws s3 cp "s3://${B2_BUCKET}/latest/lms-prod.sql.gz.asc" ./latest.sql.gz.asc \
    --endpoint-url "${B2_ENDPOINT}"

# Or specific date:
aws s3 cp "s3://${B2_BUCKET}/daily/lms-prod-2026-05-28T02-00-00Z.sql.gz.asc" ./backup.sql.gz.asc \
    --endpoint-url "${B2_ENDPOINT}"
```

### Step 2: Decrypt (every `.asc` dump)

You need the GPG private key matching the public key used during backup. Stored in your password manager / hardware key — **without it the backup is permanently unreadable.**

```bash
gpg --decrypt latest.sql.gz.asc > latest.sql.gz
```

### Step 3: Decompress

```bash
gunzip latest.sql.gz   # produces latest.sql
```

### Step 4: Apply to the target database

Get the destination project's connection string from Supabase → Project Settings → Database → URI → "Direct connection".

```bash
DEST="postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres"
psql "${DEST}" < latest.sql
```

The dump uses `--clean --if-exists`, so it'll DROP existing tables before re-creating. **Make sure you targeted the right project.**

### Step 5: Verify

```sql
-- Should match production row counts (approximately):
SELECT
  (SELECT COUNT(*) FROM organizations) AS orgs,
  (SELECT COUNT(*) FROM profiles)      AS profiles,
  (SELECT COUNT(*) FROM courses)       AS courses,
  (SELECT COUNT(*) FROM course_attempts) AS attempts;
```

### Step 6: Point the prod Worker at the new project

If you restored to a different Supabase project (not the original), update these GitHub Secrets:

- `PROD_NEXT_PUBLIC_SUPABASE_URL`
- `PROD_NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `PROD_DATABASE_URL` (the backup workflow itself)

No changes needed to the B2 secrets — they reference the bucket, not the source database.

Then trigger **Deploy to production** workflow to rebuild the Worker with the new Supabase URL baked in.

---

## Scenario 2 — Restore a single table

Sometimes you don't need a full restore — just one table you accidentally truncated. Extract it from the dump:

```bash
# Show me the courses INSERT statements:
grep -A1 "^INSERT INTO public.courses" latest.sql | head -100

# Or extract the whole courses section into its own file:
awk '/^-- Data for Name: courses;/,/^--$/' latest.sql > courses-only.sql

# Apply selectively:
psql "${DEST}" < courses-only.sql
```

For tables with foreign-key dependencies, you may need to disable triggers temporarily (`SET session_replication_role = replica;`).

---

## Scenario 3 — Point-in-time recovery

Plain `pg_dump` backups are **daily snapshots**, not point-in-time. If you need recovery between snapshots (e.g. "restore to 14:32 yesterday"), upgrade to **Supabase Pro plan** which includes daily PITR backups via WAL streaming. The nightly dump remains as an off-site secondary.

---

## Operational notes

- **The workflow uses `pg_dump --format=plain`.** Sufficient for normal restore. If you'd prefer parallel restore for very large dumps, switch to `--format=directory --jobs=4` and use `pg_restore` instead. The plaintext format is more portable and human-inspectable for ad-hoc fixes.

- **Lifecycle rules.** Set a retention policy on the B2 bucket: B2 dashboard → Buckets → `lms-backups` → Lifecycle Settings. Typical: keep `daily/*` for 30 days (B2 auto-deletes older versions), keep `latest/*` forever. B2's free 10GB tier covers ~100 days of 100MB dumps.

- **First-run validation.** After setting up the workflow, manually trigger it once (Actions → Nightly Supabase backup → Run workflow). Confirm:
  - B2 has both `daily/<stamp>.sql.gz.asc` and `latest/lms-prod.sql.gz.asc` objects
  - `gpg --decrypt` + `gunzip` + `psql` against a test Supabase project successfully restores it

- **The dump excludes ownership/grant statements** (`--no-owner --no-privileges`) so it's portable across Supabase projects with different role names. RLS policies, sequences, indexes, foreign keys, and triggers are preserved.

- **Auth users.** Supabase manages `auth.users` separately. `pg_dump` against the default `postgres` user can capture the `auth` schema — verify after first restore that user logins still work. If `auth.users` isn't included, you may need to use the Supabase Management API to export/import it separately.

---

## When backups fail

GitHub will email repo admins on failed workflow runs. Common causes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `::error title=backup failed::pg_dump failed` (the public log never shows pg_dump's own message, which can contain parts of the URL) | Wrong PROD_DATABASE_URL secret, or the pooler is unreachable | Run `pg_dump` with the same URL from your own machine to read the error, then fix the secret (session pooler URI, see the header of `backup.yml`) |
| `::error title=backup not encrypted::...` | `BACKUP_GPG_PUBKEY` is unset, not an armored public key, or expired | Set or re-export it (`gpg --armor --export <fingerprint>`); nothing was uploaded that night |
| `aws: An error occurred (InvalidAccessKeyId)` | B2 Application Key revoked or scope mismatch | Regenerate at B2 → App Keys → Add a New Application Key with **Read and Write** caps on the backup bucket |
| Cron didn't run at all | GitHub disables scheduled workflows after 60 days of repo inactivity | Make any commit, or manually `workflow_dispatch` |

If two consecutive nightly runs fail, treat it as P1: the backup window is your recovery guarantee.
