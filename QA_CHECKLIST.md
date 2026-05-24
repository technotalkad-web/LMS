# LMS — Manual QA Checklist

Run this against your dev server (`npm run dev`) before shipping. Each section corresponds to a user role.
Sandbox couldn't run `npm run build` (RAM-bound) or browser tests — those are listed in the **Out-of-band**
section for you to run locally.

---

## 0. Pre-flight (run once, on your machine)

- [ ] `npm install` (verify lockfile not drifted)
- [ ] `npx tsc --noEmit` → expected: zero errors (verified in sandbox ✅)
- [ ] `npm run build` → expected: green Next.js build (needs your local RAM)
- [ ] `npx eslint app components lib` → 38 warnings, **0 critical bugs** — all are React 19
      strict-mode advisories (in-render `Date.now()`, `<a>` vs `<Link>`, unescaped apostrophes).
      Safe to ship; backlog them for a polish pass.
- [ ] Apply migrations in Supabase SQL editor in order: `0001` … `0024`.
- [ ] Verify env vars exist in `.env.local`:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `NEXT_PUBLIC_SITE_URL`
  - `CRON_SECRET` (for billing/reaper/rls-audit endpoints)
  - `IMPERSONATION_SECRET` (optional — falls back to service role key)
  - `PLATFORM_OWNER_IP_ALLOWLIST` (optional — leave unset for local dev)

---

## 1. Platform Owner (super-owner) — `agrawaladarsh910@gmail.com`

### Bootstrap

- [ ] Sign in at `/login` with this email → land on `/super/organizations` directly (no MFA, since you disabled it).
- [ ] Confirm dark slate sidebar with: Organizations, Plans & Billing, Global Broadcasts, System Audit Logs, Super Admins.

### Organizations dashboard

- [ ] 4 KPI cards render: Total MRR, Active tenants, Total platform users, Action required.
- [ ] Ambak row visible with status pill, MRR, member count.
- [ ] **Click the org name** → navigates to `/super/organizations/<id>` detail page.
- [ ] On detail page, edit workspace name → click Save → page refreshes with the new name.
- [ ] Add an email to Allowed email domains → Save → new value persists.
- [ ] Add an Admin via the form at the bottom → invitation flow fires:
  - If the email is new, you should get an `account_creation` email containing a temp password.
  - If the email already exists, membership is added immediately.
- [ ] Change an existing admin's role via the dropdown → DB updates.
- [ ] Remove an admin → row disappears.

### Plan management

- [ ] In the orgs table, change Ambak's plan from Basic → Enterprise via the dropdown in the Plan & MRR column.
- [ ] Confirm: MRR jumps to $2500, the row shows "Enterprise", audit log records a `tenant.set_plan` entry.
- [ ] Visit `/super/plans` → can edit Pro's price, save, see the change reflected back in the table.
- [ ] Create a new plan ("Startup, $99/mo, 25 users") → save → it appears in the orgs-table dropdown.

### Tenant lifecycle

- [ ] Suspend Ambak via the Power icon → row turns red, billing_status = suspended.
- [ ] As a member of Ambak (sign in incognito as a non-owner), confirm `/api/users` POST returns 402 with the "workspace is suspended" message.
- [ ] Restore via the orange Power icon → back to Active.
- [ ] Soft-delete Ambak via the Trash icon → row shows "Deletion in 30d" pill, billing_status = cancelled.
- [ ] Restore via the rotate icon → back to Active.

### Impersonation

- [ ] Click the ExternalLink icon next to Ambak → enter a reason → land on `/ambak/dashboard` with the amber banner.
- [ ] Confirm banner shows "Impersonating Ambak University · Session ends in 60 min".
- [ ] Click "Exit impersonation" → bounced back to `/super/organizations`.
- [ ] Visit `/super/audit` → see both `tenant.impersonate_start` and `tenant.impersonate_end` rows for your session.

### Global broadcasts

