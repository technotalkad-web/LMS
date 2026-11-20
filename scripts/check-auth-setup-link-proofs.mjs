#!/usr/bin/env node
// =============================================================================
// scripts/check-auth-setup-link-proofs.mjs: staging proofs for ADR 0029's
// open questions 15 (an account made with an address only) and 19 (the
// sign-in time and an ended session).
// =============================================================================
//
// RUN BY HAND, STAGING ONLY. It refuses any Supabase project but staging
// (the rule of tests/bot/lifecycle/cleanup.ts, isStagingSupabaseUrl). It
// touches no app code and no app table: it calls the auth server the way the
// set-password code will (auth.admin.createUser, auth.admin.updateUserById,
// auth.admin.generateLink with verifyOtp as app/auth/callback/route.ts uses
// it, auth.admin.getUserById, and signInWithPassword on a fresh client that
// keeps no session), plus one invite as the control of point 2.
//
// Accounts: new per run, in the lifecycle namespace
// (`lifecycle+p0029-<role>-<run>@lifecycle.test`, tests/e2e/helpers/
// namespace.ts). The domain is reserved and has no inbox; the e2e purge never
// matches it, and the lifecycle cleanup sweeps it after 48 h if a delete here
// fails. No organisation, membership or learner record is created (the
// profiles trigger adds one profile row per account; it goes with the
// account). Every account is deleted at the end, also after a failure.
//
// Output: step names, pass / fail / recorded, HTTP statuses, error codes and
// "set" / "empty" for a time. Never an address, password, token, session,
// id or error message.
//
// The point 2 control sends ONE invite mail per run to a reserved address
// that nothing can deliver to.
//
// SETTINGS (environment only; the script reads no file):
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//   SUPABASE_SERVICE_ROLE_KEY (the staging values the lifecycle suite uses).
//   Loaded the way the Playwright configs load them, e.g.
//     node -r dotenv/config scripts/check-auth-setup-link-proofs.mjs \
//       dotenv_config_path=<checkout>/.env.test.local --report <file>.json
//
// FLAGS:
//   --dry-run        check the settings and the project guard; call nothing
//   --report <file>  also write the results as JSON (no secrets, no ids)
//
// EXIT: 0 every proof passed; 1 a proof failed or its control was void;
// 2 refused (not staging, a setting missing); 3 harness error or a failed
// cleanup.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const STAGING_REF = "zeaclbapadosqqttexxh";
const PRODUCTION_REF = "alkfrcglmseksweqhwzq";
const NS_PREFIX = "lifecycle";
const NS_DOMAIN = "lifecycle.test";
const SENT_FIELDS = ["confirmation_sent_at", "invited_at", "recovery_sent_at", "email_change_sent_at"];
const USER_PAGE_SIZE = 1000;
const USER_MAX_PAGES = 20;

// ---------------------------------------------------------------------------
// Flags and settings
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2).filter((a) => !a.startsWith("dotenv_config_"));
let dryRun = false;
let reportPath = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--report" && argv[i + 1]) reportPath = argv[++i];
  else {
    console.error(`✖ unknown flag (${a.slice(0, 20)})`);
    process.exit(3);
  }
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function refuse(msg) {
  console.error(`✖ refused: ${msg}`);
  process.exit(2);
}
if (URL_.includes(PRODUCTION_REF)) refuse("the Supabase URL is the production project.");
function isStagingSupabaseUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === `${STAGING_REF}.supabase.co` && u.port === "";
  } catch {
    return false;
  }
}
if (!isStagingSupabaseUrl(URL_)) refuse("the Supabase URL is not the staging project.");
const missing = [
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) refuse(`missing setting(s): ${missing.join(", ")}.`);

