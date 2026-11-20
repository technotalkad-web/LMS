/**
 * Unit test for resolveEmails and its strict sibling resolveEmailsStrict
 * (lib/users/emails.ts; the strict one is for code that sends mail, ADR 0029
 * note of 2026-11-20, part 3), and a guard on the pages
 * that show a person's email. Reading one capped page of the whole project's
 * accounts leaves an org's members out once the project has more accounts, and
 * those pages then show the first 8 characters of a user id. Also the house
 * rule's strict readers for mail (readAllStrict and readByIdsStrict in
 * lib/db/chunked.ts): whole sets or none, never a part.
 *
 * Run:  npx tsx tests/unit/resolve-emails.test.ts   (or npm run test:unit)
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmails, resolveEmailsStrict } from "../../lib/users/emails";
import { readAllStrict, readByIdsStrict } from "../../lib/db/chunked";

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

  // The house rule's strict readers (lib/db/chunked.ts; ADR 0029): a read
  // that decides who is mailed is whole or not used. Pages of 1000 rows
  // until a short one, `.in()` lists of 150 ids, never a part of a set.
  {
    /** A table of `total` rows; records each page asked for; page `failAt` (1-based) fails as `how`. */
    const table = (total: number, failAt?: number, how: "error" | "throw" | "null" = "error") => {
      const pages: Array<[number, number]> = [];
      const page = async (from: number, to: number) => {
        pages.push([from, to]);
        if (failAt === pages.length) {
          if (how === "throw") throw new Error("fetch failed");
          return how === "null" ? { data: null, error: null } : { data: null, error: { code: "X1" } };
        }
        return { data: Array.from({ length: Math.max(0, Math.min(to + 1, total) - from) }, (_, i) => from + i), error: null };
      };
      return { pages, page };
    };
    {
      const t = table(2500);
      const rows = await readAllStrict<number>(t.page);
      eq("readAllStrict: 2,500 rows read whole, in pages of 1000 until a short one", [Array.isArray(rows) ? rows.length : rows, t.pages], [2500, [[0, 999], [1000, 1999], [2000, 2999]]]);
    }
    {
      const t = table(1000);
      const rows = await readAllStrict<number>(t.page);
      eq("…exactly 1000 rows: one more page is asked, and it is empty", [Array.isArray(rows) ? rows.length : rows, t.pages.length], [1000, 2]);
    }
    for (const how of ["error", "throw", "null"] as const) {
      const t = table(2500, 2, how);
      eq(`…a second page that ${how === "error" ? "fails" : how === "throw" ? "throws" : "answers neither rows nor an error"}: "unreadable", never the first page's rows`, await readAllStrict<number>(t.page), "unreadable");
    }
    {
      const t = table(2500);
      let room = 1;
      const rows = await readAllStrict<number>(t.page, () => room-- > 0);
      eq("…no room for the second page: \"no_room\", and that page is not read", [rows, t.pages.length], ["no_room", 1]);
    }
    {
      const lists: number[] = [];
      const rows = await readByIdsStrict<string>(["", "a", "a", ...ids], async (part) => {
        lists.push(part.length);
        return { data: part, error: null };
      });
      eq("readByIdsStrict: blanks and duplicates dropped, lists of at most 150 ids, every id read", [lists, Array.isArray(rows) ? rows.length : rows], [[150, 150, 101], 401]);
      let asked = 0;
      eq("…a failed list: \"unreadable\"", await readByIdsStrict<string>(ids, async (part) => (++asked === 2 ? { data: null, error: { code: "X1" } } : { data: part, error: null })), "unreadable");
      let reads = 0;
      eq("…no ids: no read, no rows", [await readByIdsStrict<string>([], async () => { reads++; return { data: [], error: null }; }), reads], [[], 0]);
    }
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

  // ADR 0029 (part 3 of the note of 2026-11-20): every file under app/ and
  // lib/ that sends mail takes the strict reader, so a failed read of
  // addresses is never "no address". Pages that only show addresses keep the
  // loose one. A file that still holds the loose one beside a send is named
  // in LOOSE_STILL_TO_COME with the stage that changes it; the case fails as
  // soon as it no longer does, so the list never goes stale.
  {
    const ROOT = path.resolve(__dirname, "..", "..");
    const SENDS = /\b(sendNotification|notifyBackground|sendMany|sendPlatformEmail|sendAuthEmail|sendSettingsTest|notifyLearnerOfDecision|notifyAdminsOfRequest|notifyAdminsOfTicket|notifyRequesterOfTicket|notifyCourseUpdate)\s*\(/;
    const LOOSE = /\bresolveEmails\s*\(|emails:\s*resolveEmails\b(?!Strict)/;
    const LOOSE_STILL_TO_COME: Record<string, string> = {
      "app/api/super/tenants/[id]/admins/route.ts": "stage 3: the console's welcome moves to the platform sender",
    };
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, d.name);
        if (d.isDirectory()) walk(q);
        else if (/\.(ts|tsx)$/.test(d.name)) files.push(q);
      }
    };
    walk(path.join(ROOT, "app"));
    walk(path.join(ROOT, "lib"));
    const offenders: string[] = [];
    let senders = 0;
    for (const abs of files) {
      const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
      const src = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      if (rel === "lib/users/emails.ts" || !SENDS.test(src)) continue;
      senders++;
      if (LOOSE.test(src) && !(rel in LOOSE_STILL_TO_COME)) offenders.push(rel);
    }
    eq(`non-vacuous: the scan reads the files that send (${senders})`, senders >= 20, true);
    eq("no file that sends mail reads addresses with the loose resolveEmails", offenders, []);
    for (const [rel, stage] of Object.entries(LOOSE_STILL_TO_COME)) {
      eq(`still to come, ${stage}: ${rel} still holds the loose reader (remove it from the list when it does not)`, LOOSE.test(readFileSync(path.join(ROOT, rel), "utf8")), true);
    }
    eq("a planted file that sends and reads loosely is caught", LOOSE.test("const m = await resolveEmails(svc, ids); await sendMany(run, m, f);") && SENDS.test("await sendMany(run, m, f);"), true);
    eq("…the strict reader is not mistaken for the loose one", LOOSE.test("const m = await resolveEmailsStrict(svc, ids); notify: { emails: resolveEmailsStrict }"), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
