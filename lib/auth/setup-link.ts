import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { membershipCounts } from "@/lib/auth/org-membership";
import { checkPassword, PASSWORD_RULE_TEXT } from "@/lib/auth/password-policy";
import { endImpersonationForSessionChange } from "@/lib/auth/impersonation";
import { isMissingRelation } from "@/lib/scoring/attempt-kind";

/**
 * The LMS's own "set your password" link (ADR 0029 section N, rules N9 to
 * N12 and N14; migration 0117). This module is the only code that reads or
 * writes public.account_setup_links, always with the service role it is
 * given, and the only code that creates an account for such a link.
 *
 * The link:
 *   - a new account is created with the address alone: no password and an
 *     unconfirmed address (createAccountForSetupLink, the one place that
 *     calls auth.admin.createUser for it);
 *   - its token is 32 random bytes, sent only inside the link's fragment
 *     (/auth/set-password#t=<token>); the table keeps the SHA-256 digest;
 *   - the database stamps its life, 7 days, and one account holds at most
 *     one open link: a new one ends the older first;
 *   - opening the page spends nothing. The page posts the token; the read
 *     answers with the organisation's name and the password rule, or with
 *     rule N10's one answer;
 *   - setting the password claims the link by one conditional update, then
 *     one admin call sets the password and the confirmed mark together.
 *
 * The checks, one order on every path (rule N14): rule N10 (an unknown,
 * used, ended or expired link); then the reason it was issued still holds:
 * (a) the membership in its organisation counts, (c) for a tenant's link no
 * membership row elsewhere, (d) for a tenant's link no platform owner, and
 * (b) the account has never signed in; then the password policy; then the
 * claim. A link refused by (a) to (d) gets rule N10's answer and is ended. A
 * read that fails ends nothing and answers 503.
 *
 * "Never signed in" is read only from an answer of the auth server that has
 * no error and holds the account with the id that was asked for; then a
 * sign-in time that is left out or null means never. Anything else is a
 * failed read. The auth server's sent times (confirmation, invitation,
 * recovery) are not read: they say that a link was made, not that mail went.
 *
 * Without migration 0117 every link reads as unusable (rule N10), and a
 * caller that would create an account for a link asks setupLinksReady first.
 *
 * No log line holds a token, a link, a password or an address: only fixed
 * words and error codes.
 */

export const SETUP_LINK_TABLE = "account_setup_links";
/** The life of a link, which the database sets (0117); stated here for the mail and the page. */
export const SETUP_LINK_DAYS = 7;
export const SETUP_LINK_PATH = "/auth/set-password";
/** 32 random bytes, base64url: 43 characters. */
export const SETUP_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Rule N10: the one answer for a link that cannot be used, the same on the page and on the route. */
export const LINK_UNUSABLE_MESSAGE =
  "This link can no longer be used. Ask your LMS Administrator for a new one, or use Forgot password.";
export const LINK_UNUSABLE_STATUS = 400;
/** Rule N14: a read that failed. Nothing was ended. */
export const LINK_TRY_AGAIN_MESSAGE = "Try again in a moment.";
/** Rule N9: the auth server gave no definite answer, so the password may be set. */
export const LINK_NOT_CONFIRMED_MESSAGE =
  "We could not confirm that your password was saved. Try to sign in with it. If that does not work, use Forgot password.";
/** Rule N9: the auth server refused the password; the link stays usable. */
export const LINK_PASSWORD_REFUSED_MESSAGE = "Your password could not be saved. Try again with a different password.";
/** Section J: a caller that needs the table, on a database without 0117. */
export const SETUP_LINKS_NEED_0117 =
  "This needs migration 0117 (account setup links) on this database. Nothing was created or sent.";
/** Rule N12: the answer for anyone a new link is not for. */
export const HAS_A_WAY_IN_MESSAGE = "This person already has a way in. They can use Forgot password.";
/** Rule N12: at most three links in 24 hours for one account. */
export const SETUP_LINKS_PER_DAY = 3;

export type SetupIssuer = "tenant" | "platform";

/** A route's answer: its status and its JSON body. */
export type SetupLinkAnswer = { status: number; body: Record<string, unknown> };

