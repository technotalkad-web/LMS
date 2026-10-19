/**
 * Unit test for the ALDS P4 feature flag (lib/alds/flag.ts; ADR 0005 note (h),
 * ADR 0006 note (a)): default OFF, on only for "on", "1" or "true" (trimmed,
 * case-insensitive), plus the schema-missing classifier every P4 caller uses
 * to fail soft before 0100 is applied.
 *
 * Every case passes an explicit env object, so a shell that happens to have
 * ALDS_P4 set cannot change the result.
 *
 * Run:  npx tsx tests/unit/alds-flag.test.ts   (or npm run test:unit)
 */
import { ALDS_P4_ENV, aldsP4Enabled, isAldsSchemaMissing } from "../../lib/alds/flag";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("aldsP4Enabled");
{
  eq("env name is ALDS_P4", ALDS_P4_ENV, "ALDS_P4");
  eq("unset → off", aldsP4Enabled({}), false);
  eq("undefined value → off", aldsP4Enabled({ ALDS_P4: undefined }), false);
  for (const v of ["", "  ", "off", "0", "false", "no", "yes", "enabled", "onn", "true1", "11", "o n"]) {
    eq(`"${v}" → off`, aldsP4Enabled({ ALDS_P4: v }), false);
  }
  for (const v of ["on", "1", "true", "ON", "True", "TRUE", " on ", "1 ", "\ttrue\n"]) {
    eq(`${JSON.stringify(v)} → on`, aldsP4Enabled({ ALDS_P4: v }), true);
  }
  eq("another variable set to on → off", aldsP4Enabled({ NEXT_PUBLIC_ALDS_P4: "on", ALDS_P4_ON: "1" }), false);
}

console.log("isAldsSchemaMissing");
{
  eq("null → false", isAldsSchemaMissing(null), false);
  eq("undefined → false", isAldsSchemaMissing(undefined), false);
  for (const code of ["42703", "42P01", "42883", "PGRST204", "PGRST202"]) {
    eq(`code ${code} → true`, isAldsSchemaMissing({ code, message: "" }), true);
  }
  eq("schema cache message → true", isAldsSchemaMissing({ message: "Could not find the 'analytics_tier' column of 'course_versions' in the schema cache" }), true);
  eq("does not exist message → true", isAldsSchemaMissing({ code: null, message: 'relation "public.package_certifications" does not exist' }), true);
  eq("unique violation 23505 → false", isAldsSchemaMissing({ code: "23505", message: "duplicate key value violates unique constraint" }), false);
  eq("permission denied 42501 → false", isAldsSchemaMissing({ code: "42501", message: "permission denied for table course_versions" }), false);
  eq("empty error object → false", isAldsSchemaMissing({}), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
