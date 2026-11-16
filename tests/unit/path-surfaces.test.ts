/**
 * The learner's path page and the dashboard path tile on the path rule (ADR
 * 0024 phase 2, P2-7 items 2, 3, 6 and 7): the real pages under a stubbed
 * fetch (the precedent of attempt-page-official-sentence.test.ts: next/headers
 * stubbed through Module._load, redirect() caught by its digest), the path
 * page rendered with renderToStaticMarkup and the dashboard's element tree
 * read for the DashboardGrid's cards.
 *
 *   (a) the path page: the steps' states from pathProgress() over the path
 *       rows, the grants, the facts, the completion and the terms; the shown
 *       steps numbered among themselves; the hint only when a shown earlier
 *       step is not done; pathStepLabel's words beside a done step's result
 *       (O4); the end banner and the celebration from the stored completion
 *       only (P2-Q1); the due date from the terms, read on a service client
 *       naming the organisation and the learner (ruling (a));
 *   (b) O5-d and the owner's P2-Q1 answer on the path page: a step whose
 *       course is inactive is not rendered, for a completed and an
 *       in-progress learner; an inactive path redirects, for both;
 *   (c) the dashboard tile: done of total over the shown steps, completed
 *       from the stored completion only, the terms' due date; O5-d with the
 *       course and then the path inactive, for a completed and an
 *       in-progress learner; a path with no shown step is left off; the
 *       ?locked= notice names nothing when only a hidden step is in the way;
 *   (d) a failed read shows a notice (the path page) or leaves the tile out
 *       (the dashboard), never a step locked or not done on a guess; a
 *       database without 0107 reads the facts as none, and the completion
 *       and the terms as none (the Gate line);
 *   (e) the request counts of each page (in the page; no layout, no
 *       middleware), which do not grow with the number of steps;
 *   (f) ADR 0024 P2-9 (step 27 (c)): a step the learner can launch whose
 *       course has two or more active languages offers "Change language",
 *       the launch's own picker in the path's context (?lp= and
 *       ?switch=choose); no other step does; one packages read, only when a
 *       step can be launched; a failed read shows no link and nothing else
 *       changes.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/path-surfaces.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PATH_STEP_LABEL_TEXT } from "../../lib/paths/progress";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; query: URLSearchParams; apikey: string | null };

const SUPABASE = "http://stub.supabase.test";
const USER = { id: "u1", aud: "authenticated", role: "authenticated", email: "learner@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const SERVICE_KEY = "stub-service-key";
const PATH = "11111111-1111-4111-8111-111111111111";
const PKEY = `path:${PATH}`;
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "33333333-3333-4333-8333-333333333333";
const C3 = "44444444-4444-4444-8444-444444444444";
const TITLES: Record<string, string> = { [C1]: "Alpha Module", [C2]: "Bravo Module", [C3]: "Charlie Module" };
const BOOM = { code: "XX000", message: "the read failed" };
const CONTEXT_FIELDS = ["context_kind", "context_key", "journey_day_id", "journey_version_id"];

// tsx compiles the pages' JSX to React.createElement.
(globalThis as { React?: unknown }).React = React;

const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => [{ name: "sb-stub-auth-token", value: SESSION }], get: () => undefined, set() {} }),
      headers: async () => new Headers({ host: "lms.test" }),
    };
  }
  return load.call(this, request, ...rest);
};

type StepCfg = { course: string; n: number; active?: boolean; stepRule?: boolean | null; courseRule?: boolean; releaseAt?: string | null };
type World = {
  pathActive: boolean;
  sequence: "strict" | "random";
  steps: StepCfg[];
  /** The learner's rows, every context, as a database with 0107 holds them. */
  attempts: Row[];
  grants: Row[];
  facts: Row[];
  completion: Row | null;
  terms: Row | null;
  assignmentDue: string | null;
  no0107: boolean;
  /** Tables whose read answers an error. */
  failing: string[];
  /** Active language packages per course (1 when not named). */
  languages: Record<string, number>;
};
const STEPS: StepCfg[] = [{ course: C1, n: 1 }, { course: C2, n: 2 }, { course: C3, n: 3 }];
const fresh = (): World => ({
  pathActive: true, sequence: "strict", steps: STEPS, attempts: [], grants: [], facts: [], completion: null, terms: null,
  assignmentDue: null, no0107: false, failing: [], languages: {},
});
let world: World = fresh();
let requests: Req[] = [];
const unmatched: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const strip = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => !CONTEXT_FIELDS.includes(k)));
const missingRelation = (t: string) => json({ code: "PGRST205", message: `Could not find the table 'public.${t}' in the schema cache` }, 404);
const inList = (q: URLSearchParams, col: string) => (q.get(col) ?? "").replace(/^in\.\(|\)$/g, "").split(",").filter(Boolean);

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  requests.push({ method, path: p, select, query: url.searchParams, apikey: headers.get("apikey") });
  const table = p.replace("/rest/v1/", "");
  if (world.failing.includes(table)) return json(BOOM, 500);
  const q = url.searchParams;
  switch (p) {
    case "/auth/v1/user":
      return json(USER);
    case "/rest/v1/profiles":
      return json([{ must_change_password: false, first_name: "Pat", last_name: "Learner" }]);
    case "/rest/v1/organizations":
      return json([{ id: "o1", name: "Acme", slug: "acme", logo_url: null, brand_color: null, brand_font: null, custom_domain: null }]);
    case "/rest/v1/organization_members":
      return json([{ role: "member" }]);
    case "/rest/v1/learning_paths": {
      if (q.has("visibility")) return json([]);
      const row = { id: PATH, name: "Onboarding Path", description: null, organization_id: "o1", is_active: world.pathActive, thumbnail_url: null, visibility: "private", sequence_mode: world.sequence };
      if (q.get("is_active") === "eq.true" && !world.pathActive) return json([]);
      return json([row]);
    }
    case "/rest/v1/learning_path_assignments":
      return json([{ id: "pa1", organization_id: "o1", path_id: PATH, assignee_type: "user", user_id: USER.id, team_id: null, group_id: null, due_at: world.assignmentDue }]);
    case "/rest/v1/learning_path_courses": {
      const stepRule = /,pass_required$/.test(select);
      if (stepRule && world.no0107) return json({ code: "42703", message: "column learning_path_courses.pass_required does not exist" }, 400);
      return json(world.steps.map((s) => ({
        path_id: PATH,
        course_id: s.course,
        step_number: s.n,
        release_at: s.releaseAt ?? null,
        courses: { id: s.course, title: TITLES[s.course], description: null, current_version_id: `v-${s.course}`, is_active: s.active !== false, pass_required: s.courseRule === true },
        ...(stepRule ? { pass_required: s.stepRule ?? null } : {}),
      })));
    }
    case "/rest/v1/course_packages":
      return json(inList(q, "course_id").flatMap((id) => Array.from({ length: world.languages[id] ?? 1 }, () => ({ course_id: id }))));
    case "/rest/v1/course_versions":
      return json(world.steps.map((s) => ({ id: `v-${s.course}`, course_id: s.course, version_number: 1, manifest_type: "cmi5" })));
    case "/rest/v1/courses": {
      if (q.has("visibility")) return json([]);
      const ids = inList(q, "id");
      const cfg = world.steps.filter((s) => ids.includes(s.course));
      if (q.get("pass_required") === "eq.true") return json(cfg.filter((s) => s.courseRule === true).map((s) => ({ id: s.course, pass_required: true })));
      const active = q.get("is_active") === "eq.true" ? cfg.filter((s) => s.active !== false) : cfg;
      return json(active.map((s) => ({ id: s.course, title: TITLES[s.course], description: null, current_version_id: `v-${s.course}`, updated_at: "2026-01-01T00:00:00Z", thumbnail_url: null, thumbnail_fit: null, thumbnail_pos_x: null, thumbnail_pos_y: null })));
    }
    case "/rest/v1/course_attempts": {
      const filtered = q.get("context_kind") === "neq.preview";
      if (world.no0107 && filtered) return json({ code: "42703", message: "column course_attempts.context_kind does not exist" }, 400);
      let rows = world.attempts;
      if (q.has("learning_path_id")) rows = rows.filter((r) => inList(q, "learning_path_id").includes(String(r.learning_path_id)));
      if (filtered) rows = rows.filter((r) => r.context_kind !== "preview");
      return json(world.no0107 ? rows.map(strip) : rows);
    }
    case "/rest/v1/attempt_requests":
      if (world.no0107 && select.includes("context_key")) return json({ code: "42703", message: "column attempt_requests.context_key does not exist" }, 400);
      return json(world.no0107 ? world.grants.map(strip) : world.grants);
    case "/rest/v1/learning_path_step_completions":
      return world.no0107 ? missingRelation("learning_path_step_completions") : json(world.facts);
    case "/rest/v1/learning_path_completions":
      return world.no0107 ? missingRelation("learning_path_completions") : json(world.completion ? [world.completion] : []);
    case "/rest/v1/v_path_enrollment_terms":
      return world.no0107 ? missingRelation("v_path_enrollment_terms") : json(world.terms ? [world.terms] : []);
    case "/rest/v1/rpc/effective_attempt_policies":
      return json([]);
    case "/rest/v1/rpc/get_my_gamification":
      return json(null);
    case "/rest/v1/gamification_settings":
    case "/rest/v1/journey_enrollments":
    case "/rest/v1/team_members":
    case "/rest/v1/org_announcements":
    case "/rest/v1/course_assignments":
    case "/rest/v1/dashboard_backgrounds":
      return json([]);
  }
  unmatched.push(`${method} ${p}`);
  return json([]);
};