type LinkRow = {
  id: string;
  user_id: string;
  organization_id: string;
  issuer: SetupIssuer;
  expires_at: string;
  used_at: string | null;
  ended_at: string | null;
};
type OrgRow = { id: string; name: string; slug: string; deleted_at: string | null };

const LINK_COLUMNS = "id, user_id, organization_id, issuer, expires_at, used_at, ended_at";

function logFailure(event: string, step: string, error: { code?: string | null } | null | undefined | "thrown"): void {
  const code = error === "thrown" ? "thrown" : isMissingRelation(error ?? null, SETUP_LINK_TABLE) ? "no_0117" : String(error?.code ?? "unknown");
  console.warn(JSON.stringify({ event, step, code }));
}

/** SHA-256 of a token, as the table stores it. */
export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The address of a link: the token in the fragment and in no other part. */
export function setupLinkUrl(origin: string, token: string): string {
  return `${origin}${SETUP_LINK_PATH}#t=${token}`;
}

/**
 * Whether this database holds account_setup_links (migration 0117): one plain
 * read. A missing table is "missing"; any other failure is "unreadable",
 * which is never read as missing.
 */
export async function setupLinksReady(svc: SupabaseClient): Promise<"ready" | "missing" | "unreadable"> {
  try {
    const { error } = await svc.from(SETUP_LINK_TABLE).select("id").limit(1);
    if (!error) return "ready";
    if (isMissingRelation(error, SETUP_LINK_TABLE)) return "missing";
    logFailure("setup_link_read_failed", "ready", error);
    return "unreadable";
  } catch {
    logFailure("setup_link_read_failed", "ready", "thrown");
    return "unreadable";
  }
}

/**
 * Create an account for a setup link: the address alone, so the account has
 * no password and an unconfirmed address until the person sets one (rule
 * N9). The only call that creates an account for a link.
 */
export async function createAccountForSetupLink(
  svc: SupabaseClient,
  email: string
): Promise<{ user: User } | { error: string }> {
  try {
    const { data, error } = await svc.auth.admin.createUser({ email });
    if (error || !data?.user) return { error: error?.message ?? "Could not create user" };
    return { user: data.user };
  } catch {
    return { error: "Could not create user" };
  }
}

/**
 * Issue a link for an account: end its open link, if any, then write the
 * new row (the database stamps its times), and return the address. The
 * token leaves this function only inside that address. On failure nothing
 * is returned but whether the table is missing.
 */
export async function issueSetupLink(
  svc: SupabaseClient,
  args: { userId: string; organizationId: string; issuer: SetupIssuer; issuedBy: string | null; origin: string }
): Promise<{ ok: true; url: string } | { ok: false; missing: boolean }> {
  const token = randomBytes(32).toString("base64url");
  try {
    // An expired row that was never used or ended still holds the account's
    // one open slot, so the older row is ended whatever its expiry.
    const ended = await svc
      .from(SETUP_LINK_TABLE)
      .update({ ended_at: new Date().toISOString() })
      .eq("user_id", args.userId)
      .is("used_at", null)
      .is("ended_at", null);
    if (ended.error) {
      logFailure("setup_link_issue_failed", "end_older", ended.error);
      return { ok: false, missing: isMissingRelation(ended.error, SETUP_LINK_TABLE) };
    }
    const inserted = await svc.from(SETUP_LINK_TABLE).insert({
      user_id: args.userId,
      organization_id: args.organizationId,
      issuer: args.issuer,
      issued_by: args.issuedBy,
      token_hash: hashSetupToken(token),
    });
    if (inserted.error) {
      logFailure("setup_link_issue_failed", "insert", inserted.error);
      return { ok: false, missing: isMissingRelation(inserted.error, SETUP_LINK_TABLE) };
    }
  } catch {
    logFailure("setup_link_issue_failed", "thrown", "thrown");
    return { ok: false, missing: false };
  }
  return { ok: true, url: setupLinkUrl(args.origin, token) };
}

/**
 * Rule N14 (b), exact: "never" only when the auth server answered with no
 * error and with the account whose id was asked for, and that account's
 * sign-in time is left out or null. A time that parses is "signed_in".
 * Anything else (an error, no account, another id, any other value) is
 * "unreadable".
 */
