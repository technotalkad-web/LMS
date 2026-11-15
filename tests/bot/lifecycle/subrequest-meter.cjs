/**
 * Opt-in subrequest meter for a local production build (ADR 0024 P2-5 gate:
 * "A preview launch's subrequest count is measured and recorded"; step 70
 * asks for a measured count on a local build). A Playwright spec sees only
 * the responses, never the fetches the server makes while it renders, so the
 * count is taken inside the server process and read back by the spec.
 *
 * Preloaded into the app server only, never into the spec run:
 *
 *   SUBREQUEST_LOG=<file> NODE_OPTIONS="--require ./tests/bot/lifecycle/subrequest-meter.cjs" \
 *     node node_modules/next/dist/bin/next start -p 3100
 *
 * with the same SUBREQUEST_LOG (an absolute path) in the Playwright run's
 * environment, on the same machine. Without SUBREQUEST_LOG it does nothing.
 *
 * For every incoming HTTP request it counts the global fetch() calls made
 * while that request is handled (each one a subrequest on the Workers
 * production runtime) and, when the response finishes, appends one JSON
 * line: { path, method, status, fetches, supabase, other }. `path` is the
 * request's path and query (ids only); `supabase` counts the calls to the
 * NEXT_PUBLIC_SUPABASE_URL host, `other` the rest. No host name, header or
 * body is written. The request is told apart by an AsyncLocalStorage store
 * entered at the server's "request" event, which follows the render's awaits.
 *
 * Limits, recorded with every figure: the middleware may run in Next's edge
 * sandbox with a fetch of its own, outside this wrapper (ADR 0019 estimates
 * its one auth call); work scheduled to run after the response finishes is
 * not counted; a fetch answered from Next's per-render memo makes no call
 * and is not counted, as on Workers.
 */
"use strict";

const LOG = process.env.SUBREQUEST_LOG;

// process.getBuiltinModule (Node 22.3 and later; the nightly runs Node 22):
// the built-ins without require(), which the repository's lint refuses.
const builtin = typeof process.getBuiltinModule === "function" ? (id) => process.getBuiltinModule(id) : null;

if (LOG && builtin && typeof globalThis.fetch === "function") {
  const fs = builtin("node:fs");
  const http = builtin("node:http");
  const { AsyncLocalStorage } = builtin("node:async_hooks");

  const store = new AsyncLocalStorage();
  let supabaseHost = null;
  try {
    supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").host || null;
  } catch {
    supabaseHost = null;
  }

  const hostOf = (input) => {
    try {
      if (typeof input === "string") return new URL(input).host;
      if (input instanceof URL) return input.host;
      if (input && typeof input.url === "string") return new URL(input.url).host;
    } catch {
      /* a relative or unparsable URL counts as other */
    }
    return "";
  };

  const original = globalThis.fetch;
  globalThis.fetch = function meteredFetch(input, init) {
    const counts = store.getStore();
    if (counts) {
      if (supabaseHost !== null && hostOf(input) === supabaseHost) counts.supabase += 1;
      else counts.other += 1;
    }
    return original.call(this, input, init);
  };

  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function meteredEmit(event, req, res) {
    if (event !== "request" || !req || !res || typeof res.once !== "function") {
      return emit.apply(this, arguments);
    }
    const counts = { supabase: 0, other: 0 };
    res.once("finish", () => {
      try {
        const line = {
          path: typeof req.url === "string" ? req.url : "",
          method: req.method || "",
          status: res.statusCode,
          fetches: counts.supabase + counts.other,
          supabase: counts.supabase,
          other: counts.other,
        };
        fs.appendFileSync(LOG, `${JSON.stringify(line)}\n`);
      } catch {
        /* the meter never fails a request */
      }
    });
    const args = arguments;
    return store.run(counts, () => emit.apply(this, args));
  };
}
