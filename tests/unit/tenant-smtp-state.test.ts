/**
 * A tenant's SMTP state and the run of its mail (ADR 0029 section C and G,
 * step 9 and 10; lib/notifications/smtp-state.ts and send.ts):
 *   - nextState for every reading: repeated failures to the same recipient
 *     never flip, the same class to FLIP_AFTER_PEOPLE recipients does; auth
 *     and quota flip on the first failure; rejected never flips; a success
 *     returns the organisation to healthy;
 *   - stopping: against an unreachable SMTP, a run tries three
 *     recipients, records the flip, sets alert_due_at without mailing and
 *     then skips the rest; an auth failure ends it after one try; a run that
 *     opens on a failing organisation sends a single probe first;
 *   - call counting: many sends share one state read; a healthy run with a
 *     recent last_success_at writes nothing; a failing run writes at most
 *     three times; one send, then groups of four, each group logged by one
 *     insert;
 *   - pausing: password_reset and magic_link (D1) ignore it, every other
 *     event obeys it, custom_broadcast keeps its existing exemption;
 *   - deleted organisations read not_configured, send nothing and get no
 *     alert mark; one only scheduled for deletion (deleted_at still empty)
 *     sends as before;
 *   - a learner's ticket mail still goes out on a failing organisation as
 *     the probe, and its delivery clears the state;
 *   - no fallback sender: the fixed message names the organisation's SMTP
 *     and the result carries the error class;
 *   - a database without 0114, one case each: a missing tenant_mail_status
 *     means ready on complete settings, no limit, the send attempted, no
 *     state write, no alert mark; a missing tenant_smtp_state table on write
 *     turns writes off for the run without changing any result; every other
 *     RPC error is "unreadable" and kept apart from "missing";
 *   - the RPC request itself: path and single argument are pinned, because
 *     a misspelt name would look like an unpasted migration indefinitely;
 *   - recordRecipientsUnreadable (ADR 0029, note of 2026-11-19).
 *
 * Under the stubbed fetch of tests/unit/mail-world.ts. No database, no network.
 *
 * Run:  npx tsx tests/unit/tenant-smtp-state.test.ts   (or npm run test:unit)
 */