export async function signInState(svc: SupabaseClient, userId: string): Promise<"never" | "signed_in" | "unreadable"> {
  let answer: Awaited<ReturnType<SupabaseClient["auth"]["admin"]["getUserById"]>>;
  try {
    answer = await svc.auth.admin.getUserById(userId);
  } catch {
    return "unreadable";
  }
  if (answer.error) return "unreadable";
  const user = answer.data?.user as (User & { last_sign_in_at?: unknown }) | null | undefined;
  if (!user || typeof user !== "object" || user.id !== userId) return "unreadable";
  const t = user.last_sign_in_at;
  if (t === undefined || t === null) return "never";
  if (typeof t === "string" && t.length > 0 && Number.isFinite(Date.parse(t))) return "signed_in";
  return "unreadable";
}

/** End one link that is still open (a refusal under rule N11 or N14). A failure is logged; the answer stands. */
async function endLink(svc: SupabaseClient, id: string): Promise<void> {
  try {
    const { error } = await svc
      .from(SETUP_LINK_TABLE)
      .update({ ended_at: new Date().toISOString() })
      .eq("id", id)
      .is("used_at", null)
      .is("ended_at", null);
    if (error) logFailure("setup_link_end_failed", "refused", error);
  } catch {
    logFailure("setup_link_end_failed", "refused", "thrown");
  }
}

type Checked = { kind: "good"; link: LinkRow; org: OrgRow } | { kind: "unusable" } | { kind: "unreadable" };

/**
 * Rule N10, then rule N14 with rule N11, in that order. A link that fails
 * N14 or N11 is ended; one that rule N10 refuses is left as it was.
 */
async function checkLink(svc: SupabaseClient, token: unknown): Promise<Checked> {
  if (typeof token !== "string" || !SETUP_TOKEN_SHAPE.test(token)) return { kind: "unusable" };
  let found: LinkRow | null;
  try {
    const { data, error } = await svc.from(SETUP_LINK_TABLE).select(LINK_COLUMNS).eq("token_hash", hashSetupToken(token)).maybeSingle();
    if (error) {
      // Without 0117 there is no link to use: rule N10's answer (section J).
      if (isMissingRelation(error, SETUP_LINK_TABLE)) return { kind: "unusable" };
      logFailure("setup_link_read_failed", "link", error);
      return { kind: "unreadable" };
    }
    found = data as LinkRow | null;
  } catch {
    logFailure("setup_link_read_failed", "link", "thrown");
    return { kind: "unreadable" };
  }
  // Rule N10: unknown, used, ended or expired. Left as it is.
  if (!found || found.used_at || found.ended_at || !(Date.parse(found.expires_at) > Date.now())) return { kind: "unusable" };
  const link: LinkRow = found;

  const refuse = async (): Promise<Checked> => {
    await endLink(svc, link.id);
    return { kind: "unusable" };
  };

  // (a) and (c): every membership row of the account, of any status.
  const members = await svc.from("organization_members").select("organization_id, role, status").eq("user_id", link.user_id);
  if (members.error || !Array.isArray(members.data)) {
    logFailure("setup_link_read_failed", "members", members.error);
    return { kind: "unreadable" };
  }
  const rows = members.data as Array<{ organization_id: string; role: string | null; status: string | null }>;
  const orgRead = await svc.from("organizations").select("id, name, slug, deleted_at").eq("id", link.organization_id).maybeSingle();
  if (orgRead.error) {
    logFailure("setup_link_read_failed", "organization", orgRead.error);
    return { kind: "unreadable" };
  }
  const org = orgRead.data as OrgRow | null;
  const own = rows.find((r) => r.organization_id === link.organization_id) ?? null;
  if (!org || !membershipCounts(own, org)) return refuse();
  if (link.issuer === "tenant") {
    // (c): a row in any other organisation, whatever its status.
    if (rows.some((r) => r.organization_id !== link.organization_id)) return refuse();
    // (d), rule N11: a platform owner.
    const owner = await svc.from("platform_owners").select("user_id").eq("user_id", link.user_id).maybeSingle();
    if (owner.error) {
      logFailure("setup_link_read_failed", "platform_owner", owner.error);
      return { kind: "unreadable" };
    }
    if (owner.data) return refuse();
  }
  // (b): the account has never signed in.
  const signIn = await signInState(svc, link.user_id);
  if (signIn === "unreadable") {
    logFailure("setup_link_read_failed", "sign_in", null);
    return { kind: "unreadable" };
  }
  if (signIn === "signed_in") return refuse();
  return { kind: "good", link, org };
}

