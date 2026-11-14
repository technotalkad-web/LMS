/**
 * ADR 0020 step 8: the one definition of "enrolled on a course" stays one.
 * Source scans, no database.
 *
 *   (a) the SQL twin of lib/org/groups.ts parseGroupRules in
 *       supabase/migrations/0105_enrolment_expansion.sql (comments stripped)
 *       knows every rule key TypeScript knows (RULE_ARRAY_KEYS and
 *       joined_within_days), the 200-value cap and the 3650-day cap, so a
 *       rule key added to TypeScript fails CI until the SQL twin learns it;
 *       each of the three view bodies expands groups through
 *       group_member_ids (never a join of the whole group view). The group
 *       and path views are 0105's; the course view is read from its latest
 *       definer, supabase/migrations/0107_learning_contexts.sql (ADR 0024
 *       step 18, decision D2): the four direct arms (user, team, org-wide,
 *       Custom Group), each behind its release gate, no path arm and no
 *       hold-back; 0105's body, which has both, is the control that those
 *       checks can fail. The two terms views of 0107 write the same arms out
 *       again with their dates, so they are held to the same rules;
 *   (b) Organisation Reports stays on members and official pairs: its page
 *       reads neither the enrolment view, the course matviews nor the loader,
 *       its Completion rate is completed over official pairs and its Total
 *       users is the member count;
 *   (c) the four readers of steps 5 and 7 read the enrolled set from the view
 *       (ENROLMENTS_VIEW or the literal), so a revert of one fails the job;
 *       the learners table and its CSV page every direct-row read, since
 *       their "path" label is what no read direct row reaches, and read the
 *       attempts and profiles of the enrolled set in chunks of 150, paged
 *       (lib/db/chunked.ts);
 *   (d) the launch page's hold-back gate is still there. 0105's view
 *       copied it (ADR 0020 rule 2); from 0107 the view has no hold-back
 *       (ADR 0024 decision D2), and the gate stays on the launch page until
 *       phase 2's resolver replaces it (ADR 0024 step 22);
 *   (e) ADR 0024 step 49: the three attempts reads over the enrolled set (the
 *       loader behind the course card and Reports tab, the learners table,
 *       its CSV) are the Individual product, so each goes through
 *       individualContextOnly and adds `.eq("context_kind", "individual")`
 *       when it applies; no other file calls individualContextOnly (a path
 *       or journey surface must never read the Individual context only).
 *
 * Run:  npx tsx tests/unit/enrolment-definition.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { RULE_ARRAY_KEYS } from "../../lib/org/groups";
import { ENROLMENTS_VIEW } from "../../lib/scoring/status";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
/** The shape of scripts/check-migration-grants.mjs: block and line comments removed. */
const stripSqlComments = (sql: string) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
/** TypeScript with line and block comments blanked (strings kept), so a comment naming the view is not a read. */
const stripTsComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const MIGRATION = "supabase/migrations/0105_enrolment_expansion.sql";
/** The course view's latest definer (ADR 0024 step 18). */
const MIGRATION_0107 = "supabase/migrations/0107_learning_contexts.sql";
/** The body of `create or replace view public.<view>`, up to its first `;` (in SQL already comment-stripped and lower-cased). */
const viewBody = (sql: string, view: string) =>
  new RegExp(`create\\s+or\\s+replace\\s+view\\s+public\\.${view}\\b([^;]*);`).exec(sql)?.[1] ?? null;

