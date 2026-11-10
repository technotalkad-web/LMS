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
 *       group_member_ids (never a join of the whole group view);
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
 *   (d) the launch page's hold-back gate is still there (the view's
 *       `not exists` clause copies it; ADR 0020 rule 2: a change to the gate
 *       changes the view in the same pull request).
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

console.log("\n(a) the SQL twin of parseGroupRules knows every TypeScript rule key");
{
  const sql = stripSqlComments(read(MIGRATION)).toLowerCase();
  for (const key of [...RULE_ARRAY_KEYS, "joined_within_days"]) {
    eq(`0105 reads the rule key '${key}' (outside comments)`, sql.includes(`'${key}'`), true);
  }
  eq("non-vacuous: RULE_ARRAY_KEYS has the nine array keys", RULE_ARRAY_KEYS.length, 9);
  eq("0105 caps a rule list at 200 values (`limit 200`)", /\blimit\s+200\b/.test(sql), true);
  eq("0105 caps joined_within_days at 3650 (`<= 3650`)", /<=\s*3650\b/.test(sql), true);
  const views = ["v_group_members_expanded", "v_path_enrollments_expanded", "v_course_enrollments_expanded"];
  for (const v of views) {
    const m = new RegExp(`create\\s+or\\s+replace\\s+view\\s+public\\.${v}\\b([^;]*);`).exec(sql);
    eq(`${v}: its body is in 0105`, m !== null, true);
    eq(`${v}: its body expands groups through group_member_ids`, /\bgroup_member_ids\s*\(/.test(m?.[1] ?? ""), true);
    eq(`${v}: its body joins no whole group view`, /\bjoin\s+public\.v_group_members_expanded\b/.test(m?.[1] ?? ""), false);
  }
  const course = new RegExp("create\\s+or\\s+replace\\s+view\\s+public\\.v_course_enrollments_expanded\\b([^;]*);").exec(sql)?.[1] ?? "";
  eq("the course view keeps the launch page's hold-back (a future step of an org_public or assigned path)",
    [/\bnot\s+exists\b/.test(course), /release_at\s*>\s*now\(\)/.test(course), /'org_public'/.test(course)], [true, true, true]);
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

console.log("\n(d) the launch page's hold-back gate is still there");
{
  const launch = read("app/[org]/(learner)/courses/[courseId]/launch/page.tsx");
  eq("launch/page.tsx redirects to dashboard?upcoming=", launch.includes("dashboard?upcoming="), true);
  eq("launch/page.tsx computes enforcedPathIds", launch.includes("enforcedPathIds"), true);
}

console.log(`\n==== enrolment definition: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
