# Restoring from a nightly backup

The `Nightly Supabase backup` workflow (`.github/workflows/backup.yml`)
runs at 02:00 UTC daily and produces:

- **B2 `daily/lms-prod-YYYY-MM-DDTHH-MM-SSZ.sql.gz[.asc]`** — durable, kept until you delete (or until a B2 Lifecycle Rule expires it).
- **B2 `latest/lms-prod.sql.gz[.asc]`** — stable pointer to the most recent successful dump. Restore tooling can hit this without knowing the timestamp.
- **GitHub artifact `lms-prod-backup-<stamp>`** — quick-grab hot copy, retained 7 days. Useful when you don't have R2 credentials handy.

The `.asc` suffix means the dump was GPG-encrypted (because the `BACKUP_GPG_PUBKEY` secret was set when it ran). If it ends in `.sql.gz`, it's plaintext.

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
aws s3 cp "s3://${B2_BUCKET}/latest/lms-prod.sql.gz" ./latest.sql.gz \
    --endpoint-url "${B2_ENDPOINT}"

# Or specific date:
aws s3 cp "s3://${B2_BUCKET}/daily/lms-prod-2026-05-28T02-00-00Z.sql.gz" ./backup.sql.gz \
    --endpoint-url "${B2_ENDPOINT}"
```

**From GitHub artifact** (faster if it's <7 days old):

1. GitHub repo → **Actions** → **Nightly Supabase backup** → pick the run
2. Scroll to **Artifacts** → click `lms-prod-backup-<stamp>` to download a zip
3. Unzip it.

### Step 2: Decrypt (only if `.asc`)

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
  - B2 has both `daily/<stamp>` and `latest/<stamp-stripped>` objects
  - GitHub artifact is downloadable
  - `gunzip` + `psql` against a test Supabase project successfully restores it

- **The dump excludes ownership/grant statements** (`--no-owner --no-privileges`) so it's portable across Supabase projects with different role names. RLS policies, sequences, indexes, foreign keys, and triggers are preserved.

- **Auth users.** Supabase manages `auth.users` separately. `pg_dump` against the default `postgres` user can capture the `auth` schema — verify after first restore that user logins still work. If `auth.users` isn't included, you may need to use the Supabase Management API to export/import it separately.

---

## When backups fail

GitHub will email repo admins on failed workflow runs. Common causes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `pg_dump: error: connection to server ... failed` | Wrong PROD_DATABASE_URL secret (probably pooled URL instead of direct) | Set PROD_DATABASE_URL to the **Direct connection** string from Supabase dashboard |
| `aws: An error occurred (InvalidAccessKeyId)` | B2 Application Key revoked or scope mismatch | Regenerate at B2 → App Keys → Add a New Application Key with **Read and Write** caps on the backup bucket |
| `gpg: encryption failed: Unusable public key` | Pubkey in secret is malformed or expired | Re-export and re-paste: `gpg --armor --export your@email.com` |
| Cron didn't run at all | GitHub disables scheduled workflows after 60 days of repo inactivity | Make any commit, or manually `workflow_dispatch` |

If two consecutive nightly runs fail, treat it as P1: the backup window is your recovery guarantee.
