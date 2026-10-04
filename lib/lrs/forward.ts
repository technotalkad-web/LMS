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

export type StatementOutcome = {
  ok: boolean;
  /** Permanent failures (bad creds, malformed) must NOT be retried. */
  permanent: boolean;
  status?: number;
  error?: string;
};

export type ForwardResult = StatementOutcome & {
  /**
   * Per-statement outcomes (keyed by statement id), present when the LRS
   * rejected the batch (409 or a 4xx/5xx) and the statements were isolated by
   * halving the batch. Callers settle each row on its own outcome.
   */
  results?: Record<string, StatementOutcome>;
};

/**
 * Upper bound on LRS requests spent isolating a bad batch. Every request is a
 * Worker subrequest, so this keeps one poison statement from exhausting the
 * per-invocation budget: halving a batch of 50 costs ~12 requests to isolate
 * one bad statement; a wholesale outage stops after the first split.
 */
const MAX_ISOLATION_POSTS = 16;

function headers(cfg: ForwardCfg): Record<string, string> {
  return {
    authorization: authHeader(cfg.auth_key, cfg.auth_secret),
    "content-type": "application/json",
    "x-experience-api-version": cfg.xapi_version || "1.0.3",
  };
}

async function post(cfg: ForwardCfg, body: unknown[]): Promise<{ status: number; text: string } | { error: string }> {
  try {
    const res = await fetch(`${base(cfg.endpoint)}/statements`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify(body),
    });
    const text = res.ok ? "" : await res.text().catch(() => "");
    return { status: res.status, text };
  } catch (e) {
    // Network/DNS/timeout → retryable.
    return { error: e instanceof Error ? e.message : "fetch failed" };
  }
}

function classify(r: { status: number; text: string } | { error: string }): StatementOutcome {
  if ("error" in r) return { ok: false, permanent: false, error: r.error };
  // 2xx stored; 409 = the LRS already holds this id → idempotent success.
  if ((r.status >= 200 && r.status < 300) || r.status === 409) return { ok: true, permanent: false, status: r.status };
  // 4xx (except 408/429) = permanent; 5xx/408/429 = retryable.
  const permanent = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
  return { ok: false, permanent, status: r.status, error: `LRS HTTP ${r.status}: ${r.text.slice(0, 200)}` };
}

const idOf = (s: unknown) => String((s as { id?: string }).id ?? "");

/** POST a batch of statements to the tenant LRS. */
export async function forwardStatements(
  cfg: ForwardCfg,
  statements: unknown[]
): Promise<ForwardResult> {
  if (!cfg.endpoint) return { ok: false, permanent: true, error: "no endpoint" };
  const first = await post(cfg, statements);
  const whole = classify(first);
  // Stored (2xx), a network error (retry the batch later) or a single statement:
  // the batch outcome is the outcome. A 409 on a MULTI-statement batch is not a
  // success for the others, so it falls through to isolation like any rejection.
  const stored = !("error" in first) && first.status >= 200 && first.status < 300;
  if (stored || "error" in first || statements.length <= 1) return whole;

  // An LRS stores a batch atomically: ONE statement it cannot accept (409 = an id
  // already stored with different content; 400 = malformed; 500 = e.g. a
  // character its database cannot store) rejects the WHOLE batch. Treating that
  // as a batch outcome either loses every other statement (409 → "sent") or
  // blocks them behind the bad one forever (4xx/5xx → "failed"). So isolate by
  // halving: good halves are accepted in one request each, and only the bad
  // statement(s) end up with their own outcome. Bounded by MAX_ISOLATION_POSTS
  // so a wholesale outage (every half fails) costs a couple of requests, not n.
  const results: Record<string, StatementOutcome> = {};
  let budget = MAX_ISOLATION_POSTS;
  const settle = async (list: unknown[]): Promise<void> => {
    if (budget <= 0) {
      // Out of requests: leave the rest retryable for the next run.
      for (const s of list) results[idOf(s)] = { ok: false, permanent: false, error: whole.error ?? "batch rejected; isolation budget exhausted" };
      return;
    }
    budget -= 1;
    const r = await post(cfg, list);
    const out = classify(r);
    if (out.ok || "error" in r || list.length === 1) {
      for (const s of list) results[idOf(s)] = out;
      return;
    }
    const mid = Math.ceil(list.length / 2);
    await settle(list.slice(0, mid));
    await settle(list.slice(mid));
  };
  const mid = Math.ceil(statements.length / 2);
  await settle(statements.slice(0, mid));
  await settle(statements.slice(mid));

  let anyFailed = false;
  let anyPermanent = false;
  let lastError: string | undefined;
  for (const o of Object.values(results)) {
    if (!o.ok) {
      anyFailed = true;
      anyPermanent = anyPermanent || o.permanent;
      lastError = o.error;
    }
  }
  return { ok: !anyFailed, permanent: anyFailed && anyPermanent, status: first.status, error: lastError, results };
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
    // /about is public on some LRSs (SQL LRS answers it without checking the
    // credentials), so also probe an authenticated route. An EMPTY batch is
    // side-effect-free: nothing is stored, but a wrong key/secret gets 401/403.
    try {
      const probe = await fetch(`${base(cfg.endpoint)}/statements`, { method: "POST", headers: headers(cfg), body: "[]" });
      if (probe.status === 401 || probe.status === 403) {
        return { ok: false, status: "auth_failed", error: "LRS rejected the key/secret" };
      }
    } catch {
      /* connectivity already proven by /about */
    }
    return { ok: true, status: "ok", versions: body.version };
  } catch (e) {
    return {
      ok: false,
      status: "unreachable",
      error: e instanceof Error ? e.message : "could not reach endpoint",
    };
  }
}
