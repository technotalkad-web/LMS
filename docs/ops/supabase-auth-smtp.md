# Supabase Auth SMTP — setup guide

By default Supabase Auth sends emails (magic links, password recovery,
signup confirmations, invites, email-change confirmations) via its
built-in test SMTP. That has two problems:

1. **Rate limit:** ~30 emails/hour. A bulk import or busy launch day
   easily blows past it and Supabase silently drops emails.
2. **Sender domain:** emails come from `noreply@mail.app.supabase.io`,
   not your domain. Reads as a test setup to the recipient.

This guide configures Supabase Auth to use **your own Gmail Workspace
SMTP** so auth-flow emails come from Ambak instead of Supabase's
shared `noreply@mail.app.supabase.io`.

---

## Architecture context — read this first

The LMS runs **two distinct email systems** on **different SMTP
architectures**. Knowing which is which is essential before tweaking
either of them.

### System 1 — Transactional emails (per-tenant SMTP)

- **What sends:** welcome / account-creation, course assignment, path
  assignment, asset completion, broadcast announcements, ticket
  replies, our **custom** password-reset OTP flow, etc.
- **Code path:** `lib/notifications/send.ts` → `supabase/functions/send-smtp`
  Edge Function → tenant's SMTP credentials (configured per-org in
  `Settings → Notifications`).
- **Sender domain:** the **tenant's** domain (e.g. Acme's learners
  see emails from `noreply@acmecorp.com`).
- **Why per-tenant:** product branding. A learner at Acme should see
  Acme's brand, not Ambak's, on the high-volume product emails they
  receive every day.

### System 2 — Auth-flow emails (platform SMTP, what THIS doc configures)