import {
  ORG,
  SMTP_SETTINGS,
  captureLogs,
  eq,
  finish,
  freshWorld,
  installStub,
  logInserts,
  logRows,
  removeStub,
  requests,
  sends,
  stateWrites,
  statusCalls,
  world,
  type Row,
} from "./mail-world";
import {
  FLIP_AFTER_PEOPLE,
  SENDS_AT_ONCE,
  alertMayBeMarked,
  nextState,
  openRun,
  readingOf,
  recordRecipientsUnreadable,
  runReady,
  runReading,
  type SmtpStateSnapshot,
} from "../../lib/notifications/smtp-state";
import { sendMany, sendNotification, type SendArgs } from "../../lib/notifications/send";
import { MAIL_RECIPIENTS_HEARTBEAT } from "../../lib/ops/health-status";

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `0b000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, email: `person${i + 1}@tenant.stub` }));
const mailTo = (event: SendArgs["event"] = "asset_assignment") => (p: { id: string; email: string }) => ({ event, to: { user_id: p.id, email: p.email }, context: { course_name: "Home loans" } });
const one = (event: SendArgs["event"], p = people(1)[0]): SendArgs => ({ organizationId: ORG, event, to: { user_id: p.id, email: p.email }, context: { course_name: "Home loans" } });
const EMPTY: SmtpStateSnapshot = { state: null, state_changed_at: null, last_success_at: null, last_failure_at: null, last_error_code: null, failed_recipients: [] };
const DEAD = { ok: false as const, error: "Connection refused" };

async function main() {
  installStub();
  try {
    console.log("\nthe readings (section C)");
    eq("settings incomplete: not_configured", readingOf({ settingsComplete: false, deleted: false, state: "healthy" }), "not_configured");
    eq("deleted: not_configured whatever the stored row says", readingOf({ settingsComplete: true, deleted: true, state: "healthy" }), "not_configured");
    eq("settings complete, no send recorded: configured", readingOf({ settingsComplete: true, deleted: false, state: null }), "configured");
    eq("healthy", readingOf({ settingsComplete: true, deleted: false, state: "healthy" }), "healthy");
    eq("failing", readingOf({ settingsComplete: true, deleted: false, state: "failing" }), "failing");

    console.log("\nflips and non-flips (pure)");
    {
      const t = (s: SmtpStateSnapshot, cls: string, who: string | null) => nextState(s, { ok: false, cls: cls as never }, who, NOW);
      let s = EMPTY;
      for (let i = 0; i < 3; i++) s = t(s, "timeout", "p1").next;
      eq("three timeouts to one person do not flip", s.state, null);
      eq("…the first counted and wrote, the repeats did not", [t(EMPTY, "timeout", "p1").write, t(t(EMPTY, "timeout", "p1").next, "timeout", "p1").write], [true, false]);
      let flips = 0;
      s = EMPTY;
      for (const who of ["p1", "p2", "p3"]) { const r = t(s, "unreachable", who); s = r.next; if (r.flipped) flips++; }
      eq("three different people flip it to failing, once", [s.state, flips, s.failed_recipients.length], ["failing", 1, FLIP_AFTER_PEOPLE]);
      eq("auth flips at once", [t(EMPTY, "auth", "p1").next.state, t(EMPTY, "auth", "p1").flipped], ["failing", true]);
      eq("quota flips at once", t(EMPTY, "quota", "p1").next.state, "failing");
      eq("rejected never changes anything", [t(EMPTY, "rejected", "p1").write, t(EMPTY, "rejected", "p1").next], [false, EMPTY]);
      eq("a failure on a failing row writes nothing", t({ ...EMPTY, state: "failing" }, "auth", "p9").write, false);
      eq("a timeout with no user id is not a different person: nothing counts", t(EMPTY, "timeout", null).write, false);
      const failing: SmtpStateSnapshot = { ...EMPTY, state: "failing", failed_recipients: ["p1", "p2", "p3"], last_error_code: "auth" };
      const cleared = nextState(failing, { ok: true }, "p4", NOW);
      eq("a delivery clears: healthy, no failed recipients, the time set", [cleared.next.state, cleared.next.failed_recipients, cleared.cleared, cleared.write], ["healthy", [], true, true]);
      const fresh: SmtpStateSnapshot = { ...EMPTY, state: "healthy", last_success_at: iso(H) };
      eq("a delivery on a healthy row with a fresh last delivery writes nothing", nextState(fresh, { ok: true }, "p1", NOW).write, false);
      eq("…a stale one (over 24 hours) is refreshed", nextState({ ...fresh, last_success_at: iso(25 * H) }, { ok: true }, "p1", NOW).write, true);
      eq("…and so is a healthy row with failures on it", nextState({ ...fresh, failed_recipients: ["p1"] }, { ok: true }, "p2", NOW).write, true);
      eq("alert bounds: 6 hours for a flip, 24 for mail not sent, none while one is due",
        [alertMayBeMarked({ cause: "flip", lastAlertAt: iso(5 * H), alertDueAt: null, nowMs: NOW }), alertMayBeMarked({ cause: "flip", lastAlertAt: iso(7 * H), alertDueAt: null, nowMs: NOW }),
          alertMayBeMarked({ cause: "not_sent", lastAlertAt: iso(23 * H), alertDueAt: null, nowMs: NOW }), alertMayBeMarked({ cause: "not_sent", lastAlertAt: iso(25 * H), alertDueAt: null, nowMs: NOW }),
          alertMayBeMarked({ cause: "flip", lastAlertAt: null, alertDueAt: iso(1), nowMs: NOW }), alertMayBeMarked({ cause: "daily_limit", lastAlertAt: null, alertDueAt: null, nowMs: NOW })],
        [false, true, false, true, false, true]);
    }

    console.log("\nthe call to tenant_mail_status (migration 0114)");
    {
      freshWorld();
      await sendNotification(one("asset_assignment"));
      const call = statusCalls()[0];
      eq("one POST to rpc/tenant_mail_status with the one argument p_org", [statusCalls().length, call?.method, call?.path, Object.keys((call?.body ?? {}) as Row), (call?.body as Row)?.p_org], [1, "POST", "/rest/v1/rpc/tenant_mail_status", ["p_org"], ORG]);
      const firstSend = requests.findIndex((r) => r.path === "/functions/v1/send-smtp");
      eq("the settings, the organisation and the status are read before the send", ["notification_settings", "organizations", "rpc/tenant_mail_status"].every((t) => requests.findIndex((r) => r.table === t) < firstSend), true);
    }

    console.log("\na ready run: the shape, the counts, the writes");
    {
      freshWorld({ state: { organization_id: ORG, state: "healthy", state_changed_at: iso(48 * H), last_success_at: iso(H), failed_recipients: [] } });
      const run = await openRun({ organizationId: ORG });
      const results = await sendMany(run, people(6), mailTo());
      const order = requests.map((r) => (r.path === "/functions/v1/send-smtp" ? "send" : r.table === "notification_log" ? "log" : null)).filter(Boolean);
      eq("six sent", results.map((r) => r.status), Array(6).fill("sent"));
      eq(`the first send alone, then ${SENDS_AT_ONCE} at a time, one log insert after each group`, order, ["send", "log", "send", "send", "send", "send", "log", "send", "log"]);
      eq("…a group's rows are one insert", logInserts().map((r) => (Array.isArray(r.body) ? (r.body as Row[]).length : 1)), [1, 4, 1]);
      eq("one state read for the whole run", statusCalls().length, 1);
      eq("a healthy run with a fresh last delivery writes no state", stateWrites().length, 0);
      eq("one template read for the event", requests.filter((r) => r.table === "notification_templates").length, 1);
      eq("each send is bounded by the shared wait (rule T1: a signal on every send-smtp request)", requests.filter((r) => r.path === "/functions/v1/send-smtp").map((r) => r.signal), Array(6).fill(true));
      freshWorld();
      await sendNotification(one("asset_assignment"));
      eq("a first delivery on an organisation with no state row writes the row once, healthy", stateWrites().map((r) => [r.method, (r.body as Row).state]), [["POST", "healthy"]]);
      eq("…a single send inserts its row as one object", Array.isArray(logInserts()[0]?.body), false);
    }

    console.log("\nthe stop rule");
    {
      freshWorld({ smtp: () => DEAD });
      const run = await openRun({ organizationId: ORG });
      const results = await sendMany(run, people(10), mailTo());
      eq("a dead SMTP (unreachable): three attempts to three people, then nothing", [sends().length, results.filter((r) => r.attempted).length], [3, 3]);
      eq("…the state flips to failing", world.state?.state, "failing");
      eq("…the other seven are not attempted (not_ready), with a message naming the organisation's SMTP", [results.filter((r) => r.errorClass === "not_ready").length, results[9].error?.includes("organisation's SMTP")], [7, true]);
      eq("…one alert marked as due, and no platform mail sent", [run.report.alertMarked, typeof world.state?.alert_due_at, sends().every((s) => s.host === "smtp.tenant.stub")], [true, "string", true]);
      eq("…at most three state writes", stateWrites().filter((r) => !("alert_due_at" in (r.body as Row))).length <= 3, true);
      eq("…the attempted ones carry their class", results.slice(0, 3).map((r) => [r.status, r.errorClass]), [["failed", "unreachable"], ["failed", "unreachable"], ["failed", "unreachable"]]);
      eq("…every mail has its row: three failures and seven not sent", logRows().map((r) => r.status), Array(10).fill("failed"));

      freshWorld({ smtp: () => ({ ok: false, error: "535 5.7.8 Username and Password not accepted" }) });
      const authRun = await openRun({ organizationId: ORG });
      const auth = await sendMany(authRun, people(6), mailTo());
      eq("auth: it stops after one attempt, failing, the rest not attempted", [sends().length, world.state?.state, world.state?.last_error_code, auth.filter((r) => r.errorClass === "not_ready").length], [1, "failing", "auth", 5]);

      freshWorld({ smtp: () => DEAD, state: { organization_id: ORG, state: "failing", state_changed_at: iso(H), failed_recipients: ["x1", "x2", "x3"], last_error_code: "unreachable", last_alert_at: iso(H) } });
      const failRun = await openRun({ organizationId: ORG });
      const probe = await sendMany(failRun, people(5), mailTo());
      eq("a run that starts failing sends one probe; it fails; nothing more is attempted", [sends().length, probe.filter((r) => r.errorClass === "not_ready").length], [1, 4]);
      eq("…a failure on a failing row writes nothing", stateWrites().filter((r) => !("alert_due_at" in (r.body as Row))).length, 0);

      freshWorld({ smtp: (_to, n) => (n === 0 ? { ok: false, error: "550 5.1.1 User unknown" } : { ok: true }), state: { organization_id: ORG, state: "failing", state_changed_at: iso(H), failed_recipients: ["x1", "x2", "x3"], last_error_code: "auth" } });
      const rejRun = await openRun({ organizationId: ORG });
      const rej = await sendMany(rejRun, people(6), mailTo());
      const order = requests.filter((r) => r.path === "/functions/v1/send-smtp" || r.table === "notification_log").map((r) => (r.table === "notification_log" ? "log" : "send"));
      eq("a probe that is rejected (one recipient's refusal) is followed by another probe, alone", order.slice(0, 4), ["send", "log", "send", "log"]);
      eq("…that one is delivered: the state clears and the rest go four at a time", [world.state?.state, rej.map((r) => r.status).join(","), order.slice(4)], ["healthy", "failed,sent,sent,sent,sent,sent", ["send", "send", "send", "send", "log"]]);
    }

    console.log("\na learner's ticket mail on a failing organisation");
    {
      freshWorld({ state: { organization_id: ORG, state: "failing", state_changed_at: iso(H), failed_recipients: ["x1", "x2", "x3"], last_error_code: "auth" } });
      const r = await sendNotification({ ...one("custom_broadcast"), override: { subject: "New ticket", body_md: "A learner raised a ticket." } });
      eq("is attempted (the probe) and, delivered, clears the state", [r.status, sends().length, world.state?.state, (world.state?.failed_recipients as string[]).length], ["sent", 1, "healthy", 0]);
    }

    console.log("\nthe pause (D1)");
    {
      for (const [label, settings] of [["master pause", { ...SMTP_SETTINGS, email_paused: true }], ["event pause", { ...SMTP_SETTINGS, event_paused: { password_reset: true, magic_link: true, asset_assignment: true } }]] as const) {
        freshWorld({ settings });
        const code = await sendNotification(one("password_reset"));
        const link = await sendNotification(one("magic_link"));
        const other = await sendNotification(one("asset_assignment"));
        eq(`${label}: a reset code and a sign-in link still go, through the tenant's SMTP only`, [code.status, link.status, sends().length, sends().every((s) => s.host === "smtp.tenant.stub")], ["sent", "sent", 2, true]);
        eq(`${label}: any other event is paused, not attempted, with its row`, [other.status, other.errorClass, other.attempted, logRows()[2]?.status, logRows()[2]?.subject], ["paused", "paused", false, "failed", "(paused)"]);
      }
      freshWorld({ settings: { ...SMTP_SETTINGS, email_paused: true } });
      const b = await sendNotification({ ...one("custom_broadcast"), override: { subject: "Notice", body_md: "Hello" } });
      eq("custom_broadcast still passes the master pause, as before (kept, not changed by this stage)", b.status, "sent");
    }

    console.log("\na deleted organisation; one scheduled for deletion");
    {
      freshWorld({ org: { id: ORG, name: "Tenant A", slug: "tenant-a", deleted_at: iso(H) }, state: { organization_id: ORG, state: "healthy", state_changed_at: iso(H), failed_recipients: [] } });
      const run = await openRun({ organizationId: ORG });
      const r = await sendMany(run, people(3), mailTo());
      eq("deleted: reads not_configured, not ready, nothing attempted", [runReading(run), runReady(run), sends().length, r.map((x) => x.errorClass)], ["not_configured", false, 0, ["not_configured", "not_configured", "not_configured"]]);
      eq("…no alert marked, no state written", [run.report.alertMarked, stateWrites().length], [false, 0]);
      freshWorld({ org: { id: ORG, name: "Tenant A", slug: "tenant-a", deleted_at: null, deletion_scheduled_at: iso(-30 * 24 * H) } });
      eq("scheduled for deletion (deleted_at empty): sends as today", (await sendNotification(one("asset_assignment"))).status, "sent");
      freshWorld({ org: "fail" });
      const run2 = await openRun({ organizationId: ORG });
      eq("an organisation read that fails is not read as deleted: the mail still goes", [run2.deleted, (await sendNotification(one("asset_assignment"), { run: run2 })).status], [false, "sent"]);
    }

    console.log("\nno fallback");
    {
      freshWorld({ settings: { email_paused: false, event_paused: {} } });
      const r = await sendNotification(one("asset_assignment"));
      eq("no SMTP settings: not sent, not attempted, class not_configured; nothing went out", [r.status, r.attempted, r.errorClass, sends().length], ["failed", false, "not_configured", 0]);
      eq("…its row names the organisation's SMTP", String(logRows()[0]?.error).includes("organisation's SMTP"), true);
      eq("…no request but the reads, the log row and the alert's mark (nothing to any other sender)", requests.every((q) => q.path.startsWith("/rest/v1/")), true);
      freshWorld({ smtp: () => ({ ok: false, error: "Timed out after 25000ms: SMTP send to smtp.tenant.stub:465" }) });
      const t = await sendNotification(one("asset_assignment"));
      eq("a failed send: one attempt, its class, a message naming the tenant's SMTP, and no second request", [t.status, t.errorClass, t.error?.startsWith("tenant SMTP failed"), sends().length], ["failed", "timeout", true, 1]);
    }

    console.log("\nwithout migration 0114");
    {
      freshWorld({ status: "missing", sent24h: 100_000 });
      const { value: run, lines } = await captureLogs(() => openRun({ organizationId: ORG }));
      const r = await sendMany(run, people(5), mailTo());
      eq("tenant_mail_status missing: ready when the settings are complete; no limit; every send attempted", [run.status, run.no0114, runReady(run), run.limit, r.map((x) => x.status).join(",")], ["missing", true, true, null, "sent,sent,sent,sent,sent"]);
      eq("…nothing written, nothing marked, and it is not a failed step of the run", [stateWrites().length, run.report.alertMarked, run.errors], [0, false, {}]);
      eq("…one fixed log line, missing (not unreadable), with no address", [lines.filter((l) => l.includes("tenant_mail_status_missing")).length, lines.some((l) => l.includes("unreadable")), lines.some((l) => l.includes("@"))], [1, false, false]);
      freshWorld({ status: "missing", settings: { email_paused: false, event_paused: {} } });
      const nc = await openRun({ organizationId: ORG });
      await sendMany(nc, people(2), mailTo());
      eq("…on an organisation that is not configured: not sent, and no alert marked (no table)", [sends().length, nc.report.alertMarked, stateWrites().length], [0, false, 0]);

      freshWorld({ stateTable: "missing", smtp: () => DEAD });
      const w = await openRun({ organizationId: ORG });
      const wr = await sendMany(w, people(5), mailTo());
      eq("a state write that answers \"no such table\" is tried once and not again in the run", stateWrites().length, 1);
      eq("…and changes no outcome: the stop rule still holds in the run (three attempts, the rest not attempted)", [sends().length, wr.filter((x) => x.errorClass === "not_ready").length, w.errors], [3, 2, {}]);

      freshWorld({ status: "fail" });
      const { value: u, lines: ul } = await captureLogs(() => openRun({ organizationId: ORG }));
      const ur = await sendNotification(one("asset_assignment"), { run: u });
      eq("any other failure reads unreadable, which is not missing: the send is attempted, no limit, no write", [u.status, u.no0114, ur.status, u.limit, stateWrites().length], ["unreadable", false, "sent", null, 0]);
      eq("…it is a failed step of the run (mail_status_read), with its own log line", [u.errors, ul.filter((l) => l.includes("tenant_mail_status_unreadable")).length], [{ mail_status_read: 1 }, 1]);
      freshWorld({ status: "empty" });
      const e = await openRun({ organizationId: ORG });
      eq("an answer that is not one row is unreadable too", [e.status, e.no0114], ["unreadable", false]);
    }

    console.log("\nthe skip helper (note of 2026-11-19)");
    {
      freshWorld();
      const { lines } = await captureLogs(() => recordRecipientsUnreadable("assignments", ORG));
      const beat = requests.filter((r) => r.table === "ops_heartbeats");
      eq("one log line in today's form: event, site and org_id", lines.map((l) => JSON.parse(l)), [{ event: "mail_recipients_unreadable", site: "assignments", org_id: ORG }]);
      eq("one upsert of the row, an error, with the site as its only detail", beat.map((r) => [r.method, (r.body as Row).name, (r.body as Row).last_status, (r.body as Row).last_detail]), [["POST", MAIL_RECIPIENTS_HEARTBEAT, "error", { site: "assignments" }]]);
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
      let threw = false;
      const { lines: l2 } = await captureLogs(async () => { try { await recordRecipientsUnreadable("ticket-requester", ORG); } catch { threw = true; } });
      globalThis.fetch = realFetch;
      eq("a write that fails changes nothing: no throw, and the log line is still written", [threw, l2.length], [false, 1]);
    }
  } finally {
    removeStub();
  }
  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