- [ ] Visit `/super/broadcasts` → click "New broadcast" → fill title + body + tone=warning + audience=all → Publish.
- [ ] Sign in as a regular Ambak user in another browser → confirm the broadcast banner appears at the top of every page.
- [ ] Dismiss the banner → it stays dismissed across page navigations.
- [ ] As super-owner, Pause the broadcast → confirm it disappears for all users on next page load.

### Provisioning a new tenant

- [ ] Click "Create new organization" → fill name + slug + plan + admin email → Submit.
- [ ] Receive success screen showing the new `/{slug}/login` URL and an optional invite link.
- [ ] Click the link → land on the new tenant's branded login page (defaults used).

---

## 2. Org Super-Owner / Admin (Ambak)

### Login

- [ ] Visit `/ambak/login` → see Ambak-branded page with the workspace logo and hero image.
- [ ] Sign in → land on `/ambak/dashboard`.
- [ ] First-time admins added by the platform owner should be force-redirected to `/change-password` on first sign-in.

### Settings

- [ ] `/ambak/settings` → Workspace tab.
- [ ] Brand-font dropdown shows: Inter, Poppins, Plus Jakarta Sans, Roboto, Merriweather (each with description).
- [ ] Pick Poppins → live preview card updates → Save → reload → entire workspace renders in Poppins.
- [ ] Switch to Merriweather → confirm headings + body both shift to serif.
- [ ] Switch back to Inter.
- [ ] Logo upload → image appears in admin sidebar + learner header + login page.
- [ ] Brand color → reflected on primary buttons across both admin and learner shells.
- [ ] Login hero image + headline + subtitle → reflected at `/ambak/login`.
- [ ] Custom domain field accepts input and saves (DNS setup is out of band).

### Users page

- [ ] All members render as cards (not rows) in a responsive grid.
- [ ] KPI strip: Total / Learners / Data Analysts / Admins / Pending.
- [ ] Search by email or role narrows the grid.
- [ ] Create user → form opens at `/ambak/users/new` → submit with no password → user gets welcome email with temp password.
- [ ] User signs in for the first time → bounced to `/change-password` → sets new password → lands on `/ambak/dashboard`.
- [ ] Promote a learner to Data Analyst via the role dropdown on their card.
- [ ] Demote them back.
- [ ] As a non-super-owner Admin, confirm the role dropdown does NOT show "Super owner" option.
- [ ] Remove a member → confirm dialog → member disappears.
- [ ] Pending tab → invite a non-existing email → row appears with Copy link + Revoke.

### Announcements

- [ ] KPI strip: Total / Active / Scheduled / Expired / Hidden.
- [ ] Create new announcement (info tone, audience=all) → card appears.
- [ ] Hide → status flips to Hidden, learners stop seeing it.
- [ ] Schedule with a future `expires_at` → card shows the expiry chip.

### Tickets

- [ ] Open + In progress + Resolved tabs filter correctly.
- [ ] Reply textarea on a ticket card works; PATCH endpoint updates.
- [ ] Status / priority selects on each card update without a page reload.

### Library

- [ ] Course grid renders thumbnails.
- [ ] Upload a new SCORM/cmi5 zip → course appears with thumbnail.
- [ ] Quota: when Basic plan's course limit (25) is hit, upload returns 402 + "plan limit reached" message.

### Learning paths

- [ ] Create a path → add 3 courses → set them as required prereqs in order.
- [ ] Assign to a user via the assignment UI.

### Teams

- [ ] Create team → add members → counts update.
- [ ] Assign a course to a team → all team members see it on their dashboard.

### Reports

- [ ] KPI strip shows: total users / completions / active learners / overdue.
- [ ] Click into Completion Report → CSV download works.

### Notifications / Broadcast

- [ ] Audience picker: All / Specific team / Specific users / Course / Path.
- [ ] Send a test broadcast to a small team → check inbox.

---

## 3. Learner (regular user)

