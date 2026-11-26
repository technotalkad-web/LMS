# 0034. A public Privacy Notice page at `/privacy`, linked from both sign-in pages

Status: Proposed (2026-11-26). Nothing is built before the owner answers the decisions below. Code and documentation only: no migration, table, view, function, policy, grant, role or permission change. Decision 4 changes one platform-owner API answer and is asked on its own.
Date: 2026-11-26
Deciders: owner; Ambak Legal for the notice's wording
Architect: Opus 5.5, standing in this week for Fable 5.2, which is at its usage limit

## Context

- **The owner's decision (2026-11-26).** "For now, please draft and wire a standard Indian corporate employee-training Privacy Notice (aligned with basic Indian DPDP norms for internal employee L&D) so the sign-in links work. Please also save a clean copy for me to review; I will get it checked/updated by Ambak Legal later if needed."
- **The dead links.**
  - `app/login/page.tsx:326-336` reads "By signing in you agree to our Terms and Privacy Policy." Both words are `<a href="#">`, so they lead nowhere.
  - `app/[org]/login/branded-login.tsx:440-443` reads "By signing in you agree to {orgName}'s Terms and Privacy Policy." with no link at all.
  - A search of `app/`, `components/`, `lib/`, `public/` and `supabase/functions/` for "privacy", "terms" and `href="#"` finds no other sign-in, footer, email or public page with such a line. The profile page's "Privacy" heading (`app/[org]/(learner)/profile/page.tsx:256`) is the leaderboard setting, not a link.
  - No terms text exists, and the owner did not ask for one.
- **What `/privacy` does today.** There is no `app/privacy` route.
  - A signed-out visit is bounced to `/privacy/login`. The middleware reads any first path segment outside `RESERVED_TOP_PATHS` as an organisation slug (`lib/supabase/middleware.ts:136-161`), and `/privacy/login` then matches the branded login of an organisation that does not exist.
  - A signed-in visit reaches `app/[org]/page.tsx` with the slug `privacy`.
- **How reserved names are enforced.**
  - The only list is `RESERVED_TOP_PATHS` (`lib/supabase/middleware.ts:134-146`). It is local to `updateSession`, and it decides only where a signed-out visitor is bounced.
  - Creating an organisation (`app/api/super/tenants/route.ts:21`, `:36-58`) checks the slug's shape and that it is unique, nothing more. That route's insert (`:72-80`) is the only place a slug is written. No update route changes a slug.
  - So nothing stops an organisation named `privacy`, or `login`, from being created today.
  - The list also lacks `super-mfa` (`app/super-mfa/`). A signed-out visit there is bounced to `/super-mfa/login`.
- **Routing.** In the App Router a static top-level folder answers its own path before `app/[org]` does. Deeper paths still reach the `[org]` routes: `/privacy/login` would still match `app/[org]/login` with the slug `privacy`.
- **The middleware.**
  - It runs on every page (`middleware.ts:8-21`) and calls `supabase.auth.getUser()` on every request (`lib/supabase/middleware.ts:87-90`). Without a session cookie that call makes no network request (`tests/unit/sign-in-next.test.ts:101-102`). With a session it makes one auth read, as it does on every page.
  - On a white-label host it rewrites every path that is not a platform path to `/<slug>/<path>` (`lib/supabase/middleware.ts:29-52`, `lib/domains/resolve.ts:49-72`). Custom domains are off on both environments (`wrangler.toml:107-112`, `:200-201`, commented out), but the branded login is exactly the page a white-label learner sees.
- **The root layout** reads one cookie, `theme` (`app/layout.tsx:583-585`). That makes every page render per request, and it involves no database read.
- **Next.js.** `package.json:45` pins `next` at `~15.5.29`. This branch has no `node_modules` installed. An installed 15.5.29 checked for this record has no `node_modules/next/dist/docs/` folder. The executor checks the branch's own install first (step 1).
- **Cloud Run** runs the same build and the same middleware. `tests/unit/sign-in-next.test.ts:92-167` already runs the real middleware, signed out, behind a container-style host.
- **Production.** The next production release is ADR 0033's pilot release, the "big update". On 2026-11-26 the owner chose that the email and sign-in fixes ship in that one update, with no backport to v1.4.3.

## Decision

**Goal.** A signed-out employee who taps "Privacy Policy" on either sign-in page reads a plain-English privacy notice. The notice says only what the platform actually does and is marked as a draft for legal review. Ambak Legal can later change its wording by editing one file.

**Out of scope.** Terms of use. A cookie banner. Consent capture. Data-request tooling. Any schema change. Per-organisation notices. Translations. Narrowing who may read profile rows (decision request 7). Gaps in the reserved list other than `privacy`, and `super-mfa` if the owner chooses it (decision request 5).

### 1. The route

- `/privacy` is a static, public page in a new folder: `app/privacy/page.tsx` renders it, and `app/privacy/notice.ts` holds its text.
- The page reads nothing. It makes no database call, reads no session, sets no cookie, has no form and uses no client code.
- Two things still run on it, as on every page:
  - the middleware's `getUser` and, with custom domains on, its host lookup;
  - the root layout's `theme` cookie read.
