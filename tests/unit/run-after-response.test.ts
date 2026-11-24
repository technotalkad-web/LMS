/**
 * runAfterResponse (lib/http/after-response.ts; ADR 0027 point 15, ADR 0029
 * section C): the one helper for work after the response, on Next's after().
 *   - the job is handed to after() and does not run before the response;
 *   - a job that throws is caught: one log line with the job's name and an
 *     error code, never the error's message;
 *   - outside a request scope it throws, as after() does (no bare promise).
 *
 * next/server is stubbed for the first three cases, so the handed task can
 * be run when the "response" is done; the last case uses the real module.
 *
 * Run:  npx tsx tests/unit/run-after-response.test.ts   (or npm run test:unit)
 */
import Module from "node:module";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Task = () => unknown;
const handed: Task[] = [];
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;

async function main() {
  (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
    if (request === "next/server") return { after: (task: Task) => { handed.push(task); } };
    return load.call(this, request, ...rest);
  };
  const lines: string[] = [];
  const realError = console.error;
  try {
    const { runAfterResponse } = await import("../../lib/http/after-response");
    let ran = 0;
    runAfterResponse("reset-code", async () => { ran++; });
    eq("the job is handed to after() and has not run yet", [handed.length, ran], [1, 0]);
    await handed[0]();
    eq("…it runs when after() runs it", ran, 1);

    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    runAfterResponse("reset-code", async () => { throw Object.assign(new Error("send failed for person@tenant.stub with code 482915"), { code: "23505" }); });
    await handed[1]();
    runAfterResponse("sign-in-link", async () => { throw new TypeError("link https://lms.stub/auth?token_hash=secret"); });
    await handed[2]();
    runAfterResponse("sign-in-link", async () => { throw "a bare string with person@tenant.stub"; });
    await handed[3]();
    console.error = realError;
    eq("a job that throws is caught: one line each, with its name and a code", lines.map((l) => JSON.parse(l)), [
      { event: "after_response_failed", job: "reset-code", code: "23505" },
      { event: "after_response_failed", job: "sign-in-link", code: "TypeError" },
      { event: "after_response_failed", job: "sign-in-link", code: "unknown" },
    ]);
    eq("…never the message: no address, no code, no link", lines.some((l) => /@|482915|token_hash|https?:/.test(l)), false);
  } finally {
    console.error = realError;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }

  // The real after(): outside a request scope it throws, so the helper never
  // falls back to a bare promise.
  {
    const { after } = await import("next/server");
    let threw = false;
    try { after(async () => {}); } catch { threw = true; }
    eq("Next's own after() throws outside a request scope (the helper inherits it)", threw, true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