console.log("guard: staging project, settings set (url set, anon key set, service key set)");
if (dryRun) {
  console.log("dry run: no call made.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
/** outcome: pass | fail | recorded | void | not run | setup | harness */
const results = [];
function rec(point, step, outcome, detail = "") {
  results.push({ point, step, outcome, detail });
  const tag = outcome.toUpperCase().padEnd(8);
  console.log(`[${point}] ${tag} ${step}${detail ? `  (${detail})` : ""}`);
  return outcome === "pass" || outcome === "recorded" || outcome === "setup";
}
const check = (point, step, ok, detail) => rec(point, step, ok ? "pass" : "fail", detail);

/** Status and code only: an auth error's message can echo the address. */
function errInfo(error) {
  if (!error) return "no error";
  const status = error.status ?? "-";
  const code = error.code ?? (error.name && error.name !== "Error" ? error.name : "-");
  return `status=${status} code=${code}`;
}
function errCode(error) {
  return error ? `${error.status ?? "-"}/${error.code ?? error.name ?? "-"}` : "none";
}
/** A thrown harness error, with anything that could be an address, a URL or a token removed. */
function harnessText(e) {
  const msg = String(e?.message ?? "")
    .replace(/\S+@\S+/g, "<address>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/eyJ[\w.-]+/g, "<token>")
    .slice(0, 160);
  return `${e?.name ?? "Error"}: ${msg}`;
}

/** "set" or "empty (...)": how the auth server returned a time. */
function timeState(user, key) {
  if (!user) return "unread";
  if (!(key in user)) return "empty (left out)";
  const v = user[key];
  if (v === null) return "empty (null)";
  if (v === "") return 'empty ("")';
  return "set";
}
const isEmpty = (user, key) => !!user && timeState(user, key).startsWith("empty");
function sentStates(user) {
  return SENT_FIELDS.map((k) => `${k}=${timeState(user, k)}`).join(", ");
}
const sentSet = (user) => SENT_FIELDS.filter((k) => user && !isEmpty(user, k));

// ---------------------------------------------------------------------------
// Clients and accounts
// ---------------------------------------------------------------------------
const AUTH_OPTS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const svc = createClient(URL_, SERVICE, { auth: AUTH_OPTS });
/** A fresh anon client: no storage, no refresh timer, nothing shared with another. */
const fresh = (fetchImpl) =>
  createClient(URL_, ANON, { auth: AUTH_OPTS, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}) });
/** An anon client whose Data API calls carry the given access token. */
const asToken = (token) =>
  createClient(URL_, ANON, { auth: AUTH_OPTS, global: { headers: { Authorization: `Bearer ${token}` } } });
/** A fetch that records the HTTP status of calls to the auth server's /logout. */
function logoutRecorder() {
  const box = { status: null };
  const f = async (input, init) => {
    const res = await fetch(input, init);
    if (String(typeof input === "string" ? input : input?.url ?? "").includes("/auth/v1/logout")) box.status = res.status;
    return res;
  };
  return { box, f };
}

const RUN = randomBytes(3).toString("hex");
const addr = (role) => `${NS_PREFIX}+p0029-${role}-${RUN}@${NS_DOMAIN}`;
/** Long, with upper, lower, digit and symbol, so no password rule refuses it. */
const newPassword = () => `${randomBytes(18).toString("base64url")}Aa1!`;
const claims = (jwt) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
};

const created = new Map(); // role -> id
const runAddresses = new Set();
function track(role, user) {
  if (user?.id) created.set(role, user.id);
}

async function readUser(id) {
  const { data, error } = await svc.auth.admin.getUserById(id);
  return { user: data?.user ?? null, error };
}
async function signIn(email, password, fetchImpl) {
  const c = fresh(fetchImpl);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  return { client: c, session: data?.session ?? null, user: data?.user ?? null, error };
}
const refusedText = (r) => (r.session ? "a session came back" : errInfo(r.error));

// ---------------------------------------------------------------------------
// The proofs
// ---------------------------------------------------------------------------
const P1 = "Q15.1", P2 = "Q15.2", P3 = "Q15.3", P4 = "Q19.4", P5 = "Q19.5", P6 = "mail";
const state = {};

async function preamble() {
  const require = createRequire(import.meta.url);
  const sjs = JSON.parse(readFileSync(require.resolve("@supabase/supabase-js/package.json"), "utf8")).version;
  rec("run", "client library", "recorded", `@supabase/supabase-js ${sjs}`);
  try {
    const res = await fetch(`${URL_}/auth/v1/health`, { headers: { apikey: ANON } });
    const body = await res.json().catch(() => ({}));
    rec("run", "auth server health", "recorded", `status=${res.status} version=${body?.version ?? "unknown"}`);
  } catch (e) {
    rec("run", "auth server health", "recorded", harnessText(e));
  }
}