- The page has no "back" link. The platform login and an organisation's login are different addresses, and the browser's Back button returns to the right one.
- `docs/ARCHITECTURE.md` §2 gains a row for `app/privacy/` when this record is accepted. The architect writes that row; the executor does not edit the file.

### 2. The middleware: three exact edits, matcher unchanged

| File | Change |
|---|---|
| `lib/supabase/middleware.ts`, `isPublic` (`:93-120`) | Add `path === "/privacy"`, an exact match. Not `startsWith`: `SLUG_RE` allows a slug such as `privacy-team`, and a prefix would take every path of that organisation out of the sign-in gate |
| `lib/supabase/middleware.ts`, `RESERVED_TOP_PATHS` (`:134-146`) | Move the set to module scope as `export const RESERVED_TOP_PATHS: ReadonlySet<string>`, same entries plus `"privacy"`. Behaviour is otherwise unchanged. A signed-out `/privacy/<anything>` then goes to `/login`, not `/privacy/login`. `"terms"` is not added. It is added only if a terms route is ever built |
| `lib/domains/resolve.ts`, `isInfraPath` (`:49-61`) | Add `p === "/privacy"`, exact. A white-label host then serves the platform's notice instead of rewriting to `/<slug>/privacy`, which has no page |

`middleware.ts` and its matcher do not change (alternative 1 says why).

### 3. The links

- **`app/login/page.tsx:326-336`.**
  - "Privacy Policy" becomes `<Link href="/privacy">`. `Link` is already imported at `:4`. The class stays the same.
  - The dead `<a href="#">Terms</a>` becomes the plain word "Terms", with no link. The sentence reads exactly as before, and it now matches the branded page, where "Terms" was never a link.
  - Whether "Terms" stays in either sentence is decision request 2.
- **`app/[org]/login/branded-login.tsx:440-443`.** Only "Privacy Policy" becomes `<Link href="/privacy">` (`Link` is imported at `:4`). No word of the sentence changes.
- Both links open in the same tab, as "Forgot password?" does. The link text stays "Privacy Policy", and the page's heading is "Privacy Notice". Ambak Legal may align the two.
- **Other surfaces.** None found (see Context). A footer or email link added later points at `/privacy`.

### 4. Reserved names at organisation creation (the owner's answer to decision request 4)

If the answer is yes, `POST /api/super/tenants` refuses any slug in `RESERVED_TOP_PATHS` with 400 and the error "This address is reserved by the platform". The check sits after the shape check (`:37-42`) and before the uniqueness read (`:50-58`). Only platform owners can call this route. No existing organisation is touched. The read-only check in step 6 shows whether any organisation already holds a reserved name.

### 5. The text and where it lives

- **One file.** The text lives only in `app/privacy/notice.ts`. The module holds data and nothing else, with no imports:
  - `PRIVACY_NOTICE_TITLE`;
  - `PRIVACY_NOTICE_VERSION`;
  - the intro paragraphs;
  - `PRIVACY_NOTICE_SECTIONS`, a read-only array of `{ heading, paragraphs?, items?: { lead?, text }[], after? }`.
- **The page** maps that data to headings, paragraphs and lists, so a later edit by Ambak Legal touches this one file. There is no CMS and no database.
- **Version 1 is Appendix A.2, word for word.** Appendix A.2 is also the owner's clean copy for review. Appendix A.1 lists every assumption the text makes and every placeholder legal must fill. The page itself shows no placeholder brackets. Where a fact is unknown, it uses the neutral wording.
- **The version line** reads "Version 1, draft for legal review, 2026-11-26".
- **Later wording changes** are an edit to `notice.ts` and its version line, with the unit test's version expectation updated in the same pull request. They need no new record. A dated note under this record lists each version. A new record is needed only if the route, the links' target or the structure changes. This record is never rewritten.

### 6. Tests

- **A new unit test,** `tests/unit/privacy-notice.test.ts`, follows the pattern of `tests/unit/sign-in-next.test.ts`. It runs the real middleware with no database and no network, with fetch stubbed. The `unit` job runs it.
- **One new case in `tests/e2e/auth/login.spec.ts`.** The repository pattern makes this cheap: it needs no seeded data, and the pull request e2e job runs it.
- **No lifecycle spec.** The deployed check is a staging check after merge (step 8).

### 7. Production

The page reaches production with ADR 0033's release (the big update). Whether it should instead go out in a separate small release from the v1.4.3 line is decision request 3. No hotfix is planned here.

## Database changes

None. No migration, table, view, function, policy or grant. The one read-only query in step 6 changes nothing.

## Steps for the executor

No step starts before the owner accepts this record. Step 4 waits for decision request 4, and the `super-mfa` entry waits for decision request 5.

