# Supabase Auth's own mailer — kept apart

Rewritten for ADR 0029, section F (the hosted auth server's mailer is kept
separate from the LMS's mail, and switched down on production). Until then this page set the hosted auth server's
mailer up as the platform's email system, with a Workspace mailbox and branded
templates. That design is gone: the LMS now sends every email itself, and the
auth server's mailer is not one of its senders. What stays here is how that
mailer is set on each project, and Step 0 (the auth URLs), which the nightly
end-to-end run still points at.

---

## The two email systems the LMS uses

Both post to the `send-smtp` Edge Function. One never stands in for the
other, and the auth server's mailer carries neither.

| System | What it sends | Through |
|---|---|---|
| **Tenant mail** | welcome and invitation mail from the Users pages, assignment, unassignment, update and completion mail, reminders, journey nudges and escalations, broadcasts, ticket and attempt-request mail, and the reset codes and sign-in links of learners and data analysts | that organisation's own SMTP (Settings → SMTP), under its daily limit (`ops/RUNBOOK.md` §6.3b). No other route: while the settings are incomplete nothing is sent; while the organisation reads `failing`, learners' codes and links are not sent and other mail gets one probe per run; at the daily limit nothing is sent. Its administrators see the reading and are alerted |
| **Platform mail** | reset codes and sign-in links of platform owners and organisation administrators, the welcome (with its setup link) for a person a platform owner adds on the console, SMTP alerts to a tenant's administrators, the console's test | the platform's own mailbox, set only in deployment secrets (`ops/RUNBOOK.md` §6.3a) |

The app makes its links itself: `auth.admin.generateLink` mints a sign-in or
invitation token and sends nothing, and the app mails a link to its own
`/auth/callback`. The LMS's own "set your password" links come from
`lib/auth/setup-link.ts`. No code under `app/` or `lib/` calls an auth method
that makes the auth server send mail (`inviteUserByEmail`, `signInWithOtp`,
`resetPasswordForEmail`, `signUp`, `resend`, `reauthenticate`);
`tests/unit/auth-mailer-calls.test.ts` fails on any.

## Production: the mailer turned down

The owner sets these in the hosted dashboard of the production project, after
trying the same settings on staging. **What the dashboard allows is not
verified yet**: write down what it offers when the settings are tried.

1. **Email sign-ups off.** Accounts are made only by the LMS (an
   administrator, the console, or an accepted invitation).
2. **No custom SMTP.** Neither the platform mailbox nor any tenant's mailbox
   is entered in the auth settings. If an earlier setup put a mailbox there,
   take it out.
3. **The auth server's email rate limit set as low as it goes.**

The one session call that can still reach the mailer is a password change
(`updateUser`), whose notice the settings above keep down.

## Staging

Staging may keep the mailer on for lifecycle spec 36
(`tests/bot/lifecycle/36-email-template-real.spec.ts`), which asks it on
purpose for one invitation to a test inbox, and as the control of the
setup-link proof harness. Its mailbox is a third one: not production's, and not
the platform sender's. When the production settings above are tried on
staging, that spec's mail stops; note it and set staging back after the trial.

---

## Step 0 — Configure Auth URLs (critical, ~2 min)

The nightly end-to-end run reports a drift here. The app's own links (sign-in
links, invitations, setup links) point straight at the app; these settings
decide where the auth server's own redirects land (for example after single
sign-on). If a redirect address is not on the project's allow-list, the auth
server falls back to the **Site URL**, which defaults to
`http://localhost:3000`.

### Set the Site URL

Each project's dashboard → **Authentication** → **URL Configuration** →
**Site URL**: the app's address on that environment, the same host as
`NEXT_PUBLIC_SITE_URL` (production: `https://my-lms-prod.mentora.workers.dev`;
staging: `https://my-lms.mentora.workers.dev`). Replace it with the custom
domain once that is live.

### Add Redirect URL allow-list entries

Same page → **Redirect URLs**, one per line, with the `/**` wildcard so any
path on that host is allowed:

```
https://my-lms-prod.mentora.workers.dev/**
https://my-lms.mentora.workers.dev/**
http://localhost:3000/**
```

The two `*.workers.dev` lines cover production and staging; the localhost line
lets `next dev` work locally. Add the Cloud Run staging address
(`docs/CLOUD_RUN_STAGING.md` §4) and any custom domain the same way. Save.

### Sanity check

Sign in on the environment through a flow that returns by way of the auth
server, such as single sign-on where an organisation uses it: it lands on the
app's own address, never on `http://localhost:3000`.

---

## The templates in `docs/ops/auth-email-templates/`

Kept for staging's mailer (spec 36) and for any mail the auth server still
sends by itself. No normal flow of the LMS uses them. They are pasted into
the project's **Authentication** → **Email Templates** only where the mailer
is on.