async function point1() {
  const email = addr("a");
  runAddresses.add(email);
  state.A = { email };
  const { data, error } = await svc.auth.admin.createUser({ email });
  track("A", data?.user);
  if (!check(P1, "createUser({ email }) with no password: no error and an id", !error && !!data?.user?.id, errInfo(error))) return;
  state.A.id = data.user.id;

  const { user, error: rErr } = await readUser(state.A.id);
  state.A.first = user;
  check(P1, "getUserById returns account A", !rErr && user?.id === state.A.id, errInfo(rErr));
  check(P1, "A: confirmed time empty", isEmpty(user, "email_confirmed_at"), `email_confirmed_at=${timeState(user, "email_confirmed_at")}, confirmed_at=${timeState(user, "confirmed_at")}`);
  check(P1, "A: sign-in time empty", isEmpty(user, "last_sign_in_at"), `last_sign_in_at=${timeState(user, "last_sign_in_at")}`);
  rec(P1, "empty time shape (A, last_sign_in_at)", "recorded", timeState(user, "last_sign_in_at"));

  // Control: the account is real, a second create for the same address is refused.
  const dup = await svc.auth.admin.createUser({ email });
  if (dup.data?.user?.id && dup.data.user.id !== state.A.id) track("A-dup", dup.data.user);
  check(P1, "control: a second createUser for the same address is refused", !!dup.error && !dup.data?.user, errInfo(dup.error));
  // The other control (A opens after the admin call) is in point 3.
}

async function point2Reading(label) {
  const { user, error } = await readUser(state.A.id);
  const ok = !error && SENT_FIELDS.every((k) => isEmpty(user, k));
  check(P2, `A ${label}: the four sent times empty`, ok, error ? errInfo(error) : sentStates(user));
  return { ok, user };
}

async function point2Control() {
  // The mailer is asked on purpose, once per run, to a reserved address.
  const email = addr("i");
  runAddresses.add(email);
  const { data, error } = await svc.auth.admin.inviteUserByEmail(email);
  track("I", data?.user);
  if (error) {
    rec(P2, "control: inviteUserByEmail on a new reserved address", "void", `${errInfo(error)}; the mailer refused, point 2 is not proven by this run`);
    state.control2 = { void: true, code: errCode(error) };
    return;
  }
  rec(P2, "control: inviteUserByEmail on a new reserved address", "recorded", "no error (the mailer accepted)");
  const { user, error: rErr } = await readUser(data.user.id);
  const set = sentSet(user);
  rec(P2, "control: sent times after the invite (read)", set.length ? "recorded" : "fail", rErr ? errInfo(rErr) : sentStates(user));
  state.control2 = { void: false, set };
}

