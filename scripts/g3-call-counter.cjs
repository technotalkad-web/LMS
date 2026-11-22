/**
 * Gate G3's call counter (ADR 0029): the outgoing calls of each incoming
 * request of a local production build, including the work the request runs
 * after its response (Next's after()), and the middleware's own calls.
 *
 * Preloaded into the app server only, never into a test run or a build:
 *
 *   G3_COUNT_LOG=<absolute file> NODE_OPTIONS="--require <this file>" \
 *     node node_modules/next/dist/bin/next start -p <port>
 *
 * Without G3_COUNT_LOG it does nothing. A driver labels each request it wants
 * counted with its own `x-g3-label` header (letters, digits and . _ : - only,
 * at most 80); any other request is "unlabelled". scripts/g3-call-counts.mjs
 * reads the file and prints one line for each labelled request.
 *
 * The file holds one JSON line for each event: a request's start and finish
 * (with its status), and each outgoing call, with the request's sequence
 * number, the label, the host kind, the source, and whether the response had
 * already finished. Host kinds: `rest` (/rest/v1/ on the
 * NEXT_PUBLIC_SUPABASE_URL host), `auth` (/auth/v1/ there), `send_smtp`
 * (/functions/v1/send-smtp there) and `other` (anything else). No URL, path,
 * header value or body is written.
 *
 * Sources:
 *   - undici: every undici request (diagnostics_channel
 *     "undici:request:create"): the global fetch, and the fetch of Next's edge
 *     sandbox, where the middleware runs. `via` is "fetch" when the request
 *     came through the global fetch, else "direct" (the middleware's calls).
 *     A "done" line follows when it ends, so a reader can tell when a
 *     request's calls have settled.
 *   - http: node http/https request() and get(), for a call not on undici.
 *   - raw_socket: a net/tls connection opened by neither undici nor the http
 *     agent.
 *   - fetch: the global fetch wrapper itself; a cross-check of the undici
 *     lines with via "fetch", not part of a total.
 * A call made outside any incoming request is written with seq 0.
 *
 * Limits: a fetch answered from Next's per-render memo makes no call and is
 * not counted, as on Workers. Work the platform would end early (its time
 * after the response, its CPU) runs to its end here.
 */
"use strict";

const LOG = process.env.G3_COUNT_LOG;
// process.getBuiltinModule (Node 22.3 and later): the built-ins without
// require(), as tests/bot/lifecycle/subrequest-meter.cjs takes them.
const builtin = typeof process.getBuiltinModule === "function" ? (id) => process.getBuiltinModule(id) : null;

