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
 *     event obeys it, custom_broadcast (broadcasts, ticket and
 *     attempt-request mail) included, under the master pause and its own
 *     event pause (the owner's decision of 2026-11-21): a ticket's and an
 *     attempt request's mail to the administrators and a learner's decision
 *     mail write their paused rows, and a reset code, a sign-in link and the
 *     Settings test still go;
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
 *   - recordRecipientsUnreadable (ADR 0029, note of 2026-11-19), and the
 *     scan that holds the event name to the helper and the two crons;
 *   - stage 2: the Settings test (a delivery reads healthy, a failure
 *     failing at once, rejected changes nothing, settings that are not
 *     complete attempt nothing, without 0114 it is sent and its state write
 *     skipped; a test the platform's call limit refused is no SMTP failure:
 *     no state settled, no alert marked, no row, the fixed line, and the
 *     Settings answer says call_limit); the platform's call limit
 *     (call_limit, one fixed line, the rest left, nothing written); the
 *     run's group hooks (a claim taken for
 *     each group just before its sends, a withdrawn mail not attempted, the
 *     state written with each group); a learner's request that mails the
 *     administrators, with their read or their addresses unreadable;
 *     an organisation read that fails attempts nothing.
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
import { runSettingsTest, sendMany, sendNotification, sendSettingsTest, type SendArgs } from "../../lib/notifications/send";
import { CALL_LIMIT_LOG_EVENT, requestBudget } from "../../lib/notifications/smtp-state";
import { notifyAdminsOfTicket } from "../../lib/tickets/notify";
import { notifyAdminsOfRequest, notifyLearnerOfDecision, reissueNotifier } from "../../lib/attempts/requests";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
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
      // The owner's decision of 2026-11-21: custom_broadcast (broadcasts,
      // ticket and attempt-request mail) is under the pause like every event
      // but the two a person asks for on the public pages.
      for (const [label, settings] of [["the master pause", { ...SMTP_SETTINGS, email_paused: true }], ["its own event pause", { ...SMTP_SETTINGS, event_paused: { custom_broadcast: true } }]] as const) {
        freshWorld({ settings });
        const b = await sendNotification({ ...one("custom_broadcast"), override: { subject: "Notice", body_md: "Hello" } });
        eq(`custom_broadcast under ${label}: paused, not attempted, nothing sent, its row written as paused`,
          [b.status, b.errorClass, b.attempted, sends().length, logRows().map((r) => [r.event_type, r.status, r.subject])], ["paused", "paused", false, 0, [["custom_broadcast", "failed", "(paused)"]]]);
        const code = await sendNotification(one("password_reset"));
        const link = await sendNotification(one("magic_link"));
        eq(`…under ${label} a reset code and a sign-in link still go`, [code.status, link.status, sends().length], ["sent", "sent", 2]);
      }
      for (const [label, settings] of [["the master pause", { ...SMTP_SETTINGS, email_paused: true }], ["the custom_broadcast pause", { ...SMTP_SETTINGS, event_paused: { custom_broadcast: true } }]] as const) {
        const admins = [{ organization_id: ORG, user_id: "0d000000-0000-4000-8000-000000000001", role: "admin", status: "active" }];
        const learner = { organization_id: ORG, user_id: "0e000000-0000-4000-8000-000000000001", role: "user", status: "active" };
        const db = () => createClient("http://stub.supabase.test", "stub-service-key-0029", { auth: { persistSession: false } });
        const world = () => freshWorld({ settings, members: [...admins, learner], profiles: { [admins[0].user_id]: "admin1@tenant.stub", [learner.user_id]: "learner@tenant.stub" } });
        world();
        await notifyAdminsOfTicket(db(), { orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "", subject: "Help", requester: { name: "A manager", email: null }, categoryLabel: "Retry", lines: ["one"], note: null });
        eq(`a ticket's mail to the administrators under ${label}: paused, nothing sent, its row written as paused`, [sends().length, logRows().map((r) => [r.to_user_id, r.status, r.subject])], [0, [[admins[0].user_id, "failed", "(paused)"]]]);
        world();
        await notifyAdminsOfRequest(db(), { orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "", courseTitle: "Home loans", learnerEmail: "learner@tenant.stub", reason: null });
        eq(`an attempt request's mail to the administrators under ${label}: paused, nothing sent, its row written as paused`, [sends().length, logRows().map((r) => [r.to_user_id, r.status, r.subject])], [0, [[admins[0].user_id, "failed", "(paused)"]]]);
        world();
        const decision = await notifyLearnerOfDecision(db(), { orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "", courseId: "c-0029", courseTitle: "Home loans", learner: { id: learner.user_id, email: "learner@tenant.stub" }, approved: true });
        eq(`the learner's decision mail under ${label}: not emailed, nothing sent, its row written as paused`,
          [sends().length, logRows().map((r) => [r.to_user_id, r.status, r.subject]), (decision as { emailed?: number } | null)?.emailed], [0, [[learner.user_id, "failed", "(paused)"]], 0]);
      }
      // The switch: the Settings page's list of event pauses holds
      // custom_broadcast, and its words name the three kinds of mail it stops.
      const settingsPage = fs.readFileSync(path.join(__dirname, "..", "..", "app", "[org]", "(admin)", "settings", "settings-client.tsx"), "utf8").replace(/\r\n/g, "\n");
      const pauseList = settingsPage.slice(settingsPage.indexOf("const PAUSE_EVENTS"), settingsPage.indexOf("];", settingsPage.indexOf("const PAUSE_EVENTS")));
      eq("the Settings page has a pause switch for custom_broadcast, labelled with broadcasts, ticket and attempt-request email",
        [/"custom_broadcast",/.test(pauseList), /custom_broadcast: "Custom broadcast, ticket and attempt-request email"/.test(settingsPage), /PAUSE_LABELS\[ev\] \?\? EVENT_LABELS\[ev\]/.test(settingsPage)], [true, true, true]);
    }

    console.log("\na deleted organisation; one scheduled for deletion");
    {
      freshWorld({ org: { id: ORG, name: "Tenant A", slug: "tenant-a", deleted_at: iso(H) }, state: { organization_id: ORG, state: "healthy", state_changed_at: iso(H), failed_recipients: [] } });
      const run = await openRun({ organizationId: ORG });
      const r = await sendMany(run, people(3), mailTo());
      eq("deleted: reads not_configured, not ready, nothing attempted", [runReading(run), runReady(run), sends().length, r.map((x) => x.errorClass)], ["not_configured", false, 0, ["not_configured", "not_configured", "not_configured"]]);
      eq("…no alert marked, no state written", [run.report.alertMarked, stateWrites().length], [false, 0]);
      // The real column (supabase/migrations/0021_platform_owner.sql), set,
      // with deleted_at empty: the organisation is live for its grace.
      freshWorld({ org: { id: ORG, name: "Tenant A", slug: "tenant-a", deleted_at: null, scheduled_deletion_at: iso(-30 * 24 * H) } });
      const scheduled = await openRun({ organizationId: ORG });
      eq("scheduled for deletion (deleted_at empty): live, ready, and it sends as today", [scheduled.deleted, runReady(scheduled), (await sendNotification(one("asset_assignment"), { run: scheduled })).status], [false, true, "sent"]);
      freshWorld({ org: "fail" });
      const run2 = await openRun({ organizationId: ORG });
      const r2 = await sendNotification(one("asset_assignment"), { run: run2 });
      eq("an organisation read that fails: whether it is deleted is not known, so nothing is attempted (a deleted organisation's SMTP is never used)",
        [run2.deleted, runReady(run2), r2.status, r2.errorClass, r2.attempted, sends().length], [false, false, "failed", "settings_unreadable", false, 0]);
      eq("…its row says the organisation could not be read, and the state is not written", [logRows()[0]?.error, stateWrites().length], ["The organisation could not be read. Nothing was sent.", 0]);
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

    console.log("\nthe event name of a skipped request: the helper and the two crons only (note of 2026-11-19, point 7)");
    {
      const ROOT = path.resolve(__dirname, "..", "..");
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const q = path.join(dir, d.name);
          if (d.isDirectory()) walk(q);
          else if (/\.(ts|tsx)$/.test(d.name)) files.push(q);
        }
      };
      walk(path.join(ROOT, "app"));
      walk(path.join(ROOT, "lib"));
      const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");
      const named = files.filter((f) => fs.readFileSync(f, "utf8").includes("mail_recipients_unreadable")).map(rel).sort();
      eq("mail_recipients_unreadable is written in the helper and the two cron routes, and nowhere else", named,
        ["app/api/cron/journey-nudges/route.ts", "app/api/cron/reminders/route.ts", "lib/notifications/smtp-state.ts"]);
      for (const cron of ["app/api/cron/reminders/route.ts", "app/api/cron/journey-nudges/route.ts"]) {
        const src = fs.readFileSync(path.join(ROOT, cron), "utf8");
        eq(`${cron} neither names the skip row nor calls the helper`, [src.includes("mail-recipients-unreadable"), src.includes("MAIL_RECIPIENTS_HEARTBEAT"), src.includes("recordRecipientsUnreadable")], [false, false, false]);
      }
    }

    console.log("\nthe Settings test (section C, step 11)");
    {
      const admin = { user_id: "0c000000-0000-4000-8000-000000000001", email: "admin@tenant.stub" };
      freshWorld();
      let run = await openRun({ organizationId: ORG, budget: requestBudget() });
      let r = await sendSettingsTest(run, admin);
      eq("a delivered test: sent, the state written healthy, one row logged as sent under its own event",
        [r.status, (world.state as Row | null)?.state, logRows().map((x) => [x.event_type, x.status, x.to_address])], ["sent", "healthy", [["smtp_test", "sent", admin.email]]]);
      eq("…the fixed text goes through the organisation's own server only", [sends().length, sends()[0]?.host], [1, "smtp.tenant.stub"]);
      freshWorld({ state: { organization_id: ORG, state: "healthy", state_changed_at: iso(H), failed_recipients: [], last_success_at: iso(H) }, smtp: () => ({ ok: false, error: "535 5.7.8 Username and Password not accepted" }) });
      run = await openRun({ organizationId: ORG });
      r = await sendSettingsTest(run, admin);
      eq("a failed test turns the organisation failing at once, with its class, and marks one alert as due (nothing is mailed by the request)",
        [r.status, r.errorClass, (world.state as Row | null)?.state, (world.state as Row | null)?.last_error_code, typeof (world.state as Row | null)?.alert_due_at, world.platformLog.length], ["failed", "auth", "failing", "auth", "string", 0]);
      freshWorld({ state: { organization_id: ORG, state: "healthy", state_changed_at: iso(H), failed_recipients: [], last_success_at: iso(H) }, smtp: () => ({ ok: false, error: "550 5.1.1 user unknown" }) });
      run = await openRun({ organizationId: ORG });
      r = await sendSettingsTest(run, admin);
      eq("…a rejected test (the receiving mailbox refused it) changes nothing", [r.errorClass, (world.state as Row | null)?.state, stateWrites().length], ["rejected", "healthy", 0]);
      freshWorld({ settings: { ...SMTP_SETTINGS, smtp_host: null } });
      run = await openRun({ organizationId: ORG });
      r = await sendSettingsTest(run, admin);
      eq("settings that are not complete: not attempted, not_configured, its row written, nothing sent", [r.attempted, r.errorClass, sends().length, logRows().length], [false, "not_configured", 0, 1]);
      freshWorld({ settings: { ...SMTP_SETTINGS, email_paused: true } });
      run = await openRun({ organizationId: ORG });
      eq("a pause does not stop the test: the administrator asked for it", (await sendSettingsTest(run, admin)).status, "sent");
      freshWorld({ settings: { ...SMTP_SETTINGS, event_paused: { custom_broadcast: true } } });
      run = await openRun({ organizationId: ORG });
      eq("…nor does the custom_broadcast pause: the test is no event of the organisation's mail", (await sendSettingsTest(run, admin)).status, "sent");
      freshWorld({ status: "missing" });
      run = await openRun({ organizationId: ORG });
      r = await sendSettingsTest(run, admin);
      eq("without 0114: the test is sent and shown, and its state write is skipped", [r.status, sends().length, stateWrites().length], ["sent", 1, 0]);
      // The platform refused the outbound call itself (rule FP8): the test never
      // reached the mail server, so it says nothing of the SMTP. Read as the
      // run's attemptOne reads it, from a healthy organisation, so a flip or an
      // alert mark would show.
      const healthy = { organization_id: ORG, state: "healthy", state_changed_at: iso(H), failed_recipients: [], last_success_at: iso(H) };
      freshWorld({ state: { ...healthy }, smtp: () => ({ ok: false, error: "Too many subrequests." }) });
      run = await openRun({ organizationId: ORG, budget: requestBudget() });
      const limited = await captureLogs(() => sendSettingsTest(run, admin));
      eq("a test the platform's call limit refused: left and not attempted, never an SMTP class",
        [limited.value.status, limited.value.errorClass, limited.value.attempted], ["failed", "left", false]);
      eq("…no state settled (still healthy, nothing written), no alert marked, no row written",
        [(world.state as Row | null)?.state, stateWrites().length, (world.state as Row | null)?.alert_due_at ?? null, logInserts().length], ["healthy", 0, null, 0]);
      eq("…counted once as call_limit, with the one fixed log line",
        [run.errors.call_limit, limited.lines.filter((l) => l.includes(CALL_LIMIT_LOG_EVENT)).length], [1, 1]);
      freshWorld({ state: { ...healthy }, smtp: () => ({ ok: false, error: "Too many subrequests." }) });
      const shown = await captureLogs(() => runSettingsTest({ organizationId: ORG, user: { id: admin.user_id, email: admin.email } }));
      eq("…the Settings answer says so: not sent, not attempted, call_limit, and the reading is the one before the test",
        [shown.value.status, shown.value.attempted, shown.value.errorClass, shown.value.reading, stateWrites().length], ["not_sent", false, "call_limit", "healthy", 0]);
      const page = fs.readFileSync(path.join(__dirname, "..", "..", "app", "[org]", "(admin)", "settings", "settings-client.tsx"), "utf8");
      eq("…and the Settings page has words for it", /call_limit:\s*"[^"]*limit on outbound calls[^"]*not tested/.test(page), true);
    }

    console.log("\nthe platform's call limit (rule FP8)");
    {
      freshWorld({ smtp: () => ({ ok: false, error: "Too many subrequests." }) });
      const run = await openRun({ organizationId: ORG, budget: requestBudget() });
      const { value: r, lines } = await captureLogs(() => sendMany(run, people(6), mailTo()));
      eq("a send the platform refuses is no tenant failure: left, not attempted, the state not written, no further send",
        [r.map((x) => x.errorClass), r.every((x) => x.attempted === false), stateWrites().length, sends().length], [["left", "left", "left", "left", "left", "left"], true, 0, 1]);
      eq("…counted once as call_limit, with one fixed log line, and no row written", [run.errors.call_limit, lines.filter((l) => l.includes(CALL_LIMIT_LOG_EVENT)).length, logInserts().length], [1, 1, 0]);
    }

    console.log("\nthe run's group hooks (rules T4 and FP7)");
    {
      freshWorld();
      const run = await openRun({ organizationId: ORG, budget: requestBudget() });
      const claimed: string[][] = [];
      const written: string[][] = [];
      const lost = new Set([people(6)[2].id]);
      const r = await sendMany(run, people(6), mailTo(), {
        hooks: {
          beforeCalls: 1,
          before: async (group) => {
            claimed.push(group.map((x) => x.id));
            return { keep: group.map((x) => !lost.has(x.id)), calls: 1 };
          },
          afterCalls: 1,
          after: async (entries) => {
            written.push(entries.map((e) => `${e.item.id.slice(-1)}:${e.result.status}`));
            return { calls: 1 };
          },
        },
      });
      eq("each group is claimed just before its sends: the first alone, then the rest", claimed.map((g) => g.length), [1, 4, 1]);
      eq("…one the claim did not keep is withdrawn: not attempted, no row", [r[2].errorClass, r[2].attempted, logRows().some((x) => x.to_user_id === people(6)[2].id)], ["withdrawn", false, false]);
      eq("…the caller's step after each group sees that group's mail", written, [["1:sent"], ["2:sent", "3:not_attempted", "4:sent", "5:sent"], ["6:sent"]]);
      freshWorld();
      const tight = requestBudget({ spent: 24 });
      const run2 = await openRun({ organizationId: ORG, budget: tight });
      const claims: number[] = [];
      const r2 = await sendMany(run2, people(10), mailTo(), {
        hooks: { beforeCalls: 1, before: async (g) => { claims.push(g.length); return { keep: g.map(() => true), calls: 1 }; } },
      });
      const started = r2.filter((x) => x.attempted).length;
      eq("a mail the request had no room for holds no claim: only the groups that started were claimed", [claims.reduce((a, b) => a + b, 0), started > 0, started < 10], [started, true, true]);
      eq("…the hooks' calls are within the sum", tight.calls <= 40, true);
    }

    console.log("\nmail to the administrators from a learner's request (note of 2026-11-19, point 2)");
    {
      const db = () => createClient("http://stub.supabase.test", "stub-service-key-0029", { auth: { persistSession: false } });
      const admins = [
        { organization_id: ORG, user_id: "0d000000-0000-4000-8000-000000000001", role: "super_owner", status: "active" },
        { organization_id: ORG, user_id: "0d000000-0000-4000-8000-000000000002", role: "admin", status: "active" },
      ];
      const profiles = Object.fromEntries(admins.map((a, i) => [a.user_id, `admin${i + 1}@tenant.stub`]));
      const ticket = () => notifyAdminsOfTicket(db(), { orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "", subject: "Help", requester: { name: "A manager", email: null }, categoryLabel: "Retry", lines: ["one"], note: null });
      const request = () => notifyAdminsOfRequest(db(), { orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "", courseTitle: "Home loans", learnerEmail: "learner@tenant.stub", reason: null });
      const skipRows = () => requests.filter((q) => q.table === "ops_heartbeats").map((q) => (q.body as Row).last_detail);
      for (const [label, send, site] of [["a ticket", ticket, "ticket-admins"], ["an attempt request", request, "attempt-request"]] as const) {
        freshWorld({ members: admins, profiles });
        await send();
        eq(`${label}: the administrators are mailed in one run (one state read)`, [logRows().map((x) => x.to_user_id).sort(), statusCalls().length], [admins.map((a) => a.user_id).sort(), 1]);
        freshWorld({ members: admins, profiles, membersFail: true });
        await captureLogs(() => send());
        eq(`${label}, the administrators cannot be read: nobody mailed, the sender not entered, the skip recorded once`, [sends().length, statusCalls().length, skipRows()], [0, 0, [{ site }]]);
        freshWorld({ members: admins, profiles, profilesFail: true });
        await captureLogs(() => send());
        eq(`${label}, their addresses cannot be read: never "no address": nobody mailed, the skip recorded once`, [sends().length, statusCalls().length, skipRows()], [0, 0, [{ site }]]);
        freshWorld({ members: [], profiles });
        await send();
        eq(`${label}, a read that finds no administrator: nothing is sent and nothing is recorded`, [sends().length, skipRows()], [0, []]);
      }
    }

    console.log("\na forced restart's re-issue mails: one run for the request (rule T4)");
    {
      const db = () => createClient("http://stub.supabase.test", "stub-service-key-0029", { auth: { persistSession: false } });
      const learners = people(5);
      const counting = new Set(learners.map((p) => p.id));
      const reissue = async (notify: ReturnType<typeof reissueNotifier>["notify"]) => {
        for (const p of learners) {
          await notify.decision(db(), { orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "", courseId: "c-0029", courseTitle: "Home loans", learner: { id: p.id, email: p.email }, approved: true, note: null, expiresAt: null, counting });
        }
      };
      freshWorld({ smtp: () => DEAD, state: { organization_id: ORG, state: "failing", state_changed_at: iso(H), failed_recipients: ["x1", "x2", "x3"], last_error_code: "unreachable", last_alert_at: iso(H) } });
      const failing = reissueNotifier();
      await reissue(failing.notify);
      eq("five re-issued learners on a failing organisation: one read of its state and one send, the probe; the other four not attempted",
        [statusCalls().length, sends().length, failing.outcome()], [1, 1, { recipients_unreadable: false, emailed: 0, not_emailed: 5, not_confirmed: 0 }]);
      freshWorld();
      const healthy = reissueNotifier();
      await reissue(healthy.notify);
      eq("…on a ready organisation the five go in that one run", [statusCalls().length, sends().length, healthy.outcome()], [1, 5, { recipients_unreadable: false, emailed: 5, not_emailed: 0, not_confirmed: 0 }]);
      freshWorld();
      const spent = requestBudget({ spent: 40 });
      const full = reissueNotifier({ budget: spent });
      await reissue(full.notify);
      eq("…a request whose budget is spent sends none: the run draws on the request's count", [sends().length, (full.outcome() as { not_emailed?: number } | undefined)?.not_emailed], [0, 5]);
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
