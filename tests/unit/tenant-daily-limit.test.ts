/**
 * A daily limit for each tenant (ADR 0029, rule FP4 of the note of
 * 2026-11-18; lib/notifications/smtp-state.ts), the run's cases and the
 * readers' cases (stage 4). The limit route's cases are in
 * tests/unit/platform-email-console.test.ts, which signs in a platform
 * owner.
 *   - the numbers: 375 where none is set, or the environment's default; the
 *     reserve a tenth, rounded up, at least 25; routine mail stops at 337 of
 *     375, 1,350 of 1,500, 5 of 30, and never below 0 for a limit under 25;
 *     also for a limit below 250;
 *   - the count is read once for a run, by one call, and carried: sends
 *     already started count;
 *   - other mail stops at the limit less the reserve and a code still goes;
 *     at the limit nothing is attempted and the organisation reads not
 *     ready; the state does not become failing;
 *   - a single mail stopped by the limit writes one failed row with the fixed
 *     error daily_limit; a loop writes none for each person and reports the
 *     count;
 *   - one alert, due from the moment routine mail stops;
 *   - when tenant_mail_status cannot be read, or 0114 is not pasted, no limit
 *     is applied and the send is attempted;
 *   - the readers (stage 4): every organisation's reading, count and limit
 *     from one call of tenant_mail_status for all of them, whether an
 *     organisation that would warn has an active member, "missing" without
 *     0114 and "unreadable" for any other failure; the code and link jobs'
 *     counts; one organisation's notice for its banner and its Attention
 *     Center item, in two calls (one for the count), with its four causes;
 *     the provider gives no item for a state it cannot read and does not
 *     throw, while settings that are incomplete still give not_configured
 *     from the settings alone, and its item cannot be marked as read;
 *   - a limit of 25 or less, where routine mail never goes: its own notice
 *     (routine_off), a warning that names the limit as the cause and never
 *     "for today", on the console's list and in the Attention Center item,
 *     the banner and the SMTP tab.
 *
 * Under the stubbed fetch of tests/unit/mail-world.ts. No database, no network.
 *
 * Run:  npx tsx tests/unit/tenant-daily-limit.test.ts   (or npm run test:unit)
 */
