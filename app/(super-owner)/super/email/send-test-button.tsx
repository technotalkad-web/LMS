"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";

/** The console's "Send test" (ADR 0029 section F): POST /api/super/email/test, no body. */
const OUTCOME: Record<string, string> = {
  "sent:": "Sent to your own address. Check that inbox (and its spam folder).",
  "suppressed:test_domain": "Not sent: your address is on a reserved test domain, which the platform never mails.",
  "suppressed:not_allowed": "Not sent: your address's domain is not in PLATFORM_EMAIL_ALLOW_DOMAINS (or that setting is unset).",
  "refused:account_limit": "Not sent: the test limit is reached (5 an hour, 10 a day). Try again later.",
  "failed:not_configured": "Not sent: the sender is not configured. Set the missing variables listed above.",
  "failed:log_unreadable": "Not sent: the platform email log cannot be read (is migration 0113 pasted?). Nothing is sent without it.",
  "failed:auth": "Not sent: the mail server refused the sign-in. Check PLATFORM_SMTP_USER and the app password.",
  "failed:quota": "Not sent: the mailbox's sending limit is reached.",
  "failed:timeout": "No answer within 8 seconds. The message may still arrive; check the inbox before trying again.",
  "failed:unreachable": "Not sent: the mail server could not be reached with these settings (host, port, TLS).",
  "failed:rejected": "Not sent: the receiving mail server refused the message.",
  "failed:unknown": "Not sent: the mail server reported an error. The newest log row has its detail.",
};

export function SendTestButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/super/email/test", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { status?: string; error_code?: string | null; logged?: boolean; error?: string };
      if (!res.ok) {
        setMessage(`Not sent: ${body.error ?? `HTTP ${res.status}`}.`);
      } else {
        const outcome = OUTCOME[`${body.status}:${body.error_code ?? ""}`] ?? `Not sent: ${body.status ?? "unknown"} ${body.error_code ?? ""}.`;
        // A delivered send whose log row was not written: the limits and the health check do not count it.
        const unlogged = body.status === "sent" && body.logged === false ? " It was not recorded in the platform email log." : "";
        setMessage(outcome + unlogged);
      }
      router.refresh();
    } catch {
      setMessage("Not sent: the request failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={send}
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
      >
        <Send className="w-4 h-4" />
        {busy ? "Sending…" : "Send test to my address"}
      </button>
      {message && (
        <p role="status" className="mt-3 text-sm text-ink">
          {message}
        </p>
      )}
    </div>
  );
}
