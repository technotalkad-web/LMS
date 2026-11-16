/**
 * The course page's "Change language" menu (ADR 0024 P2-9, step 27 (d); the
 * P2-9 review's F3), with the real page run.
 *
 * The course page is the Individual course: its menu sends `{kind:
 * "individual"}`, so the confirm it words must count the Individual
 * course's open attempts only. An open path or journey attempt passed to it
 * would make the menu promise "Your attempt in progress on this course will
 * be reset", and the route would then close nothing (it reads and closes by
 * the Individual key).
 *
 * The page is called as Next calls a server component. requireOrgAccess,
 * learnerCanAccessCourse and both Supabase clients are stubbed at module
 * load (a recording query builder answering from a small world); everything
 * else is the real code. The returned element tree is walked, not rendered,
 * to the ChangeLanguageMenu element, and its props are read:
 *
 *   (a) open attempts in English in a path and in a journey day, and an
 *       Individual one in Hindi: `inProgress` holds the Individual row only,
 *       by its package's language;
 *   (b) a row with no context_kind (a database without 0107) reads as the
 *       Individual course's, as before;
 *   (c) only a path and a journey row open: `inProgress` is empty, so the
 *       confirm says that nothing is reset (switchConfirmText's words, on
 *       the props the page passes);
 *   (d) a completed or abandoned row and a revision visit's row are never
 *       in it (the page's existing filters).
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/course-page-change-language.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import React from "react";
import { switchConfirmText, type InProgressAttemptLang } from "../../lib/courses/slot-routing";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
const ORG = "0a000000-0000-4000-8000-000000000001";
const USER = "02000000-0000-4000-8000-000000000001";
const COURSE = "0c000000-0000-4000-8000-000000000001";
const PKG_EN = "0b000000-0000-4000-8000-000000000001";
const PKG_HI = "0b000000-0000-4000-8000-000000000002";
const V_EN = "01000000-0000-4000-8000-000000000001";
const V_HI = "01000000-0000-4000-8000-000000000002";
const PATH = "0d000000-0000-4000-8000-000000000001";
const ENR = "0e000000-0000-4000-8000-000000000001";
const DAY = "0f000000-0000-4000-8000-000000000001";

const COURSE_ROW: Row = {
  id: COURSE, organization_id: ORG, title: "Course", description: "", is_active: true, visibility: "private",
  current_version_id: V_EN, show_attempts_history: true, thumbnail_url: null,
};
const VERSIONS: Row[] = [
  { id: V_EN, course_id: COURSE, version_number: 1, manifest_type: "cmi5", launch_url: "index.html", manifest_data: {}, uploaded_at: "2026-11-01T00:00:00Z", package_id: PKG_EN },
  { id: V_HI, course_id: COURSE, version_number: 2, manifest_type: "cmi5", launch_url: "index.html", manifest_data: {}, uploaded_at: "2026-11-01T00:00:00Z", package_id: PKG_HI },
];
const PACKAGES: Row[] = [
  { id: PKG_EN, course_id: COURSE, language: "en", display_name: "English", is_active: true, current_version_id: V_EN },
  { id: PKG_HI, course_id: COURSE, language: "hi", display_name: "Hindi", is_active: true, current_version_id: V_HI },
];

type Op = [string, unknown[]];
/** A recording query builder answering from the world's attempts; `no0107`: a filter on context_kind answers 42703. */
function stubClient(attempts: Row[], no0107 = false) {
  const answer = (table: string, ops: Op[], single: boolean): { data: unknown; error: { code: string; message: string } | null; count?: number } => {
    if (no0107 && table === "course_attempts" && ops.some(([, a]) => a[0] === "context_kind")) {
      return { data: null, error: { code: "42703", message: "column course_attempts.context_kind does not exist" } };
    }
    const rows = ((): Row[] => {
      switch (table) {
        case "courses":
          return [COURSE_ROW];
        case "course_versions":
          return VERSIONS;
        case "course_packages":
          return PACKAGES;
        case "course_attempts":
          // The filters the page's read names: the user, the versions, and
          // withoutPreviews' neq (PostgREST's neq drops a null too).
          return attempts.filter((r) =>
            ops.every(([o, a]) => {
              if (o === "eq") return r[a[0] as string] === a[1];
              if (o === "in") return (a[1] as unknown[]).includes(r[a[0] as string]);
              if (o === "neq") return r[a[0] as string] !== null && r[a[0] as string] !== undefined && r[a[0] as string] !== a[1];
              return true;
            })
          );
        default:
          return [];
      }
    })();
    return { data: single ? rows[0] ?? null : rows, error: null, count: rows.length };
  };
  const from = (table: string) => {
    const ops: Op[] = [];
    let single = false;
    const b: Record<string, unknown> = {};
    for (const op of ["eq", "in", "neq", "is", "not", "or", "limit", "order", "range", "gt", "gte", "lt", "lte"]) b[op] = (...a: unknown[]) => (ops.push([op, a]), b);
    b.abortSignal = () => b;
    b.select = () => b;
    b.maybeSingle = () => ((single = true), b);
    b.single = () => ((single = true), b);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answer(table, ops, single)).then(res, rej);
    return b;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

/** The first element of the tree whose props hold `options` and `inProgress` (the menu), walking children and fragments. */
function menuOf(node: unknown): Record<string, unknown> | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = menuOf(n);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return null;
  if (typeof el.type === "function" && (el.type as { name?: string }).name === "ChangeLanguageMenu") return el.props;
  return menuOf(el.props.children);
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const quiet = { warn: console.warn, error: console.error };
  console.warn = () => {};
  console.error = () => {};
  let client: ReturnType<typeof stubClient> | null = null;
  const realLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
  (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
    if (request === "@/lib/auth/require-org-access") {
      return { requireOrgAccess: async () => ({ user: { id: USER }, org: { id: ORG, name: "Org", slug: "o" }, role: "user", impersonation: null }) };
    }
    if (request === "@/lib/auth/course-access") {
      return { learnerCanAccessCourse: async () => ({ allowed: true, upcomingAt: null, startPathId: null }) };
    }
    if (request === "@/lib/supabase/server") return { createClient: async () => client };
    if (request === "@supabase/supabase-js") return { createClient: () => client };
    return realLoad.call(this, request, ...rest);
  };
  (globalThis as { React?: unknown }).React = React;
  try {
    const page = (await import("../../app/[org]/(learner)/courses/[courseId]/page")).default as (a: unknown) => Promise<unknown>;
    const run = async (attempts: Row[], no0107 = false) => {
      client = stubClient(attempts, no0107);
      const tree = await page({ params: Promise.resolve({ org: "o", courseId: COURSE }), searchParams: Promise.resolve({}) });
      return menuOf(tree);
    };
    const row = (id: string, version: string, kind: string | null, extra: Row = {}): Row => ({
      id, user_id: USER, course_version_id: version, status: "in_progress", completion_status: "incomplete", success_status: null,
      score: null, started_at: "2026-11-10T00:00:00Z", completed_at: null, is_revision: false,
      ...(kind === null ? {} : { context_kind: kind }),
      learning_path_id: kind === "path" ? PATH : null, journey_enrollment_id: kind === "journey" ? ENR : null,
      journey_day_id: kind === "journey" ? DAY : null,
      ...extra,
    });
    const PATH_EN = row("path-en", V_EN, "path");
    const DAY_EN = row("day-en", V_EN, "journey");
    const words = (inProgress: InProgressAttemptLang[]) =>
      switchConfirmText({ product: "individual", target: "hi", targetLabel: "Hindi", inProgress, labelOf: (l) => (l === "en" ? "English" : l === "hi" ? "Hindi" : String(l)) });

    console.log("\n(a) open attempts in a path and a journey day beside the Individual course's");
    {
      const menu = await run([PATH_EN, DAY_EN, row("ind-hi", V_HI, "individual")]);
      eq("the menu renders with both languages", [menu !== null, (menu?.options as Row[] | undefined)?.map((o) => o.language)], [true, ["en", "hi"]]);
      eq("its inProgress is the Individual course's row only, by its package's language (no path or journey row)",
        menu?.inProgress, [{ language: "hi", grantedRetake: false }]);
    }

    console.log("\n(b) a database without 0107: a row with no context_kind");
    {
      const menu = await run([row("legacy", V_EN, null)], true);
      eq("the read falls back without the preview filter, and the page reads a missing context_kind as the Individual course's",
        menu?.inProgress, [{ language: "en", grantedRetake: false }]);
    }

    console.log("\n(c) only a path and a journey row open");
    {
      const menu = await run([PATH_EN, DAY_EN]);
      eq("inProgress is empty", menu?.inProgress, []);
      eq("…so the menu's confirm for Hindi says that nothing is reset on this course (no promise of a reset)",
        words((menu?.inProgress ?? []) as InProgressAttemptLang[]).startsWith("You have no attempt in progress on this course, so nothing is reset."), true);
    }

    console.log("\n(d) the page's other filters");
    {
      const menu = await run([
        row("done", V_EN, "individual", { status: "completed", completion_status: "completed", completed_at: "2026-11-11T00:00:00Z" }),
        row("gone", V_EN, "individual", { status: "abandoned" }),
        row("rev", V_EN, "individual", { is_revision: true }),
        row("ind-en", V_EN, "individual"),
      ]);
      eq("a completed or abandoned row and a revision visit's row are left out; the open Individual row is in", menu?.inProgress, [{ language: "en", grantedRetake: false }]);
    }
  } finally {
    console.warn = quiet.warn;
    console.error = quiet.error;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = realLoad;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
