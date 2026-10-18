/**
 * Load-test world seeder — creates the `qa-load` org on STAGING with N learners,
 * uploads the scorm12.zip fixture course via the real admin API, and assigns it
 * org-wide. Persists a handle to tests/load/.seed.json for the k6 script.
 *
 * Follows the same qa-* / @example.test naming convention as the e2e helpers so
 * the existing purge routine also recognises this data. Idempotent: re-running
 * reuses the org, existing users, and the uploaded course.
 *
 *   node tests/load/seed.mjs              # seed 300 learners (default)
 *   node tests/load/seed.mjs --users 50   # seed 50
 *   node tests/load/seed.mjs --purge      # remove ONLY qa-load world (org + qa+load-* users)
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEED_FILE = path.join(ROOT, "tests/load/.seed.json");
const FIXTURE_ZIP = path.join(ROOT, "tests/bot/fixtures/scorm12.zip");

const ORG_SLUG = "qa-load";
const ORG_NAME = "QA Load Org";
const EMAIL_PREFIX = "qa+load-";
const EMAIL_DOMAIN = "example.test";
// No password is committed (the repository is public). Each seed run uses LOAD_TEST_PASSWORD
// when set, otherwise a fresh random one; it is written only to the gitignored .seed.json that
// the k6 script reads, and existing load users are reset to it so every learner can sign in.
const PASSWORD = process.env.LOAD_TEST_PASSWORD || `Lt-${randomBytes(18).toString("base64url")}-Aa1`;

// ---- env ------------------------------------------------------------------
for (const line of fs.readFileSync(path.join(ROOT, ".env.test.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const BASE_URL = process.env.E2E_BASE_URL;
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE_URL || !SUPA_URL || !ANON_KEY || !SVC_KEY) {
  throw new Error("Missing E2E_BASE_URL / Supabase env in .env.test.local");
}
// Environment guard: load seeding creates hundreds of accounts with a shared
// per-run password and purge bulk-deletes users — NEVER against prod.
if (SUPA_URL.includes("alkfrcglmseksweqhwzq")) {
  throw new Error(
    "REFUSED: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION project. Load seeding only runs against staging."
  );
}
const svc = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const USERS = Number(args[args.indexOf("--users") + 1]) || 300;

// ---- helpers --------------------------------------------------------------
const learnerEmail = (i) => `${EMAIL_PREFIX}${String(i).padStart(4, "0")}@${EMAIL_DOMAIN}`;
const ADMIN_EMAIL = `${EMAIL_PREFIX}admin@${EMAIL_DOMAIN}`;

async function pmap(items, fn, limit = 10) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/** Map of existing auth users (our prefix only): email -> id */
async function listLoadUsers() {
  const map = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) {
      if (u.email?.startsWith(EMAIL_PREFIX) && u.email.endsWith(`@${EMAIL_DOMAIN}`)) {
        map.set(u.email, u.id);
      }
    }
    if (data.users.length < 1000) return map;
  }
}

/** Build the @supabase/ssr cookie set from a password-grant session. */
function sessionCookies(session) {
  const ref = new URL(SUPA_URL).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const MAX = 3180;
  if (value.length <= MAX) return [[name, value]];
  const chunks = [];
  for (let i = 0; i * MAX < value.length; i++) {
    chunks.push([`${name}.${i}`, value.slice(i * MAX, (i + 1) * MAX)]);
  }
  return chunks;
}

