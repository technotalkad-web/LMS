/**
 * Demo showcase data for client walkthroughs.
 *
 *   node scripts/demo/seed-demo.mjs           seed the "ambak-demo" org
 *   node scripts/demo/seed-demo.mjs --purge   remove ALL demo data at once
 *
 * Design: everything lives inside ONE dedicated demo organization
 * (slug "ambak-demo"), so the real tenant is never touched and purge is a
 * single org delete (every table is org-scoped with ON DELETE CASCADE) plus
 * removal of the @ambakdemo.test auth accounts. Seeding is refused while the
 * demo org already exists — purge first, then re-seed.
 *
 * What it creates (deterministic, seeded RNG):
 *   - 100 users: 1 demo admin (Super Owner), 6 team leaders, 93 learners
 *     with realistic names, designations, grades, phones, joining dates
 *   - Hierarchy: verticals (Retail/Institutional/Fulfillment) → cities
 *     (Mumbai w/ Thane, Borivali, Vashi branches; Pune; Delhi NCR;
 *     Bengaluru) → team leaders (line managers) → members
 *   - Master data lists (designations, cities, branches, states, job roles)
 *     so the governance dropdowns are populated
 *   - 4 teams, 6 courses, a 3-step learning path, org/team assignments,
 *     one overdue + one due-soon deadline
 *   - ~230 completed/in-progress attempts spread over the past 45 days with
 *     varied scores, a dozen live streaks, XP ledger + levels + badges,
 *     last month's recognition close, 2 opted-out users (privacy showcase),
 *     profile photos for ~35 users, 2 announcements
 *   - Refreshes the gamification + report matviews so every board and
 *     report is populated immediately
 *
 * Requires SUPABASE env (.env.local / .env.test.local): URL + service key.
 * Demo logins: any seeded email + password  Demo@Ambak1
 * Admin login: demo.admin@ambakdemo.test
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of [".env.local", ".env.test.local"]) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !SVC) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "content-type": "application/json" };

const SLUG = "ambak-demo";
const ORG_NAME = "Ambak Demo University";
const DOMAIN = "ambakdemo.test";
const PASSWORD = "Demo@Ambak1";
const DAY = 24 * 60 * 60 * 1000;

async function api(p, opts = {}) {
  const res = await fetch(`${SUPA}${p}`, { ...opts, headers: { ...H, ...(opts.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${p} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const rest = (p, o) => api(`/rest/v1${p}`, o);
const ret = { Prefer: "return=representation" };
const merge = { Prefer: "resolution=merge-duplicates" };

// Deterministic RNG so re-seeds produce the same world.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// ---------------------------------------------------------------- purge ----
async function listDemoAuthUsers() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await api(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const users = j.users ?? [];
    out.push(...users.filter((u) => u.email?.endsWith(`@${DOMAIN}`)));
    if (users.length < 1000) break;
  }
  return out;
}

if (process.argv.includes("--purge")) {
  const orgs = await rest(`/organizations?slug=eq.${SLUG}&select=id`);
  if (orgs[0]) {
    await rest(`/organizations?id=eq.${orgs[0].id}`, { method: "DELETE" });
    console.log("demo organization deleted (all org data cascades)");
  } else {
    console.log("demo organization not found (already removed)");
  }
  const users = await listDemoAuthUsers();
  for (const u of users) await api(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  console.log(`${users.length} demo auth accounts deleted`);
  for (const fn of ["refresh_gamification_views", "refresh_report_views"]) {
    try { await api(`/rest/v1/rpc/${fn}`, { method: "POST", body: "{}" }); } catch {}
  }
  console.log("matviews refreshed — LMS is clean of demo data");
  process.exit(0);
}

// ----------------------------------------------------------------- seed ----
const existing = await rest(`/organizations?slug=eq.${SLUG}&select=id`);
if (existing[0]) {
  console.error(`Org "${SLUG}" already exists. Run with --purge first, then re-seed.`);
  process.exit(1);
}

console.log("Creating demo organization…");
const org = (await rest(`/organizations`, { method: "POST", headers: ret,
  body: JSON.stringify({ name: ORG_NAME, slug: SLUG, brand_color: "#4f46e5" }) }))[0];

// Does this environment have migration 0056 (verticals/branches)?
let hasVerticals = true;
try { await rest(`/organization_members?select=business_vertical&limit=1`); }
catch { hasVerticals = false; }
console.log(`verticals/branches support: ${hasVerticals ? "yes" : "no (pre-0056 — seeding without them)"}`);

// ---- Master data (makes the governance dropdowns real) ----
const MASTER = {
  designation: ["Sales Executive", "Senior Sales Executive", "Area Manager", "Relationship Manager", "Branch Head"],
  city: ["Mumbai", "Pune", "Delhi NCR", "Bengaluru"],
  state: ["Maharashtra", "Delhi", "Karnataka"],
  job_role: ["Field Sales", "Inside Sales", "Partner Success", "Operations"],
  ...(hasVerticals ? { branch: ["Thane", "Borivali", "Vashi"] } : {}),
};
for (const [field, values] of Object.entries(MASTER)) {
  for (const value of values) {
    try {
      await rest(`/org_field_options`, { method: "POST",
        body: JSON.stringify({ organization_id: org.id, field, value }) });
    } catch { /* duplicate or pre-0056 field — fine */ }
  }
}

