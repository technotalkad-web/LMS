# LMS — Phase 1

A multi-tenant learning management platform built on Next.js 16 (App Router, React 19) and Supabase.

## What's working in Phase 1

- Magic-link authentication via Supabase Auth
- Path-based multi-tenancy (`/{org-slug}/dashboard`)
- Server-side auth guard (`requireOrgAccess`) with RLS-backed membership checks
- Sidebar shell with role-aware navigation
- Org picker for users in multiple workspaces
- Tailwind v4 with a warm minimal-editorial palette (Geist + Instrument Serif via `next/font`)

## Setup

### 1. Install dependencies

If you haven't already:

    npm install

### 2. Create a Supabase project

1. Go to https://supabase.com and create a new project.
2. From **Project Settings → API**, copy the **Project URL** and **anon public key**.

### 3. Configure environment

    cp .env.local.example .env.local

Fill in:

- `NEXT_PUBLIC_SUPABASE_URL` — your Project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — your anon key
- `NEXT_PUBLIC_SITE_URL` — leave as `http://localhost:3000` for dev

### 4. Run the SQL migration

In the Supabase Dashboard, open **SQL Editor**, paste the contents of `supabase/migrations/0001_initial.sql`, and run it.

### 5. Configure auth redirects

In **Authentication → URL Configuration**, add to **Redirect URLs**:

- `http://localhost:3000/auth/callback`

### 6. Start the app

    npm run dev

Visit http://localhost:3000 and sign in with your email. You'll get a magic link.

## Bootstrapping your first workspace

After your first sign-in you'll land on `/select-org` with "No workspaces yet."

In the Supabase **SQL Editor**, run (replace the email with whatever you signed in with):

    insert into organizations (name, slug)
      values ('Acme Corp', 'acme')
      on conflict (slug) do nothing;

    insert into organization_members (organization_id, user_id, role)
    select o.id, u.id, 'owner'
    from organizations o
    join auth.users u on u.email = 'YOU@example.com'
    where o.slug = 'acme'
    on conflict do nothing;

> Don't use `auth.uid()` here — it returns `null` in the SQL editor (no auth context).
> Look up your user by email in `auth.users` instead.

Refresh the app and you'll be redirected to `/acme/dashboard`.

## File map

    app/
      layout.tsx              Root HTML shell + Geist & Instrument Serif fonts
      globals.css             Tailwind v4 + design tokens
      page.tsx                Redirects to /login or /select-org
      login/page.tsx          Magic-link form
      auth/callback/route.ts  OAuth code exchange
      select-org/page.tsx     Workspace picker
      [org]/
        layout.tsx            Sidebar + org auth guard
        dashboard/page.tsx    Stats placeholder

    lib/
      supabase/
        client.ts             Browser Supabase client
        server.ts             Server Components client (async cookies)
        middleware.ts         Edge middleware client + session refresh
      auth/
        require-org-access.ts Auth + RLS guard for org-scoped pages

    supabase/migrations/
      0001_initial.sql        Tables + RLS policies

    middleware.ts             Refreshes Supabase session, redirects unauth'd users

## Phase 2 preview

- Cloudflare R2 bucket setup
- Course package upload (.zip containing cmi5 manifest)
- Server-side cmi5 manifest parser
- Course library UI + launcher iframe

Tell me when Phase 1 is running and we'll move on.