console.log("\n(a) the SQL twin of parseGroupRules knows every TypeScript rule key");
{
  const sql = stripSqlComments(read(MIGRATION)).toLowerCase();
  for (const key of [...RULE_ARRAY_KEYS, "joined_within_days"]) {
    eq(`0105 reads the rule key '${key}' (outside comments)`, sql.includes(`'${key}'`), true);
  }
  eq("non-vacuous: RULE_ARRAY_KEYS has the nine array keys", RULE_ARRAY_KEYS.length, 9);
  eq("0105 caps a rule list at 200 values (`limit 200`)", /\blimit\s+200\b/.test(sql), true);
  eq("0105 caps joined_within_days at 3650 (`<= 3650`)", /<=\s*3650\b/.test(sql), true);
  const sql0107 = stripSqlComments(read(MIGRATION_0107)).toLowerCase();
  // Each view's body from its latest definer: the group and path views are
  // 0105's, the course view 0107's (ADR 0024 step 18).
  const bodies: Array<[string, string, string]> = [
    ["v_group_members_expanded", "0105", sql],
    ["v_path_enrollments_expanded", "0105", sql],
    ["v_course_enrollments_expanded", "0107", sql0107],
  ];
  for (const [v, file, src] of bodies) {
    const body = viewBody(src, v);
    eq(`${v}: its body is in ${file}`, body !== null, true);
    eq(`${v}: its body expands groups through group_member_ids`, /\bgroup_member_ids\s*\(/.test(body ?? ""), true);
    eq(`${v}: its body joins no whole group view`, /\bjoin\s+public\.v_group_members_expanded\b/.test(body ?? ""), false);
  }

  // The latest definer of the course view is 0107, so the checks below read
  // the body the database has after it (a later migration that redefines the
  // view fails here until this test reads its body).
  const definers = fs
    .readdirSync(path.join(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => viewBody(stripSqlComments(read(`supabase/migrations/${f}`)).toLowerCase(), "v_course_enrollments_expanded") !== null);
  eq("v_course_enrollments_expanded is defined by 0031, 0105 and 0107, the last of them 0107",
    definers, ["0031_reports_foundation.sql", "0105_enrolment_expansion.sql", "0107_learning_contexts.sql"]);

  /** A course enrolment body's shape: its direct arms (the assignment rows, alias ca), their release gates, a path arm, the hold-back. */
  const shape = (body: string) => ({
    arms: [...body.matchAll(/\bca\.assignee_type\s*=\s*'(\w+)'/g)].map((m) => m[1]).sort(),
    releaseGates: (body.match(/\(\s*ca\.release_at\s+is\s+null\s+or\s+ca\.release_at\s*<=\s*now\(\)\s*\)/g) ?? []).length,
    pathArm: /\b(learning_path_courses|learning_paths|learning_path_assignments|v_path_enrollments_expanded)\b/.test(body),
    holdBack: [/\bnot\s+exists\b/.test(body), /release_at\s*>\s*now\(\)/.test(body), /'org_public'/.test(body)],
  });
  const course0107 = shape(viewBody(sql0107, "v_course_enrollments_expanded") ?? "");
  eq("0107's course view: the four direct arms (user, team, org-wide, Custom Group), each behind its release gate",
    [course0107.arms, course0107.releaseGates], [["group", "org", "team", "user"], 4]);
  eq("0107's course view: no path arm (no step, path or path-assignment table, no path enrolment view; decision D2)",
    course0107.pathArm, false);
  eq("0107's course view: no hold-back (no `not exists`, no future release, no org_public path)",
    course0107.holdBack, [false, false, false]);
  // The control: 0105's body has the path arm and the hold-back, so the two
  // checks above can fail.
  const course0105 = shape(viewBody(sql, "v_course_enrollments_expanded") ?? "");
  eq("control: 0105's course view has the four arms, the path arm and the hold-back",
    [course0105.arms, course0105.pathArm, course0105.holdBack], [["group", "org", "team", "user"], true, [true, true, true]]);

  // The terms views of 0107 write the enrolment arms out again with their
  // dates (step 18): the same group expansion, and for a course the same
  // four released direct arms and no path arm.
  for (const v of ["v_course_enrollment_terms", "v_path_enrollment_terms"]) {
    const body = viewBody(sql0107, v);
    eq(`${v}: its body is in 0107`, body !== null, true);
    eq(`${v}: it expands groups through group_member_ids, never a join of the whole group view`,
      [/\bgroup_member_ids\s*\(/.test(body ?? ""), /\bjoin\s+public\.v_group_members_expanded\b/.test(body ?? "")], [true, false]);
  }
  const terms = shape(viewBody(sql0107, "v_course_enrollment_terms") ?? "");
  eq("v_course_enrollment_terms: the course view's four released direct arms, no path arm",
    [terms.arms, terms.releaseGates, terms.pathArm], [["group", "org", "team", "user"], 4, false]);
}

console.log("\n(b) Organisation Reports stays on members and official pairs");
{
  const src = read("app/[org]/(admin)/reports/page.tsx");
  for (const token of ["v_course_enrollments_expanded", "mv_course_enrollment_status", "mv_course_performance", "total_enrolled", "loadEnrolledCourseStatus", "ENROLMENTS_VIEW"]) {
    eq(`reports/page.tsx does not name ${token}`, src.includes(token), false);
  }
  eq("its Completion rate is completed over official pairs",
    /const\s+completionRate\s*=\s*officialPairs\.length\s*===\s*0\s*\?\s*0\s*:\s*totals\.completed\s*\/\s*officialPairs\.length\s*;/.test(src), true);
  eq("its Total users is the member count", /\btotalUsers\s*:\s*members\.length\b/.test(src), true);
}

console.log("\n(c) the four readers read the enrolled set from the view");
{
  eq("ENROLMENTS_VIEW is the view", ENROLMENTS_VIEW, "v_course_enrollments_expanded");
  const READERS = [
    "lib/scoring/status.ts",
    "app/[org]/(admin)/library/page.tsx",
    "app/[org]/(admin)/library/[courseId]/learners/page.tsx",
    "app/api/courses/[courseId]/learners/export/route.ts",
  ];
  const readsView = /\.from\(\s*(?:ENROLMENTS_VIEW|"v_course_enrollments_expanded")\s*\)/;
  for (const f of READERS) {
    eq(`${f}: reads .from(ENROLMENTS_VIEW) outside comments`, readsView.test(stripTsComments(read(f))), true);
  }
  // The Library list reads with the service role after canViewReports (an
  // analyst's session reads an incomplete set through the invoker view).
  const lib = stripTsComments(read("app/[org]/(admin)/library/page.tsx"));
  eq("library/page.tsx: the view read sits behind canViewReports(role) and a service-role client",
    [/canViewReports\(role\)/.test(lib), /SUPABASE_SERVICE_ROLE_KEY/.test(lib), /svc\s*\n?\s*\.from\(ENROLMENTS_VIEW\)/.test(lib)], [true, true, true]);
  eq("library/page.tsx: no fresh expansion (no team_members or course_assignments read)",
    [/\.from\("team_members"\)/.test(lib), /\.from\("course_assignments"\)/.test(lib)], [false, false]);
  // The learners table and its CSV label "path" any enrolled learner no
  // released direct row reaches, so each direct-row read is paged (a read
  // cut at the row cap would mislabel the learners past it).
  for (const f of [
    "app/[org]/(admin)/library/[courseId]/learners/page.tsx",
    "app/api/courses/[courseId]/learners/export/route.ts",
  ]) {
    const src = stripTsComments(read(f));
    for (const table of ["course_assignments", "organization_members", "team_members"]) {
      const reads = src.split(`.from("${table}")`).slice(1).map((after) => after.split(";")[0]);
      eq(`${f}: every .from("${table}") read is paged with .range(`,
        [reads.length > 0, reads.every((r) => /\.range\(/.test(r))], [true, true]);
    }
    // The attempts and profiles reads over the enrolled set follow the house
    // rule of lib/db/chunked.ts (the lead's ruling of 2026-11-11): chunks of
    // 150 ids, each paged in id order; no .in() takes the whole enrolled set.
    eq(`${f}: no .in() takes the whole enrolled set`,
      /\.in\(\s*"[a-z_]+"\s*,\s*enrolledUserIds\s*\)/.test(src), false);
    eq(`${f}: profiles through fetchByIds (chunks of 150, paged in id order), no direct profiles read`,
      [/fetchByIds<[^>]*>\(\s*svc,\s*"profiles",\s*"id, first_name, last_name",\s*"id",\s*enrolledUserIds\s*\)/.test(src), /\.from\("profiles"\)/.test(src)],
      [true, false]);
    const attemptReads = src.split(`.from("course_attempts")`).slice(1).map((after) => after.split(";")[0]);
    eq(`${f}: every course_attempts read takes one chunk of chunk(enrolledUserIds, 150), in id order, paged with .range(`,
      [/for \(const part of chunk\(enrolledUserIds, 150\)\)/.test(src), attemptReads.length > 0,
        attemptReads.every((r) => /\.in\("user_id", part\)/.test(r) && /\.order\("id"\)/.test(r) && /\.range\(/.test(r))],
      [true, true, true]);
  }
}

console.log("\n(d) the launch page's hold-back gate is still there (until ADR 0024 phase 2's resolver, step 22)");
{
  const launch = read("app/[org]/(learner)/courses/[courseId]/launch/page.tsx");
  eq("launch/page.tsx redirects to dashboard?upcoming=", launch.includes("dashboard?upcoming="), true);
  eq("launch/page.tsx computes enforcedPathIds", launch.includes("enforcedPathIds"), true);
}

console.log("\n(e) the Individual product's attempts reads take the Individual context when 0107 is there (ADR 0024 step 49)");
{
  const INDIVIDUAL_READERS = [
    "lib/scoring/status.ts",
    "app/[org]/(admin)/library/[courseId]/learners/page.tsx",
    "app/api/courses/[courseId]/learners/export/route.ts",
  ];
  for (const f of INDIVIDUAL_READERS) {
    const src = stripTsComments(read(f));
    const reads = src.split(`.from("course_attempts")`).slice(1).map((after) => after.split(";")[0]);
    eq(`${f}: one course_attempts read`, reads.length, 1);
    eq(`${f}: it is built inside individualContextOnly(individual, …), one state for every chunk`,
      [/const individual: IndividualFilterState = \{ applies: null \};/.test(src),
        /individualContextOnly\(individual, \((columns), (f|from), (t|to), only\)[^=]*=>\s*\{\s*const q = [a-z]+\s*\.from\("course_attempts"\)/.test(src)],
      [true, true]);
    eq(`${f}: and adds .eq("context_kind", "individual") when it applies, nothing else`,
      /\.range\((f|from), (t|to)\);\s*return only \? q\.eq\("context_kind", "individual"\) : q;\s*\}\)/.test(src), true);
  }
  // No other file calls it: a path or journey surface reads its own context
  // (ADR 0024 steps 43 and 45), never the Individual one.
  const walk = (dir: string, out: string[]) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  };
  const all: string[] = [];
  for (const d of ["app", "lib", "components"]) walk(path.join(root, d), all);
  const callers = all.filter((f) => /(?<!function\s)\bindividualContextOnly\(/.test(stripTsComments(read(f)))).sort();
  eq("individualContextOnly is called by exactly these three files", callers, [...INDIVIDUAL_READERS].sort());
}

console.log(`\n==== enrolment definition: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
