/**
 * The job's own marks (ADR 0029 rule FP3; checklist D5): the job behind a
 * public reset code or sign-in link (lib/auth/credential-mail.ts), run after
 * the response, under a stubbed fetch.
 *   - a job with work to do marks `started` before it makes or writes
 *     anything, and `finished` as its last call, with the day its start
 *     returned, for the system that serves the account (tenant or platform);
 *   - an address with no account starts no job and makes no mark; an account
 *     that no system serves on that page makes none either;
 *   - a send that fails, a limit that stops it, and a not-ready
 *     organisation's record are still finished;
 *   - the job marks an alert as due and sends none (the scheduled call
 *     sends it);
 *   - without 0114 (mail_job_mark missing) the job makes no mark, logs a
 *     fixed line, and still sends; a mark that fails otherwise does the same.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/mail-job-marks.test.ts   (or npm run test:unit)
 */
import {
  ORG, PLATFORM_ENV, SLUG, TODAY, ask, captureLogs, eq, finish, freshWorld, install, marks, platformRows, requests,
  runJobs, tenantSends, uninstall, world, type Row,
} from "./public-mail-world";

const MEMBER = { id: "0e000000-0000-4000-8000-000000000001", email: "member@tenant.stub" };
const ADMIN = { id: "0e000000-0000-4000-8000-000000000002", email: "admin@tenant.stub" };
const OUTSIDER = { id: "0e000000-0000-4000-8000-000000000003", email: "outsider@tenant.stub" };

function base(over: Parameters<typeof freshWorld>[0] = {}) {
  freshWorld({
    users: [MEMBER, ADMIN, OUTSIDER],
    members: [
      { organization_id: ORG, user_id: MEMBER.id, role: "user", status: "active" },
      { organization_id: ORG, user_id: ADMIN.id, role: "admin", status: "active" },
    ],
    ...over,
  });
}

/** The index of the first request matching `pred` in the job's requests, or -1. */
const at = (pred: (r: (typeof requests)[number]) => boolean) => requests.findIndex(pred);
const isMark = (mark: string) => (r: (typeof requests)[number]) => r.table === "rpc/mail_job_mark" && (r.body as Row | null)?.p_mark === mark;
const isWrite = (r: (typeof requests)[number]) => r.path.startsWith("/rest/v1/") && !r.table.startsWith("rpc/") && r.method !== "GET" && r.method !== "HEAD";

async function main() {
  install();
  try {
    const request = await import("../../app/api/auth/forgot-password/request/route");
    const magic = await import("../../app/api/auth/magic-link/route");
    const KINDS = [
      { name: "reset code", path: "/api/auth/forgot-password/request", route: request },
      { name: "sign-in link", path: "/api/auth/magic-link", route: magic },
    ];
    for (const kind of KINDS) {
      const job = async (email: string, payload: Row = { orgSlug: SLUG }, env: Record<string, string> = {}) => {
        for (const [k, v] of Object.entries(env)) process.env[k] = v;
        try {
          return await captureLogs(async () => {
            const a = await ask(kind.route, kind.path, { email, ...payload });
            requests.length = 0;
            await runJobs();
            return a;
          });
        } finally {
          for (const k of Object.keys(env)) delete process.env[k];
        }
      };

      console.log(`\n${kind.name}: the two marks`);
      base();
      await job(MEMBER.email);
      const started = at(isMark("started"));
      const finished = at(isMark("finished"));
      eq("a tenant-served member: started, then finished, for the tenant", marks().map((m) => [m.p_kind, m.p_mark]), [["tenant", "started"], ["tenant", "finished"]]);
      eq("…started comes before anything is made or written, and before the send", [started >= 0, started < at(isWrite), started < at((r) => r.path === "/functions/v1/send-smtp")], [true, true, true]);
      eq("…finished is the last call of the job", finished, requests.length - 1);
      eq("…the start mark names no day; the finish mark names the day the start returned", [("p_day" in (marks()[0] ?? {})), marks()[1]?.p_day], [false, TODAY]);
      eq("…and the mail went", tenantSends().length, 1);

      base();
      await job(ADMIN.email, { orgSlug: SLUG }, PLATFORM_ENV);
      eq("a platform-served administrator: the marks are the platform's", marks().map((m) => [m.p_kind, m.p_mark]), [["platform", "started"], ["platform", "finished"]]);
      eq("…around the platform's mail", platformRows().map((r) => r.status), ["sent"]);

      base();
      const none = await job("nobody@tenant.stub");
      eq("an address with no account: no job, no mark", [none.value.jobs, marks().length], [0, 0]);
      base();
      await job(OUTSIDER.email);
      eq("an account no system serves on this page: no mark", marks().length, 0);

      base({ smtp: () => ({ ok: false, error: "535 5.7.8 Authentication failed" }) });
      await job(MEMBER.email);
      eq("a send that fails is still finished", marks().map((m) => m.p_mark), ["started", "finished"]);

      base({ settings: null });
      await job(MEMBER.email);
      eq("a not-ready organisation's record is work: started and finished", marks().map((m) => m.p_mark), ["started", "finished"]);
      eq("…the alert is marked as due on the state row, and none is sent", [typeof world.state?.alert_due_at, platformRows().length, tenantSends().length], ["string", 0, 0]);
      eq("…the mark comes between the two job marks", at((r) => r.table === "tenant_smtp_state") > at(isMark("started")) && at((r) => r.table === "tenant_smtp_state") < at(isMark("finished")), true);

      console.log(`\n${kind.name}: without the function`);
      base({ jobMark: "missing" });
      const missing = await job(MEMBER.email);
      eq("mail_job_mark missing (no 0114): one call, no finish, and the mail still goes", [marks().map((m) => m.p_mark), tenantSends().length], [["started"], 1]);
      eq("…a fixed line says so, with no address", [missing.lines.some((l) => l.includes("mail_job_mark_missing")), missing.lines.some((l) => l.includes("@"))], [true, false]);
      base({ jobMark: "fail" });
      const failed = await job(MEMBER.email);
      eq("a mark that fails otherwise: no finish, the mail still goes, and its own line", [marks().map((m) => m.p_mark), tenantSends().length, failed.lines.some((l) => l.includes("mail_job_mark_failed"))], [["started"], 1, true]);
    }
  } finally {
    uninstall();
  }
  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