async function passwordGrant(email) {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`password grant ${email} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---- purge ----------------------------------------------------------------
async function purge() {
  const { data: org } = await svc.from("organizations").select("id").eq("slug", ORG_SLUG).maybeSingle();
  if (org) {
    const { error } = await svc.from("organizations").delete().eq("id", org.id);
    if (error) throw error;
    console.log(`Deleted org ${ORG_SLUG} (cascade removes members/courses/attempts).`);
  }
  const users = await listLoadUsers();
  console.log(`Deleting ${users.size} qa+load-* auth users...`);
  await pmap([...users.values()], async (id) => {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error && !/not found/i.test(error.message)) throw error;
  }, 10);
  if (fs.existsSync(SEED_FILE)) fs.unlinkSync(SEED_FILE);
  console.log("Purge done.");
}

// ---- seed -----------------------------------------------------------------
async function seed() {
  console.log(`Seeding ${USERS} learners into '${ORG_SLUG}' on ${BASE_URL}`);

  let { data: org } = await svc.from("organizations").select("id, slug").eq("slug", ORG_SLUG).maybeSingle();
  if (!org) {
    const { data, error } = await svc
      .from("organizations")
      .insert({ name: ORG_NAME, slug: ORG_SLUG })
      .select("id, slug")
      .single();
    if (error) throw error;
    org = data;
  }
  console.log(`Org ${org.slug} = ${org.id}`);

  // The BASIC plan default caps orgs at 100 seats (0038_billing_overrides_and_
  // atomic_quota.sql). Give the load org the same per-tenant override a real
  // enterprise tenant would get.
  const { error: subErr } = await svc.from("tenant_subscriptions").upsert(
    {
      organization_id: org.id,
      custom_user_limit_override: 2000,
      owner_notes: "QA load-test org — seat cap raised for k6 runs (tests/load).",
    },
    { onConflict: "organization_id" }
  );
  if (subErr) throw new Error(`tenant_subscriptions override: ${subErr.message}`);

  const existing = await listLoadUsers();
  const wanted = [ADMIN_EMAIL, ...Array.from({ length: USERS }, (_, i) => learnerEmail(i + 1))];

  let created = 0;
  const ids = await pmap(wanted, async (email) => {
    let id = existing.get(email);
    if (id) {
      const { error: pwErr } = await svc.auth.admin.updateUserById(id, { password: PASSWORD });
      if (pwErr) throw new Error(`reset password ${email}: ${pwErr.message}`);
    }
    if (!id) {
      const { data, error } = await svc.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      if (error) throw new Error(`createUser ${email}: ${error.message}`);
      id = data.user.id;
      created++;
      if (created % 50 === 0) console.log(`  created ${created} users...`);
    }
    const { error: profErr } = await svc.from("profiles").upsert(
      {
        id,
        email,
        first_name: "Load",
        last_name: email === ADMIN_EMAIL ? "Admin" : email.slice(EMAIL_PREFIX.length, EMAIL_PREFIX.length + 4),
        must_change_password: false,
      },
      { onConflict: "id" }
    );
    if (profErr) throw new Error(`profile ${email}: ${profErr.message}`);
    const { error: memErr } = await svc.from("organization_members").upsert(
      {
        organization_id: org.id,
        user_id: id,
        role: email === ADMIN_EMAIL ? "admin" : "member",
        employee_id: `LOAD-${email.slice(EMAIL_PREFIX.length).split("@")[0]}`,
        node_id: null,
        status: "active",
      },
      { onConflict: "organization_id,user_id" }
    );
    if (memErr) throw new Error(`member ${email}: ${memErr.message}`);
    return id;
  }, 10);
  console.log(`Users ready: ${ids.length} (${created} newly created).`);

  // Course: reuse if the org already has one, else upload the fixture via the real admin API.
  let { data: course } = await svc
    .from("courses")
    .select("id, title")
    .eq("organization_id", org.id)
    .limit(1)
    .maybeSingle();
  if (!course) {
    console.log("Uploading scorm12.zip via /api/courses/upload as load admin...");
    const session = await passwordGrant(ADMIN_EMAIL);
    const cookie = sessionCookies(session).map(([n, v]) => `${n}=${v}`).join("; ");
    const fd = new FormData();
    fd.append("orgSlug", ORG_SLUG);
    fd.append("file", new Blob([fs.readFileSync(FIXTURE_ZIP)], { type: "application/zip" }), "scorm12.zip");
    const res = await fetch(`${BASE_URL}/api/courses/upload`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    if (!res.ok) throw new Error(`upload → ${res.status}: ${await res.text()}`);
    const { courseId } = await res.json();
    course = { id: courseId, title: "scorm12" };
    console.log(`Uploaded course ${courseId}`);

    const assign = await fetch(`${BASE_URL}/api/assignments`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orgSlug: ORG_SLUG, courseId: course.id, assignToOrg: true }),
    });
    if (!assign.ok) throw new Error(`assign → ${assign.status}: ${await assign.text()}`);
    console.log("Assigned org-wide.");
  } else {
    console.log(`Reusing existing course ${course.id}`);
  }

  fs.writeFileSync(
    SEED_FILE,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        supabaseUrl: SUPA_URL,
        anonKey: ANON_KEY,
        orgSlug: ORG_SLUG,
        courseId: course.id,
        password: PASSWORD,
        users: USERS,
        emailPrefix: EMAIL_PREFIX,
        emailDomain: EMAIL_DOMAIN,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${SEED_FILE}`);
}

if (args.includes("--purge")) await purge();
else await seed();
