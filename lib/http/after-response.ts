import { after } from "next/server";

/**
 * Work after the response (ADR 0027 point 15 and decision 9; ADR 0029
 * section C): the one helper every route uses for work it does after it has
 * answered, built on Next's after(). No route uses a bare un-awaited promise
 * for this.
 *
 * after() hands the task to the platform's waitUntil: on the Workers build
 * the OpenNext adapter provides it through Next's request context, and the
 * Node server that Cloud Run and the in-runner builds use keeps the process
 * up until the task ends. Outside a request scope after() throws, and so does
 * this helper: a caller that is not a route has nothing to answer first.
 *
 * A job that fails is caught here and logged as one line with the job's
 * fixed name and an error code: never the error's message, which may hold
 * an address, a code or a link.
 */
export function runAfterResponse(name: string, job: () => Promise<void>): void {
  after(async () => {
    try {
      await job();
    } catch (e) {
      console.error(JSON.stringify({ event: "after_response_failed", job: name, code: errorCode(e) }));
    }
  });
}

/** A short, fixed-shape code for a thrown value: its own code, else its class name, else "unknown". */
function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return code;
  if (e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name)) return e.name;
  return "unknown";
}