// ---- People ----
const FIRST = ["Aarav","Vivaan","Aditya","Arjun","Ishaan","Rohan","Kabir","Ananya","Diya","Ishita","Kavya","Meera","Priya","Riya","Sneha","Tanvi","Rahul","Vikram","Neha","Pooja","Amit","Suresh","Deepak","Anjali","Swati","Nikhil","Manish","Farhan","Zoya","Sana"];
const LAST = ["Sharma","Verma","Patel","Iyer","Nair","Reddy","Gupta","Mehta","Joshi","Kulkarni","Desai","Chopra","Malhotra","Banerjee","Das","Khan","Singh","Agarwal","Rao","Pillai"];

// city → { state, branches?, vertical mix }
const GEO = [
  { city: "Mumbai", state: "Maharashtra", branches: ["Thane", "Borivali", "Vashi"], verticals: ["Retail", "Retail", "Institutional"] },
  { city: "Pune", state: "Maharashtra", branches: [null], verticals: ["Institutional", "Retail"] },
  { city: "Delhi NCR", state: "Delhi", branches: [null], verticals: ["Institutional", "Fulfillment"] },
  { city: "Bengaluru", state: "Karnataka", branches: [null], verticals: ["Fulfillment", "Retail"] },
];

async function createUser(email, first, last, extra = {}) {
  const created = await api(`/auth/v1/admin/users`, { method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }) });
  await rest(`/profiles?on_conflict=id`, { method: "POST", headers: merge,
    body: JSON.stringify({ id: created.id, email, first_name: first, last_name: last,
      username: email, must_change_password: false, phone: `+91-98${between(10000000, 99999999)}`,
      ...extra }) });
  return created.id;
}

console.log("Creating 100 users (admin + 6 leaders + 93 learners)…");
const adminId = await createUser(`demo.admin@${DOMAIN}`, "Demo", "Admin");
await rest(`/organization_members`, { method: "POST",
  body: JSON.stringify({ organization_id: org.id, user_id: adminId, role: "super_owner",
    employee_id: "DEMO-ADMIN", node_id: "HQ", status: "active" }) });

// Leaders: one per (city, branch) slot.
const leaderSlots = [];
for (const g of GEO) for (const b of g.branches) leaderSlots.push({ ...g, branch: b });
// Mumbai gets 3 slots (one per branch) → 6 total.
const leaders = [];
let avatarN = 1;
const usedNames = new Set();
function freshName() {
  for (;;) {
    const f = pick(FIRST), l = pick(LAST);
    if (!usedNames.has(f + l)) { usedNames.add(f + l); return [f, l]; }
  }
}
for (let i = 0; i < leaderSlots.length; i++) {
  const slot = leaderSlots[i];
  const [f, l] = freshName();
  const email = `${f}.${l}${i}@${DOMAIN}`.toLowerCase();
  const id = await createUser(email, f, l, { avatar_url: `https://i.pravatar.cc/150?img=${avatarN++}` });
  const vertical = slot.verticals[0];
  await rest(`/organization_members`, { method: "POST",
    body: JSON.stringify({ organization_id: org.id, user_id: id, role: "member",
      employee_id: `DEMO-L${100 + i}`, node_id: `${slot.city.slice(0, 3).toUpperCase()}-${i}`,
      status: "active", designation: "Area Manager", job_role: "Field Sales",
      grade: "M2", city: slot.city, state: slot.state,
      date_of_joining: new Date(Date.now() - between(400, 1200) * DAY).toISOString().slice(0, 10),
      ...(hasVerticals ? { business_vertical: vertical, branch: slot.branch } : {}) }) });
  leaders.push({ id, email, name: `${f} ${l}`, slot, vertical });
}

