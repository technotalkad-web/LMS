/**
 * The tenant's alert (ADR 0029 section E; rule FP3 of the note of 2026-11-18;
 * lib/notifications/smtp-state.ts). An alert is two steps: what owes it only
 * marks it as due on the state row; a scheduled call (sendDueAlert) claims
 * it and mails it, at most one alert in a call.
 *   - a flip marks one alert, and a second flip inside 6 hours of any alert
 *     marks none; mail not sent inside 24 hours of any alert marks none;
 *   - two requests at once mark one; an organisation with no state row gets
 *     its row with the mark;
 *   - no run and no request sends an alert: the run's only mail is the
 *     tenant's;
 *   - the scheduled call: one send of the oldest due alert, to at most five
 *     administrators whose membership counts, super owners first; two calls
 *     at once send one; three due alerts are sent one a call;
 *   - none for an idle organisation or a deleted one; one that is ready
 *     again has its mark cleared and gets no alert;
 *   - an alert is still sent when the organisation's platform allowance for
 *     codes and links is used up (that limit is not the alert's);
 *   - the reading daily_limit: due from the moment routine mail stops, mailed
 *     with the limit;
 *   - a failed read before the claim leaves the alert due for the next call;
 *   - without migration 0114: no mark, and the read for the oldest due alert
 *     answers "none" without an error.
 *
 * Under the stubbed fetch of tests/unit/mail-world.ts. No database, no network.
 *
 * Run:  npx tsx tests/unit/tenant-smtp-alert.test.ts   (or npm run test:unit)
 */
import {
  ORG,
  OTHER_ORG,
  PLATFORM_ENV,
  SMTP_SETTINGS,
  captureLogs,
  eq,
  finish,
  freshWorld,
  installStub,
  removeStub,
  requests,
  sends,
  world,
  type Row,
} from "./mail-world";
import { ALERT_MAX_RECIPIENTS, cronBudget, openRun, sendDueAlert } from "../../lib/notifications/smtp-state";
import { sendMany, sendNotification, type SendArgs } from "../../lib/notifications/send";

const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const BASE = "https://lms.stub";
const people = (n: number, prefix = "0b") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, email: `person${i + 1}@tenant.stub` }));
const mailTo = (p: { id: string; email: string }) => ({ event: "asset_assignment" as const, to: { user_id: p.id, email: p.email }, context: { course_name: "Home loans" } });
const one = (event: SendArgs["event"] = "asset_assignment"): SendArgs => ({ organizationId: ORG, event, to: { user_id: people(1)[0].id, email: people(1)[0].email }, context: {} });
const DEAD = { ok: false as const, error: "Connection refused" };
const ADMINS = (org: string, roles: Array<[string, string]>) => roles.map(([user_id, role]) => ({ organization_id: org, user_id, role, status: "active" }));
const platformSends = () => sends().filter((s) => s.host === "smtp.platform.stub");
const tenantSends = () => sends().filter((s) => s.host === "smtp.tenant.stub");
const dueAlert = (env = PLATFORM_ENV) => sendDueAlert({ baseUrl: BASE, env });

