import { createClient } from "@supabase/supabase-js";
import { attemptAbandonedResponse } from "@/lib/attempts/abandon";

const serviceClient = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
};

export interface XapiSession {
  attemptId: string;
  authToken: string;
  /** course_attempts.status at bind time (null if it could not be read). */
  attemptStatus?: string | null;
}

type TokenMatch = XapiSession & { expired: boolean };

export type XapiBinding =
  | { ok: true; session: XapiSession }
  | { ok: false; response: Response };

/**
 * Bind an xAPI request to its attempt (ALDS step 0, P4). One query
 * (token → attempt). An abandoned attempt answers 410 attempt_abandoned for
 * every resource — also when its token was expired by the abandon itself, so
 * a stale tab learns WHY it is shut out; any other missing/unknown/expired
 * token answers 401.
 */
export async function bindXapi(request: Request): Promise<XapiBinding> {
  const match = await matchToken(request);
  if (!match) return { ok: false, response: unauthorizedResponse() };
  if (match.attemptStatus === "abandoned") {
    return { ok: false, response: attemptAbandonedResponse() };
  }
  if (match.expired) return { ok: false, response: unauthorizedResponse() };
  const { attemptId, authToken, attemptStatus } = match;
  return { ok: true, session: { attemptId, authToken, attemptStatus } };
}

/**
 * Verify the Authorization header and return the bound session (null when
 * missing, unknown or expired). Kept for callers that only need the binding;
 * the statements/state routes use bindXapi().
 */
export async function authenticateXapi(
  request: Request
): Promise<XapiSession | null> {
  const match = await matchToken(request);
  if (!match || match.expired) return null;
  const { attemptId, authToken, attemptStatus } = match;
  return { attemptId, authToken, attemptStatus };
}

/**
 * Find the launch token in the Authorization header (any shape the AU
 * sent). Logs the raw header on miss so we can see what shape it was.
 */
async function matchToken(request: Request): Promise<TokenMatch | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!header) {
    console.error("[xapi/auth] MISS: no Authorization header. url=", request.url);
    return null;
  }

  // Try every parsing strategy and check each candidate against the table.
  const candidates: string[] = [];

  // 1. 64-char hex anywhere in the raw header.
  const hexInRaw = header.match(/[a-f0-9]{64}/i);
  if (hexInRaw) candidates.push(hexInRaw[0]);

  // 2. Strip scheme prefix(es). "Basic ", "Bearer ", or "Basic Bearer ".
  let stripped = header.trim();
  const schemes = ["basic ", "bearer "];
  for (let i = 0; i < 3; i++) {
    const lower = stripped.toLowerCase();
    const match = schemes.find((s) => lower.startsWith(s));
    if (!match) break;
    stripped = stripped.slice(match.length).trim();
  }
  if (stripped) candidates.push(stripped);

  // 3. Base64-decode whatever's left and look inside.
  try {
    const decoded = Buffer.from(stripped, "base64").toString("utf8");
    if (decoded) {
      candidates.push(decoded);
      // user:token form
      if (decoded.includes(":")) {
        const parts = decoded.split(":");
        candidates.push(parts[parts.length - 1]);
      }
      // hex anywhere in decoded
      const hexInDecoded = decoded.match(/[a-f0-9]{64}/i);
      if (hexInDecoded) candidates.push(hexInDecoded[0]);
    }
  } catch {
    // ignore
  }

  // 4. URL-decoded version of the header (in case the AU URL-encoded it).
  try {
    const urlDecoded = decodeURIComponent(stripped);
    const hexInUrl = urlDecoded.match(/[a-f0-9]{64}/i);
    if (hexInUrl) candidates.push(hexInUrl[0]);
  } catch {
    // ignore
  }

  // Look each candidate up.
  const svc = serviceClient();
  for (const cand of candidates) {
    const trimmed = cand.trim();
    if (!trimmed) continue;
    let { data, error } = await svc
      .from("cmi5_launch_tokens")
      .select("attempt_id, expires_at, course_attempts(status)")
      .eq("auth_token", trimmed)
      .maybeSingle();
    if (error) {
      // Never let the attempt embed lock everyone out (schema cache hiccup):
      // bind without the status; the conditional attempt writes still hold.
      console.warn("[xapi/auth] token+attempt lookup failed, retrying plain:", error.message);
      ({ data, error } = await svc
        .from("cmi5_launch_tokens")
        .select("attempt_id, expires_at")
        .eq("auth_token", trimmed)
        .maybeSingle());
    }
    if (data) {
      const row = data as {
        attempt_id: string;
        expires_at: string;
        course_attempts?: { status?: string | null } | Array<{ status?: string | null }> | null;
      };
      const att = Array.isArray(row.course_attempts) ? row.course_attempts[0] : row.course_attempts;
      const expired = new Date(row.expires_at).getTime() < Date.now();
      if (expired) console.error("[xapi/auth] token expired at", row.expires_at);
      return {
        attemptId: row.attempt_id,
        authToken: trimmed,
        attemptStatus: att?.status ?? null,
        expired,
      };
    }
  }

  // Nothing matched. Dump everything we tried so we can see the AU's shape.
  console.error(
    "[xapi/auth] MISS: no candidate matched.",
    "\n  raw header:", JSON.stringify(header),
    "\n  url:       ", request.url,
    "\n  candidates:", candidates.map((c) => c.slice(0, 24)),
  );
  return null;
}

export function unauthorizedResponse() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="xapi"' },
  });
}

export { serviceClient };
