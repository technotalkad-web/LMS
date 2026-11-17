import { cache } from "react";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  PLATFORM_SENDER_FAILURE_CLASSES,
  classifyPlatformEmail,
  type PlatformEmailReason,
} from "@/lib/ops/health-status";
import { platformEmailLimits, platformSenderReadiness } from "./platform-sender";

/**
 * The `platform_email` reading (ADR 0029 section H), read by the health
 * route, the platform console's banner and its email page. The rules are
 * classifyPlatformEmail's (lib/ops/health-status.ts); this module only reads.
 *
 * Two reads of platform_email_log, run together: the two newest rows that
 * are sent or a sender-side failure, and the count of sent rows in 24 hours
 * (the ceiling's count). A read that fails, or a table that is not there
 * yet, reads "log unreadable", which is a fail. Never throws.
 *
 * It returns variable names and counts, never a setting's value or an
 * address. Read with the service role, after the caller's own role check.
 */

export type PlatformEmailHealth = {
  status: "ok" | "warn" | "fail";
  reasons: PlatformEmailReason[];
  configured: boolean;
  /** Required variables that are missing or invalid: names only. */
  missing: string[];
  /** The newest sent or sender-side failed row; null when none or unreadable. */
  newest: { sent_at: string; status: string; error_code: string | null } | null;
  sent24h: number | null;
  ceiling: number;
};

const DAY_MS = 24 * 3_600_000;

export async function readPlatformEmailHealth(
  db: SupabaseClient,
  opts: { env?: Record<string, string | undefined>; now?: number } = {}
): Promise<PlatformEmailHealth> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const readiness = platformSenderReadiness(env);
  const { dailyCeiling } = platformEmailLimits(env);

  let logReadable = false;
  let newest: Array<{ sent_at: string; status: string; error_code: string | null }> = [];
  let sent24h: number | null = null;
  try {
    const [recent, sent] = await Promise.all([
      db
        .from("platform_email_log")
        .select("sent_at, status, error_code")
        .or(`status.eq.sent,and(status.eq.failed,error_code.in.(${PLATFORM_SENDER_FAILURE_CLASSES.join(",")}))`)
        .order("sent_at", { ascending: false })
        .limit(2),
      db
        .from("platform_email_log")
        .select("id", { count: "exact", head: true })
        .eq("status", "sent")
        .gte("sent_at", new Date(now - DAY_MS).toISOString()),
    ]);
    if (!recent.error && Array.isArray(recent.data) && !sent.error && typeof sent.count === "number") {
      logReadable = true;
      newest = recent.data as typeof newest;
      sent24h = sent.count;
    }
  } catch {
    logReadable = false;
  }

  const { status, reasons } = classifyPlatformEmail({
    configured: readiness.configured,
    logReadable,
    newest,
    sent24h: sent24h ?? 0,
    ceiling: dailyCeiling,
  });
  return {
    status,
    reasons,
    configured: readiness.configured,
    missing: readiness.missing,
    newest: newest[0] ?? null,
    sent24h,
    ceiling: dailyCeiling,
  };
}

/**
 * The reading once per server render, with the service role: the platform
 * console's layout (its banner) and /super/email share it, so the two log
 * reads run once for a request that renders both (React's cache(), as
 * requirePlatformOwner uses it). Call it only after the platform guard.
 * Outside a render (the health route, scripts) use readPlatformEmailHealth.
 */
export const platformEmailHealthForRender = cache(
  async (): Promise<PlatformEmailHealth> =>
    readPlatformEmailHealth(
      createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { persistSession: false },
      })
    )
);