1. **The page.**
   - Create `app/privacy/notice.ts` with the text of Appendix A.2, copied word for word, in the shape of decision 5. The module has no imports.
   - Create `app/privacy/page.tsx` as a server component:
     - no `"use client"`;
     - `export const metadata: Metadata = { title: "Privacy Notice" }`;
     - imports only the `Metadata` type from `next` and `./notice`;
     - no `@/lib/supabase`, `@supabase/*` or `next/headers`, no `cookies()`, no `fetch`, no route segment config.
   - Layout: one centred column (`max-w-2xl`) in the existing tokens (`bg-canvas`, `text-ink`, `text-muted`, `serif`). The heading is an `h1`, the version line sits under it, each section heading is an `h2`, and the lists are `ul` elements.
   - Before writing, look for `node_modules/next/dist/docs/` in this branch's own install. If it is there, read the App Router page and metadata guides. If it is absent, as in 15.5.29, follow the repository's own top-level pages (`app/login/page.tsx`, `app/forgot-password/page.tsx`).
   - Verified by steps 5 and 8.
2. **The middleware.** Make the three edits of decision 2, with one comment line each saying why the match is exact. Verified by step 5 (b) to (d).
3. **The links.** Make the edits of decision 3. Verified by step 5 (e) and the e2e case.
4. **Reserved names at creation** (if decision request 4 is yes). In `app/api/super/tenants/route.ts`, import `RESERVED_TOP_PATHS` from `@/lib/supabase/middleware` and add the refusal of decision 4. If decision request 5 is yes, add `"super-mfa"` to the set too. Verified by step 5 (h).
5. **`tests/unit/privacy-notice.test.ts`.**
   - (a) `RESERVED_TOP_PATHS` has `privacy` and does not have `terms`.
   - (b) `isInfraPath("/privacy")` is true; `isInfraPath("/privacy-team")` is false; `tenantRewritePath("/privacy", "acme")` is `null`.
   - (c) The real `updateSession`, signed out, on a platform host and on the container host `http://0.0.0.0:8080`:
     - `/privacy` answers with no `location` and no `x-middleware-rewrite` header;
     - `/privacy/dashboard` gives 307 to `/login`;
     - `/privacy-team/dashboard` gives 307 to `/privacy-team/login`, so the gate stays on a slug that only starts with "privacy";
     - no fetch is made.
   - (d) With `CUSTOM_DOMAINS_ENABLED=1` on the host `learn.example.test`, where the stubbed lookup answers `acme`:
     - `/privacy` answers with no `location` and no `x-middleware-rewrite`;
     - `/dashboard` is still bounced to `/login`, as today;
     - the host lookup is the only fetch.
   - (e) A source scan of the two sign-in files:
     - `app/login/page.tsx` has `href="/privacy"` on the "Privacy Policy" link and no `href="#"` left;
     - `app/[org]/login/branded-login.tsx` has `href="/privacy"`, and its sentence still holds "By signing in you agree to", "Terms and" and "Privacy" (JSX line breaks allowed).
   - (f) `app/privacy/page.tsx` imports only `next` types and `./notice`. `app/privacy/notice.ts` has no import line. Neither file contains `@/lib/supabase`, `@supabase/`, `next/headers`, `cookies(`, `fetch(` or `"use client"`.
   - (g) The text:
     - the version line is "Version 1, draft for legal review, 2026-11-26" until legal's version replaces it;
     - it contains "Data Protection Board of India", "under 18", "HR or Learning & Development team" and "the organisation that gave you access to this platform (usually your employer)";
     - it contains no `[`, `]`, `{`, `}`, `@` or `http`, and none of the words "compliant", "certified" or "Section";
     - its word count (every string in the module, split on whitespace) is between 700 and 1,100;
     - no `app/terms` folder exists.
   - If the count or any wording check fails on the copied text, the executor stops and reports it. The executor does not trim or reword the notice; the architect does.
   - (h) If step 4 is built, a source scan of the tenants route shows that it imports `RESERVED_TOP_PATHS` and refuses before the uniqueness read. If `"super-mfa"` is added, (a) checks it, and (c) checks that `/super-mfa/challenge` signed out goes to `/login`.
6. **The read-only name check** (owner-run, explained beforehand).
   - On the staging database before merge, and on production before the release's tag, in the SQL editor:

     ```sql
     select slug from public.organizations
     where slug in ('privacy', 'super', 'auth', 'api', 'invitations', 'login',
                    'forgot-password', 'select-org', 'change-password', 'super-mfa');
     ```

   - Expected: no rows. A row goes to the owner before anything else happens. Nothing is renamed by hand.
   - The production line is added to ADR 0033's sitting runbook.
7. **The e2e case.** In `tests/e2e/auth/login.spec.ts`: signed out, open `/login`, wait for the form, and click the link named "Privacy Policy". Then expect the address to end in `/privacy`, a heading "Privacy Notice", and text matching `/Version \d+/`.
8. **Staging check after merge** (by hand, written into the pull request).
   - Where: on the Workers staging deployment after its deploy from `main`, and on Cloud Run staging after the owner's next deploy.
   - In a private window, signed out:
     - `/privacy` shows the page with no redirect;
     - on `/login`, "Privacy Policy" opens it;
     - on a staging organisation's `/<org>/login`, "Privacy Policy" opens it;
     - `/privacy/x` goes to `/login`.
   - Signed in, `/privacy` still shows the page.