const unusable = (): SetupLinkAnswer => ({ status: LINK_UNUSABLE_STATUS, body: { error: LINK_UNUSABLE_MESSAGE, code: "unusable" } });
const tryAgain = (): SetupLinkAnswer => ({ status: 503, body: { error: LINK_TRY_AGAIN_MESSAGE, code: "unreadable" } });

/**
 * The page's read of a link (rule N9, "Opening it spends nothing"): the
 * organisation's name and the password rule for a link that is good, and
 * rule N10's answer otherwise. A good link is not changed, however often it
 * is read.
 */
export async function readSetupLink(svc: SupabaseClient, token: unknown): Promise<SetupLinkAnswer> {
  const checked = await checkLink(svc, token);
  if (checked.kind === "unusable") return unusable();
  if (checked.kind === "unreadable") return tryAgain();
  return { status: 200, body: { ok: true, organization: checked.org.name, rule: PASSWORD_RULE_TEXT } };
}

/** A definite refusal by the auth server: an answer with a 4xx status. A 5xx, no answer or a thrown call is not one. */
function definitelyRefused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * The set step (rule N9): the checks in their order, the password policy,
 * the claim, then one admin call that sets the password and the confirmed
 * mark together. The route creates no session: the answer names the
 * organisation's sign-in page, where the person signs in.
 */
export async function setPasswordWithSetupLink(svc: SupabaseClient, token: unknown, password: unknown): Promise<SetupLinkAnswer> {
  const checked = await checkLink(svc, token);
  if (checked.kind === "unusable") return unusable();
  if (checked.kind === "unreadable") return tryAgain();
  const policy = checkPassword(password);
  if (!policy.ok) return { status: 400, body: { error: policy.error, code: "policy" } };
  const { link, org } = checked;

  // The claim: one conditional update, so two requests cannot both win.
  const claimAt = new Date().toISOString();
  let claimedAt: string;
  try {
    const { data, error } = await svc
      .from(SETUP_LINK_TABLE)
      .update({ used_at: claimAt })
      .eq("id", link.id)
      .is("used_at", null)
      .is("ended_at", null)
      .gt("expires_at", claimAt)
      .select("id, used_at");
    if (error) {
      logFailure("setup_link_claim_failed", "claim", error);
      return tryAgain();
    }
    const hit = Array.isArray(data) && data.length === 1 ? (data[0] as { id?: unknown; used_at?: unknown }) : null;
    if (!hit || hit.id !== link.id || typeof hit.used_at !== "string") return unusable();
    claimedAt = hit.used_at;
  } catch {
    logFailure("setup_link_claim_failed", "claim", "thrown");
    return tryAgain();
  }

  // The password and the confirmed mark in one call, never split.
  let refused = false;
  let set = false;
  try {
    const { data, error } = await svc.auth.admin.updateUserById(link.user_id, { password: password as string, email_confirm: true });
    if (!error && data?.user) set = true;
    else refused = definitelyRefused(error);
  } catch {
    set = false;
  }
  if (!set) {
    if (!refused) {
      // No definite answer: the password may be set, so the claim stands.
      logFailure("setup_link_set_failed", "not_confirmed", null);
      return { status: 502, body: { error: LINK_NOT_CONFIRMED_MESSAGE, code: "not_confirmed" } };
    }
    // A definite refusal: release this request's own claim, and nothing else.
    try {
      const { data, error } = await svc
        .from(SETUP_LINK_TABLE)
        .update({ used_at: null })
        .eq("id", link.id)
        .eq("used_at", claimedAt)
        .is("ended_at", null)
        .select("id");
      if (error || !Array.isArray(data) || data.length !== 1) {
        logFailure("setup_link_release_failed", "release", error);
        return unusable();
      }
    } catch {
      logFailure("setup_link_release_failed", "release", "thrown");
      return unusable();
    }
    return { status: 400, body: { error: LINK_PASSWORD_REFUSED_MESSAGE, code: "refused" } };
  }

  // An older row may still carry the forced change; it is cleared.
  try {
    const { error } = await svc.from("profiles").update({ must_change_password: false }).eq("id", link.user_id).eq("must_change_password", true);
    if (error) logFailure("setup_link_flag_failed", "profile", error);
  } catch {
    logFailure("setup_link_flag_failed", "profile", "thrown");
  }
  // The person signs in next, on this browser: end an impersonation held
  // here, as a completed reset does. Never throws.
  await endImpersonationForSessionChange();
  return { status: 200, body: { ok: true, next: `/${org.slug}/login` } };
}