const learners = [];
for (let i = 0; i < 93; i++) {
  const leader = leaders[i % leaders.length];
  const [f, l] = freshName();
  const email = `${f}.${l}${i}@${DOMAIN}`.toLowerCase();
  const withPhoto = i < 28;
  const id = await createUser(email, f, l,
    withPhoto ? { avatar_url: `https://i.pravatar.cc/150?img=${avatarN++}` } : {});
  const vertical = pick(leader.slot.verticals);
  await rest(`/organization_members`, { method: "POST",
    body: JSON.stringify({ organization_id: org.id, user_id: id, role: "member",
      employee_id: `DEMO-${1000 + i}`, node_id: `${leader.slot.city.slice(0, 3).toUpperCase()}-${i % 4}`,
      status: "active", designation: pick(MASTER.designation.slice(0, 3)),
      job_role: pick(MASTER.job_role), grade: pick(["A1", "A2", "B1"]),
      city: leader.slot.city, state: leader.slot.state,
      line_manager_id: leader.id, indirect_manager_id: adminId,
      date_of_joining: new Date(Date.now() - between(30, 900) * DAY).toISOString().slice(0, 10),
      ...(hasVerticals ? { business_vertical: vertical, branch: leader.slot.branch } : {}) }) });
  learners.push({ id, email, name: `${f} ${l}`, leader });
}
console.log(`  ${1 + leaders.length + learners.length} users created`);

