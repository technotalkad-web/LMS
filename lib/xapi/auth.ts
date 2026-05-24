import { createClient } from "@supabase/supabase-js";

const serviceClient = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
};

export interface XapiSession {
  attemptId: string;
  authToken: string;
}

/**
 * Verify the Authorization header and return the bound session.
 * Logs the raw header on miss so we can see what shape the AU sent.
 */
export async function authenticateXapi(
  request: Request
): Promise<XapiSession | null> {
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
    const { data } = await svc
      .from("cmi5_launch_tokens")
      .select("attempt_id, expires_at")
      .eq("auth_token", trimmed)
      .maybeSingle();
    if (data) {
      if (new Date(data.expires_at).getTime() < Date.now()) {
        console.error("[xapi/auth] token expired at", data.expires_at);
        return null;
      }
      return { attemptId: data.attempt_id, authToken: trimmed };
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
