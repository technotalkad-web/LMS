/**
 * Unit test for resolveEmails and its strict sibling resolveEmailsStrict
 * (lib/users/emails.ts; the strict one is for code that sends mail, ADR 0029
 * note of 2026-11-20, part 3), and a guard on the pages
 * that show a person's email. Reading one capped page of the whole project's
 * accounts leaves an org's members out once the project has more accounts, and
 * those pages then show the first 8 characters of a user id.
 *
 * Run:  npx tsx tests/unit/resolve-emails.test.ts   (or npm run test:unit)
 */
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmails, resolveEmailsStrict } from "../../lib/users/emails";

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

  // The strict reader (ADR 0029, note of 2026-11-20, part 3): for code that
  // sends mail, a failed read is never "no address".
  {
    const { svc, sizes } = fakeSvc();
    const out = await resolveEmailsStrict(svc, ids);
    eq("strict: every id resolves, in the same chunks", [out instanceof Map ? out.size : out, sizes], [400, [150, 150, 100]]);
  }
  {
    const { svc } = fakeSvc();
    const out = await resolveEmailsStrict(svc, ["a", "none"]);
    eq("strict: a profile with no email is absent, and that is a read that worked", out instanceof Map ? [...out.keys()] : out, ["a"]);
  }
  {
    const { svc, sizes } = fakeSvc();
    const out = await resolveEmailsStrict(svc, []);
    eq("strict: no ids, no read, an empty map", [sizes, out instanceof Map ? out.size : out], [[], 0]);
  }
  for (const failing of [1, 2, 3]) {
    const { svc, sizes } = fakeSvc(failing);
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { logged.push(a); };
    const out = await resolveEmailsStrict(svc, ids);
    console.error = real;
    eq(`strict: chunk ${failing} of 3 fails: "unreadable", never the other chunks' addresses`, out, "unreadable");
    eq("…the read stops at the failed chunk", sizes.length, failing);
    eq("…logged with the code only (no id, no address)", [logged.length, JSON.stringify(logged).includes("@"), JSON.stringify(logged).includes("u1")], [1, false, false]);
  }
  {
    const svc = { from: () => ({ select: () => ({ in: async () => { throw new Error("fetch failed for a@x.test"); } }) }) } as unknown as SupabaseClient;
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { logged.push(a); };
    const out = await resolveEmailsStrict(svc, ["a"]);
    console.error = real;
    eq("strict: a read that throws is \"unreadable\", and its message is not logged", [out, JSON.stringify(logged).includes("@")], ["unreadable", false]);
  }
  {
    const svc = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: null }) }) }) } as unknown as SupabaseClient;
    eq("strict: an answer with no rows and no error is \"unreadable\" (no rows is []), never \"no address\"", await resolveEmailsStrict(svc, ["a"]), "unreadable");
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