async function point3() {
  const A = state.A;
  // D: no password, confirmed. B: password, confirmed. C: password, unconfirmed.
  const D = { email: addr("d") }, B = { email: addr("b"), pw: newPassword() }, C = { email: addr("c"), pw: newPassword() };
  [D, B, C].forEach((x) => runAddresses.add(x.email));
  state.B = B; state.C = C; state.D = D;

  const d = await svc.auth.admin.createUser({ email: D.email, email_confirm: true });
  track("D", d.data?.user);
  const b = await svc.auth.admin.createUser({ email: B.email, password: B.pw, email_confirm: true });
  track("B", b.data?.user);
  const c = await svc.auth.admin.createUser({ email: C.email, password: C.pw });
  track("C", c.data?.user);
  if (!rec(P3, "setup: create D, B and C", d.error || b.error || c.error ? "fail" : "setup", `D ${errInfo(d.error)}; B ${errInfo(b.error)}; C ${errInfo(c.error)}`)) return;
  D.id = d.data.user.id; B.id = b.data.user.id; C.id = c.data.user.id;

  const rd = await readUser(D.id), rc = await readUser(C.id), rb = await readUser(B.id);
  rec(P3, "setup: D confirmed, C unconfirmed", isEmpty(rd.user, "email_confirmed_at") || !isEmpty(rc.user, "email_confirmed_at") ? "fail" : "setup",
    `D email_confirmed_at=${timeState(rd.user, "email_confirmed_at")}; C email_confirmed_at=${timeState(rc.user, "email_confirmed_at")}`);
  state.B.lastBefore = timeState(rb.user, "last_sign_in_at");

  // A: no password, unconfirmed.
  if (A.id) {
    const a1 = await signIn(A.email, newPassword());
    check(P3, "A (no password, unconfirmed): a random password is refused", !a1.session && !!a1.error, refusedText(a1));
    const a2 = await signIn(A.email, "");
    check(P3, "A (no password, unconfirmed): an empty password is refused", !a2.session && !!a2.error, refusedText(a2));
  } else {
    rec(P3, "A rows", "not run", "account A was not created");
  }
  // D: no password, confirmed.
  const d1 = await signIn(D.email, newPassword());
  check(P3, "D (no password, confirmed): a random password is refused", !d1.session && !!d1.error, refusedText(d1));
  const d2 = await signIn(D.email, "");
  rec(P3, "D (no password, confirmed): an empty password (extra row)", !d2.session && !!d2.error ? "recorded" : "fail", refusedText(d2));
  // B: password, confirmed (the control that sign-in works here).
  const b1 = await signIn(B.email, B.pw);
  check(P3, "B (password, confirmed): the right password gives a session", !!b1.session && b1.user?.id === B.id, b1.session ? "session" : errInfo(b1.error));
  const b2 = await signIn(B.email, newPassword());
  check(P3, "B (password, confirmed): a wrong password is refused", !b2.session && !!b2.error, refusedText(b2));
  state.B.wrongCode = errCode(b2.error);
  const rb2 = await readUser(B.id);
  state.B.lastAfter = timeState(rb2.user, "last_sign_in_at");
  // C: password, unconfirmed (recorded either way).
  const c1 = await signIn(C.email, C.pw);
  rec(P3, "C (password, unconfirmed): the right password", "recorded", c1.session ? "a session came back" : errInfo(c1.error));
  state.C.rightCode = c1.session ? "session" : errCode(c1.error);

  // The step the set-password route will make on A.
  if (!A.id) return;
  A.pw = newPassword();
  const up = await svc.auth.admin.updateUserById(A.id, { password: A.pw, email_confirm: true });
  check(P3, "A: updateUserById({ password, email_confirm: true }) has no error", !up.error, errInfo(up.error));
  const ra = await readUser(A.id);
  check(P3, "A: confirmed time now set", !isEmpty(ra.user, "email_confirmed_at"), `email_confirmed_at=${timeState(ra.user, "email_confirmed_at")}`);
  rec(P3, "A: sign-in time after the admin call", "recorded", `last_sign_in_at=${timeState(ra.user, "last_sign_in_at")}`);
  const a3 = await signIn(A.email, A.pw);
  check(P3, "A: the new password signs in (also point 1's control)", !!a3.session && a3.user?.id === A.id, a3.session ? "session" : errInfo(a3.error));
  const a4 = await signIn(A.email, newPassword());
  check(P3, "A: a wrong password is still refused", !a4.session && !!a4.error, refusedText(a4));
  const ra2 = await readUser(A.id);
  check(P1, "control: A's sign-in time is set once A signs in", !isEmpty(ra2.user, "last_sign_in_at"), `last_sign_in_at=${timeState(ra2.user, "last_sign_in_at")}`);
}