import { ORG, OTHER_ORG, SMTP_SETTINGS, SUPABASE, eq, finish, freshWorld, installStub, logRows, removeStub, requests, sends, stateWrites, statusCalls, world } from "./mail-world";
import {
  DAILY_LIMIT_RESERVE_MIN,
  DEFAULT_TENANT_DAILY_LIMIT,
  NEAR_LIMIT_SHARE,
  RESERVE_EVENTS,
  dailyLimitAllows,
  drawsOnReserve,
  openRun,
  readMailJobCounts,
  readTenantMailNotice,
  readTenantSmtpOverview,
  readingSince,
  runReady,
  tenantDailyLimit,
  tenantMailNoticeOf,
} from "../../lib/notifications/smtp-state";
import { sendMany, sendNotification, type SendArgs } from "../../lib/notifications/send";
import { collectAttention } from "../../lib/attention/collect";
import { ATTENTION_PROVIDERS } from "../../lib/attention/types";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `0b000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, email: `person${i + 1}@tenant.stub` }));
const routine = (p: { id: string; email: string }) => ({ event: "asset_reminder" as const, to: { user_id: p.id, email: p.email }, context: {} });
const code = (p: { id: string; email: string }) => ({ event: "password_reset" as const, to: { user_id: p.id, email: p.email }, context: { otp_code: "123456", otp_minutes: "10" } });
const one = (event: SendArgs["event"]): SendArgs => ({ organizationId: ORG, event, to: { user_id: people(1)[0].id, email: people(1)[0].email }, context: {} });

async function main() {
  installStub();
  try {
    console.log("\nthe numbers");
    eq("375 where none is set", [DEFAULT_TENANT_DAILY_LIMIT, tenantDailyLimit(null, {})], [375, { limit: 375, reserve: 38, routineStop: 337 }]);
    eq("1,500 (the production tenant): routine mail stops at 1,350", tenantDailyLimit(1500, {}), { limit: 1500, reserve: 150, routineStop: 1350 });
    eq("30 (spec 79's): the reserve is at least 25, so routine mail stops at 5", tenantDailyLimit(30, {}), { limit: 30, reserve: DAILY_LIMIT_RESERVE_MIN, routineStop: 5 });
    eq("a limit below 250 keeps the 25 (200: stops at 175)", tenantDailyLimit(200, {}), { limit: 200, reserve: 25, routineStop: 175 });
    eq("under 25 routine mail never goes, and the line is never below 0", tenantDailyLimit(10, {}), { limit: 10, reserve: 25, routineStop: 0 });
    eq("TENANT_EMAIL_DEFAULT_DAILY_LIMIT sets the default for an environment", tenantDailyLimit(null, { TENANT_EMAIL_DEFAULT_DAILY_LIMIT: "1000" }), { limit: 1000, reserve: 100, routineStop: 900 });
    eq("…a stored number wins over it", tenantDailyLimit(60, { TENANT_EMAIL_DEFAULT_DAILY_LIMIT: "1000" }).limit, 60);
    eq("…a value that is not a whole number from 1 to 100,000 is ignored", [tenantDailyLimit(null, { TENANT_EMAIL_DEFAULT_DAILY_LIMIT: "0" }).limit, tenantDailyLimit(null, { TENANT_EMAIL_DEFAULT_DAILY_LIMIT: "lots" }).limit, tenantDailyLimit(0, {}).limit], [375, 375, 375]);
    eq("the reserve is for reset codes, sign-in links and welcome mail", [...RESERVE_EVENTS].sort(), ["account_creation", "account_invite", "magic_link", "password_reset"]);
    eq("…routine mail does not draw on it", ["asset_reminder", "custom_broadcast", "asset_completion", "journey_nudge"].map((e) => drawsOnReserve(e as SendArgs["event"])), [false, false, false, false]);
    const L = tenantDailyLimit(375, {});
    eq("at 336 a routine mail fits, at 337 it does not; a code fits to 374", [dailyLimitAllows(336, L, "asset_reminder"), dailyLimitAllows(337, L, "asset_reminder"), dailyLimitAllows(374, L, "password_reset"), dailyLimitAllows(375, L, "password_reset")], [true, false, true, false]);

    console.log("\nthe run reads the count once and carries it");
    {
      freshWorld({ sent24h: 335 });
      const run = await openRun({ organizationId: ORG });
      const r = await sendMany(run, people(6), routine);
      eq("335 sent of 375: two routine mails go, the four others stop at the line", [r.map((x) => x.status === "sent" ? "sent" : x.errorClass).join(","), sends().length], ["sent,sent,daily_limit,daily_limit,daily_limit,daily_limit", 2]);
      eq("…one call for the count, for the whole run", statusCalls().length, 1);
      eq("…a loop writes no row for a person the limit stopped (the count is reported)", [logRows().length, run.report.notAttempted.daily_limit], [2, 4]);
      eq("…the run says routine mail stopped, and an alert is due from that moment", [run.report.routineStopped, run.report.alertMarked, typeof world.state?.alert_due_at], [true, true, "string"]);
      const codes = await sendMany(run, people(3), code);
      eq("…a reset code still goes, on the same run (337 of 375)", codes.map((x) => x.status), ["sent", "sent", "sent"]);
      eq("…the state does not become failing (the deliveries keep it healthy)", [world.state?.state ?? null, stateWrites().some((w) => (w.body as Record<string, unknown>).state === "failing")], ["healthy", false]);
      freshWorld({ sent24h: 336 });
      const tight = await openRun({ organizationId: ORG });
      const g = await sendMany(tight, people(6), routine);
      eq("one routine mail of room and a group of four ready: sends already started count, so one goes", [g.filter((x) => x.status === "sent").length, sends().length], [1, 1]);
    }

    console.log("\nat the limit");
    {
      freshWorld({ sent24h: 375 });
      const run = await openRun({ organizationId: ORG });
      eq("375 of 375: the organisation reads not ready", runReady(run), false);
      const c = await sendNotification(one("password_reset"), { run });
      eq("…even a reset code is not attempted", [c.status, c.errorClass, c.attempted, sends().length], ["failed", "daily_limit", false, 0]);
      eq("…a single mail writes one failed row with the fixed error daily_limit", logRows().map((x) => [x.status, x.error]), [["failed", "daily_limit"]]);
      freshWorld({ sent24h: 374 });
      eq("374 of 375: ready", runReady(await openRun({ organizationId: ORG })), true);
      freshWorld({ sent24h: 20, state: { organization_id: ORG, state: null, state_changed_at: new Date().toISOString(), failed_recipients: [], daily_limit: 30 } });
      const small = await openRun({ organizationId: ORG });
      const s = await sendMany(small, people(3), routine);
      eq("a stored limit of 30 at 20 sent: routine mail has stopped (its line is 5)", s.map((x) => x.errorClass), ["daily_limit", "daily_limit", "daily_limit"]);
      eq("…a code still goes up to 29", (await sendNotification(one("password_reset"), { run: small })).status, "sent");
    }

    console.log("\nwhen the count cannot be read, no limit is applied");
    {
      freshWorld({ status: "missing", sent24h: 100_000 });
      const missing = await openRun({ organizationId: ORG });
      const m = await sendMany(missing, people(3), routine);
      eq("0114 not pasted: no limit, every send attempted, ready", [missing.limit, m.map((x) => x.status).join(","), runReady(missing)], [null, "sent,sent,sent", true]);
      freshWorld({ status: "fail", sent24h: 100_000 });
      const failed = await openRun({ organizationId: ORG });
      const f = await sendMany(failed, people(3), routine);
      eq("the call fails: no limit, every send attempted, the failed read counted", [failed.limit, f.map((x) => x.status).join(","), failed.errors], [null, "sent,sent,sent", { mail_status_read: 1 }]);
    }

    await readerCases();
    bannerAndTabText();
  } finally {
    removeStub();
  }
  finish();
}

/* ------------------------------------------------ the readers (stage 4) */

async function readerCases() {
  const db = () => createClient(SUPABASE, "stub-service-key", { auth: { persistSession: false } });
  const B = { id: OTHER_ORG, name: "Tenant B", slug: "tenant-b", deleted_at: null };
  const member = (org: string, user: string, status = "active") => ({ organization_id: org, user_id: user, role: "user", status });
  const healthy = { organization_id: ORG, state: "healthy", state_changed_at: "2026-11-20T08:00:00.000Z", failed_recipients: [], last_success_at: "2026-11-21T08:00:00.000Z", daily_limit: null };

  console.log("\nthe readers: every organisation in one call (step 17)");
  {
    freshWorld({ otherOrgs: [B], state: { ...healthy }, sent24h: 12, allSettings: [{ organization_id: ORG, ...SMTP_SETTINGS }], members: [member(ORG, "u1"), member(OTHER_ORG, "u2")] });
    const o = await readTenantSmtpOverview(db());
    const calls = statusCalls();
    eq("one call of tenant_mail_status for every organisation, with no organisation named", [calls.length, (calls[0]?.body as Record<string, unknown> | null)?.p_org], [1, null]);
    eq("…each organisation's reading from its settings and its state", o.kind === "ok" ? o.rows.map((r) => [r.organization_id, r.reading, r.sent24h, r.limit.limit]) : o, [[ORG, "healthy", 12, DEFAULT_TENANT_DAILY_LIMIT], [OTHER_ORG, "not_configured", 0, DEFAULT_TENANT_DAILY_LIMIT]]);
    eq("…whether it has an active member is read only for the one that would warn, in one read", [o.kind === "ok" ? o.rows.map((r) => r.hasMembers) : o, requests.filter((r) => r.table === "organization_members").length], [[null, true], 1]);
    eq("…the settings read asks for the three fields that decide complete, never the password", requests.filter((r) => r.table === "notification_settings").map((r) => r.query.get("select")), ["organization_id,smtp_host,smtp_port,from_email"]);

    freshWorld({ otherOrgs: [B], allSettings: [{ organization_id: ORG, ...SMTP_SETTINGS }], members: [member(OTHER_ORG, "u2", "inactive")] });
    const quiet = await readTenantSmtpOverview(db());
    eq("an organisation not configured with no active member: its member read says so", quiet.kind === "ok" ? quiet.rows.find((r) => r.organization_id === OTHER_ORG)?.hasMembers : quiet, false);

    for (const [label, sent, stopped, atLimit] of [["336 of 375", 336, false, false], ["337 of 375: routine mail has stopped", 337, true, false], ["375 of 375: the limit", 375, true, true]] as const) {
      freshWorld({ state: { ...healthy }, sent24h: sent, members: [member(ORG, "u1")] });
      const r = await readTenantSmtpOverview(db());
      eq(`${label}`, r.kind === "ok" ? [r.rows[0].routineStopped, r.rows[0].atLimit] : r, [stopped, atLimit]);
    }
    // A state row made by the limit's edit alone: a time, no state.
    freshWorld({ state: { organization_id: ORG, state: null, state_changed_at: "2026-11-21T09:00:00.000Z", failed_recipients: [], daily_limit: 1500 }, allSettings: [{ organization_id: ORG, ...SMTP_SETTINGS }] });
    const editOnly = await readTenantSmtpOverview(db());
    eq("configured, nothing sent yet, on a row the limit's edit made: no \"since\" (that time is the edit's, not a reading's)",
      editOnly.kind === "ok" ? [editOnly.rows[0].reading, editOnly.rows[0].since] : editOnly, ["configured", null]);
    freshWorld({ state: { ...healthy, state: "failing", state_changed_at: "2026-11-21T07:00:00.000Z" }, allSettings: [{ organization_id: ORG, ...SMTP_SETTINGS }], members: [member(ORG, "u1")] });
    const failingSince = await readTenantSmtpOverview(db());
    eq("…a healthy or failing reading keeps its time", [failingSince.kind === "ok" ? failingSince.rows[0].since : failingSince, readingSince("healthy", "2026-11-20T08:00:00.000Z"), readingSince("not_configured", "2026-11-20T08:00:00.000Z")],
      ["2026-11-21T07:00:00.000Z", "2026-11-20T08:00:00.000Z", null]);
    freshWorld({ state: { ...healthy, daily_limit: 10 }, sent24h: 0 });
    const low = await readTenantSmtpOverview(db());
    eq("a stored limit of 10: routine mail is off at this limit (the line is 0), which the list says apart from a stop", low.kind === "ok" ? [low.rows[0].routineOff, low.rows[0].limit.routineStop, low.rows[0].atLimit] : low, [true, 0, false]);
    freshWorld({ state: { ...healthy, daily_limit: DAILY_LIMIT_RESERVE_MIN + 1 }, sent24h: 0 });
    const above = await readTenantSmtpOverview(db());
    eq(`…at ${DAILY_LIMIT_RESERVE_MIN + 1} routine mail goes, so it is not off`, above.kind === "ok" ? [above.rows[0].routineOff, above.rows[0].routineStopped] : above, [false, false]);
    freshWorld({ state: { ...healthy, daily_limit: 1500 }, sent24h: 1349 });
    const big = await readTenantSmtpOverview(db());
    eq("a stored limit of 1,500: the number and the line where routine mail stops are the organisation's own", big.kind === "ok" ? [big.rows[0].storedLimit, big.rows[0].limit.routineStop, big.rows[0].routineStopped] : big, [1500, 1350, false]);

    freshWorld({ status: "missing" });
    eq("without 0114 (no such function): missing, and nothing else is read", [await readTenantSmtpOverview(db()), requests.filter((r) => r.table !== "rpc/tenant_mail_status").length], [{ kind: "missing" }, 0]);
    freshWorld({ status: "fail" });
    eq("any other failure of the call: unreadable, which is not missing", await readTenantSmtpOverview(db()), { kind: "unreadable" });
    freshWorld({ settings: "fail" });
    eq("the settings cannot be read: unreadable", await readTenantSmtpOverview(db()), { kind: "unreadable" });
    freshWorld({ allSettings: [], membersFail: true });
    eq("the member read fails for one that would warn: unreadable, never \"no members\"", await readTenantSmtpOverview(db()), { kind: "unreadable" });
  }

  console.log("\nthe readers: the code and link jobs (today and yesterday, UTC)");
  {
    const now = Date.parse("2026-11-21T10:00:00Z");
    freshWorld({ tables: { mail_job_counts: [
      { day: "2026-11-21", kind: "tenant", started: 4, finished: 3 },
      { day: "2026-11-20", kind: "platform", started: 2, finished: 2 },
      { day: "2026-11-19", kind: "tenant", started: 9, finished: 0 },
    ] } });
    eq("the two days' rows only, in one read", [await readMailJobCounts(db(), now), requests.length], [[
      { day: "2026-11-21", kind: "tenant", started: 4, finished: 3 },
      { day: "2026-11-20", kind: "platform", started: 2, finished: 2 },
    ], 1]);
    freshWorld({ missingTables: ["mail_job_counts"] });
    eq("without 0114 (no such table): missing", await readMailJobCounts(db(), now), "missing");
  }

  console.log("\none organisation's notice: its banner and its Attention Center item (section E; rule FP4)");
  {
    const ok = (row: Record<string, unknown>) => ({ kind: "ok" as const, row: { organization_id: ORG, state: null, state_changed_at: null, last_success_at: null, last_failure_at: null, last_error_code: null, failed_recipients: [], last_alert_at: null, alert_due_at: null, daily_limit: null, sent_24h: 0, ...row } as never });
    const N = (settings: "complete" | "incomplete" | "unreadable", status: Parameters<typeof tenantMailNoticeOf>[0]["status"]) => tenantMailNoticeOf({ settings, status }, {});
    eq("settings incomplete: not configured, from the settings alone, whatever the state read", [N("incomplete", { kind: "missing" }), N("incomplete", { kind: "unreadable", code: "x" })], [{ kind: "not_configured" }, { kind: "not_configured" }]);
    eq("settings that cannot be read, or a state that cannot be read (0114 not pasted included): no notice", [N("unreadable", ok({})), N("complete", { kind: "missing" }), N("complete", { kind: "unreadable", code: "x" })], [null, null, null]);
    eq("failing: since when, and the last error class", N("complete", ok({ state: "failing", state_changed_at: "2026-11-21T07:00:00.000Z", last_error_code: "auth" })), { kind: "failing", since: "2026-11-21T07:00:00.000Z", lastErrorClass: "auth" });
    eq(`the count: a warning from ${NEAR_LIMIT_SHARE * 10} tenths (300 of 375), routine mail stopped (337), the limit (375); nothing below (299)`,
      [299, 300, 337, 375].map((n) => N("complete", ok({ state: "healthy", sent_24h: n }))?.kind ?? null), [null, "near_limit", "routine_stopped", "limit_reached"]);

    eq(`a limit of ${DAILY_LIMIT_RESERVE_MIN} or less: routine mail never goes, its own notice (not a stop for today), whatever the count below the limit`,
      [[10, 0], [10, 5], [DAILY_LIMIT_RESERVE_MIN, 0]].map(([limit, sent]) => N("complete", ok({ state: "healthy", daily_limit: limit, sent_24h: sent }))),
      [{ kind: "routine_off", sent24h: 0, limit: 10 }, { kind: "routine_off", sent24h: 5, limit: 10 }, { kind: "routine_off", sent24h: 0, limit: DAILY_LIMIT_RESERVE_MIN }]);
    eq("…at the limit itself all mail has stopped, which still says so", N("complete", ok({ state: "healthy", daily_limit: 10, sent_24h: 10 }))?.kind, "limit_reached");
    eq(`…at ${DAILY_LIMIT_RESERVE_MIN + 1} routine mail goes: no notice at 0`, N("complete", ok({ state: "healthy", daily_limit: DAILY_LIMIT_RESERVE_MIN + 1, sent_24h: 0 })), null);

    freshWorld({ state: { ...healthy }, sent24h: 340 });
    const notice = await readTenantMailNotice(db(), ORG);
    eq("read: two calls, one of them for the count", [notice, requests.length, statusCalls().length], [{ kind: "routine_stopped", sent24h: 340, limit: 375 }, 2, 1]);
    eq("…the settings read asks for the three fields that decide complete, never the password", requests.filter((r) => r.table === "notification_settings").map((r) => r.query.get("select")), ["smtp_host,smtp_port,from_email"]);
    freshWorld({ status: "fail" });
    eq("read, the state cannot be read: no notice, no throw", await readTenantMailNotice(db(), ORG), null);

    // The provider, through collectAttention with it alone enabled.
    const onlyThis = { enabled: true, config: Object.fromEntries(ATTENTION_PROVIDERS.filter((p) => p.type !== "tenant-smtp").map((p) => [p.type, { enabled: false }])) };
    const collect = async (dismissals = new Map<string, string>()) => (await collectAttention({ svc: db(), orgId: ORG, orgSlug: "tenant-a", settings: onlyThis, dismissals })).items;
    eq("the provider is in the registry, critical by default, and first", [ATTENTION_PROVIDERS[0]?.type, ATTENTION_PROVIDERS[0]?.defaultPriority], ["tenant-smtp", "critical"]);
    freshWorld({ settings: null, status: "missing" });
    const nc = await collect(new Map([["tenant-smtp:not_configured", "2999-01-01T00:00:00.000Z"]]));
    eq("settings incomplete, 0114 not pasted: one critical item, not configured, linking to the SMTP tab of Settings, that cannot be marked as read",
      nc.map((i) => [i.key, i.priority, i.href, i.dismissible]), [["tenant-smtp:not_configured", "critical", "/tenant-a/settings?tab=smtp", false]]);
    freshWorld({ status: "missing" });
    eq("settings complete, 0114 not pasted: no item", (await collect()).length, 0);
    freshWorld({ status: "fail" });
    eq("settings complete, the state cannot be read: no item, and no throw", (await collect()).length, 0);
    freshWorld({ settings: "fail" });
    eq("the settings cannot be read: no item", (await collect()).length, 0);
    freshWorld({ state: { ...healthy }, sent24h: 310 });
    eq("near the limit: one item, a warning (high), with the count and the limit", (await collect()).map((i) => [i.key, i.priority, i.context]), [["tenant-smtp:near_limit", "high", "310 of 375 sent in the last 24 hours. Routine email stops before the limit."]]);
    freshWorld({ state: { ...healthy, daily_limit: 10 } });
    const off = await collect();
    eq("a limit of 10: one item that says routine email is off at this limit, a warning (high), never \"for today\"",
      [off.map((i) => [i.key, i.priority]), off.some((i) => /for today/i.test(`${i.title} ${i.context}`)), off[0]?.context?.includes("The daily limit of 10")], [[["tenant-smtp:routine_off", "high"]], false, true]);
    freshWorld({ state: { ...healthy, state: "failing", last_error_code: "unreachable" } });
    const f = await collect();
    eq("failing: critical, with its last error class and no address", [f.map((i) => [i.key, i.priority]), /@/.test(JSON.stringify(f))], [[["tenant-smtp:failing", "critical"]], false]);
  }
}

/** The banner and the SMTP tab, by their text (a layout's and a client page's functions cannot be imported here). */
function bannerAndTabText(): void {
  console.log("\nthe banner and the SMTP tab for a limit where routine mail never goes");
  const root = path.join(__dirname, "..", "..");
  const layout = fs.readFileSync(path.join(root, "app", "[org]", "(admin)", "layout.tsx"), "utf8");
  const off = layout.slice(layout.indexOf('case "routine_off":'), layout.indexOf('case "near_limit":'));
  eq("the banner has a case for it: a warning that names the limit and says routine email is never sent, not \"for today\"",
    [off.length > 0, /tone: "warning"/.test(off), /never sent/.test(off), /for today/.test(off)], [true, true, true, false]);
  const tab = fs.readFileSync(path.join(root, "app", "[org]", "(admin)", "settings", "settings-client.tsx"), "utf8");
  eq("the banner's link opens the SMTP tab of Settings (section E), as the Attention item's does", [/<Link href=\{smtpSettingsPath\(org\.slug\)\}/.test(layout), /href=\{`\/\$\{org\.slug\}\/settings`\}[^>]*>\s*Open/.test(layout)], [true, false]);
  eq("…and Settings opens on the tab the page names: the page passes ?tab= and the client starts on it",
    [/initialTab=\{initialTab\}/.test(fs.readFileSync(path.join(root, "app", "[org]", "(admin)", "settings", "page.tsx"), "utf8")), /useState<SettingsTab>\(\(\) => settingsTabOf\(initialTab\)\)/.test(tab)], [true, true]);
  eq("the SMTP tab says so when the line where routine mail stops is 0", /mailState\.routineStop === 0\s*\?\s*" At this limit reminders, announcements and assignment email are never sent/.test(tab), true);
  const settingsPage = fs.readFileSync(path.join(root, "app", "[org]", "(admin)", "settings", "page.tsx"), "utf8");
  eq("the SMTP tab's \"since\" is the reading's (readingSince), never the row's time alone", [/since: readingSince\(reading, status\.row\.state_changed_at\)/.test(settingsPage), /since: status\.row\.state_changed_at/.test(settingsPage)], [true, false]);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