9. **Review.** One independent review of the pull request.

## Verification

- Step 5 in the `unit` job on every push. Step 7 in the pull request e2e job.
- Existing tests that read the edited files and must stay green:
  - `tests/unit/sign-in-next.test.ts` (the middleware sets `next` twice and clears the query; the branded login reads `next` through `safeNextPath`);
  - `tests/unit/preview-mode-sites.test.ts:705-708` (the middleware sets `next` twice);
  - `tests/unit/setup-link.test.ts:906` (runs `updateSession`);
  - `tests/unit/platform-route-guards.test.ts:69` (the tenants `POST` keeps its `"full"` guard);
  - `tests/unit/self-hosted-fonts.test.ts` and `tests/unit/membership-rule-migrations.test.ts` (they scan every app source file, the two new ones included);
  - the existing cases of `tests/e2e/auth/login.spec.ts`.
- Step 6 recorded before merge (staging) and before the tag (production).
- Step 8 recorded in the pull request.
- On production after the release deploy, the owner loads `/privacy` once, signed out. That is a page load only, with no write.

## Risks and protections

| # | Risk | Protection |
|---|---|---|
| 1 | Learners cannot sign in because a sign-in page breaks | Only one link per page changes. The sign-in logic is untouched. The e2e case and the existing `/login` cases run on every pull request |
| 2 | The sign-in gate opens too wide | Exact matches only. Step 5 (c) proves that `/privacy-team/dashboard` and `/privacy/dashboard` are still bounced |
| 3 | An organisation named `privacy` loses its root page | The read-only check before merge and before the tag (step 6). Decision request 4 stops new ones |
| 4 | A white-label host rewrites `/privacy` to a missing page | The `isInfraPath` edit, proven by step 5 (d) |
| 5 | The notice says something the platform does not do, or leaves something out | Every statement maps to a line in Appendix B. The page says "draft for legal review". Appendix A.1 lists the assumptions. Ambak Legal reviews it before it is final |
| 6 | The notice promises erasure or a retention period the platform cannot keep | It states no period and no erasure of training history. It says training history is kept (principle 3, `docs/ARCHITECTURE.md` §3). Assumption A1 says nothing is deleted automatically |
| 7 | Privacy of the page itself | It collects nothing. It adds no tracker and no cookie. The error reporting and session refresh that run on every page run here too, and the notice describes them |
| 8 | Grading | No scoring, attempt or completion code is touched |
| 9 | Existing records | No migration, no write, no backfill |
| 10 | A random 1102 on the free Workers plan | The page is static text that is cheaper to render than the sign-in page. A reload clears it, as on any page |
| 11 | The text drifts from what was reviewed | One file, a version line, and a unit test of the version. The appendix records version 1 only, and later versions are listed in dated notes |
| 12 | The sign-in sentence still says "you agree to … Terms" | The words are unchanged and the dead link is gone. Decision request 2 and assumption A10 take it to the owner and legal |

## Consequences

- Both sign-in links work, on the platform host, on Cloud Run and on a white-label host.
- `privacy` becomes a reserved top-level name.
- A new folder, `app/privacy/`, holds one page and one text module. Legal's later edits touch `notice.ts` only.
- The notice states some things the owner may want to change in the product rather than in the text: every member can read whole profile rows, the photo address is public, and support access has administrator rights (decision request 7, assumptions A4 to A6).
- Production gets the page with the big update unless the owner chooses otherwise.

## Alternatives considered

1. **Leave `/privacy` out of the middleware matcher, with an anchored pattern.**
   - What it would bring: no `getUser` and no host lookup on the page, and no custom-domain rewrite.
   - Rejected for three reasons:
     - The house pattern for signed-out pages is `isPublic` (`/login`, `/forgot-password`, `/invitations`). The matcher's exclusions are static files.
     - A second list would have to be kept in step with `RESERVED_TOP_PATHS`.
     - The pattern is easy to get wrong. Without its end anchor it would take the sign-in gate off every organisation whose slug starts with "privacy".
   - The cost accepted instead: `getUser` runs on `/privacy`. It makes no network call when signed out, and one auth read when signed in, as on every page.
2. **The text in the database, editable per organisation.** Rejected for version 1. It needs a migration with RLS and grants, and a database read on a signed-out page. It can follow if legal wants notices per organisation.
3. **A route per organisation, `/[org]/privacy`.** Rejected. It needs an organisation lookup and the organisation layout's checks, and the text is the same for every organisation today. The page says an organisation may give its own notice.
4. **A Markdown file rendered at run time.** Rejected. It needs a parser dependency or file-system access, and the Worker has no file system at run time.
5. **A static HTML file under `public/`.** Rejected. It skips the layout and the fonts. The matcher does not exclude `.html`, so it would still need the `isPublic` edit.
6. **Write terms of use now.** Rejected. The owner did not ask for them. Terms would be a separate record.
7. **Remove the whole sign-in sentence.** Rejected. It changes more of what the owner sees, and legal may want the sentence reworded instead.

