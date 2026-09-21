/**
 * Mobile responsiveness audit (phones: 360 / 390 / 412 px).
 *
 * Seeds realistic long names, designations and a populated leaderboard on
 * the qa-scoring org, then drives every learner, admin and public route as
 * the right role and measures, per page and width:
 *   - horizontal page / <main> overflow
 *   - elements spilling past the viewport edge (outside a scroll container)
 *   - ellipsis-truncated text (names, labels)
 *   - overflow-hidden containers clipping wider content
 * Screenshots at 360 px. Prints a per-route line and an issue summary.
 *
 *   node tests/mobile/audit.mjs                 seed + audit everything
 *   node tests/mobile/audit.mjs --no-seed       audit only
 *   node tests/mobile/audit.mjs --only=leaderboard,courses   subset
 *
 * Known false positives: decorative hero SVGs (clipped on purpose) and
 * sr-only spans (1px by design).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Repo-relative: run from the project root against a dev server on the
// staging database (E2E_BASE_URL overrides). Screenshots + report.json
// land in tests/mobile/shots (git-ignored).
const ROOT = process.cwd(), BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const OUT = path.join(ROOT, "tests", "mobile", "shots");
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = createRequire(`${ROOT}/package.json`)("playwright");
for (const f of [".env.local", ".env.test.local"]) {
  try {
    for (const line of fs.readFileSync(`${ROOT}/${f}`, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
const args = process.argv.slice(2);
const NO_SEED = args.includes("--no-seed");
const ONLY = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL, SVC = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const REF = new URL(SUPA).hostname.split(".")[0];
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "content-type": "application/json" };
const SLUG = "qa-scoring", PW = "Sc!Aa1-verify";
const OWNER = "qa+scoring-owner@example.test", LEARNER = "qa+scoring-learner@example.test";
const L2 = "qa+mob-l2@example.test", L3 = "qa+mob-l3@example.test";
async function api(p, opts = {}) {
  const res = await fetch(`${SUPA}${p}`, { ...opts, headers: { ...H, ...(opts.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${p} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const rest = (p, o) => api(`/rest/v1${p}`, o);
const merge = { Prefer: "resolution=merge-duplicates" }, ret = { Prefer: "return=representation" };
async function ensureUser(email, first, last) {
  const j = await api(`/auth/v1/admin/users?page=1&per_page=1000`);
  let id = (j.users ?? []).find((u) => u.email === email)?.id ?? null;
  if (!id) id = (await api(`/auth/v1/admin/users`, { method: "POST", body: JSON.stringify({ email, password: PW, email_confirm: true }) })).id;
  await rest(`/profiles?on_conflict=id`, { method: "POST", headers: merge, body: JSON.stringify({ id, email, first_name: first, last_name: last, must_change_password: false }) });
  return id;
}
async function grant(email) {
  const res = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
function cookiesOf(s) {
  const value = "base64-" + Buffer.from(JSON.stringify(s)).toString("base64url");
  const name = `sb-${REF}-auth-token`;
  const parts = [];
  if (value.length <= 3180) parts.push([name, value]);
  else for (let i = 0; i * 3180 < value.length; i++) parts.push([`${name}.${i}`, value.slice(i * 3180, (i + 1) * 3180)]);
  return parts.map(([n, v]) => ({ name: n, value: v, domain: "localhost", path: "/" }));
}
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

// ---------------- seed ----------------
let org = (await rest(`/organizations?slug=eq.${SLUG}&select=id`))[0];
if (!org) org = (await rest(`/organizations`, { method: "POST", headers: ret, body: JSON.stringify({ name: "QA Scoring Org", slug: SLUG }) }))[0];
const ow = await ensureUser(OWNER, "Score", "Owner");
const lr = await ensureUser(LEARNER, "Venkatasubramaniam", "Ramachandran Iyer");
const l2 = await ensureUser(L2, "Priya", "Krishnamurthy Venkataraman");
const l3 = await ensureUser(L3, "Mohammed Abdul", "Rahman Khan");
const members = [
  [ow, "owner", "SCR-OWN", "Head of Learning & Development", "Mumbai", "Institutional", "Bandra Kurla Complex"],
  [lr, "member", "SCR-001", "Senior Business Development Manager", "Mumbai", "Institutional", "Andheri East"],
  [l2, "member", "SCR-002", "Relationship Manager – Home Loans", "Navi Mumbai", "Institutional", "Vashi"],
  [l3, "member", "SCR-003", "Business Manager", "Mumbai", "Institutional", "Andheri East"],
];
if (!NO_SEED) {
  for (const [uid, role, emp, designation, city, business_vertical, branch] of members) {
    await rest(`/organization_members?on_conflict=organization_id,user_id`, { method: "POST", headers: merge, body: JSON.stringify({ organization_id: org.id, user_id: uid, role, employee_id: emp, node_id: null, status: "active", designation, city, business_vertical, branch, job_role: designation }) });
  }
  // Leaderboard data: XP ledger + gamification totals + completed attempts (scores).
  const gam = [[lr, 1520, 4, 6, 12, 5], [l2, 980, 3, 2, 9, 3], [l3, 640, 2, 0, 4, 2]];
  for (const [uid, total_xp, current_level, current_streak_days, longest_streak_days, courses_completed] of gam) {
    await rest(`/user_gamification?on_conflict=organization_id,user_id`, { method: "POST", headers: merge, body: JSON.stringify({ organization_id: org.id, user_id: uid, total_xp, current_level, current_streak_days, longest_streak_days, courses_completed, last_active_day: daysAgo(0).slice(0, 10) }) });
  }
  const xp = [];
  const activeDays = { [lr]: [0, 1, 2, 3, 5, 8, 9, 12, 15, 20, 26, 40, 45, 50], [l2]: [1, 4, 7, 11, 18, 22, 33, 47], [l3]: [2, 6, 13, 21, 38] };
  for (const [uid, days] of Object.entries(activeDays)) {
    for (const d of days) xp.push({ organization_id: org.id, user_id: uid, rule: "daily_activity", xp: 10, source_day: daysAgo(d).slice(0, 10), dedupe_key: `qa-mob:${uid}:day:${daysAgo(d).slice(0, 10)}`, created_at: daysAgo(d) });
    xp.push({ organization_id: org.id, user_id: uid, rule: "course_completed", xp: 100, source_day: daysAgo(3).slice(0, 10), dedupe_key: `qa-mob:${uid}:cc:1`, created_at: daysAgo(3) });
    xp.push({ organization_id: org.id, user_id: uid, rule: "course_completed", xp: 100, source_day: daysAgo(40).slice(0, 10), dedupe_key: `qa-mob:${uid}:cc:2`, created_at: daysAgo(40) });
  }
  await rest(`/xp_events?on_conflict=dedupe_key`, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify(xp) });
  const orgCourses = await rest(`/courses?organization_id=eq.${org.id}&select=id,current_version_id&order=created_at.asc&limit=3`);
  const versions = orgCourses.filter((c) => c.current_version_id).map((c) => ({ id: c.current_version_id, course_id: c.id }));
  const scores = { [lr]: 0.92, [l2]: 0.81, [l3]: 0.66 };
  for (const v of versions) {
    for (const uid of [lr, l2, l3]) {
      const existing = await rest(`/course_attempts?course_version_id=eq.${v.id}&user_id=eq.${uid}&completion_status=eq.completed&select=id&limit=1`);
      if (existing.length) continue;
      await rest(`/course_attempts`, { method: "POST", body: JSON.stringify({ course_version_id: v.id, user_id: uid, organization_id: org.id, status: "completed", completion_status: "completed", success_status: "passed", score: scores[uid], started_at: daysAgo(4), completed_at: daysAgo(4), progress_pct: 100 }) });
    }
  }
  for (const fn of ["refresh_gamification_views", "refresh_report_views"]) {
    try { await api(`/rest/v1/rpc/${fn}`, { method: "POST", body: "{}" }); } catch (e) { console.warn(`${fn}: ${e.message.slice(0, 120)}`); }
  }
  console.log("seeded");
}

// ---------------- discover ids ----------------
const course = (await rest(`/courses?organization_id=eq.${org.id}&select=id,title&order=created_at.desc&limit=1`))[0];
const attempt = (await rest(`/course_attempts?user_id=eq.${lr}&select=id,course_version_id,course_versions!course_attempts_course_version_id_fkey(course_id)&order=started_at.desc&limit=1`))[0];
const lp = (await rest(`/learning_paths?organization_id=eq.${org.id}&select=id&limit=1`))[0];
const ticket = null;
const attemptCourse = attempt?.course_versions?.course_id ?? course?.id;

const learnerRoutes = [
  "/dashboard", "/courses", `/courses/${course?.id}`, `/courses/${attemptCourse}/attempts/${attempt?.id}`,
  `/courses/${course?.id}/launch`, "/journey", "/journey/certificate",
  "/leaderboard", "/leaderboard?board=active", "/leaderboard?board=scorer", "/leaderboard?board=improved", "/leaderboard?board=streak", "/leaderboard?board=vertical",
  lp ? `/paths/${lp.id}` : null, "/profile", "/support", "/team-performance",
].filter(Boolean);
const adminRoutes = [
  "/analytics", "/announcements", "/gamification", "/groups", "/integrations", "/journey-admin",
  "/learning-paths", lp ? `/learning-paths/${lp.id}/learners` : null, lp ? `/learning-paths/${lp.id}/reports` : null,
  "/library", `/library/${course?.id}`, `/library/${course?.id}/learners`, `/library/${course?.id}/reports`, "/library/upload",
  "/master-data", "/notifications", "/reports", "/settings", "/teams", "/tickets", "/users", `/users/${lr}/edit`, "/users/new",
].filter(Boolean);
const publicRoutes = ["/login", `/${SLUG}/login`, "/forgot-password", "/select-org", "/change-password"];

const VIEWPORTS = [
  { name: "360", width: 360, height: 800 },
  { name: "390", width: 390, height: 844 },
  { name: "412", width: 412, height: 915 },
];

const METRICS = `() => {
  const iw = window.innerWidth;
  const doc = document.documentElement;
  const out = { innerW: iw, docScrollW: doc.scrollWidth, bodyScrollW: document.body.scrollWidth, offscreen: [], truncated: [], clipped: [], mainScroll: null };
  const main = document.querySelector('main');
  if (main) out.mainScroll = { sw: main.scrollWidth, cw: main.clientWidth };
  const hasScrollAncestor = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { if (p === main) continue; const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  const desc = (el) => ({ tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90), text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60) });
  const all = Array.from(document.querySelectorAll('body *'));
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // partially visible but spilling past the right edge (or left)
    if ((r.right > iw + 2 && r.left < iw) || (r.left < -2 && r.right > 0)) {
      if (!hasScrollAncestor(el) && cs.position !== 'fixed') {
        const fixedAnc = (() => { for (let p = el.parentElement; p; p = p.parentElement) { if (getComputedStyle(p).position === 'fixed') return true; } return false; })();
        if (!fixedAnc) out.offscreen.push({ ...desc(el), right: Math.round(r.right), left: Math.round(r.left), w: Math.round(r.width) });
      }
    }
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && (el.innerText || '').trim()) {
      out.truncated.push({ ...desc(el), full: (el.innerText || '').trim().slice(0, 80), cw: el.clientWidth, sw: el.scrollWidth });
    }
    if ((cs.overflowX === 'hidden' || cs.overflow === 'hidden') && el.scrollWidth > el.clientWidth + 3 && cs.textOverflow !== 'ellipsis' && (el.innerText || '').trim() && el.children.length < 60) {
      out.clipped.push({ ...desc(el), cw: el.clientWidth, sw: el.scrollWidth });
    }
  }
  // dedupe nested offscreen: keep outermost 12
  out.offscreen = out.offscreen.slice(0, 12);
  out.truncated = out.truncated.slice(0, 20);
  out.clipped = out.clipped.slice(0, 12);
  return out;
}`;

const slug = (s) => s.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "") || "root";
const report = [];
const browser = await chromium.launch();
async function auditRole(roleName, cookies, routes, prefix) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36" });
    if (cookies) await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    for (const route of routes) {
      const key = slug(route);
      if (ONLY.length && !ONLY.some((o) => key.includes(o))) continue;
      const url = `${BASE}${prefix}${route}`;
      const entry = { role: roleName, route: prefix + route, vp: vp.name, url };
      try {
        const res = await page.goto(url, { waitUntil: "load", timeout: 150000 });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        entry.status = res?.status();
        entry.final = page.url().replace(BASE, "");
        await page.waitForTimeout(600);
        Object.assign(entry, await page.evaluate(`(${METRICS})()`));
        if (vp.name === "360") {
          await page.screenshot({ path: `${OUT}/${roleName}-${key}-${vp.name}${ONLY.length ? "-only" : ""}.png`, fullPage: true });
        }
      } catch (e) {
        entry.error = e.message.slice(0, 200);
      }
      report.push(entry);
      const flags = [];
      if (entry.docScrollW > entry.innerW + 2) flags.push(`DOC-OVERFLOW ${entry.docScrollW}>${entry.innerW}`);
      if (entry.mainScroll && entry.mainScroll.sw > entry.mainScroll.cw + 2) flags.push(`MAIN-SCROLL ${entry.mainScroll.sw}>${entry.mainScroll.cw}`);
      if (entry.offscreen?.length) flags.push(`offscreen:${entry.offscreen.length}`);
      if (entry.truncated?.length) flags.push(`truncated:${entry.truncated.length}`);
      if (entry.clipped?.length) flags.push(`clipped:${entry.clipped.length}`);
      console.log(`${roleName.padEnd(7)} ${vp.name} ${String(entry.status ?? "ERR").padEnd(3)} ${(prefix + route).padEnd(60)} ${flags.join("  ")}${entry.error ? "  ERR " + entry.error : ""}`);
    }
    // Interactive bits at 360 only
    if (vp.name === "360" && roleName === "learner" && !ONLY.length) {
      await page.goto(`${BASE}${prefix}/dashboard`, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
      const avatarBtn = page.locator("header button").last();
      if (await avatarBtn.count()) { await avatarBtn.click().catch(() => {}); await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/learner-profile-dropdown-360.png` }); report.push({ role: roleName, route: "dropdown", vp: "360", ...(await page.evaluate(`(${METRICS})()`)) }); }
    }
    await ctx.close();
  }
}

const lrCookies = cookiesOf(await grant(LEARNER));
const owCookies = cookiesOf(await grant(OWNER));
await auditRole("learner", lrCookies, learnerRoutes, `/${SLUG}`);
await auditRole("admin", owCookies, adminRoutes, `/${SLUG}`);
await auditRole("public", null, publicRoutes, "");
await browser.close();
fs.writeFileSync(`${OUT}/report${ONLY.length ? "-only" : ""}.json`, JSON.stringify(report, null, 1));

// ---------------- summary ----------------
console.log("\n==== ISSUES ====");
for (const e of report) {
  const issues = [];
  if (e.docScrollW > e.innerW + 2) issues.push(`page scrolls horizontally: ${e.docScrollW}px in ${e.innerW}px`);
  if (e.mainScroll && e.mainScroll.sw > e.mainScroll.cw + 2) issues.push(`<main> scrolls horizontally: ${e.mainScroll.sw}px in ${e.mainScroll.cw}px`);
  for (const o of e.offscreen ?? []) issues.push(`offscreen <${o.tag} .${o.cls.split(" ").slice(0, 4).join(".")}> "${o.text}" right=${o.right}`);
  for (const t of e.truncated ?? []) issues.push(`truncated "${t.full}" (${t.cw}/${t.sw}px) <${t.tag} .${t.cls.split(" ").slice(0, 4).join(".")}>`);
  for (const c of e.clipped ?? []) issues.push(`clipped <${c.tag} .${c.cls.split(" ").slice(0, 4).join(".")}> "${c.text}" (${c.cw}/${c.sw}px)`);
  if (issues.length) { console.log(`\n[${e.role} ${e.vp}] ${e.route} (${e.status}${e.final && e.final !== e.route ? " → " + e.final : ""})`); for (const i of issues) console.log("   - " + i); }
}
