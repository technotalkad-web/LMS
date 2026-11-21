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
 *     fixed line, and still sends; a mark that fails otherwise does the same;
 *   - the job's one deadline (rule T3): a send waits the smaller of its own
 *     wait and the time the job has left, less the time kept for its row;
 *     with no time left the send does not start, no row is written for it,
 *     a fixed line says so and the job is still finished. Both systems.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/mail-job-marks.test.ts   (or npm run test:unit)
 */
import {
  ORG, PLATFORM_ENV, SLUG, TODAY, ask, captureLogs, eq, finish, freshWorld, install, logInserts, marks, platformRows, requests,
  runJobs, tenantSends, uninstall, world, type Row,
} from "./public-mail-world";
import { CREDENTIAL_JOB_MS, SEND_ROW_MS } from "../../lib/auth/credential-mail";

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
      eq("…around the platform's mail (its claim, its in-flight row, then its row)", platformRows().map((r) => [r.status, r.error_code]), [["suppressed", "pending"], ["suppressed", "in_flight"], ["sent", null]]);

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

    console.log("\nthe job's one deadline (rule T3)");
    {
      eq("the job has 25 s for everything, and keeps 2 s for a send's row", [CREDENTIAL_JOB_MS, SEND_ROW_MS], [25_000, 2_000]);
      const realNow = Date.now;
      /**
       * A reset code's job on the organisation's page whose own work before
       * the send takes `spentMs` of the job's time: the clock moves on when
       * the code's row is written. The send never answers, so its row says
       * how long it was given.
       */
      const slowJob = async (email: string, spentMs: number, env: Record<string, string> = {}) => {
        let clock = realNow();
        Date.now = () => clock;
        world.smtp = () => "hang";
        world.onRequest = (r) => { if (r.table === "password_reset_otps" && r.method === "POST") clock += spentMs; };
        for (const [k, v] of Object.entries(env)) process.env[k] = v;
        try {
          return await captureLogs(async () => {
            await ask(request, "/api/auth/forgot-password/request", { email, orgSlug: SLUG });
            requests.length = 0;
            await runJobs();
          });
        } finally {
          Date.now = realNow;
          for (const k of Object.keys(env)) delete process.env[k];
        }
      };
      const left = (spentMs: number) => CREDENTIAL_JOB_MS - spentMs - SEND_ROW_MS;
      const line = (lines: string[], outcome: string) => lines.filter((l) => l.includes('"event":"credential_mail"') && l.includes(`"outcome":"${outcome}"`)).length;

      base();
      await slowJob(MEMBER.email, 22_500);
      // The outcome's row, not the claim or the in-flight row written before it.
      const outcomeRows = () => logInserts().filter((r) => r.event_type === "password_reset" && r.status !== "queued");
      const platformOutcomes = () => platformRows().filter((r) => r.error_code !== "pending" && r.error_code !== "in_flight");
      const tenantRow = outcomeRows()[0];
      eq(`tenant: 22.5 s of the job spent before the send: the send is given what is left less the row's time (${left(22_500)} ms), not the whole wait`,
        [tenantSends().length, String(tenantRow?.error ?? "").includes(`Timed out after ${left(22_500)}ms`)], [1, true]);
      eq("…the row is written and the job finished", [tenantRow?.status, marks().map((m) => m.p_mark)], ["failed", ["started", "finished"]]);

      base();
      const tenantLate = await slowJob(MEMBER.email, 24_000);
      eq("tenant: 24 s spent, no time left for the send: it is not started, no outcome row is written for it, one fixed line, and the job is finished",
        [tenantSends().length, outcomeRows().length, line(tenantLate.lines, "no_time"), marks().map((m) => m.p_mark)],
        [0, 0, 1, ["started", "finished"]]);

      base();
      await slowJob(ADMIN.email, 22_500, PLATFORM_ENV);
      const platformRow = platformOutcomes()[0];
      eq(`platform: 22.5 s spent: the send is given ${left(22_500)} ms, and its row says it timed out`,
        [platformRow?.event_type, platformRow?.status, platformRow?.error_code, String(platformRow?.error_detail ?? "").includes(`Timed out after ${left(22_500)}ms`)],
        ["platform_reset_code", "failed", "timeout", true]);

      base();
      const platformLate = await slowJob(ADMIN.email, 24_000, PLATFORM_ENV);
      eq("platform: no time left: nothing dispatched, no outcome row, one fixed line, and the job is finished",
        [platformOutcomes().length, requests.filter((r) => r.path === "/functions/v1/send-smtp").length, line(platformLate.lines, "no_time"), marks().map((m) => m.p_mark)],
        [0, 0, 1, ["started", "finished"]]);
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