async function point4() {
  const E = { email: addr("e"), pw: newPassword() };
  runAddresses.add(E.email);
  const e = await svc.auth.admin.createUser({ email: E.email });
  track("E", e.data?.user);
  if (!check(P4, "E = createUser({ email }) has no error", !e.error && !!e.data?.user?.id, errInfo(e.error))) return;
  E.id = e.data.user.id;

  let r = await readUser(E.id);
  check(P4, "E after create: sign-in time empty", isEmpty(r.user, "last_sign_in_at"), `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);
  rec(P4, "empty time shape (E after create)", "recorded", `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}; email_confirmed_at=${timeState(r.user, "email_confirmed_at")}`);

  const up = await svc.auth.admin.updateUserById(E.id, { password: E.pw, email_confirm: true });
  check(P4, "E: updateUserById({ password, email_confirm: true }) has no error", !up.error, errInfo(up.error));
  r = await readUser(E.id);
  check(P4, "E after updateUserById: sign-in time still empty", isEmpty(r.user, "last_sign_in_at"), `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);

  const gl = await svc.auth.admin.generateLink({ type: "magiclink", email: E.email });
  const hash = gl.data?.properties?.hashed_token;
  check(P4, "E: generateLink({ type: \"magiclink\" }) has no error and a token hash", !gl.error && !!hash, `${errInfo(gl.error)}; hashed_token=${hash ? "set" : "empty"}; verification_type=${gl.data?.properties?.verification_type ?? "-"}`);
  r = await readUser(E.id);
  check(P4, "E after generateLink, link not opened: sign-in time still empty", isEmpty(r.user, "last_sign_in_at"), `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);
  rec(P4, "E after generateLink: the four sent times (read)", "recorded", sentStates(r.user));
  if (!hash) return;

  // Control on the same account: the link is used.
  const v = await fresh().auth.verifyOtp({ type: "magiclink", token_hash: hash });
  check(P4, "control: verifyOtp({ type: \"magiclink\", token_hash }) on a fresh client gives a session", !!v.data?.session && v.data?.user?.id === E.id, v.data?.session ? "session" : errInfo(v.error));
  r = await readUser(E.id);
  check(P4, "control: E's sign-in time now set", !isEmpty(r.user, "last_sign_in_at"), `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);

  // Second control: B before and after its password sign-in (point 3).
  if (state.B?.lastBefore) {
    check(P4, "second control: B's sign-in time empty before its password sign-in", state.B.lastBefore.startsWith("empty"), `last_sign_in_at=${state.B.lastBefore}`);
    check(P4, "second control: B's sign-in time set after it", state.B.lastAfter === "set", `last_sign_in_at=${state.B.lastAfter}`);
  } else {
    rec(P4, "second control (B)", "not run", "B was not created");
  }

  // Recorded beside it: an invite-type link (it creates its own account).
  const F = { email: addr("f") };
  runAddresses.add(F.email);
  const gi = await svc.auth.admin.generateLink({ type: "invite", email: F.email });
  track("F", gi.data?.user);
  const fh = gi.data?.properties?.hashed_token;
  rec(P4, "invite link: generateLink({ type: \"invite\" }) on a new address", !gi.error && fh ? "recorded" : "fail", `${errInfo(gi.error)}; hashed_token=${fh ? "set" : "empty"}`);
  if (!gi.data?.user?.id || !fh) return;
  r = await readUser(gi.data.user.id);
  rec(P4, "invite link: sign-in time before the link is used", "recorded", `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}; ${sentStates(r.user)}`);
  const vi = await fresh().auth.verifyOtp({ type: "invite", token_hash: fh });
  rec(P4, "invite link: verifyOtp({ type: \"invite\" }) on a fresh client", "recorded", vi.data?.session ? "session" : errInfo(vi.error));
  r = await readUser(gi.data.user.id);
  rec(P4, "invite link: sign-in time after the link is used", "recorded", `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);
}

/** One round of point 5: X is ended, Y is the control in every row. */
async function point5Round(H, way) {
  const lr = logoutRecorder();
  const sx = await signIn(H.email, H.pw, way === "own" ? lr.f : undefined);
  const sy = await signIn(H.email, H.pw);
  if (!rec(P5, `${way}: two sessions on separate clients`, sx.session && sy.session ? "setup" : "fail", `X ${sx.session ? "session" : errInfo(sx.error)}; Y ${sy.session ? "session" : errInfo(sy.error)}`)) return;
  const X = { access: sx.session.access_token, refresh: sx.session.refresh_token };
  const Y = { access: sy.session.access_token, refresh: sy.session.refresh_token };
  const cx = claims(X.access), cy = claims(Y.access);
  rec(P5, `${way}: the two are different sessions`, cx.session_id && cy.session_id && cx.session_id !== cy.session_id ? "setup" : "fail", `session_id X ${cx.session_id ? "set" : "empty"}, Y ${cy.session_id ? "set" : "empty"}, differ=${cx.session_id !== cy.session_id}`);

  // End X with the scope of that one session.
  if (way === "own") {
    const { error } = await sx.client.auth.signOut({ scope: "local" });
    rec(P5, "own: X's own signOut({ scope: \"local\" })", error ? "fail" : "recorded", `${errInfo(error)}; logout HTTP status=${lr.box.status ?? "no call"}`);
  } else {
    const adm = logoutRecorder();
    const admin = createClient(URL_, SERVICE, { auth: AUTH_OPTS, global: { fetch: adm.f } });
    const { error } = await admin.auth.admin.signOut(X.access, "local");
    rec(P5, "admin: auth.admin.signOut(X's token, \"local\")", error ? "fail" : "recorded", `${errInfo(error)}; logout HTTP status=${adm.box.status ?? "no call"}`);
  }
  const lifeLeft = Number.isFinite(cx.exp) ? Math.round(cx.exp - Date.now() / 1000) : null;
  rec(P5, `${way}: X's access token life left when tested`, "recorded", lifeLeft === null ? "unknown" : `${lifeLeft} s`);

  // (a) The auth server asked who this is.
  const ax = await fresh().auth.getUser(X.access);
  check(P5, `${way} (a): getUser with X's old token is refused`, !ax.data?.user && !!ax.error, ax.data?.user ? "the account came back" : errInfo(ax.error));
  const ay = await fresh().auth.getUser(Y.access);
  check(P5, `${way} (a) control: getUser with Y's token returns the account`, ay.data?.user?.id === H.id, ay.data?.user ? "the account" : errInfo(ay.error));

  // (c) A read through the Data API (before (b), so Y's refresh changes nothing here).
  const read = async (tok) => {
    const res = await asToken(tok).from("profiles").select("id").eq("id", H.id);
    const rows = Array.isArray(res.data) ? res.data.length : 0;
    const own = rows === 1 && res.data[0].id === H.id;
    return { status: res.status, rows, own, error: res.error };
  };
  const qx = await read(X.access);
  rec(P5, `${way} (c): Data API read of H's own profile row with X's old token`, "recorded", `status=${qx.status} rows=${qx.rows} own_row=${qx.own}${qx.error ? ` code=${qx.error.code ?? "-"}` : ""}`);
  const qy = await read(Y.access);
  check(P5, `${way} (c) control: the same read with Y's token returns the row`, qy.status === 200 && qy.own, `status=${qy.status} rows=${qy.rows} own_row=${qy.own}${qy.error ? ` code=${qy.error.code ?? "-"}` : ""}`);

  // (b) A refresh.
  const bx = await fresh().auth.refreshSession({ refresh_token: X.refresh });
  check(P5, `${way} (b): refresh with X's old refresh token is refused`, !bx.data?.session && !!bx.error, bx.data?.session ? "new tokens came back" : errInfo(bx.error));
  const by = await fresh().auth.refreshSession({ refresh_token: Y.refresh });
  const yNew = by.data?.session;
  check(P5, `${way} (b) control: refresh with Y's refresh token gives new tokens`, !!yNew && yNew.access_token !== Y.access && yNew.user?.id === H.id, yNew ? "new tokens" : errInfo(by.error));
}