/**
 * End an account's open link after its password was set another way (rule
 * N9: a completed reset, a password change). Never throws and never fails
 * the caller: a missing table or any other failure is logged with an error
 * class, and rule N14 (b) refuses such a link once the person has signed in.
 */
export async function endOpenSetupLinks(svc: SupabaseClient, userId: string, site: string): Promise<void> {
  try {
    const { error } = await svc
      .from(SETUP_LINK_TABLE)
      .update({ ended_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("used_at", null)
      .is("ended_at", null);
    if (error) logFailure("setup_link_end_failed", site, error);
  } catch {
    logFailure("setup_link_end_failed", site, "thrown");
  }
}

/**
 * The console's offer of "Send setup link again" (rule N12): the accounts
 * among `userIds` that the platform created in this organisation with a
 * setup link and that have never signed in. A read that fails offers
 * nothing; the action itself checks again.
 */
export async function platformSetupLinkOffers(svc: SupabaseClient, organizationId: string, userIds: string[]): Promise<Set<string>> {
  const offered = new Set<string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return offered;
  let withRow: string[];
  try {
    const { data, error } = await svc
      .from(SETUP_LINK_TABLE)
      .select("user_id")
      .eq("organization_id", organizationId)
      .eq("issuer", "platform")
      .in("user_id", ids);
    if (error || !Array.isArray(data)) {
      if (error && !isMissingRelation(error, SETUP_LINK_TABLE)) logFailure("setup_link_read_failed", "offers", error);
      return offered;
    }
    withRow = [...new Set((data as Array<{ user_id: string }>).map((r) => r.user_id))];
  } catch {
    logFailure("setup_link_read_failed", "offers", "thrown");
    return offered;
  }
  const states = await Promise.all(withRow.map(async (id) => [id, await signInState(svc, id)] as const));
  for (const [id, state] of states) if (state === "never") offered.add(id);
  return offered;
}

/**
 * Whether the console may send a platform administrator a new link now
 * (rule N12): the platform created the account in this organisation with a
 * link, the account has never signed in, and it has had fewer than three
 * links in 24 hours.
 */
export async function platformSetupLinkResendCheck(
  svc: SupabaseClient,
  organizationId: string,
  userId: string
): Promise<"ok" | "missing" | "unreadable" | "has_way_in" | "limit"> {
  try {
    const own = await svc
      .from(SETUP_LINK_TABLE)
      .select("id")
      .eq("user_id", userId)
      .eq("organization_id", organizationId)
      .eq("issuer", "platform")
      .limit(1);
    if (own.error) {
      if (isMissingRelation(own.error, SETUP_LINK_TABLE)) return "missing";
      logFailure("setup_link_read_failed", "resend", own.error);
      return "unreadable";
    }
    if (!Array.isArray(own.data) || own.data.length === 0) return "has_way_in";
  } catch {
    logFailure("setup_link_read_failed", "resend", "thrown");
    return "unreadable";
  }
  const signIn = await signInState(svc, userId);
  if (signIn === "unreadable") return "unreadable";
  if (signIn === "signed_in") return "has_way_in";
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = await svc.from(SETUP_LINK_TABLE).select("id").eq("user_id", userId).gte("created_at", dayAgo).limit(SETUP_LINKS_PER_DAY);
    if (recent.error || !Array.isArray(recent.data)) {
      logFailure("setup_link_read_failed", "resend_count", recent.error);
      return "unreadable";
    }
    if (recent.data.length >= SETUP_LINKS_PER_DAY) return "limit";
  } catch {
    logFailure("setup_link_read_failed", "resend_count", "thrown");
    return "unreadable";
  }
  return "ok";
}
