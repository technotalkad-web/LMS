/**
 * Unit tests for decision A22 in the reminders cron (ADR 0024 step 49's
 * reminders row, P2-6 item 2): POST /api/cron/reminders skips the
 * course_assignments rows with source = 'self', a learner's own enrolment
 * from pressing Start on an "Everyone" course, so such a member gets no
 * asset_reminder email. The real handler under a stubbed fetch.
 *
 *   - with the column: a self row reminds nobody; an admin row reminds its
 *     learner; a learner who holds a self row AND a team row is still
 *     reminded (the row is skipped, not the learner); the self-only learner's
 *     email is not even resolved;
 *   - without it (no row carries source): every user row reminds, today's run;
 *   - the read stays select("*") (the missing-column fallback names no 0107
 *     column), and the completed-pairs read of course_attempts is unchanged
 *     (preview-isolation-sites.test.ts pins it; phase 7 moves it).
 *
 * Who is reminded is read from the reminder_state upsert (one entry per
 * learner the run nudged) and the notification_log rows, not from `sent`:
 * the stub's org has email paused, so nothing leaves.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/reminders-self-enrolment.test.ts   (or npm run test:unit)
 */
export {}; // a module, so its names do not meet the other test scripts' in one program

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; table: string; select: string; query: string; body: unknown };

const SUPABASE = "http://stub.supabase.test";
const SERVICE = "stub-service-role-key";
const SECRET = "stub-cron-secret";
const ORG = "org-1";
const COURSE = "c-course";

let assignmentRows: Row[] = [];
let requests: Req[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const table = url.pathname.replace("/rest/v1/", "");
  const query = decodeURIComponent(url.search);
  requests.push({ method, table, select: url.searchParams.get("select") ?? "", query, body });
  if (table === "course_reminder_settings") {
    return json([{ course_id: COURSE, enabled: true, cadence_days: 1, cap_days: 30, courses: { id: COURSE, title: "Course K", organization_id: ORG, organizations: { name: "Org", slug: "org", deleted_at: null } } }]);
  }
  if (table === "course_assignments") return json(assignmentRows);
  if (table === "team_members") return json([{ team_id: "t-1", user_id: "u-both" }]);
  // ADR 0030 rule 10: the run reminds only members that count, so every
  // learner here holds an active row in a live organisation.
  if (table === "organization_members") {
    return json(["u-adm", "u-both", "u-self"].map((user_id) => ({ user_id, role: "user", status: "active" })));
  }
  if (table === "course_attempts") return json([]);
  if (table === "reminder_state" && method === "GET") return json([]);
  if (table === "reminder_state") return json([], 201);
  if (table === "profiles") {
    const inList = /id=in\.\(([^)]*)\)/.exec(query)?.[1] ?? "";
    return json(inList.split(",").filter(Boolean).map((id) => ({ id, email: `${id}@example.test` })));
  }
  if (table === "notification_settings") return json([{ email_paused: true, event_paused: {} }]);
  // ADR 0029: each send opens its run with tenant_mail_status (migration 0114): one row, no state yet.
  if (table === "rpc/tenant_mail_status") return json([{ organization_id: (body as Row | null)?.p_org ?? ORG, state: null, state_changed_at: null, last_success_at: null, last_failure_at: null, last_error_code: null, failed_recipients: [], last_alert_at: null, alert_due_at: null, daily_limit: null, sent_24h: 0 }]);
  if (table === "organizations") return json([{ id: ORG, name: "Org", deleted_at: null }]);
  if (table === "notification_log") return json([], 201);
  return json([]);
};

const user = (id: string, source?: string): Row => ({
  id: `a-${id}`, course_id: COURSE, organization_id: ORG, assignee_type: "user", user_id: id, team_id: null, group_id: null, release_at: null,
  ...(source === undefined ? {} : { source }),
});
const team = (source?: string): Row => ({
  id: "a-team", course_id: COURSE, organization_id: ORG, assignee_type: "team", user_id: null, team_id: "t-1", group_id: null, release_at: null,
  ...(source === undefined ? {} : { source }),
});

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  process.env.CRON_SECRET = SECRET;
  delete process.env.RESEND_API_KEY;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    const route = await import("../../app/api/cron/reminders/route");
    const run = async (rows: Row[]) => {
      assignmentRows = rows;
      requests = [];
      const res = await route.POST(new Request("http://lms.test/api/cron/reminders", { method: "POST", headers: { "x-cron-secret": SECRET } }));
      const upsert = requests.find((q) => q.table === "reminder_state" && q.method === "POST");
      return {
        status: res.status,
        reminded: ((upsert?.body ?? []) as Row[]).map((r) => r.user_id as string).sort(),
        logged: requests.filter((q) => q.table === "notification_log").map((q) => (q.body as Row).to_user_id as string).sort(),
        resolved: requests.filter((q) => q.table === "profiles").flatMap((q) => (/id=in\.\(([^)]*)\)/.exec(q.query)?.[1] ?? "").split(",")).sort(),
        reads: requests.filter((q) => q.method === "GET" && (q.table === "course_assignments" || q.table === "course_attempts")).map((q) => `${q.table} ${q.query}`),
      };
    };

    console.log("\nwith the column: a self row reminds nobody");
    {
      const r = await run([user("u-self", "self"), user("u-adm", "admin"), user("u-both", "self"), team("admin")]);
      eq("200", r.status, 200);
      eq("reminded: the assigned learner and the one a team row also reaches, never the self-only learner", r.reminded, ["u-adm", "u-both"]);
      eq("…one notification each, none for the self-only learner", r.logged, ["u-adm", "u-both"]);
      eq("…the self-only learner's email is not even resolved", r.resolved, ["u-adm", "u-both"]);
      const onlySelf = await run([user("u-self", "self")]);
      eq("a course whose only row is a self row: nobody reminded, no upsert", [onlySelf.status, onlySelf.reminded, onlySelf.logged], [200, [], []]);
    }

    console.log("\nwithout the column (no row carries source): today's run");
    {
      const r = await run([user("u-self"), user("u-adm"), user("u-both"), team()]);
      eq("every user row reminds, as before", [r.status, r.reminded], [200, ["u-adm", "u-both", "u-self"]]);
      eq("…one notification each", r.logged, ["u-adm", "u-both", "u-self"]);
    }

    console.log("\nthe reads");
    {
      const r = await run([user("u-adm", "admin")]);
      eq("course_assignments is read with select=* (names no 0107 column), and course_attempts unchanged", r.reads, [
        `course_assignments ?select=*&course_id=in.(${COURSE})`,
        `course_attempts ?select=user_id,course_versions!inner(course_id),completion_status,success_status&course_versions.course_id=in.(${COURSE})`,
      ]);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