## Decisions requested from the owner

| # | Question | Recommended | Cost of the recommended answer |
|---|---|---|---|
| 1 | Accept this record: the page at `/privacy`, both sign-in links, version 1 of the text marked "draft for legal review" | Yes | About half a day of executor work and one review |
| 2 | "Terms" on both sign-in pages, where no terms exist | Keep the word as plain text, with the dead link removed, until Ambak Legal decides | Both sentences still mention terms that do not exist |
| 3 | When the page reaches production | With ADR 0033's release, the big update | No privacy link on production until that release |
| 4 | Organisation creation refuses reserved names | Yes, in this branch | One more check and one test |
| 5 | Add `super-mfa` to the reserved list | Yes, in this branch | None beyond one word and one test case |
| 6 | The read-only name check of step 6 | Run it on staging before merge and on production before the tag | Two short owner pastes, read-only |
| 7 | Any member of an organisation can read every member's whole profile row, phone, date of birth and gender included (`supabase/migrations/0115_membership_status_enforced.sql:920-933`); the notice says so | A separate small record that narrows it, before the first learner | A policy change with its own review; the notice is then updated |
| 8 | Production's error reports go to staging's error-reporting project when no production key is set (`.github/workflows/deploy-prod.yml:38-42`) | Tell the architect which is the case. The notice says "may be sent" and is true either way | None for this record |
| 9 | Send Appendix A to Ambak Legal with the placeholders of A.1 | Yes | None |

### Owner answers

One line per question. Nothing is built for a question before its line is filled.

- 1, accept this record (yes or no): yes. The owner asked on 2026-11-26 to "draft and wire" the notice so the sign-in links work, with Ambak Legal reviewing later.
- 2, "Terms" on the sign-in pages: keep the word as plain text, with the dead link removed. Settled by the lead on 2026-11-26 as a minor decision under the owner's standing rule, with the architect's recommendation; the owner may overrule.
- 3, production timing: with ADR 0033's release, the big update; no separate release (the owner, 2026-11-26).
- 4, reserved names refused at creation (yes or no): yes. Settled by the lead on 2026-11-26 as a minor decision, as for 2.
- 5, `super-mfa` reserved (yes or no): yes. Settled by the lead on 2026-11-26 as a minor decision, as for 2.
- 6, the read-only check (yes or no): yes. Staging, read-only, 2026-11-26 16:40 UTC: no organisation holds any of the names (the list of step 6 plus `terms`). Production: the owner, before the tag.
- 7, a separate record for profile visibility (yes or no): asked of the owner on 2026-11-26; not built here.
- 8, the production error-reporting key: asked of the owner on 2026-11-26; the notice is true either way.
- 9, send Appendix A to Ambak Legal (yes or no): yes; the owner sends it to Ambak Legal later (2026-11-26).

## References

- `docs/ARCHITECTURE.md` §1 (stack, roles, learning-data flow), §3 (principles 3 and 7) and §4.
- ADR 0033 (the pilot release; part 1, the CRM off for the pilot). ADR 0025 (self-hosted fonts: no font request leaves the platform).
- `middleware.ts`; `lib/supabase/middleware.ts`; `lib/domains/resolve.ts`; `app/api/super/tenants/route.ts`; `app/layout.tsx`; `app/login/page.tsx`; `app/[org]/login/branded-login.tsx`; `tests/unit/sign-in-next.test.ts`; `tests/e2e/auth/login.spec.ts`; `wrangler.toml`.

## Appendix A. The notice, version 1

### A.1 Assumptions and placeholders

Placeholders that Ambak Legal fills. Until then, the page uses the neutral wording shown and no brackets.

- L1. **The responsible party.** The data fiduciary, and whether the platform's operator acts for the organisation. The page says "your organisation" throughout.
- L2. **A grievance contact.** A role, an address and a response time. The page sends people to "your organisation's HR or Learning & Development team, or the administrator who invited you".
- L3. **Retention periods** for each kind of data. The page says the organisation decides.
- L4. **Breach notice.** Who tells people, and how. The page says "you will be told as the law requires".
- L5. **Providers and data location.** Whether to name the service providers, and where the data is stored. The page names roles only and states no location.
- L6. **Nomination.** How a person names someone to use their rights. The page states the right only.
- L7. **Languages.** Whether the notice must be offered in languages other than English.
- L8. **The basis for using the data.** The page says the data is used "as part of your employment". It does not rest on consent.
- L9. **Who the notice covers.** The page says "This platform is for work training" and does not name employees only. Legal confirms whether contractors and partners are covered.
- L10. **The sign-in sentence.** "By signing in you agree to … Terms and Privacy Policy" speaks of agreement and of terms that do not exist (decision request 2).

Assumptions the text makes. These are facts as of `main` at 3094e35, with evidence in Appendix B.