async function main() {
  installStub();
  try {
    console.log("\nmarking an alert as due");
    {
      freshWorld({ smtp: () => DEAD });
      const run = await openRun({ organizationId: ORG });
      await sendMany(run, people(5), mailTo);
      eq("a flip marks one alert as due, by the state row", [run.report.alertMarked, typeof world.state?.alert_due_at], [true, "string"]);
      eq("…and sends none: no platform mail in the run", platformSends().length, 0);
      freshWorld({ smtp: () => DEAD, state: { organization_id: ORG, state: "healthy", state_changed_at: iso(48 * H), failed_recipients: [], last_alert_at: iso(5 * H) } });
      const second = await openRun({ organizationId: ORG });
      await sendMany(second, people(5), mailTo);
      eq("a second flip inside 6 hours of any alert marks none", [world.state?.state, second.report.alertMarked, world.state?.alert_due_at], ["failing", false, null]);
      freshWorld({ settings: { email_paused: false, event_paused: {} }, state: { organization_id: ORG, state: null, state_changed_at: iso(48 * H), failed_recipients: [], last_alert_at: iso(23 * H) } });
      const ns = await openRun({ organizationId: ORG });
      await sendNotification(one(), { run: ns });
      eq("mail not sent while not ready, inside 24 hours of any alert: none marked", [ns.report.alertMarked, world.state?.alert_due_at], [false, null]);
      freshWorld({ settings: { email_paused: false, event_paused: {} } });
      const fresh = await openRun({ organizationId: ORG });
      await sendNotification(one(), { run: fresh });
      eq("…outside it, on an organisation with no state row yet: the row is written with the mark", [fresh.report.alertMarked, typeof world.state?.alert_due_at, world.state?.state], [true, "string", null]);
      freshWorld({ settings: { email_paused: false, event_paused: {} } });
      const [a, b] = await Promise.all([openRun({ organizationId: ORG }), openRun({ organizationId: ORG })]);
      await Promise.all([sendNotification(one(), { run: a }), sendNotification(one(), { run: b })]);
      eq("two requests at once: one mark", [a.report.alertMarked, b.report.alertMarked].filter(Boolean).length, 1);
      const DUE_AT = iso(H);
      freshWorld({ settings: { email_paused: false, event_paused: {} }, state: { organization_id: ORG, state: null, state_changed_at: iso(H), failed_recipients: [], alert_due_at: DUE_AT } });
      const held = await openRun({ organizationId: ORG });
      await sendNotification(one(), { run: held });
      eq("while one is due, a request marks nothing more", [held.report.alertMarked, world.state?.alert_due_at], [false, DUE_AT]);
      freshWorld({ settings: { ...SMTP_SETTINGS, email_paused: true } });
      const paused = await openRun({ organizationId: ORG });
      await sendNotification(one(), { run: paused });
      eq("a paused mail marks nothing (the administrator paused it)", paused.report.alertMarked, false);
      freshWorld();
      const idle = await openRun({ organizationId: ORG });
      eq("an idle organisation that has not tried to send marks nothing", [idle.report.alertMarked, world.state], [false, null]);
      freshWorld({ settings: { email_paused: false, event_paused: {} }, org: { id: ORG, name: "Tenant A", slug: "tenant-a", deleted_at: iso(H) } });
      const gone = await openRun({ organizationId: ORG });
      await sendNotification(one(), { run: gone });
      eq("a deleted organisation marks nothing", [gone.report.alertMarked, world.state], [false, null]);
    }

    console.log("\nthe scheduled call sends it");
    {
      const due = (over: Row = {}) => ({ organization_id: ORG, state: "failing", state_changed_at: iso(H), failed_recipients: ["x1"], last_error_code: "auth", alert_due_at: iso(30 * 60_000), last_alert_at: null, ...over });
      const admins = ADMINS(ORG, [["a-admin-1", "admin"], ["a-admin-2", "admin"], ["s-owner-2", "super_owner"], ["a-admin-3", "admin"], ["s-owner-1", "super_owner"], ["a-admin-4", "admin"], ["a-admin-5", "admin"], ["l-learner", "user"]]);
      const profiles = Object.fromEntries(admins.map((m) => [m.user_id, `${m.user_id}@tenant.stub`]));
      freshWorld({ state: due(), members: [...admins, { organization_id: ORG, user_id: "s-inactive", role: "super_owner", status: "inactive" }], profiles: { ...profiles, "s-inactive": "s-inactive@tenant.stub" } });
      const r = await dueAlert();
      // The five mails start together, so their order on the wire is not fixed: the set is checked.
      eq("one alert: at most five administrators whose membership counts, super owners first (both owners, then the first three admins)", [r.kind, platformSends().map((s) => String(s.to)).sort()], ["sent", ["a-admin-1@tenant.stub", "a-admin-2@tenant.stub", "a-admin-3@tenant.stub", "s-owner-1@tenant.stub", "s-owner-2@tenant.stub"]]);
      eq(`…${ALERT_MAX_RECIPIENTS} platform mails with the reading and the class, and no tenant mail`, [platformSends().length, tenantSends().length, String(platformSends()[0]?.text).includes("refused the sign-in"), r.kind === "sent" ? r.reading : null], [5, 0, true, "failing"]);
      eq("…claimed: alert_due_at emptied, last_alert_at set", [world.state?.alert_due_at, typeof world.state?.last_alert_at], [null, "string"]);
      eq("…the settings address is the organisation's on the platform address", String(platformSends()[0]?.text).includes(`${BASE}/tenant-a/settings`), true);
      eq("…the platform log holds user ids, never an address", JSON.stringify(world.platformLog).includes("@"), false);
      const again = await dueAlert();
      eq("the next call finds nothing due", [again.kind, platformSends().length], ["none", 5]);

      freshWorld({ state: due(), members: admins, profiles });
      const [x, y] = await Promise.all([dueAlert(), dueAlert()]);
      eq("two calls at once send one alert", [[x.kind, y.kind].filter((k) => k === "sent").length, platformSends().length], [1, 5]);

      freshWorld({ state: due({ alert_due_at: iso(10 * 60_000) }), members: [...admins, ...ADMINS(OTHER_ORG, [["b-admin", "admin"]])], profiles: { ...profiles, "b-admin": "b-admin@tenant.stub" } });
      world.otherStates.push({ organization_id: OTHER_ORG, state: "failing", state_changed_at: iso(H), failed_recipients: [], last_error_code: "quota", alert_due_at: iso(50 * 60_000), last_alert_at: null });
      world.otherStates.push({ organization_id: "0a000000-0000-4000-8000-0000000000c1", state: "failing", state_changed_at: iso(H), failed_recipients: [], last_error_code: "quota", alert_due_at: iso(5 * 60_000), last_alert_at: null });
      world.org = { id: OTHER_ORG, name: "Tenant B", slug: "tenant-b", deleted_at: null };
      const first = await dueAlert();
      eq("three due: one call sends one alert, the oldest", [first.kind, platformSends().map((s) => s.to), world.otherStates[0].alert_due_at, typeof world.state?.alert_due_at, typeof world.otherStates[1].alert_due_at], ["sent", ["b-admin@tenant.stub"], null, "string", "string"]);

      freshWorld({ state: due(), members: admins, profiles });
      world.platformLog.push(...Array.from({ length: 60 }, () => ({ event_type: "platform_reset_code", organization_id: ORG, status: "sent" })));
      eq("the organisation's platform allowance for codes and links used up: the alert still goes", [(await dueAlert()).kind, platformSends().length], ["sent", 5]);
    }

    console.log("\nnone for a deleted organisation, none once ready again");
    {
      const LAST = iso(30 * H);
      freshWorld({ state: { organization_id: ORG, state: "failing", state_changed_at: iso(H), failed_recipients: [], last_error_code: "auth", alert_due_at: iso(H), last_alert_at: LAST }, org: { id: ORG, name: "Tenant A", slug: "tenant-a", deleted_at: iso(1) }, members: ADMINS(ORG, [["s1", "super_owner"]]), profiles: { s1: "s1@tenant.stub" } });
      const d = await dueAlert();
      eq("deleted: no alert, the mark cleared, last_alert_at untouched", [d, platformSends().length, world.state?.alert_due_at, world.state?.last_alert_at], [{ kind: "dropped", reason: "deleted" }, 0, null, LAST]);
      freshWorld({ state: { organization_id: ORG, state: "healthy", state_changed_at: iso(H), failed_recipients: [], alert_due_at: iso(H), last_alert_at: null }, members: ADMINS(ORG, [["s1", "super_owner"]]), profiles: { s1: "s1@tenant.stub" } });
      const c = await dueAlert();
      eq("ready again (healthy, settings complete, under its routine line): no alert, the mark cleared", [c, platformSends().length, world.state?.alert_due_at, world.state?.last_alert_at], [{ kind: "dropped", reason: "cleared" }, 0, null, null]);
      freshWorld({ state: { organization_id: ORG, state: "failing", state_changed_at: iso(H), failed_recipients: [], alert_due_at: iso(H) }, members: ADMINS(ORG, [["l1", "user"]]), profiles: { l1: "l1@tenant.stub" } });
      eq("no administrator counts: no alert, the mark cleared", [await dueAlert(), world.state?.alert_due_at], [{ kind: "dropped", reason: "no_recipients" }, null]);
      freshWorld({ settings: { email_paused: false, event_paused: {} }, state: { organization_id: ORG, state: null, state_changed_at: iso(H), failed_recipients: [], alert_due_at: iso(H) }, members: ADMINS(ORG, [["s1", "super_owner"]]), profiles: { s1: "s1@tenant.stub" } });
      const nc = await dueAlert();
      eq("not configured: the alert says so", [nc.kind === "sent" ? nc.reading : nc.kind, String(platformSends()[0]?.text).includes("no complete SMTP settings")], ["not_configured", true]);
    }

    console.log("\nthe reading daily_limit");
    {
      freshWorld({ sent24h: 337, members: ADMINS(ORG, [["s1", "super_owner"]]), profiles: { s1: "s1@tenant.stub" } });
      const run = await openRun({ organizationId: ORG });
      const r = await sendMany(run, people(3), mailTo);
      eq("routine mail at 337 of 375: not attempted, and an alert due from that moment", [r.map((x) => x.errorClass).join(","), run.report.routineStopped, run.report.alertMarked, tenantSends().length], ["daily_limit,daily_limit,daily_limit", true, true, 0]);
      const a = await dueAlert();
      eq("the scheduled call mails the reading daily_limit with the limit", [a.kind === "sent" ? a.reading : a.kind, String(platformSends()[0]?.text).includes("375 emails in 24 hours")], ["daily_limit", true]);
      freshWorld({ sent24h: 375, state: { organization_id: ORG, state: "healthy", state_changed_at: iso(H), failed_recipients: [], last_success_at: iso(H), last_alert_at: iso(H) } });
      const at = await openRun({ organizationId: ORG });
      await sendNotification(one("password_reset"), { run: at });
      eq("at the limit itself, the same day: no second alert", [at.report.alertMarked, world.state?.alert_due_at ?? null], [false, null]);
    }

    console.log("\na failed read before the claim leaves the alert due");
    {
      const base = () => ({ state: { organization_id: ORG, state: "failing", state_changed_at: iso(H), failed_recipients: [], last_error_code: "auth", alert_due_at: iso(H) } as Row, members: ADMINS(ORG, [["s1", "super_owner"]]), profiles: { s1: "s1@tenant.stub" } });
      for (const [label, over, step] of [
        ["the members cannot be read", { membersFail: true }, "recipients"],
        ["the addresses cannot be read", { profilesFail: true }, "addresses"],
        ["the settings cannot be read", { settings: "fail" as const }, "read"],
        ["the state with its count cannot be read", { status: "fail" as const }, "read"],
      ] as const) {
        freshWorld({ ...base(), ...over });
        const { value, lines } = await captureLogs(() => dueAlert());
        eq(`${label}: failed (${step}), nothing sent, the alert still due`, [value, platformSends().length, typeof world.state?.alert_due_at], [{ kind: "failed", step }, 0, "string"]);
        eq("…logged with a fixed step and no address", [lines.some((l) => l.includes("tenant_smtp_alert_failed")), lines.some((l) => l.includes("@"))], [true, false]);
      }
      freshWorld(base());
      world.stateTable = "fail";
      eq("the read for the oldest due alert fails: failed (read)", await dueAlert(), { kind: "failed", step: "read" });
      freshWorld(base());
      eq("no platform address to link to: failed (config), nothing read", [await sendDueAlert({ baseUrl: "", env: PLATFORM_ENV }), requests.length], [{ kind: "failed", step: "config" }, 0]);
      freshWorld(base());
      const tight = cronBudget({ spent: 30 });
      eq("a call with no room for an alert reads nothing and leaves it due", [await sendDueAlert({ baseUrl: BASE, env: PLATFORM_ENV, budget: tight }), requests.length, typeof world.state?.alert_due_at], [{ kind: "no_room" }, 0, "string"]);
    }

    console.log("\nwithout migration 0114");
    {
      freshWorld({ status: "missing", stateTable: "missing", settings: { email_paused: false, event_paused: {} } });
      const run = await openRun({ organizationId: ORG });
      await sendNotification(one(), { run });
      eq("no alert is marked (nothing is written)", [run.report.alertMarked, requests.filter((r) => r.table === "tenant_smtp_state").length], [false, 0]);
      const { value, lines } = await captureLogs(() => dueAlert());
      eq("the read for the oldest due alert answers none, without an error", [value, lines.length], [{ kind: "none" }, 0]);
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
