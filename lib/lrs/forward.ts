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
   * Per-statement outcomes (keyed by statement id), present only when the LRS
   * rejected the batch with 409 and the statements were re-sent one by one.
   * Callers settle each row on its own outcome instead of the batch's.
   */
  results?: Record<string, StatementOutcome>;
};

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

/** POST a batch of statements to the tenant LRS. */
export async function forwardStatements(
  cfg: ForwardCfg,
  statements: unknown[]
): Promise<ForwardResult> {
  if (!cfg.endpoint) return { ok: false, permanent: true, error: "no endpoint" };
  const first = await post(cfg, statements);
  if ("error" in first || first.status !== 409 || statements.length <= 1) return classify(first);

  // A conformant LRS answers 409 for the WHOLE batch when any id already exists
  // with different content (e.g. a backfilled copy whose learner dimensions
  // changed since the first send). Treating that as "all sent" would lose every
  // NEW statement in the batch, so re-send one by one and report each outcome.
  const results: Record<string, StatementOutcome> = {};
  let anyFailed = false;
  let anyPermanent = false;
  let lastError: string | undefined;
  for (const s of statements) {
    const id = String((s as { id?: string }).id ?? "");
    const out = classify(await post(cfg, [s]));
    results[id] = out;
    if (!out.ok) {
      anyFailed = true;
      anyPermanent = anyPermanent || out.permanent;
      lastError = out.error;
    }
  }
  return { ok: !anyFailed, permanent: anyFailed && anyPermanent, status: 409, error: lastError, results };
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