- **What sends:** Supabase Auth's built-in emails: magic link
  (`signInWithOtp`), signup confirmation, password recovery (Supabase's
  flow, not ours), invite (Supabase's flow, not ours), email-change
  confirmation.
- **Code path:** the browser / server calls `supabase.auth.*` →
  Supabase Auth uses **its own globally-configured SMTP**.
- **Sender domain:** the **platform's** domain (`Ambak LMS <lms@ambak.com>`)
  for ALL tenants.
- **Why platform-branded:** Supabase Auth is structurally **one shared
  instance per project** — there is no per-tenant SMTP knob in Auth.
  We could build per-tenant routing via Auth Hooks (~6–8 hours of
  webhook plumbing) but the decision has been made not to. Auth-flow
  emails are treated as **platform infrastructure** (identity verification)
  rather than tenant-branded product UX. This matches industry norm
  for B2B SaaS (Stripe, Auth0, Atlassian all split this way).

### Which emails does each system send in practice?

| Email | Triggered when | System | Sender |
|---|---|---|---|
| Welcome / account creation | Admin creates a user | System 1 | Tenant |
| Course assignment | Admin assigns a course | System 1 | Tenant |
| Path assignment | Admin assigns a learning path | System 1 | Tenant |
| Reminder | Cron daily | System 1 | Tenant |
| Broadcast | Admin sends a broadcast | System 1 | Tenant |
| Asset completion (course done) | Learner completes | System 1 | Tenant |
| Custom password reset OTP | Learner uses `/forgot-password` | System 1 | Tenant |
| **Magic link** | Learner picks "Magic link" on `/[org]/login` | **System 2** | **Ambak (platform)** |
| Supabase signup confirmation | Disabled in LMS (we use admin invites) | n/a | n/a |
| Supabase Auth recovery | Disabled in LMS (we use our custom flow) | n/a | n/a |
| Email-change confirmation | If user changes email in `/profile` | System 2 | Ambak (platform) |

**The only common case in normal use is magic link.** Everything else
in System 2 is admin / edge-case territory. The branded templates we
ship in `docs/ops/auth-email-templates/` cover all 5 just so the
edge cases also look professional when they fire.

### If you change your mind later

To migrate auth-flow emails to per-tenant routing (true white-label
even for magic links), the path is:

1. Disable Supabase's default email sending for the relevant auth events
2. Configure a **Supabase Auth Hook** (webhook) pointing at a new
   `/api/auth/hooks/email` endpoint in the LMS
3. The hook receives the event payload, looks up the user → tenant
   → tenant's SMTP config, dispatches via the existing
   `send-smtp` Edge Function

That's an estimated 6–8 hours of work plus careful failure-mode
testing (a failed hook breaks the entire auth flow, not just the
email). Worth doing if magic-link branding becomes a sales objection.

---

## Prerequisites

- Google Workspace account on `ambak.com` (you have this — your address
  is `trainingcontent@ambak.com`)
- A dedicated sender account or alias. **Recommended:** create
  `lms@ambak.com` as a separate Workspace user (~$6/mo) so the
  account can be administered separately from any one person.
  **Acceptable:** reuse an existing account (e.g. `trainingcontent@`),
  but be aware that disabling that person's account would break LMS
  email.
- Two-factor authentication enabled on the Google account — required
  to generate App Passwords.

---

## Step 0 — Configure Auth URLs (critical, ~2 min)

**Skipping this step will make the SMTP setup look broken even when
it isn't.** Symptom: magic-link emails arrive correctly, but clicking
the link redirects to `http://localhost:3000/?error=otp_expired`
instead of the LMS.

Supabase Auth's magic-link / recovery / invite flows check the
`emailRedirectTo` URL the SDK sends against an **allowlist** in the
project. If the URL isn't on the allowlist, Supabase silently falls
back to the project's **Site URL** — which defaults to
`http://localhost:3000`. The OTP then "expires" because verification
fails at the wrong destination.

### Set the Site URL

Prod Supabase Dashboard → **Authentication** → **URL Configuration** →
**Site URL**:

```
https://my-lms-prod.mentora.workers.dev
```

(Replace with your custom-domain URL when #124 lands — same hostname
that's in `NEXT_PUBLIC_SITE_URL`.)

### Add Redirect URL allowlist entries

Same page → **Redirect URLs** → add each (one per line, with the
`/**` wildcard so any path on that host is allowed):

```
https://my-lms-prod.mentora.workers.dev/**
https://my-lms.mentora.workers.dev/**
http://localhost:3000/**
```

The two `*.workers.dev` lines cover prod and staging respectively.
The localhost line lets `next dev` test magic links locally. If you
add a custom domain later, append `https://lms.ambak.com/**`.

Save.

### Sanity check

After saving, request a magic link from `/login` and confirm the
generated email URL starts with one of your allowed origins, not
`http://localhost:3000`.

---

## Step 1 — Generate a Google App Password (~3 min)

App Passwords are dedicated 16-character credentials Google issues for
SMTP-only access. They bypass 2FA so SMTP libraries can authenticate
without going through interactive Google login.

1. Sign in as the sender account (e.g. `lms@ambak.com`)
2. Visit https://myaccount.google.com/apppasswords
   - If the page says "App passwords aren't available for your
     account": go to https://myaccount.google.com/security and enable
     **2-Step Verification** first, then come back
3. **App name:** `Supabase Auth — LMS production`
4. Click **Create**
5. Google shows a 16-char password like `abcd efgh ijkl mnop`. **Copy
   it now** — it disappears when you close the dialog. Remove the
   spaces when pasting into Supabase.

**Store the App Password in your password manager** under "LMS — Supabase
Auth SMTP". You'll also need it again if you ever rotate.

---

## Step 2 — Configure Supabase Auth SMTP (~2 min)

1. Prod Supabase Dashboard → **Authentication** → **Settings** →
   scroll to **SMTP Settings** section
2. Toggle **Enable Custom SMTP** ON
3. Fill in:

   | Field | Value |
   |---|---|
   | **Sender email** | `lms@ambak.com` (or whichever account you used) |
   | **Sender name** | `Ambak LMS` (this is what shows in the recipient's inbox before they open) |
   | **Host** | `smtp.gmail.com` |
   | **Port number** | `587` |
   | **Username** | `lms@ambak.com` (must match sender email) |
   | **Password** | The 16-char App Password from Step 1 (no spaces) |
   | **Minimum interval between emails** | `0` (keep default — Supabase doesn't need to throttle since Gmail does) |

4. Click **Save changes**
5. Use the **Send test email** button at the top of the section —
   send to your own address. Should arrive in seconds with sender
   `Ambak LMS <lms@ambak.com>`.

---

## Step 3 — Raise the rate limit (~1 min)

With custom SMTP, you can lift Supabase's conservative default rate
limit. Gmail Workspace allows 2,000 messages per day per account.

1. Prod Supabase Dashboard → **Authentication** → **Rate Limits** tab
2. Find **Rate limit for sending emails**
3. Bump from `30` to `100` per hour (well within Gmail's budget,
   handles a launch event without throttling). Higher is fine too —
   500/hour is safe.
4. Save.

---

## Step 4 — Brand the auth email templates (~10 min)

Prod Supabase Dashboard → **Authentication** → **Email Templates**.
There are 5 templates; the LMS only uses **Magic Link** in normal flows
(password sign-in goes through the LMS's own `/api/auth/forgot-password`
endpoints, NOT Supabase Auth's recovery flow). But brand all 5 — the
others are still triggered in admin or edge-case scenarios.

For each template:

1. **Subject** — copy the suggested subject line from this directory
2. **Body (HTML)** — copy the corresponding `*.html` file content
3. **Save**

Templates to update (files in this directory):

| Supabase template | File to paste | When it fires |
|---|---|---|
| **Confirm signup** | `confirm-signup.html` | New user signup with email-confirm flow (rare in LMS — invites are admin-driven) |
| **Invite user** | `invite-user.html` | `auth.admin.inviteUserByEmail()` calls (not used in current flows; LMS uses its own invite email) |
| **Magic Link** | `magic-link.html` | `signInWithOtp()` — THE common case |
| **Change Email Address** | `change-email.html` | User changes their account email from /profile (currently disabled in LMS UI but template applies if enabled) |
| **Reset Password** | `reset-password.html` | `auth.resetPasswordForEmail()` — NOT used by LMS (custom OTP flow takes over) but worth branding in case |

All 5 templates use these placeholders that Supabase substitutes at send time:

- `{{ .ConfirmationURL }}` — the action link
- `{{ .Token }}` — 6-digit code (where applicable)
- `{{ .Email }}` — the recipient's email
- `{{ .SiteURL }}` — your configured site URL (Settings → API → Site URL)
- `{{ .RedirectTo }}` — the post-action redirect

---

## Step 5 — Verify end-to-end (~2 min)

1. Open `https://my-lms-prod.mentora.workers.dev/login` in an
   incognito window
2. Switch to the **Magic link** tab, enter your own email, click
   **Send link**
3. Within ~10 seconds, an email should arrive from `Ambak LMS
   <lms@ambak.com>` with the branded magic-link template
4. Click the link — should land you on `/select-org` (or directly into
   your dashboard if you're only in one org)

If it arrives but the link redirects to `localhost:3000/?error=otp_expired`:

- You skipped **Step 0** (or the Site URL save didn't stick). Go back
  to Step 0 and verify Site URL + Redirect URLs are set to your prod
  origin, then request a fresh magic link (the old OTP is single-use
  and now invalid).

If it doesn't arrive at all:

- Check Gmail's **Sent** folder for the sender account (`lms@ambak.com`)
  — if it's not there, Supabase couldn't authenticate (wrong App
  Password, or 2FA not enabled). Re-check Step 2.
- Check spam folder.
- Supabase Auth logs: Dashboard → Logs → **Auth logs**. Failed SMTP
  attempts show up as `error_sending_email`.

---

## Operational notes

- **Per-tenant SMTP unchanged.** Each tenant org can still bring its
  own SMTP for tenant-scoped transactional emails (welcome, course
  assignments, etc.) — that's the `send-smtp` Edge Function path
  configured in tenant settings. This change only routes the
  **auth flow** emails. The two paths are independent.

- **Sender domain auth.** Gmail handles SPF/DKIM/DMARC for Workspace
  domains automatically — you don't need to add any DNS records.
  Just verify the Workspace domain is `ambak.com` in Google Admin.

- **Rotating the App Password.** When the sender account password
  changes, the App Password is auto-revoked. You'll need to:
  1. Generate a new App Password (Step 1)
  2. Update it in Supabase Dashboard → Auth → SMTP Settings (Step 2)
  3. Send a test email to confirm

- **If you migrate to Resend later.** All the dashboard SMTP fields
  swap for Resend's values (host: `smtp.resend.com`, port: `465`,
  username: `resend`, password: a Resend API key). Templates stay
  the same. Estimated swap time: 10 minutes.

- **Quota awareness.** Gmail Workspace caps at 2,000 outbound messages
  per day per account. If LMS auth volume ever approaches that
  (~83/hour sustained), switch to Resend (3k/month free, then $20/mo
  for 50k) or another transactional provider.
