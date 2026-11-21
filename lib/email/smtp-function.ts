/**
 * The one way the app sends SMTP mail: a POST to the `send-smtp` Supabase
 * Edge Function (supabase/functions/send-smtp/index.ts), which holds the
 * socket. The main app runs on Cloudflare Workers, which open no raw TCP
 * socket, so nodemailer cannot run here.
 *
 * Two senders use it and neither is a fallback for the other (ADR 0029):
 *   - a tenant's own SMTP, from lib/notifications/send.ts;
 *   - the platform's SMTP, from lib/email/platform-sender.ts.
 *
 * dispatchSmtp and sendSmtpUrl moved here from lib/notifications/send.ts
 * unchanged (ADR 0029 step 2). The one addition is an optional timeout:
 * without it the request is exactly the one send.ts made before.
 *
 * The error-class table reads send-smtp's free-text error (send-smtp is not
 * changed) into the fixed classes of ADR 0029 section C.
 */

export function sendSmtpUrl(): string {
  // Override allowed for local dev (e.g., `supabase functions serve`)
  // and for the unusual case of running functions on a different host.
  const explicit = process.env.SEND_SMTP_FUNCTION_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is required to resolve the send-smtp Edge Function URL."
    );
  }
  return `${base.replace(/\/$/, "")}/functions/v1/send-smtp`;
}

export type SmtpDispatchPayload = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
};

/**
 * How long one send is waited for, in both systems (ADR 0029, rule T1 of the
 * timing note of 2026-11-18): the tenant pipeline and the platform sender
 * both pass it. It is the after-response job's budget (25 s) less 10 s kept
 * for the job's reads, its rows and an alert; if that budget moves, this
 * moves with it. send-smtp may still deliver after the wait ends.
 */
export const SMTP_SEND_WAIT_MS = 15_000;

/**
 * Each limit on a public code or link is claimed before the send (ADR 0029,
 * the note of 2026-11-22): the job writes its claim, then counts the rows
 * with its own among them, and goes on only within the limit. The same
 * three numbers hold in both systems (the platform's `pending` row, the
 * tenant's `queued` row).
 *
 * CLAIM_SEND_WITHIN_MS: a job starts its send no later than this after it
 * wrote its claim; later, it sends nothing.
 */
export const CLAIM_SEND_WITHIN_MS = 30_000;
/**
 * A claim counts as a send in flight for this long from its row's time,
 * against an organisation's share, the platform's ceiling and a tenant's
 * daily limit. It is at least the time to start the send, the send's own
 * wait, and a minute for the outcome's row and for two clocks that differ,
 * so a mail that went has its sent row before its claim stops counting.
 */
export const CLAIM_IN_FLIGHT_MS = 120_000;
/** At most this many claims of one account and kind count as in flight: no more of them can go in an hour. */
export const CLAIMS_IN_FLIGHT_PER_ACCOUNT = 5;
/** A read of the claims in flight asks for this many rows; a full page cannot be counted, and nothing is sent. */
export const CLAIMS_IN_FLIGHT_PAGE = 1000;

/**
 * The sends in flight that a list of claims stands for: for each account and
 * kind at most CLAIMS_IN_FLIGHT_PER_ACCOUNT, and a claim with no account
 * counts by itself. So the claims of one address hold back no more of a
 * share than that address may use.
 */
export function claimsInFlight(rows: ReadonlyArray<{ to_user_id?: unknown; event_type?: unknown }>): number {
  const byAccount = new Map<string, number>();
  let alone = 0;
  for (const r of rows) {
    if (typeof r.to_user_id !== "string" || r.to_user_id.length === 0) {
      alone++;
      continue;
    }
    const key = `${r.to_user_id} ${String(r.event_type ?? "")}`;
    byAccount.set(key, Math.min(CLAIMS_IN_FLIGHT_PER_ACCOUNT, (byAccount.get(key) ?? 0) + 1));
  }
  let n = alone;
  for (const c of byAccount.values()) n += c;
  return n;
}

export type SmtpDispatchOptions = {
  /**
   * Stop waiting after this many milliseconds and answer a timeout. The
   * function may still deliver the mail: send-smtp keeps trying for up to
   * 25 s (ADR 0029 section F). Unset: no limit, as before the move.
   */
  timeoutMs?: number;
};

/** The fixed text dispatchSmtp answers when its own timeout stops the wait. */
export function dispatchTimeoutMessage(ms: number): string {
  return `Timed out after ${ms}ms waiting for the send-smtp function.`;
}

/**
 * POST the rendered email to the send-smtp Edge Function. Returns
 * { ok: true } on a successful send, or { ok: false, error: string }
 * when the SMTP conversation fails (bad creds, connection refused,
 * TLS error, etc.). Any infrastructure error (function timeout,
 * function not deployed, network failure) is captured as { ok: false,
 * error } too so callers always get a usable status.
 */