- A1. **Nothing is deleted automatically.**
  - Learner history is never rewritten or deleted (principle 3).
  - Removing a member deletes only their membership row.
  - Deleted organisations are soft-deleted.
  - The one automatic delete is of LRS outbox rows after forwarding.
  - Database backups are kept until someone deletes them.
  - No route in the code deletes an account (no `auth.admin.deleteUser` call). An account deleted by hand in the database host's console would take its attempts with it (`supabase/migrations/0002_courses.sql:87`, on delete cascade).
  - So the page promises no period and no erasure of training history. This conflicts with a plain "erase on request", and legal must reconcile the two.
- A2. **Browser error reporting.** It runs on every page when the build carries its key. It sends timing measurements from 10% of page visits, and a masked screen recording of any session that hits an error. On production the key falls back to staging's when no production key is set (decision request 8). The page says "may be sent" and names both kinds of report.
- A3. **The CRM integration and tenant LRS forwarding** are off unless an organisation turns them on. For the pilot the CRM is off (ADR 0033 part 1). The page describes what each does when on.
- A4. **Profile rows.** Any signed-in member of an organisation can read every co-member's whole profile row: name, username, work email, photo address, phone, gender and date of birth. The page says so (decision request 7).
- A5. **Profile photos** are stored in a public bucket. Anyone with a photo's web address can open it.
- A6. **Support access.** It is entered with administrator (`super_owner`) rights. It lasts at most 60 minutes and is recorded with the operator's network address, browser and stated reason.
- A7. **Providers.**
  - Production runs on Cloudflare Workers.
  - Supabase holds the database, sign-in and file storage, and runs the `send-smtp` function.
  - Backblaze B2 holds the encrypted database backups.
  - GitHub Actions runs the backups and the scheduled jobs.
  - Sentry receives the error reports.
  - The Cloud Run trial is staging only and R2 is unused, so neither is listed.
  - The platform mailbox's provider is not named.
  - The page names roles only (L5).
- A8. **Email.** Emails go through the organisation's own mail server settings. Some messages to platform owners and administrators go through the platform's own mailbox.
- A9. **Sign-in service facts** that come from the hosting service, not from this repository's code. Passwords are held hashed. The sign-in service keeps records of sign-ins and sessions. Legal may ask for these to be confirmed with the provider.
- A10. **Left out because unverified.** Encryption of connections in transit, and the platform owners' two-step sign-in. The owners' two-step sign-in is required by default (`lib/auth/require-platform-owner.ts:10-15`) but can be switched off per owner.
- A11. **No advertising or marketing trackers.** The only telemetry dependency is `@sentry/nextjs`, and the fonts are self-hosted (ADR 0025).
- A12. **Under 18.** There is no age check in the code. Date of birth is optional.
- A13. **Hosting logs.** The hosting provider's request logs are switched on (`wrangler.toml:39-40`). Their exact contents are the provider's.
- A14. **Other browser storage, not listed in the page.** The page names only the cookies that keep a person signed in. The platform also sets:
  - a `theme` cookie for the light or dark display;
  - two cookies when a person arrives from a connected HR or business system;
  - a support-visit cookie for platform operators only.
  It also keeps the announcements a person closed in browser storage. A cookie section is out of scope here; legal decides whether to list these.

### A.2 The text (clean copy)

The executor copies everything between the two marker lines into `app/privacy/notice.ts`, word for word. Each bold line is a heading. "Version 1, draft for legal review, 2026-11-26" is the version line.

----- BEGIN NOTICE TEXT, VERSION 1 -----

**Privacy Notice**

Version 1, draft for legal review, 2026-11-26

This notice explains what personal data this learning platform holds about you, why, who can see it, how long it is kept and what you can ask for.

In this notice, "your organisation" means the organisation that gave you access to this platform (usually your employer). It decides who gets access, what training you are given and how your training records are used. It may also give you its own privacy notice.

**What the platform holds about you**

- Account details: your name, work email address, username and employee ID. The sign-in service holds your password only in scrambled (hashed) form. With single sign-on, you sign in through your organisation's own system.
- Work details, entered by your organisation or its connected HR system: such as your platform role, designation, grade, department, branch, location, joining date, managers, teams and groups.
- Optional details, added by you or an administrator: phone number, gender, date of birth and a profile photo.
- Learning records: what is assigned to you, when you open it, your progress, your answers and actions inside courses, scores, pass or fail results, completion dates, attempts and review visits, requests for another attempt with your reason, your language choice, ratings, feedback and comments, points, badges, leaderboard places, certificates, help requests, and which announcements you have seen.
- Message records: the emails and reminders sent to you, with the address, subject, time and whether sending worked.
- Sign-in and security records: cookies that keep you signed in, records of your sign-ins, and password reset codes, held only in scrambled form, with the network address and browser type of each request.
- Error reports: if something goes wrong in your browser, a report may be sent to an error-reporting service. It can include the page address, your browser type, the steps before the error and a recording of the screen in which text, images and typed input are hidden. The service also receives timing measurements from some page visits.