if (LOG && builtin) {
  const fs = builtin("node:fs");
  const http = builtin("node:http");
  const https = builtin("node:https");
  const net = builtin("node:net");
  const tls = builtin("node:tls");
  const dc = builtin("node:diagnostics_channel");
  const { AsyncLocalStorage } = builtin("node:async_hooks");

  const reqStore = new AsyncLocalStorage();
  const viaFetch = new AsyncLocalStorage();
  let seqNext = 0;
  let supabaseHost = null;
  try {
    supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").host || null;
  } catch {
    supabaseHost = null;
  }

  const write = (obj) => {
    try {
      fs.appendFileSync(LOG, `${JSON.stringify(obj)}\n`);
    } catch {
      /* the counter never fails a request */
    }
  };

  /** The host kind of a call: never the URL itself. */
  const kindOf = (host, path) => {
    if (supabaseHost !== null && host === supabaseHost) {
      const p = typeof path === "string" ? path : "";
      if (p.startsWith("/rest/v1/")) return "rest";
      if (p.startsWith("/auth/v1/")) return "auth";
      if (p.startsWith("/functions/v1/send-smtp")) return "send_smtp";
    }
    return "other";
  };
  const hostOfOrigin = (origin) => {
    try {
      if (typeof origin === "string") return new URL(origin).host;
      if (origin && typeof origin.host === "string") return origin.host;
    } catch {
      /* unparsable: other */
    }
    return "";
  };
  const urlParts = (input) => {
    try {
      const u =
        typeof input === "string" ? new URL(input)
        : input instanceof URL ? input
        : input && typeof input.url === "string" ? new URL(input.url)
        : null;
      return u ? { host: u.host, path: u.pathname } : { host: "", path: "" };
    } catch {
      return { host: "", path: "" };
    }
  };

  const ctx = () => {
    const s = reqStore.getStore();
    return s ? { seq: s.seq, label: s.label, after: s.finished } : { seq: 0, label: "none", after: false };
  };

  const open = new WeakMap();
  dc.subscribe("undici:request:create", (m) => {
    const r = m && m.request;
    if (!r) return;
    const c = ctx();
    open.set(r, c.seq);
    write({ ev: "call", src: "undici", via: viaFetch.getStore() === true ? "fetch" : "direct", kind: kindOf(hostOfOrigin(r.origin), r.path), seq: c.seq, label: c.label, after: c.after, t: Date.now() });
  });
  const ended = (m) => {
    const r = m && m.request;
    if (!r || !open.has(r)) return;
    const seq = open.get(r);
    open.delete(r);
    write({ ev: "done", src: "undici", seq, t: Date.now() });
  };
  dc.subscribe("undici:request:trailers", ended);
  dc.subscribe("undici:request:error", ended);

  if (typeof globalThis.fetch === "function") {
    const original = globalThis.fetch;
    globalThis.fetch = function countedFetch(input, init) {
      const c = ctx();
      const { host, path } = urlParts(input);
      write({ ev: "call", src: "fetch", kind: kindOf(host, path), seq: c.seq, label: c.label, after: c.after, t: Date.now() });
      return viaFetch.run(true, original.bind(this, input, init));
    };
  }

  const wrapHttp = (mod, name) => {
    const orig = mod[name];
    mod[name] = function countedHttp(...args) {
      const c = ctx();
      let host = "";
      let path = "";
      const a = args[0];
      if (typeof a === "string" || a instanceof URL) ({ host, path } = urlParts(String(a)));
      else if (a && typeof a === "object") {
        host = a.host || (a.hostname ? `${a.hostname}${a.port ? `:${a.port}` : ""}` : "");
        path = typeof a.path === "string" ? a.path.split("?")[0] : "";
      }
      write({ ev: "call", src: "http", kind: kindOf(host, path), seq: c.seq, label: c.label, after: c.after, t: Date.now() });
      return orig.apply(this, args);
    };
  };
  for (const [m, n] of [[http, "request"], [http, "get"], [https, "request"], [https, "get"]]) wrapHttp(m, n);

  const wrapSocket = (mod, name) => {
    const orig = mod[name];
    mod[name] = function countedSocket(...args) {
      // The frames' file names only, to leave out undici's and the http agent's own connections.
      if (!/undici|_http_agent|_http_client/.test(new Error().stack || "")) {
        const c = ctx();
        write({ ev: "call", src: "raw_socket", kind: "other", seq: c.seq, label: c.label, after: c.after, t: Date.now() });
      }
      return orig.apply(this, args);
    };
  };
  for (const [m, n] of [[net, "connect"], [net, "createConnection"], [tls, "connect"]]) wrapSocket(m, n);

  const LABEL_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function countedEmit(event, req, res) {
    if (event !== "request" || !req || !res || typeof res.once !== "function") {
      return emit.apply(this, arguments);
    }
    const raw = req.headers ? req.headers["x-g3-label"] : undefined;
    const label = typeof raw === "string" && LABEL_RE.test(raw) ? raw : "unlabelled";
    const store = { seq: ++seqNext, label, finished: false };
    write({ ev: "start", seq: store.seq, label, t: Date.now() });
    res.once("finish", () => {
      store.finished = true;
      write({ ev: "finish", seq: store.seq, label, status: res.statusCode, t: Date.now() });
    });
    const args = arguments;
    return reqStore.run(store, () => emit.apply(this, args));
  };
}