async function point5() {
  const H = { email: addr("h"), pw: newPassword() };
  runAddresses.add(H.email);
  const h = await svc.auth.admin.createUser({ email: H.email, password: H.pw, email_confirm: true });
  track("H", h.data?.user);
  if (!rec(P5, "setup: create H (password, confirmed)", h.error ? "fail" : "setup", errInfo(h.error))) return;
  H.id = h.data.user.id;

  for (const way of ["own", "admin"]) {
    try {
      await point5Round(H, way);
    } catch (e) {
      rec(P5, `${way}: round`, "harness", harnessText(e));
    }
  }

  // N13's second open point: three refusal codes side by side.
  const hw = await signIn(H.email, newPassword());
  const unknown = addr("u"); // never created
  const uk = await signIn(unknown, newPassword());
  rec(P5, "codes: wrong password on H (confirmed)", "recorded", refusedText(hw));
  rec(P5, "codes: right password on C (unconfirmed)", "recorded", state.C?.rightCode ?? "not run");
  rec(P5, "codes: an unknown address", "recorded", refusedText(uk));
}

// ---------------------------------------------------------------------------
// Cleanup: every account of this run, also after a failure
// ---------------------------------------------------------------------------
let cleaned = false;
async function cleanup() {
  if (cleaned) return true;
  cleaned = true;
  let ok = true;
  const ids = [...new Set(created.values())];
  let deleted = 0;
  for (const id of ids) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) {
      ok = false;
      rec("cleanup", "deleteUser", "fail", errInfo(error));
    } else deleted++;
  }
  // Any account of this run's addresses still there (one an error left behind).
  let left = 0, extra = 0, scanned = 0, scanError = null;
  for (let page = 1; page <= USER_MAX_PAGES; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE });
    if (error) { scanError = error; break; }
    const users = data?.users ?? [];
    scanned += users.length;
    for (const u of users) {
      if (u.email && runAddresses.has(u.email.toLowerCase())) {
        const { error: dErr } = await svc.auth.admin.deleteUser(u.id);
        if (dErr) { left++; ok = false; } else extra++;
      }
    }
    if (users.length < USER_PAGE_SIZE) break;
  }
  const { count, error: pErr } = ids.length
    ? await svc.from("profiles").select("id", { count: "exact", head: true }).in("id", ids)
    : { count: 0, error: null };
  if (pErr || (count ?? 0) > 0) ok = false;
  if (scanError) ok = false;
  rec("cleanup", "accounts of this run deleted", ok ? "pass" : "fail",
    `created=${ids.length} deleted=${deleted} found_by_address_and_deleted=${extra} left=${left}; users scanned=${scanned}${scanError ? ` scan ${errInfo(scanError)}` : ""}; profile rows left=${pErr ? `unread ${pErr.code ?? "-"}` : count ?? 0}`);
  return ok;
}