- [ ] `/ambak/dashboard` shows assigned courses in card grid with thumbnails.
- [ ] Announcements banner appears (if any active).
- [ ] 48-hour callout for items due within 2 days.
- [ ] Click a course → launches SCORM/cmi5 in iframe with the exit button.
- [ ] Learning paths section shows progress dots per course.
- [ ] Profile page → can update first name, last name, phone.
- [ ] Help & Support page → can file a ticket → it appears in admin's Tickets inbox.

---

## 4. Security & Cron

### Cron endpoints (test with curl from your machine)

```
curl -X POST -H "x-cron-secret: <CRON_SECRET>" http://localhost:3000/api/cron/billing
curl -X POST -H "x-cron-secret: <CRON_SECRET>" http://localhost:3000/api/cron/reaper
curl -X POST -H "x-cron-secret: <CRON_SECRET>" http://localhost:3000/api/cron/rls-audit
```

- [ ] Billing: returns `{ ok: true, toPastDue, toSuspended, … }`.
- [ ] Reaper: returns `{ ok: true, reaped }`.
- [ ] RLS audit: returns `{ ok: true, offenders: [] }` (empty list = healthy).
- [ ] Each call without the header → 401.

### IP allowlist (production only)

- [ ] Set `PLATFORM_OWNER_IP_ALLOWLIST=<your-ip>/32` → confirm you can still reach `/super/*`.
- [ ] Change to `198.51.100.0/24` (not your IP) → confirm `/super/*` returns 404 (not 403, to avoid leaking URL existence).

### MFA (production only)

- [ ] Re-enable MFA for the platform owner:
      `update platform_owners set mfa_required=true where user_id=…;`
- [ ] Enable TOTP in Supabase Studio → Authentication → Sign In / Up → MFA.
- [ ] Sign out, sign back in → redirected to `/super-mfa/enroll` → scan QR → verify code → land on `/super/organizations`.

---

## Out-of-band (do these on your local box)

- [ ] `npm run build` — sandbox is RAM-bound; needs your machine.
- [ ] Cross-browser smoke test: Chrome, Firefox, Safari, Edge.
- [ ] Mobile responsive check at 375px, 768px, 1280px breakpoints.
- [ ] Lighthouse run for performance/accessibility on `/{slug}/dashboard`.
- [ ] Clean up `.tmp` debris:
      ```
      Get-ChildItem -Path .\app, .\components, .\lib -Recurse -Include *.tmp | Remove-Item -Force
      Remove-Item .\app\'[org]'\'(admin)'\announcements\test.tsx -Force
      ```

---

## Known accepted warnings (won't block release)

| Category | Count | Why it's OK |
|---|---|---|
| `Cannot call impure function during render` (`Date.now`, `new Date`) | ~12 | Used for time-display ("X hours ago"). Mild stale-data risk only; not a correctness bug. |
| `Cannot create components during render` (inline `LogoBlock` in branded-login) | 2 | Component is stateless. Mild perf concern. |
| `setState synchronously within an effect` | 3 | Already gated by mount checks. Effect-compat warning, not a bug. |
| `<a>` instead of `<Link>` for internal nav | ~5 | Costs prefetch performance only. |
| `react/no-unescaped-entities` (apostrophes) | ~5 | Cosmetic. |
| `randomPassword` unused | 1 | Legacy helper in `/api/users` — superseded by the auto-generate flow. Can delete. |

---

## Audit summary

- ✅ TypeScript: 0 errors
- ⚠️  ESLint: 38 advisory warnings (0 bugs)
- ✅ Migrations: 24 files, all idempotent, sequential
- ✅ RLS: 29 of 30 tables have RLS enabled (`subscription_plans` intentional)
- ✅ No TODO / FIXME / HACK comments
- ✅ All 19 `console.*` calls are intentional error/warn instrumentation
- ❌ `npm run build`: sandbox OOM — run on your machine