export async function dispatchSmtp(
  payload: SmtpDispatchPayload,
  options: SmtpDispatchOptions = {}
): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing." };
  }
  const timeoutMs = options.timeoutMs;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    };
    if (controller) init.signal = controller.signal;
    const res = await fetch(sendSmtpUrl(), init);
    if (res.status === 401) {
      return { ok: false, error: "Edge Function rejected service-role bearer." };
    }
    if (!res.ok && res.status !== 200) {
      return { ok: false, error: `Edge Function returned HTTP ${res.status}.` };
    }
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (body?.ok === true) return { ok: true };
    return { ok: false, error: body?.error ?? "Unknown SMTP error." };
  } catch (e) {
    // The runtimes word an abort differently; the answer is one fixed text.
    if (controller?.signal.aborted && timeoutMs) {
      return { ok: false, error: dispatchTimeoutMessage(timeoutMs) };
    }
    const msg = e instanceof Error ? e.message : "Edge Function fetch failed.";
    return { ok: false, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The classes a failed send is read into (ADR 0029 sections C and F):
 *   auth         the server refused the sign-in (wrong user or app password,
 *                sign-in disabled): the sender is dead until someone acts;
 *   quota        the sending mailbox's own limit is reached (a sender-side
 *                limit only; one recipient's full mailbox is "rejected");
 *   timeout      no answer in time (the mail may still have gone);
 *   unreachable  the server or the function could not be reached or spoken
 *                to as configured (DNS, refused connection, TLS, HTTP 5xx or
 *                404 from the function);
 *   rejected     the recipient's mail server refused this one mail (an
 *                unknown or full mailbox): it never moves a health reading;
 *   unknown      anything else, including a refused sender address, which
 *                fails every send and so must count as a sender-side failure.
 */
export type SmtpErrorClass = "auth" | "quota" | "timeout" | "unreachable" | "rejected" | "unknown";

/**
 * Read in order; the first match wins. Each pattern is matched against the
 * whole message, case-insensitively. An SMTP reply code is matched with the
 * separator that follows it in a reply ("535 " or "535-"), so a port number
 * or a count never reads as a code.
 *
 * The rule the order keeps: a recipient's refusal never reads as a sender's
 * failure (it would mark a working sender dead), and a sender's failure
 * never reads as a recipient's refusal (it would hide a dead sender).
 */
export const SMTP_ERROR_CLASS_TABLE: ReadonlyArray<{ cls: SmtpErrorClass; pattern: RegExp }> = [
  // Our own wait ran out, or send-smtp's (withTimeout: "Timed out after …").
  { cls: "timeout", pattern: /\btimed out\b|\btimeout\b|\bETIMEDOUT\b/i },
  // The sending mailbox's own limit, in its sender-side forms only: Gmail
  // 550 5.4.5 / 421 4.7.28, Microsoft 365's submission quota (which can come
  // with 5.2.2, so it is read before the full-mailbox row), Amazon SES's
  // "Maximum sending rate exceeded" and throttling. A bare "quota exceeded"
  // or "limit exceeded" is not read here: a recipient's full mailbox and a
  // message size limit say that too.
  {
    cls: "quota",
    pattern:
      /\b5\.4\.5\b|\b4\.7\.28\b|sending (quota|limit)|submission ?quota|maximum sending rate|throttl|too many (messages|emails|recipients)/i,
  },
  // One recipient's mailbox is full (x.2.2 and its wording): that mail only.
  { cls: "rejected", pattern: /\b[45]\.2\.2\b|mailbox (is )?full|mailbox quota/i },
  // Sign-in refused: SMTP 535 and 534 (not after a word character, a colon
  // or a dot, so a port such as host:535 is not read as a reply), Gmail's
  // "Username and Password not accepted" and "Application-specific password
  // required", Microsoft 365's "Authentication unsuccessful".
  {
    cls: "auth",
    pattern:
      /(?<![\w:.])53[45][ -]|\b5\.7\.(8|9|139)\b|authentication (failed|unsuccessful|required)|username and password not accepted|application-specific password|invalid (login|credentials)|bad ?credentials|auth(entication)? .*(disabled|not enabled)/i,
  },
  // The sender's own address refused (x.1.7, x.1.8, "Sender address
  // rejected"): every send fails the same way, so it is a sender-side
  // failure, read before the recipient rows below.
  { cls: "unknown", pattern: /\b[45]\.1\.[78]\b|sender address rejected/i },
  // This one recipient refused (unknown user or domain, mailbox unavailable),
  // in recipient forms only.
  {
    cls: "rejected",
    pattern:
      /\b5\.1\.(1|2|3|6|10)\b|user unknown|no such user|mailbox (unavailable|not found|does not exist)|recipient (address )?rejected|does not exist/i,
  },
  // The server, the function or the network as configured.
  {
    cls: "unreachable",
    pattern:
      /connection refused|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|getaddrinfo|name or service not known|failed to lookup address|no such host|network is unreachable|connection (reset|closed)|certificate|\btls\b|\bssl\b|client construction failed|Edge Function returned HTTP (404|5\d\d)|fetch failed|requires port 465/i,
  },
];

/**
 * The hosting platform's own limit on outbound calls in one request (rule
 * FP8 of ADR 0029). On Workers a fetch past the limit throws "Too many
 * subrequests.", which dispatchSmtp and the database client hand back as an
 * error message. It is the job's own failed step (the word call_limit),
 * never a tenant's failed send: the mail never left this request.
 */
export function isCallLimitMessage(message: string | null | undefined): boolean {
  return /too many subrequests/i.test(String(message ?? ""));
}

/** The class of a send-smtp error message; text that matches nothing is "unknown". */
export function classifySmtpError(message: string | null | undefined): SmtpErrorClass {
  const text = String(message ?? "");
  for (const row of SMTP_ERROR_CLASS_TABLE) {
    if (row.pattern.test(text)) return row.cls;
  }
  return "unknown";
}