**Why it is used**

Your organisation uses this data as part of your employment, for your training and development:

- to give you your training, keep your place, and record what you complete and your results;
- to show your progress to the people listed below;
- to send you sign-in emails, reminders and announcements;
- to run points, badges and leaderboards, where your organisation uses them;
- to keep the platform secure, prevent misuse, and find and fix faults;
- to share your training records with your organisation's own systems, if it turns this on.

The platform shows no advertising and uses no marketing trackers.

**Who can see it**

- You: your profile and your own learning records.
- Your organisation's administrators and data analysts: the details and learning records of everyone in the organisation, including reports and downloads.
- Your managers (up to three levels above you, as named in your record): your progress and results. Only your direct manager sees your email address there.
- Other people in your organisation who use the platform: the details in your profile (your name, work email, photo and any optional details) and your leaderboard places. Where your organisation allows it, you can hide yourself from leaderboards on your profile page; administrators still see you. Your photo's web address works for anyone who has it.
- The platform's operators: to give support, they can enter your organisation's workspace with administrator access. Each visit lasts at most one hour and is recorded.

**Systems your organisation can connect**

These are off unless your organisation turns them on.

- An HR or business system: it can create, update and deactivate your account, sign you in, and read your courses, progress, scores and completions. When you complete a course, the platform can send it your employee ID, email address, the course, your score, whether you passed and when.
- A learning record store: your organisation can have a copy of your learning records sent to its own store. Each copy carries your name and email address.

**Service providers**

The platform relies on:

- a database, sign-in and file storage provider, which also hands emails to the email service;
- a hosting provider that runs the website and keeps technical logs of requests;
- an automation service that runs scheduled jobs, including backups;
- a separate storage provider that holds encrypted copies of the database;
- an error-reporting service (see above);
- your organisation's own email service or, for some messages to administrators, the platform's email account.

**How it is protected**

- Database rules keep each organisation's data apart. Each person sees only what their role allows.
- Passwords and reset codes are stored only in scrambled form, and database backups are encrypted.
- Your training history is not deleted or rewritten; a correction is recorded alongside it.

If a security breach affects your personal data, you will be told as the law requires.

**How long it is kept**

Your organisation decides how long your data is kept, and keeps it only as long as it needs it for the purposes in this notice or as the law requires. Your training history is kept as a lasting record, also after you leave your organisation's workspace.

**Your rights**

You can ask your organisation:

- for a summary of the personal data held about you, how it is used and who it has been shared with;
- to correct, complete or update your data. You can change your own personal details and photo on your profile page; administrators change your work details;
- to erase personal data that is no longer needed. Data your organisation still needs for an employment or legal purpose, such as your training history, may be kept;
- to name another person who can use these rights for you if you die or become unable to act.

**Questions and complaints**

Send any question, request or complaint about your personal data to your organisation's HR or Learning & Development team, or to the administrator who invited you. If you are not satisfied with the answer, you can complain to the Data Protection Board of India.

**Children**

This platform is for work training. It is not meant for anyone under 18.

**Changes to this notice**

This notice may change. The version line at the top shows which version you are reading.

----- END NOTICE TEXT, VERSION 1 -----

The text is about 1,030 words, title and headings included, counted by hand. Step 5 (g) counts it again in the module.

## Appendix B. What the notice relies on

