/**
 * External LRS forwarding — engine verification against a local mock LRS.
 *
 * Runs against LOCAL dev (the dev server must reach the mock on 127.0.0.1), so
 * set E2E_BASE_URL=http://localhost:3000 when running this spec. Covers:
 *   - drainer forwards a pending outbox row to the tenant LRS (happy path)
 *   - retry/durability: 500 → failed+backoff, then 200 → sent
 *   - connection test (xAPI /about) returns ok
 *   - config GET masks the secret
 *
 * Skips automatically if migration 0044 (tenant_lrs_config) isn't applied yet.
 */
import http from "node:http";
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";

type Mock = { url: string; received: unknown[][]; setStatus: (n: number) => void; close: () => Promise<void> };

async function startMockLrs(): Promise<Mock> {
  const received: unknown[][] = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    if (req.url?.includes("/about")) {
      res.writeHead(status === 200 ? 200 : status, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: ["1.0.3"] }));
      return;
    }
    if (req.url?.includes("/statements")) {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        try { received.push(JSON.parse(buf)); } catch { /* ignore */ }
        res.writeHead(status).end(status === 200 ? "[]" : "error");
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    setStatus: (n) => (status = n),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function tableExists() {
  const { error } = await svc().from("tenant_lrs_config").select("organization_id").limit(1);
  return !error;
}

async function drain(baseURL: string) {
  const res = await fetch(`${baseURL}/api/cron/lrs-forward`, {
    method: "POST",
    headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
  });
  return res.json().catch(() => ({}));
}

async function outboxStatus(stmtId: string) {
  const { data } = await svc()
    .from("lrs_forward_outbox")
    .select("status, attempts, last_error")
    .eq("statement_id", stmtId)
    .maybeSingle();
  return data as { status: string; attempts: number; last_error: string | null } | null;
}

test("LRS forwarding engine: drain, retry, connection test, secret masking", async ({
  browser,
  baseURL,
}) => {
  test.skip(!(await tableExists()), "migration 0044 (tenant_lrs_config) not applied yet");

  const mock = await startMockLrs();
  try {
    const org = await createOrg({ name: "QA LRS Org" });
    const admin = await createAuthUser({
      profile: { first_name: "LRS", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });

    // Configure forwarding → mock LRS.
    await svc().from("tenant_lrs_config").upsert(
      {
        organization_id: org.id,
        enabled: true,
        endpoint: mock.url,
        auth_key: "k",
        auth_secret: "s3cr3t",
        xapi_version: "1.0.3",
      },
      { onConflict: "organization_id" }
    );

    // --- happy path: pending row → drained → sent + mock received it ---
    const stmtId = `urn:uuid:${rand(8)}-happy`;
    await svc().from("lrs_forward_outbox").insert({
      organization_id: org.id,
      statement_id: stmtId,
      payload: { id: stmtId, verb: { id: "http://adlnet.gov/expapi/verbs/completed" } },
      status: "pending",
    });
    await drain(baseURL!);
    expect((await outboxStatus(stmtId))?.status, "happy row should be sent").toBe("sent");
    expect(mock.received.flat().some((s) => (s as { id?: string }).id === stmtId)).toBeTruthy();

    // --- retry/durability: 500 → failed, then 200 → sent ---
    mock.setStatus(500);
    const retryId = `urn:uuid:${rand(8)}-retry`;
    await svc().from("lrs_forward_outbox").insert({
      organization_id: org.id,
      statement_id: retryId,
      payload: { id: retryId, verb: { id: "http://adlnet.gov/expapi/verbs/attempted" } },
      status: "pending",
    });
    await drain(baseURL!);
    const afterFail = await outboxStatus(retryId);
    expect(afterFail?.status, "should be failed after 500").toBe("failed");
    expect(afterFail?.attempts).toBe(1);

    mock.setStatus(200);
    await svc()
      .from("lrs_forward_outbox")
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
      .eq("statement_id", retryId);
    await drain(baseURL!);
    expect((await outboxStatus(retryId))?.status, "should be sent after recovery").toBe("sent");

    // --- connection test (xAPI /about) ---
    const ctx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const testRes = await ctx.request.post("/api/org/lrs/test", {
      data: { orgSlug: org.slug, endpoint: mock.url, auth_key: "k", auth_secret: "s3cr3t" },
    });
    expect(testRes.ok()).toBeTruthy();
    expect((await testRes.json()).status).toBe("ok");

    // --- config GET masks the secret ---
    const getRes = await ctx.request.get(`/api/org/lrs?orgSlug=${org.slug}`);
    const cfg = (await getRes.json()).config;
    expect(cfg.has_secret).toBeTruthy();
    expect(cfg.auth_secret).not.toBe("s3cr3t"); // masked, never the raw value
    await ctx.close();
  } finally {
    await mock.close();
  }
});
