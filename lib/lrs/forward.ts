/**
 * External LRS transport. xAPI statements are forwarded with their own ids, so
 * a compliant LRS dedups them → retries are idempotent. All sends run
 * server-side (Workers `fetch`); credentials never reach the browser.
 */

type ForwardCfg = {
  endpoint: string;
  auth_key: string | null;
  auth_secret: string | null;
  xapi_version: string;
};

function authHeader(key: string | null, secret: string | null): string {
  return "Basic " + Buffer.from(`${key ?? ""}:${secret ?? ""}`).toString("base64");
}

function base(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

export type ForwardResult = {
  ok: boolean;
  /** Permanent failures (bad creds, malformed) must NOT be retried. */
  permanent: boolean;
  status?: number;
  error?: string;
};

/** POST a batch of statements to the tenant LRS. */
export async function forwardStatements(
  cfg: ForwardCfg,
  statements: unknown[]
): Promise<ForwardResult> {
  if (!cfg.endpoint) return { ok: false, permanent: true, error: "no endpoint" };
  try {
    const res = await fetch(`${base(cfg.endpoint)}/statements`, {
      method: "POST",
      headers: {
        authorization: authHeader(cfg.auth_key, cfg.auth_secret),
        "content-type": "application/json",
        "x-experience-api-version": cfg.xapi_version || "1.0.3",
      },
      body: JSON.stringify(statements),
    });
    if (res.ok || res.status === 204) return { ok: true, permanent: false, status: res.status };
    // 409 = statement(s) already stored → idempotent success.
    if (res.status === 409) return { ok: true, permanent: false, status: 409 };
    const text = await res.text().catch(() => "");
    // 4xx (except 408/429) = permanent; 5xx/408/429 = retryable.
    const permanent =
      res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    return {
      ok: false,
      permanent,
      status: res.status,
      error: `LRS HTTP ${res.status}: ${text.slice(0, 200)}`,
    };
  } catch (e) {
    // Network/DNS/timeout → retryable.
    return { ok: false, permanent: false, error: e instanceof Error ? e.message : "fetch failed" };
  }
}

export type TestResult = {
  ok: boolean;
  status: "ok" | "auth_failed" | "unreachable" | "error";
  versions?: string[];
  error?: string;
};

/** Side-effect-free connectivity + auth probe: GET {endpoint}/about. */
export async function testConnection(cfg: ForwardCfg): Promise<TestResult> {
  if (!cfg.endpoint) return { ok: false, status: "error", error: "Endpoint is required" };
  try {
    const res = await fetch(`${base(cfg.endpoint)}/about`, {
      method: "GET",
      headers: {
        authorization: authHeader(cfg.auth_key, cfg.auth_secret),
        "x-experience-api-version": cfg.xapi_version || "1.0.3",
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: "auth_failed", error: "LRS rejected the key/secret" };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, status: "error", error: `LRS HTTP ${res.status}: ${t.slice(0, 160)}` };
    }
    const body = (await res.json().catch(() => ({}))) as { version?: string[] };
    return { ok: true, status: "ok", versions: body.version };
  } catch (e) {
    return {
      ok: false,
      status: "unreachable",
      error: e instanceof Error ? e.message : "could not reach endpoint",
    };
  }
}