const row = (id: string, course: string, outcome: "passed" | "failed" | "completed" | "open", day: number, o: Row = {}): Row => {
  const d = String(day).padStart(2, "0");
  const done = outcome !== "open";
  return {
    id, user_id: USER.id, course_version_id: `v-${course}`, status: outcome === "open" ? "in_progress" : outcome,
    completion_status: done ? "completed" : "in_progress", success_status: outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "unknown",
    score: outcome === "passed" ? 0.9 : outcome === "failed" ? 0.4 : outcome === "completed" ? 0.7 : null,
    started_at: `2026-02-${d}T09:00:00Z`, completed_at: done ? `2026-02-${d}T09:30:00Z` : null, is_revision: false,
    context_kind: "path", context_key: PKEY, learning_path_id: PATH, journey_enrollment_id: null, journey_day: null, journey_day_id: null, journey_version_id: null,
    progress_pct: null, ...o,
  };
};
const COMPLETED = [row("a1", C1, "passed", 1), row("a2", C2, "passed", 2), row("a3", C3, "passed", 3)];
const COMPLETION = { path_id: PATH, completed_at: "2026-02-04T00:00:00Z", path_score: 0.9 };
const IN_PROGRESS = [row("a1", C1, "passed", 1), row("a2", C2, "open", 2)];
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/<!-- -->/g, "");

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (x: unknown): x is El => typeof x === "object" && x !== null && "type" in x && "props" in x;
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) elements(n, out); return out; }
  if (!isEl(node)) return out;
  out.push(node);
  elements(node.props.children, out);
  return out;
}
function texts(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out; }
  if (isEl(node)) texts(node.props.children, out);
  return out;
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  (process.env as Record<string, string>).NODE_ENV = "test";
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  globalThis.fetch = stub as typeof fetch;
  let logs: string[] = [];
  console.warn = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.error = () => {};
  try {
    const pathPage = (await import("../../app/[org]/(learner)/paths/[pathId]/page")).default;
    const dashboard = (await import("../../app/[org]/(learner)/dashboard/page")).default;
    const redirectOf = (e: unknown): string => {
      const digest = (e as { digest?: unknown }).digest;
      if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) throw e;
      return digest.split(";").slice(2, -2).join(";");
    };
    const openPath = async (w: Partial<World>, sp: Record<string, string> = {}) => {
      world = { ...fresh(), ...w };
      requests = []; logs = [];
      try {
        const tree = await pathPage({ params: Promise.resolve({ org: "acme", pathId: PATH }), searchParams: Promise.resolve(sp) });
        return { html: decode(renderToStaticMarkup(tree as ReactElement)), redirect: null as string | null, all: requests.length, events: logs.filter((l) => l.startsWith("{")).map((l) => (JSON.parse(l) as Row).event) };
      } catch (e) {
        return { html: "", redirect: redirectOf(e), all: requests.length, events: [] as unknown[] };
      }
    };
    const openDashboard = async (w: Partial<World>, sp: Record<string, string> = {}) => {
      world = { ...fresh(), ...w };
      requests = []; logs = [];
      const tree = await dashboard({ params: Promise.resolve({ org: "acme" }), searchParams: Promise.resolve(sp) });
      const grid = elements(tree).find((el) => typeof el.type === "function" && (el.type as { name?: string }).name === "DashboardGrid");
      const cards = ((grid?.props.cards ?? []) as Array<Record<string, unknown>>);
      return {
        tile: cards.find((c) => c.kind === "path") ?? null,
        courseCards: cards.filter((c) => c.kind !== "path").map((c) => c.course_id),
        text: texts(tree).join(" "),
        all: requests.length,
        events: logs.filter((l) => l.startsWith("{")).map((l) => (JSON.parse(l) as Row).event),
      };
    };
    const stepNumbers = (html: string) => [...html.matchAll(/Step (\d+)/g)].map((m) => Number(m[1]));
    const shownTitles = (html: string) => [C1, C2, C3].filter((c) => html.includes(TITLES[c])).map((c) => TITLES[c]);
    const HINT = "Finish the previous step to unlock";
    const CELEBRATION = "You finished this path";

    console.log("\n(a) the path page on the path rule");
    {
      const r = await openPath({ attempts: IN_PROGRESS });
      eq("in progress: every step shown, numbered 1 to 3, 1 / 3 done", [shownTitles(r.html), stepNumbers(r.html), r.html.includes("33% completed")], [[TITLES[C1], TITLES[C2], TITLES[C3]], [1, 2, 3], true]);
      eq("…step 2 resumes (its official row is open), step 3 is locked by it with the hint", [r.html.includes("Resume"), r.html.includes(`title="${HINT}"`)], [true, true]);
      eq("…no celebration, no end banner without a completion", [r.html.includes(CELEBRATION), r.html.includes("continue-end-banner")], [false, false]);
      const individual = await openPath({ attempts: [row("i1", C1, "passed", 1, { context_kind: "individual", context_key: "individual", learning_path_id: null })] });
      eq("an Individual completion of step 1 does not advance the path (only the path's own rows count)", individual.html.includes("0% completed"), true);
      const revision = await openPath({ attempts: [row("a1", C1, "passed", 1), row("r2", C2, "open", 2, { is_revision: true })] });
      eq("an open revision visit's row never marks a step in progress (step 2 reads Launch, not Resume)", [revision.html.includes("Resume"), revision.html.includes("Launch")], [false, true]);
      const d14 = await openPath({
        steps: [{ course: C1, n: 1, courseRule: true }, { course: C2, n: 2 }, { course: C3, n: 3 }],
        attempts: [row("a1", C1, "passed", 1), row("a2", C1, "failed", 3)],
        grants: [{ id: "g1", course_id: C1, used_attempt_id: "a2", used_at: "2026-02-02T10:00:00Z", expires_at: null, created_at: "2026-02-02T08:00:00Z", context_key: PKEY }],
      });
      eq("D14: passed, then a failed granted retake: done, with the label beside the latest result, and step 2 open",
        [d14.html.includes(PATH_STEP_LABEL_TEXT.passed_earlier), d14.html.includes("Score: 40%"), d14.html.includes(`/courses/${C2}/launch?lp=${PATH}`)], [true, true, true]);
      const fact = await openPath({
        steps: [{ course: C1, n: 1, stepRule: true }, { course: C2, n: 2 }, { course: C3, n: 3 }],
        attempts: [row("a1", C1, "completed", 1)],
        facts: [{ path_id: PATH, course_id: C1, done_at: "2026-02-01T10:00:00Z", rule_pass_required: false }],
      });
      eq("a step done by its stored fact under a rule tightened later: done, labelled, and step 2 open",
        [fact.html.includes(PATH_STEP_LABEL_TEXT.completed_under_earlier_rule), fact.html.includes(`/courses/${C2}/launch?lp=${PATH}`), fact.html.includes(HINT)], [true, true, true]);
      const noFact = await openPath({ steps: [{ course: C1, n: 1, stepRule: true }, { course: C2, n: 2 }, { course: C3, n: 3 }], attempts: [row("a1", C1, "completed", 1)] });
      eq("…the same rows without the fact: not done, no label, step 2 locked", [noFact.html.includes("Completed Under"), noFact.html.includes(`/courses/${C2}/launch?lp=${PATH}`)], [false, false]);
      const done = await openPath({ attempts: COMPLETED, completion: COMPLETION }, { end: "1" });
      eq("a completed path: the end banner and the celebration (the stored completion)", [done.html.includes("continue-end-banner"), done.html.includes(CELEBRATION)], [true, true]);
      const noRow = await openPath({ attempts: COMPLETED }, { end: "1" });
      eq("every step done but no completion row: 3 / 3, no end banner, no celebration (P2-Q1)",
        [noRow.html.includes("100% completed"), noRow.html.includes("continue-end-banner"), noRow.html.includes(CELEBRATION)], [true, false, false]);
      // Far-future dates, so the page's own clock never turns "Due" into "Overdue".
      const due = await openPath({ attempts: IN_PROGRESS, terms: { path_id: PATH, due_at: "2099-12-01T00:00:00Z", enrolled_at: "2026-01-01T00:00:00Z" }, assignmentDue: "2098-06-01T00:00:00Z" });
      eq("the due date is the terms' (decision A9), not the assignment row's", [due.html.includes("Due 2099-12-01"), due.html.includes("2098-06-01")], [true, false]);
      const terms = requests.filter((q) => q.path === "/rest/v1/v_path_enrollment_terms");
      eq("…read once on a service client, naming the organisation and the learner (ruling (a))",
        terms.map((q) => [q.apikey, q.query.get("organization_id"), q.query.get("user_id")]), [[SERVICE_KEY, "eq.o1", `eq.${USER.id}`]]);
      // requireOrgAccess's own profile check reads on its own service client (lib/auth/require-org-access.ts).
      eq("…every other read of the page on the learner's session",
        requests.filter((q) => q.path.startsWith("/rest/v1/") && !["/rest/v1/v_path_enrollment_terms", "/rest/v1/profiles"].includes(q.path) && q.apikey === SERVICE_KEY).map((q) => q.path), []);
      const random = await openPath({ sequence: "random" });
      eq("a random path: no step locked", [random.html.includes("Locked"), (random.html.match(/>Launch</g) ?? []).length], [false, 3]);
    }

    console.log("\n(b) O5-d and P2-Q1 on the path page");
    {
      const hidden = [{ course: C1, n: 1 }, { course: C2, n: 2, active: false }, { course: C3, n: 3 }];
      const completedHidden = await openPath({ steps: hidden, attempts: COMPLETED, completion: COMPLETION });
      eq("the course inactive, a completed learner: the step left out (no row, no name, no link), the rest numbered 1 and 2, 2 / 2, still completed",
        [shownTitles(completedHidden.html), stepNumbers(completedHidden.html), completedHidden.html.includes(`/courses/${C2}`), completedHidden.html.includes("100% completed"), completedHidden.html.includes(CELEBRATION)],
        [[TITLES[C1], TITLES[C3]], [1, 2], false, true, true]);
      const progressHidden = await openPath({ steps: hidden, attempts: IN_PROGRESS });
      eq("the course inactive, an in-progress learner: the step left out; the next shown step reads Locked with no reason; 1 / 2",
        [shownTitles(progressHidden.html), progressHidden.html.includes("Locked"), progressHidden.html.includes(HINT), progressHidden.html.includes("50% completed"), progressHidden.html.includes(`/courses/${C2}`)],
        [[TITLES[C1], TITLES[C3]], true, false, true, false]);
      const lastHidden = await openPath({ steps: [{ course: C1, n: 1 }, { course: C2, n: 2 }, { course: C3, n: 3, active: false }], attempts: [row("a1", C1, "passed", 1), row("a2", C2, "passed", 2)] }, { end: "1" });
      eq("a hidden last step, every shown step done: 2 / 2 and not completed (no end banner, no celebration, nothing to press)",
        [lastHidden.html.includes("100% completed"), lastHidden.html.includes(CELEBRATION), lastHidden.html.includes("continue-end-banner"), lastHidden.html.includes("/launch?lp=")], [true, false, false, false]);
      const reactivated = await openPath({ steps: STEPS, attempts: [row("a1", C1, "passed", 1), row("a2", C2, "passed", 2)] });
      eq("reactivated: the step back in its place with its saved state, numbered 1 to 3", [shownTitles(reactivated.html), stepNumbers(reactivated.html), reactivated.html.includes("67% completed")],
        [[TITLES[C1], TITLES[C2], TITLES[C3]], [1, 2, 3], true]);
      for (const [who, rows, completion] of [["a completed learner", COMPLETED, COMPLETION], ["an in-progress learner", IN_PROGRESS, null]] as Array<[string, Row[], Row | null]>) {
        const inactive = await openPath({ pathActive: false, attempts: rows, completion });
        eq(`the path inactive, ${who}: the dashboard, and no step or progress read`,
          [inactive.redirect, requests.some((q) => q.path === "/rest/v1/learning_path_courses" || q.path === "/rest/v1/course_attempts")], ["/acme/dashboard", false]);
      }
      const allHidden = await openPath({ steps: STEPS.map((s) => ({ ...s, active: false })), attempts: COMPLETED });
      eq("every step hidden: the path's name and no steps", [allHidden.html.includes("Onboarding Path"), shownTitles(allHidden.html), allHidden.html.includes("Step 1")], [true, [], false]);
    }

    console.log("\n(c) the dashboard tile");
    {
      const all = await openDashboard({ attempts: IN_PROGRESS, terms: { path_id: PATH, due_at: "2026-12-01T00:00:00Z", enrolled_at: null } });
      eq("in progress: 1 of 3, in progress, the terms' due date", [all.tile?.progressDone, all.tile?.progressTotal, all.tile?.status, all.tile?.dueAt], [1, 3, "in_progress", "2026-12-01T00:00:00Z"]);
      const hidden = [{ course: C1, n: 1 }, { course: C2, n: 2, active: false }, { course: C3, n: 3 }];
      for (const [who, rows, completion, want] of [
        ["a completed learner", COMPLETED, COMPLETION, [2, 2, "completed"]],
        ["an in-progress learner", IN_PROGRESS, null, [1, 2, "in_progress"]],
      ] as Array<[string, Row[], Row | null, unknown[]]>) {
        const d = await openDashboard({ steps: hidden, attempts: rows, completion });
        eq(`the course inactive, ${who}: the tile counts the shown steps only`, [d.tile?.progressDone, d.tile?.progressTotal, d.tile?.status], want);
        eq(`…no card for the inactive course (${who})`, d.courseCards.includes(C2), false);
        const off = await openDashboard({ pathActive: false, attempts: rows, completion });
        eq(`the path inactive, ${who}: no tile, and no card from that path`, [off.tile, off.courseCards], [null, []]);
      }
      const noRow = await openDashboard({ steps: [{ course: C1, n: 1 }, { course: C2, n: 2 }, { course: C3, n: 3, active: false }], attempts: [row("a1", C1, "passed", 1), row("a2", C2, "passed", 2)] });
      eq("every shown step done, a hidden step, no completion row: 2 of 2 and still in progress (P2-Q1)", [noRow.tile?.progressDone, noRow.tile?.progressTotal, noRow.tile?.status], [2, 2, "in_progress"]);
      const allHidden = await openDashboard({ steps: STEPS.map((s) => ({ ...s, active: false })), attempts: COMPLETED, completion: COMPLETION });
      eq("every step hidden: the path is left off the dashboard", allHidden.tile, null);
      const fresh0 = await openDashboard({});
      eq("not started: 0 of 3, not started", [fresh0.tile?.progressDone, fresh0.tile?.status], [0, "not_started"]);
      const lockedHidden = await openDashboard({ steps: hidden, attempts: [row("a1", C1, "passed", 1)] }, { locked: C3 });
      eq("?locked= on a step held back only by a hidden step: a line that names nothing",
        [lockedHidden.text.includes("That course is not open yet."), lockedHidden.text.includes("Finish the earlier steps first.")], [true, false]);
      const lockedShown = await openDashboard({ attempts: [row("a1", C1, "passed", 1)] }, { locked: C3 });
      eq("…held back by a shown step that is not done: \"Finish the earlier steps first.\"",
        [lockedShown.text.includes("Finish the earlier steps first."), lockedShown.text.includes("That course is not open yet.")], [true, false]);
    }

    console.log("\n(d) failed reads and a database without 0107");
    {
      for (const t of ["learning_path_step_completions", "learning_path_completions", "v_path_enrollment_terms", "attempt_requests", "learning_path_courses"]) {
        const r = await openPath({ attempts: IN_PROGRESS, failing: [t] });
        eq(`the path page, ${t} unreadable: the notice, no step shown, one log line`,
          [r.html.includes("path-progress-unreadable"), shownTitles(r.html), r.html.includes("Locked"), r.events], [true, [], false, ["path_progress_unreadable"]]);
      }
      const rowsFail = await openPath({ attempts: IN_PROGRESS, failing: ["course_attempts"] });
      eq("…the path rows unreadable: the notice", rowsFail.html.includes("path-progress-unreadable"), true);
      for (const t of ["learning_path_step_completions", "learning_path_completions", "v_path_enrollment_terms", "attempt_requests"]) {
        const d = await openDashboard({ attempts: IN_PROGRESS, failing: [t] });
        eq(`the dashboard, ${t} unreadable: the tile left out, the path's course cards kept, one log line`,
          [d.tile, d.courseCards.sort(), d.events], [null, [C1, C2, C3].sort(), ["path_progress_unreadable"]]);
      }
      const old = await openPath({ no0107: true, attempts: COMPLETED, assignmentDue: "2099-12-01T00:00:00Z" }, { end: "1" });
      eq("the path page without 0107: today's path-tagged rows read every step done; the completion and the terms read as none (never completed, no due date)",
        [old.html.includes("100% completed"), old.html.includes(CELEBRATION), old.html.includes("continue-end-banner"), old.html.includes("Due "), old.html.includes("path-progress-unreadable")],
        [true, false, false, false, false]);
      const oldProgress = await openPath({ no0107: true, attempts: [...IN_PROGRESS, row("i3", C3, "passed", 4, { context_kind: "individual", context_key: "individual", learning_path_id: null })] });
      eq("…a row without a path tag counts for no step there", oldProgress.html.includes("33% completed"), true);
      const oldDash = await openDashboard({ no0107: true, attempts: COMPLETED });
      eq("the dashboard without 0107: 3 of 3 and in progress (no completion row can be read)", [oldDash.tile?.progressDone, oldDash.tile?.status, oldDash.tile?.dueAt], [3, "in_progress", null]);
    }

    console.log("\n(e) the request counts (in the page; requireOrgAccess included, no layout, no middleware)");
    {
      const three = await openPath({ attempts: IN_PROGRESS });
      const six = await openPath({ steps: [...STEPS, { course: "55555555-5555-4555-8555-555555555555", n: 4 }, { course: "66666666-6666-4666-8666-666666666666", n: 5 }, { course: "77777777-7777-4777-8777-777777777777", n: 6 }], attempts: IN_PROGRESS });
      // P2-9 adds one read of the launchable steps' active packages ("Change language").
      eq("the path page with 0107: 15, the same for 3 and for 6 steps (14 before P2-9, 13 before P2-7, measured on 8e9c966 with this stub)", [three.all, six.all], [15, 15]);
      const old = await openPath({ no0107: true, attempts: IN_PROGRESS });
      eq("…without 0107: 18 (the step read, the rows read and the grants read fall back once each)", old.all, 18);
      const none = await openPath({ attempts: COMPLETED, completion: COMPLETION });
      eq("…a path with no step to launch makes no packages read: 14", [none.all, requests.filter((r) => r.path === "/rest/v1/course_packages").length], [14, 0]);
      const dash = await openDashboard({ attempts: IN_PROGRESS });
      // P2-7 adds the facts, the completion and the terms reads (3); the grants read replaces the course
      // cards' fail-soft one and the path rows come from the attempts the page already reads (0 more).
      eq("the dashboard with one path: 26 with 0107 (23 before P2-7, measured on 8e9c966 with this stub)", dash.all, 26);
      const dashOld = await openDashboard({ no0107: true, attempts: IN_PROGRESS });
      eq("…without 0107: 28 (the step read and the grants read fall back once each)", dashOld.all, 28);
    }
    console.log("\n(f) P2-9: \"Change language\" on a step the learner can launch, in the path's context");
    {
      const LINK = `/acme/courses/${C2}/launch?lp=${PATH}&switch=choose`;
      const two = await openPath({ attempts: IN_PROGRESS, languages: { [C1]: 2, [C2]: 2, [C3]: 2 } });
      eq("step 2 (in progress) offers it, linked to the launch's picker in the path's context; step 1 (done) and step 3 (locked) do not",
        [two.html.includes(LINK), (two.html.match(/data-testid="step-change-language"/g) ?? []).length, two.html.includes(`/courses/${C1}/launch?lp=${PATH}&switch=`), two.html.includes(`/courses/${C3}/launch?lp=${PATH}&switch=`)],
        [true, 1, false, false]);
      const pk = requests.filter((r) => r.path === "/rest/v1/course_packages");
      eq("…one packages read, for the launchable step's course, active packages only, on the learner's session",
        [pk.length, inList(pk[0]?.query ?? new URLSearchParams(), "course_id"), pk[0]?.query.get("is_active"), pk[0]?.apikey === SERVICE_KEY], [1, [C2], "eq.true", false]);
      const one = await openPath({ attempts: IN_PROGRESS });
      eq("one active language: no link", one.html.includes('data-testid="step-change-language"'), false);
      const random = await openPath({ sequence: "random", attempts: IN_PROGRESS, languages: { [C2]: 2, [C3]: 3 } });
      eq("random order: every step not done offers it (steps 2 and 3)", (random.html.match(/data-testid="step-change-language"/g) ?? []).length, 2);
      const failed = await openPath({ attempts: IN_PROGRESS, languages: { [C2]: 2 }, failing: ["course_packages"] });
      eq("a failed packages read: no link, the steps shown as before, one log line",
        [failed.html.includes('data-testid="step-change-language"'), failed.html.includes("Bravo Module"), failed.html.includes("path-progress-unreadable"), failed.events], [false, true, false, ["path_languages_unreadable"]]);
    }
    eq("the stub answered every request the pages made", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