| Statement in the notice | Evidence on `main` |
|---|---|
| Name, username, work email, optional phone, gender, date of birth | `supabase/migrations/0006_profiles.sql:3-8`; `supabase/migrations/0011_user_profile_expansion.sql:8-15`; email held in `profiles`: `app/api/profile/route.ts:44-53` |
| Profile photo, stored in a public bucket | `supabase/migrations/0053_gamification.sql:31-32`; `app/api/upload/image/route.ts:19-22`, `:197-220` |
| Employee ID, required when an administrator adds a person; optional details at the same time | `supabase/migrations/0006_profiles.sql:12-17`; `app/api/users/route.ts:98`, `:348-350` |
| Work details: role, status, joining date, grade, designation, job role, managers L1 to L3, unit code, city, state, vertical, branch, department | `supabase/migrations/0001_initial.sql:24-30`; `0011_user_profile_expansion.sql:38-49`; `0056_business_verticals.sql:58-60`; `0091_reporting_lines_l3.sql:26-27`; `0096_department_content_mapping.sql:78-79` |
| Teams and groups | `supabase/migrations/0007_teams_bulk_domain.sql:4`, `:16`; `0067_custom_groups.sql:21`, `:45` |
| Single sign-on | `app/api/org/sso/route.ts:16-17`; `app/[org]/login/branded-login.tsx:99` |
| Self-service edits; work details changed by administrators only | `app/api/profile/route.ts:4-17`, `:54-80`; `app/[org]/(learner)/profile/profile-form.tsx:72-137`; read-only work fields `app/[org]/(learner)/profile/page.tsx:131`, `:308-373` |
| Leaderboard hiding, where allowed; administrators still see the person | `supabase/migrations/0053_gamification.sql:36-41`, `:162`; `app/api/profile/route.ts:82-112`; `app/[org]/(learner)/leaderboard/_components/vertical-board.tsx:256` |
| Attempts: status, score, start and completion, saved data | `supabase/migrations/0002_courses.sql:84-95` |
| Answers and actions inside courses (statements and state) | `supabase/migrations/0004_xapi.sql:9-17`, `:29-36` |
| When a course is opened | `supabase/migrations/0100_alds_core.sql:383-396` |
| Review visits | `supabase/migrations/0103_revision_visits.sql:309` |
| Requests for another attempt, with the learner's reason | `supabase/migrations/0083_attempt_requests.sql:18-35` |
| Language choice | `app/api/courses/[courseId]/language-preference/route.ts:345` |
| Ratings, feedback and comments | `lib/interactions/feedback.ts:208`; `docs/ARCHITECTURE.md:39` |
| Points, levels, streaks, badges, monthly awards | `supabase/migrations/0053_gamification.sql:97-112`, `:150-165`, `:222-232`, `:249-264` |
| Certificates, built from records | `app/[org]/(learner)/journey/certificate/page.tsx:28`, `:74` |
| Help requests and messages | `supabase/migrations/0013_help_tickets.sql:2-16`; `0095_manager_tickets.sql:63` |
| Announcements seen | `supabase/migrations/0068_popup_announcements.sql:39`; `0022_platform_10b_10c.sql:55` |
| Email and reminder records with address, subject, status, time | `supabase/migrations/0014_notifications.sql:48-60`, `:82-91` |
| Emails through the organisation's mail settings, or the platform mailbox; sent by the database host's function | `supabase/migrations/0014_notifications.sql:11`; `lib/email/platform-sender.ts:65-80`; `supabase/functions/send-smtp/index.ts:5-15` |
| Reset codes stored hashed, with the request's network address and browser | `supabase/migrations/0025_password_reset.sql:18-37`; `app/api/auth/forgot-password/request/route.ts:38-41`; `lib/auth/credential-mail.ts:173-175`, `:488-489` |
| Cookies that keep a person signed in | `lib/supabase/middleware.ts:66-90` |
| Other cookies and browser storage, not in the page (A14) | `app/api/theme/route.ts:14`; `app/api/integrations/enter/route.ts:37-38`; `lib/auth/impersonation.ts:29-30`; `app/[org]/(learner)/_components/announcements-banner.tsx:24-36` |
| Passwords held hashed; records of sign-ins (hosting behaviour, not code) | The sign-in service of the database host (A9); to be confirmed with the provider |
| Support visits: administrator rights, at most one hour, recorded with address, browser and reason | `lib/auth/impersonation.ts:6-30`; `app/api/super/impersonate/route.ts:10-13`, `:60-80`; `supabase/migrations/0021_platform_owner.sql:102-110`; `0022_platform_10b_10c.sql:116-127` |
| Administrators and data analysts see the whole organisation | `lib/auth/permissions.ts:4-16`; `docs/ARCHITECTURE.md:28` |
| Managers L1 to L3; email address for the direct team only | `lib/manager/access.ts:4-14` |
| Co-members can read whole profile rows | `supabase/migrations/0115_membership_status_enforced.sql:920-933` |
| Connected HR or business system: create, update, deactivate, sign in, read progress | `app/api/integrations/employees/route.ts:24-42`; `app/api/integrations/sso-link/route.ts`; `app/api/integrations/progress/route.ts`; `app/api/integrations/learner-summary/route.ts` |
| Completion message: employee ID, email, course, score, pass, time | `lib/integrations/webhook.ts:48-60` |
| Off for the pilot | `docs/adr/0033-paths-pilot-first-release.md:81-98` |
| Learning record store copies carry name and email | `supabase/migrations/0044_lrs_forwarding.sql:13`, `:27`; `lib/lrs/enrich.ts:96-102` |
| Providers by role | `docs/ARCHITECTURE.md:9-12`; `wrangler.toml:39-40`; `.github/workflows/backup.yml:4`; `docs/ops/backup-restore.md:6-7` |
| Error reports and timing measurements: what is sent, the 10% sample, masking | `instrumentation-client.ts:41-95`; `lib/security/telemetry-scrub.ts:8-27`; `.github/workflows/deploy-prod.yml:38-42` |
| No advertising or marketing trackers | `package.json:37` (the only telemetry dependency); ADR 0025 |
| Organisations kept apart by database rules | `docs/ARCHITECTURE.md:10` |
| Training history never deleted or rewritten; corrections added | `docs/ARCHITECTURE.md:71`; `supabase/migrations/0053_gamification.sql:128-146` |
| Nothing deleted automatically; removal keeps history | `app/api/organization-members/[userId]/route.ts:169-175`; `app/api/cron/reaper/route.ts:11-19`; `app/api/cron/lrs-forward/route.ts:225`; `docs/ops/backup-restore.md:6` |