// ---- Teams ----
console.log("Creating teams…");
const teamNames = ["Sales Titans", "Mumbai Mavericks", "Growth Gurus", "Service Stars"];
const teamIds = [];
for (const name of teamNames) {
  const t = (await rest(`/teams`, { method: "POST", headers: ret,
    body: JSON.stringify({ organization_id: org.id, name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") }) }))[0];
  teamIds.push(t.id);
}
const teamMemberships = learners.map((u, i) => ({ team_id: teamIds[i % teamIds.length], user_id: u.id }));
await rest(`/team_members`, { method: "POST", body: JSON.stringify(teamMemberships) });

// ---- Courses + learning path ----
console.log("Creating courses, assignments and a learning path…");
const COURSES = [
  ["ambak-sales-framework", "A.M.B.A.K. — The 5-Step Sales Framework"],
  ["home-loan-fundamentals", "Home Loan Fundamentals"],
  ["kyc-compliance", "KYC & Compliance Essentials"],
  ["objection-handling", "Customer Objection Handling"],
  ["digital-tools", "Digital Tools Onboarding"],
  ["advanced-negotiation", "Advanced Negotiation Skills"],
];
const courses = [];
for (const [slug, title] of COURSES) {
  const c = (await rest(`/courses`, { method: "POST", headers: ret,
    body: JSON.stringify({ organization_id: org.id, slug, title, is_active: true,
      description: `${title} — demo course for the client walkthrough.` }) }))[0];
  const pkg = (await rest(`/course_packages`, { method: "POST", headers: ret,
    body: JSON.stringify({ course_id: c.id }) }))[0];
  const v = (await rest(`/course_versions`, { method: "POST", headers: ret,
    body: JSON.stringify({ course_id: c.id, package_id: pkg.id, version_number: 1,
      manifest_type: "scorm12", launch_url: "index.html", manifest_data: {},
      storage_prefix: `${SLUG}/courses/${slug}/v1` }) }))[0];
  await rest(`/course_packages?id=eq.${pkg.id}`, { method: "PATCH",
    body: JSON.stringify({ current_version_id: v.id }) });
  await rest(`/courses?id=eq.${c.id}`, { method: "PATCH",
    body: JSON.stringify({ current_version_id: v.id }) });
  courses.push({ ...c, version_id: v.id });
}
// Org-wide assignments (one overdue, one due soon — deadline showcases).
const now = Date.now();
const orgAssign = [
  { course: 0 }, { course: 1, due: now - 2 * DAY }, { course: 2, due: now + 1.5 * DAY }, { course: 3 },
];
for (const a of orgAssign) {
  await rest(`/course_assignments`, { method: "POST",
    body: JSON.stringify({ course_id: courses[a.course].id, organization_id: org.id,
      assignee_type: "org", assigned_by: adminId,
      ...(a.due ? { due_at: new Date(a.due).toISOString() } : {}) }) });
}
await rest(`/course_assignments`, { method: "POST",
  body: JSON.stringify({ course_id: courses[4].id, organization_id: org.id,
    assignee_type: "team", team_id: teamIds[0], assigned_by: adminId }) });

const lp = (await rest(`/learning_paths`, { method: "POST", headers: ret,
  body: JSON.stringify({ organization_id: org.id, name: "New Hire Journey",
    description: "The three-step onboarding path every new joiner completes.",
    slug: "new-hire-journey", is_active: true }) }))[0];
for (const [n, ci] of [[1, 0], [2, 2], [3, 5]]) {
  await rest(`/learning_path_courses`, { method: "POST",
    body: JSON.stringify({ path_id: lp.id, course_id: courses[ci].id, step_number: n }) });
}
await rest(`/learning_path_assignments`, { method: "POST",
  body: JSON.stringify({ path_id: lp.id, organization_id: org.id, assignee_type: "org",
    assigned_by: adminId }) });

// ---- Activity: attempts + XP ledger + rollups ----
console.log("Generating 45 days of learning activity…");
const LADDER = [0, 100, 300, 700, 1500, 3000, 6000, 12000];
const levelFor = (xp) => LADDER.filter((t) => xp >= t).length;
const dstr = (ms) => new Date(ms).toISOString().slice(0, 10);

const everyone = [...leaders.map((l) => ({ ...l, isLeader: true })), ...learners];
const attempts = [];
const xpEvents = [];
const rollups = [];
const badges = [];
const active = everyone.filter((_, i) => i % 8 !== 5); // ~87% have activity
const streakers = new Set(active.slice(0, 12).map((u) => u.id));

for (const u of active) {
  const nDone = between(1, 5);
  const courseIdx = [...courses.keys()].sort(() => rnd() - 0.5).slice(0, nDone);
  const days = new Set();
  let totalXp = 0, completed = 0, perfects = 0, passed = 0;

  for (const ci of courseIdx) {
    const c = courses[ci];
    const score = rnd() < 0.08 ? 1 : Math.round((0.55 + rnd() * 0.44) * 100) / 100;
    const when = now - between(1, 45) * DAY - between(0, 9) * 3600 * 1000;
    const startedAt = new Date(when - between(20, 70) * 60000).toISOString();
    const completedAt = new Date(when).toISOString();
    const ok = score >= 0.7;
    attempts.push({ course_version_id: c.version_id, user_id: u.id, organization_id: org.id,
      status: ok ? "passed" : "failed", completion_status: "completed",
      success_status: ok ? "passed" : "failed", score, cmi_data: {},
      started_at: startedAt, completed_at: completedAt, last_activity_at: completedAt });
    days.add(dstr(when));
    completed++; if (ok) passed++;
    xpEvents.push({ organization_id: org.id, user_id: u.id, rule: "course_completed",
      xp: 100, course_id: c.id, source_day: dstr(when),
      dedupe_key: `complete:${u.id}:${c.id}`, created_at: completedAt,
      metadata: { demo: true } });
    totalXp += 100;
    if (score >= 0.9) {
      const perfect = score >= 0.999;
      if (perfect) perfects++;
      xpEvents.push({ organization_id: org.id, user_id: u.id,
        rule: perfect ? "perfect_score" : "high_score", xp: perfect ? 50 : 25,
        course_id: c.id, source_day: dstr(when),
        dedupe_key: `${perfect ? "perfect" : "high"}:${u.id}:${c.id}`,
        created_at: completedAt, metadata: { demo: true } });
      totalXp += perfect ? 50 : 25;
    }
  }

  // A dozen users hold live streaks ending today; others have scattered days.
  if (streakers.has(u.id)) {
    const len = between(3, 14);
    for (let d = 0; d < len; d++) days.add(dstr(now - d * DAY));
  } else {
    for (let d = 0; d < between(0, 6); d++) days.add(dstr(now - between(2, 44) * DAY));
  }
  for (const day of days) {
    xpEvents.push({ organization_id: org.id, user_id: u.id, rule: "daily_activity",
      xp: 10, course_id: null, source_day: day, dedupe_key: `daily:${org.id}:${u.id}:${day}`,
      created_at: `${day}T09:30:00.000Z`, metadata: { demo: true } });
    totalXp += 10;
  }

  // Streak rollup from the day set.
  const sorted = [...days].sort();
  let current = 0, longest = 0, run = 0, prev = null, runStart = null, curStart = null;
  for (const day of sorted) {
    if (prev && new Date(day) - new Date(prev) === DAY) run++;
    else { run = 1; runStart = day; }
    if (run > longest) longest = run;
    prev = day;
  }
  const last = sorted[sorted.length - 1] ?? null;
  if (last && new Date(dstr(now)) - new Date(last) <= DAY) { current = run; curStart = runStart; }
  if (longest >= 7) {
    xpEvents.push({ organization_id: org.id, user_id: u.id, rule: "streak_7", xp: 50,
      course_id: null, source_day: last, dedupe_key: `streak7:${org.id}:${u.id}:${runStart}`,
      created_at: `${last}T20:00:00.000Z`, metadata: { demo: true } });
    totalXp += 50;
    badges.push({ organization_id: org.id, user_id: u.id, badge_slug: "streak_7", metadata: { demo: true } });
  }
  if (perfects > 0) badges.push({ organization_id: org.id, user_id: u.id, badge_slug: "perfect_score", metadata: { demo: true } });
  if (passed >= 5) badges.push({ organization_id: org.id, user_id: u.id, badge_slug: "assessment_ace", metadata: { demo: true } });

  rollups.push({ organization_id: org.id, user_id: u.id, total_xp: totalXp,
    current_level: levelFor(totalXp), current_streak_days: current,
    longest_streak_days: longest, last_active_day: last, streak_started_day: curStart,
    courses_completed: completed, perfect_scores: perfects, assessments_passed: passed,
    opted_out: false });
}
// Some in-progress attempts (Resume buttons, "in progress" stats).
for (const u of active.slice(0, 25)) {
  const c = courses[between(0, 3)];
  const started = new Date(now - between(0, 3) * DAY).toISOString();
  // NOTE: bulk-insert rows must share identical keys (PGRST102).
  attempts.push({ course_version_id: c.version_id, user_id: u.id, organization_id: org.id,
    status: "in_progress", completion_status: "in_progress", success_status: "unknown",
    score: null, cmi_data: {}, started_at: started, completed_at: null,
    last_activity_at: started });
}
// Two learners exercise the privacy opt-out.
for (const r of rollups.slice(3, 5)) r.opted_out = true;

const batch = async (table, rows, size = 200) => {
  for (let i = 0; i < rows.length; i += size) {
    await rest(`/${table}`, { method: "POST", body: JSON.stringify(rows.slice(i, i + size)) });
  }
};
await batch("course_attempts", attempts);
await batch("xp_events", xpEvents);
await batch("user_gamification", rollups);
await batch("user_badges", badges);
console.log(`  ${attempts.length} attempts, ${xpEvents.length} XP events, ${badges.length} badges`);

// ---- Announcements ----
await rest(`/org_announcements`, { method: "POST", body: JSON.stringify([
  { organization_id: org.id, title: "Welcome to Ambak University!",
    body: "Complete your New Hire Journey this week and climb the leaderboard.",
    tone: "info", is_active: true, created_by: adminId },
  { organization_id: org.id, title: "KYC & Compliance refresh due",
    body: "The compliance module must be completed by everyone before month end.",
    tone: "warning", is_active: true, created_by: adminId },
]) });

// ---- Wake up every precomputed surface ----
console.log("Refreshing leaderboards, recognition history and reports…");
for (const fn of ["refresh_gamification_views", "gamification_close_month", "refresh_report_views"]) {
  try { await api(`/rest/v1/rpc/${fn}`, { method: "POST", body: "{}" }); }
  catch (e) { console.log(`  (${fn} skipped: ${String(e).slice(0, 120)})`); }
}

console.log(`
DONE — demo world ready.

  Org URL:      /${SLUG}   (e.g. https://<staging-host>/${SLUG}/dashboard)
  Admin login:  demo.admin@${DOMAIN}   password: ${PASSWORD}
  Any learner:  e.g. ${learners[0].email}   password: ${PASSWORD}
  Team leader:  e.g. ${leaders[0].email} (${leaders[0].name}, ${leaders[0].slot.city}${leaders[0].slot.branch ? "/" + leaders[0].slot.branch : ""})

Remove everything at once:
  node scripts/demo/seed-demo.mjs --purge
`);
