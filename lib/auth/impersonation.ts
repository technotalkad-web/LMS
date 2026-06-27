import { cookies } from "next/headers";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import crypto from "crypto";

/**
 * Tenant impersonation lets a platform owner enter a tenant workspace
 * as a read-mostly admin so they can debug a customer issue. We store
 * a server-side session row in `platform_impersonation_sessions` and
 * a small signed cookie on the browser. The cookie contains only the
 * session id + HMAC; everything sensitive lives server-side.
 *
 *  - The cookie is HttpOnly, Secure, SameSite=Lax, scoped to the whole
 *    app (path "/"). It expires alongside the DB session row.
 *  - Every page load that calls getImpersonation() re-validates the
 *    HMAC AND checks the DB row is still active (not revoked, not
 *    past expires_at, not ended_at).
 *  - require-org-access reads getImpersonation() and overrides the
 *    role to "super_owner" when the impersonation targets the current
 *    org. The banner reads it too so we can show "Impersonating …".
 */

const COOKIE_NAME = "lms_impersonation";
const COOKIE_MAX_AGE_SECS = 60 * 60; // 60 min, matches DB default

function getSecret(): string {
  const s = process.env.IMPERSONATION_SECRET;
  if (s) return s;
  // In production, refuse to fall back to the service-role key: reusing the
  // master DB key to sign impersonation cookies collapses two trust boundaries
  // (a service-role leak would then also let an attacker forge impersonation
  // cookies, and the signing key can't be rotated independently).
  // ⚠️ Deploy note: IMPERSONATION_SECRET must be set as a Worker secret in prod.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "IMPERSONATION_SECRET must be set in production (no service-role fallback)."
    );
  }
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!fallback) {
    throw new Error(
      "Missing IMPERSONATION_SECRET (and no SUPABASE_SERVICE_ROLE_KEY for dev fallback)."
    );
  }
  return fallback;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function pack(sessionId: string): string {
  const sig = sign(sessionId);
  return `${sessionId}.${sig}`;
}

function unpack(raw: string): string | null {
  const ix = raw.indexOf(".");
  if (ix < 0) return null;
  const id = raw.slice(0, ix);
  const sig = raw.slice(ix + 1);
  const expected = sign(id);
  // Constant-time compare to avoid sig-leak timing attacks.
  try {
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return id;
}

export type ImpersonationSession = {
  id: string;
  actor_user_id: string;
  target_org_id: string;
  target_user_id: string | null;
  started_at: string;
  expires_at: string;
};

/**
 * Read the impersonation session from the request cookies, validating
 * the HMAC and re-checking the DB row. Returns null if missing,
 * forged, expired, or revoked.
 */
export async function getImpersonation(): Promise<ImpersonationSession | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  const id = unpack(raw);
  if (!id) return null;

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: row } = await svc
    .from("platform_impersonation_sessions")
    .select(
      "id, actor_user_id, target_org_id, target_user_id, started_at, expires_at, ended_at, revoked_at"
    )
    .eq("id", id)
    .maybeSingle();

  if (!row) return null;
  const r = row as {
    id: string;
    actor_user_id: string;
    target_org_id: string;
    target_user_id: string | null;
    started_at: string;
    expires_at: string;
    ended_at: string | null;
    revoked_at: string | null;
  };
  if (r.ended_at || r.revoked_at) return null;
  if (new Date(r.expires_at).getTime() < Date.now()) return null;

  return {
    id: r.id,
    actor_user_id: r.actor_user_id,
    target_org_id: r.target_org_id,
    target_user_id: r.target_user_id,
    started_at: r.started_at,
    expires_at: r.expires_at,
  };
}

/**
 * Start a new impersonation session. Caller must already be a verified
 * platform owner. Writes the DB row, sets the cookie, returns the
 * session id so the route can audit-log it.
 */
export async function startImpersonation(args: {
  actorUserId: string;
  targetOrgId: string;
  targetUserId?: string | null;
  reason?: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<string> {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data, error } = await svc
    .from("platform_impersonation_sessions")
    .insert({
      actor_user_id: args.actorUserId,
      target_org_id: args.targetOrgId,
      target_user_id: args.targetUserId ?? null,
      reason: args.reason ?? null,
      ip: args.ip ?? null,
      user_agent: args.userAgent ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `Could not create impersonation session: ${error?.message ?? "unknown"}`
    );
  }
  const sessionId = (data as { id: string }).id;

  const jar = await cookies();
  jar.set(COOKIE_NAME, pack(sessionId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECS,
  });

  return sessionId;
}

/**
 * End the active impersonation: stamp ended_at on the DB row and
 * delete the cookie.
 */
export async function endImpersonation(): Promise<void> {
  const session = await getImpersonation();
  const jar = await cookies();
  jar.delete(COOKIE_NAME);

  if (!session) return;
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  await svc
    .from("platform_impersonation_sessions")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", session.id);
}