process.on("SIGINT", async () => {
  console.log("interrupted: cleaning up");
  await cleanup().catch(() => {});
  process.exit(3);
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let harnessFailed = false;
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    harnessFailed = true;
    rec(name, "step threw", "harness", harnessText(e));
  }
}

const startedAt = new Date().toISOString();
await step("run", preamble);
await step(P1, point1);
if (state.A?.id) {
  await step(P2, () => point2Reading("after create").then((r) => (state.A2a = r)));
  await step(P2, point2Control);
} else rec(P2, "point 2", "not run", "account A was not created");
await step(P3, point3);
if (state.A?.id) await step(P2, () => point2Reading("after point 3's last step").then((r) => (state.A2b = r)));
await step(P4, point4);
await step(P5, point5);
rec(P6, "fragment through mail (SMTP and platform sender)", "not run", "waits for the owner's test mailbox");

// Point 2's verdict: A leaves empty what the control set.
if (state.control2 && state.A2a && state.A2b) {
  if (state.control2.void) rec(P2, "verdict", "void", `control refused (${state.control2.code}); not proven by this run`);
  else {
    const set = state.control2.set;
    const aEmpty = set.every((k) => isEmpty(state.A2a.user, k) && isEmpty(state.A2b.user, k));
    check(P2, "verdict: A leaves empty what the control set", set.length > 0 && aEmpty && state.A2a.ok && state.A2b.ok, `control set: ${set.join(", ") || "nothing"}`);
  }
}

const cleanOk = await cleanup().catch((e) => {
  rec("cleanup", "cleanup threw", "harness", harnessText(e));
  return false;
});

const count = (o) => results.filter((r) => r.outcome === o).length;
const summary = `pass=${count("pass")} fail=${count("fail")} void=${count("void")} recorded=${count("recorded")} not_run=${count("not run")} harness=${count("harness")}`;
console.log(`\nsummary: ${summary}`);
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), project: "staging", summary, results }, null, 2) + "\n");
  console.log("report written");
}
process.exit(harnessFailed || count("harness") || !cleanOk ? 3 : count("fail") || count("void") ? 1 : 0);
