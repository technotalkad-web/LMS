# Migration rehearsal (v1.3.0)

The free local copy the owner chose on 2026-10-18 for the v1.3.0 practice run (`docs/release/v1.3.0.md` §7). It replays the repository's migrations on an embedded Postgres ([PGlite](https://pglite.dev) 0.5.10, Postgres 18.6) with a small Supabase shim and synthetic rows, runs `ops/release-v1.3.0-audit.sql` before and after the sitting exactly as the owner will paste it, and compares every result with `expectations.json`.

No network database, no credentials, no production or staging data. Nothing is written inside the repository.

## Run it

```bash
node scripts/migration-rehearsal/run.mjs                  # every scenario
node scripts/migration-rehearsal/run.mjs prod gap         # some scenarios
node scripts/migration-rehearsal/run.mjs --verbose        # also print each audit grid (synthetic rows)
```

PGlite is not a project dependency (`package.json` is not changed for it):

- `PGLITE_DIR=<folder>` uses an existing install: an `npm install --prefix <folder>` folder, or the package folder itself.
- Without `PGLITE_DIR`, the runner installs `@electric-sql/pglite@0.5.10` once into `<system temp>/lms-migration-rehearsal-pglite-0.5.10` with `npm --prefix` (`--ignore-scripts`, no lock file) and reuses it afterwards. It never installs into the repository's `node_modules`.

The runner needs only Node (CI uses Node 22; the local runs used Node 24). It prints, for each scenario, every migration file applied (and re-applied where the sitting pastes it twice), and for each audit run the expected and actual value of each named check, the exact set of `MISMATCH` rows for that moment, `Z90`, and the read-only proof. The last line is `RESULT: PASS` or `RESULT: FAIL`. Exit code 0 = every check passed, 1 = a check failed, 2 = the run could not start.

CI runs the same command: `.github/workflows/migration-rehearsal.yml`, on every pull request and push that touches `supabase/migrations/**`, `ops/release-*.sql`, this folder or the workflow, and on demand (Actions → Migration rehearsal → Run workflow).

## Files

| File | What it is |
|---|---|
| `run.mjs` | the runner (Node only) |
| `expectations.json` | the pinned PGlite version, the scenarios and their steps, and every expected result |
| `shim.sql` | the Supabase surface the migrations and the audit need: roles (`anon`, `authenticated`, `service_role`, …), `auth.users`, `auth.uid()/role()/jwt()`, `storage.buckets/objects` and helpers |
| `shim-dashboard.sql` | `public.set_updated_at()`, made in the dashboard before the migrations existed (see "Repository gap") |
| `seed.sql`, `seed-0071.sql` | synthetic rows that make every data check read something (shared storage prefix, inactive package with a learner's and a staff member's in-progress attempt, wrong default, cmi5 completion after 20 s with only a screen-level statement, webhook and LRS endpoint with credentials in the URL, a `qa-*` organisation with an abandoned-but-completed, cross-organisation attempt) |
| `seed-hotfix.sql`, `seed-many.sql`, `asrole-grants.sql` | extras for one scenario each |
| `repoint.sql` | the repoint after 0098 refuses on the shared prefix |

## Scenarios and what each one proves

| Scenario | Steps | Expected |
|---|---|---|
| `prod` | 0001–0071 without 0032 (production's believed state); seed; audit; the sitting: 0032 and 0072–0098, each pasted twice, 0098 first refused on the shared prefix, then `repoint.sql`, then 0098 twice; audit; 0099 twice; `refresh_report_views()`; audit | every file applies and re-applies without error; 0098 refuses while `D02` = 1; the three audits match `exp_before`, `exp_after` and `exp_0099` except the seeded `qa-*` organisation (`A03`, before and after) and, before the repoint, the seeded shared prefix (`D02`); `Z90` = `2 / 46 / 50`, `40 / 1 / 5`, `45 / 6 / 0`; every 0072–0098 probe (first and end-of-file) absent before and present after the sitting and after 0099; `B0099*` flip only after 0099; the six report views refresh without error |
| `hotfix` | 0001–0071 with 0032 (the out-of-band hotfix already applied) plus a course-level duplicate pair | `C05` = `per-package only`, `C03` = 1, `C04` = 0 |
| `below0071` | 0001–0069 | `B0070`, `B0071a`, `B0071b` absent and mismatched (the "production below 0071" stop rule fires) |
| `gap` | 0072–0075 and 0077 applied, 0076 missing | `Z01` = `0076`, `Z02` = `0077` (the "applied out of order" stop rule fires) |
| `asrole` | the audit run as `authenticated` with Supabase-like default grants | row-level security makes every D row read 0 (`D02` reads `ok`, `A03` reads 0 although a `qa-*` organisation exists); `A04` is the only mismatch, which is why it is a stop rule |
| `many` | 1,001 more courses | `D04.01003` listed, 1,003 `D04` rows, no check id collision |
| `no-dashboard-fn` | the shim without `public.set_updated_at()` | the replay stops at `0049_security_advisor_hardening.sql` with `42883` (function does not exist) |

Every audit run is also checked to be read-only: every relation in `public`, `auth` and `storage`, and every row of every table there (count and md5), is the same before and after. A static check confirms the audit file writes nothing but its temporary table, and the grid is searched for the seeded credentials (user, password, token, secret), which must never appear.

Results on 2026-10-18 (branch `feat/p1-release-prep`, Node 24, PGlite 0.5.10): `RESULT: PASS: 229 checks, 0 failed` over the seven scenarios; the sitting's first pastes took about 0.14 s in total and 0099 about 0.02 s (toy data). The audit grids are identical, row for row, to those of the first replay recorded in `docs/release/v1.3.0.md` §7 (made the same day in a temporary folder before this harness existed), except `A01`, the run time.

## Repository gap it found

A replay from the repository alone stops at `0049_security_advisor_hardening.sql`: it runs `alter function public.set_updated_at() set search_path = …`, and no migration creates `public.set_updated_at()`. The function was created in the Supabase dashboard before the migrations existed, so production and staging have it and a fresh project built from `supabase/migrations/` does not. The harness creates it in `shim-dashboard.sql`; the `no-dashboard-fn` scenario keeps the gap visible. Closing it would take a new migration (a schema change, outside this harness).

## What it cannot prove

- Anything that depends on production's real rows: duplicate version-number pairs, shared storage prefixes, the 0032 constraint state, rows a new constraint or trigger would refuse. The read-only audit run on production before the sitting is designed to catch exactly these, and its stop rules hold the sitting (`docs/release/v1.3.0.md` §2.3 item 11, §4.2).
- Supabase itself: its Postgres version (PGlite is 18.6), its roles, grants, default privileges, extensions and row-level security, and the SQL editor's batch and confirmation behaviour. The staging SQL-editor applies of 0072–0099 are the evidence there.
- That last night's dump restores into a Supabase project, and timing on production's compute.

## When it fails

Read the `FAIL` lines. A changed migration or audit file that changes a result on purpose needs `expectations.json` updated in the same change, with the reason in the commit message. A migration added after 0099 is not part of the v1.3.0 sitting and is not applied here.
