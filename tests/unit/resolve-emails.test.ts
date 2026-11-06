/**
 * Unit test for resolveEmails (lib/users/emails.ts) and a guard on the pages
 * that show a person's email. Reading one capped page of the whole project's
 * accounts leaves an org's members out once the project has more accounts, and
 * those pages then show the first 8 characters of a user id.
 *
 * Run:  npx tsx tests/unit/resolve-emails.test.ts   (or npm run test:unit)
 */
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmails } from "../../lib/users/emails";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else {
    fail++;
    console.error(`FAIL ${n}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
};

type Row = { id: string; email: string | null };
function fakeSvc(failChunk?: number) {
  const sizes: number[] = [];
  const svc = {
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => {
          sizes.push(ids.length);
          if (failChunk === sizes.length) return { data: null, error: { code: "X1" } };
          const data: Row[] = ids.map((id) => ({ id, email: id === "none" ? null : `${id}@x.test` }));
          return { data, error: null };
        },
      }),
    }),
  };
  return { svc: svc as unknown as SupabaseClient, sizes };
}

async function main() {
  const ids = Array.from({ length: 400 }, (_, i) => `u${i}`);

  {
    const { svc, sizes } = fakeSvc();
    const out = await resolveEmails(svc, ids);
    eq("every id past the old cap resolves", out.size, 400);
    eq("no list above the house rule of 150", sizes, [150, 150, 100]);
    eq("the last id has its email", out.get("u399"), "u399@x.test");
  }
  {
    const { svc, sizes } = fakeSvc();
    const out = await resolveEmails(svc, new Set(["a", "a", "b", "", "none"]));
    eq("duplicates and blanks are dropped", sizes, [3]);
    eq("a null email is left out, so the caller can fall back", [...out.keys()], ["a", "b"]);
  }
  {
    const { svc, sizes } = fakeSvc();
    const out = await resolveEmails(svc, []);
    eq("no ids, no read", [sizes, out.size], [[], 0]);
  }
  {
    const { svc } = fakeSvc(2);
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { logged.push(a); };
    const out = await resolveEmails(svc, ids);
    console.error = real;
    eq("a failed chunk keeps the other chunks' emails", out.size, 250);
    eq("a failed chunk is logged with its code only", logged, [["[resolveEmails] read failed", "X1"]]);
  }

  // Pages that display a person's email must not read a capped list of accounts.
  const capped = /listUsers\(\s*\{\s*page:\s*1\b/;
  for (const f of [
    "app/[org]/(admin)/teams/page.tsx",
    "app/[org]/(admin)/users/new/page.tsx",
    "app/[org]/(admin)/users/[userId]/edit/page.tsx",
    "app/[org]/(admin)/notifications/page.tsx",
    "app/[org]/(admin)/reports/page.tsx",
    "app/[org]/(admin)/library/[courseId]/page.tsx",
    "app/[org]/(admin)/learning-paths/page.tsx",
    "app/(super-owner)/super/admins/page.tsx",
    "app/(super-owner)/super/audit/page.tsx",
    "app/(super-owner)/super/organizations/[id]/page.tsx",
  ]) {
    eq(`${f} reads no capped list`, capped.test(readFileSync(f, "utf8")), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
