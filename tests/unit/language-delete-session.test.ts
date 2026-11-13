/**
 * The language (package) DELETE route deletes on the caller's session, never
 * through the service role. Deleting a course_packages row cascades to its
 * course_versions and their course_attempts, and the learner-history guard on
 * course_versions (0098, 0100) returns early for the service role; the
 * route's attempt count cannot see an attempt inserted after it, so only a
 * session delete lets the guard refuse that case (ADR 0003 step 10).
 * Source scan, no database. Spec 50 proves the cascade reaches the guard.
 *
 * Run:  npx tsx tests/unit/language-delete-session.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const file = "app/api/courses/[courseId]/packages/[packageId]/route.ts";
const src = fs.readFileSync(path.join(root, file), "utf8");
const del = src.slice(src.indexOf("export async function DELETE("));

console.log("\nthe language DELETE route deletes on the caller's session");
eq("DELETE handler found", del.length > 0 && src.includes("export async function DELETE("), true);
const pkgDeletes = [...del.matchAll(/(\w+)\s*\.from\("course_packages"\)\s*\.delete\(\)/g)].map((m) => m[1]);
eq("exactly one course_packages delete in DELETE", pkgDeletes.length, 1);
eq("it runs on the session client (supabase), not svc", pkgDeletes[0], "supabase");
eq("supabase is the cookie-session client in DELETE", /const supabase = await createClient\(\);/.test(del), true);
eq("createClient comes from the session helper", /import \{ createClient \} from "@\/lib\/supabase\/server";/.test(src), true);
eq("no service-role delete of course_packages or course_versions in DELETE", /svc\s*\.from\("course_(packages|versions)"\)\s*\.delete\(/.test(del), false);
eq("learner_history_exists maps to 409", /isLearnerHistoryError\(error\)[\s\S]{0,400}status: 409/.test(del), true);
eq("a delete that RLS filtered (no row back) is not answered ok", /\.select\("id"\)[\s\S]{0,900}length !== 1/.test(del), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
