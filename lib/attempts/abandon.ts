/**
 * "Abandoned is terminal" (ALDS step 0, P4).
 *
 * An attempt becomes `abandoned` when the learner confirms a language switch,
 * when a granted retake is consumed at launch, or when an admin replaces a
 * package with "force restart". From then on nothing may write to it again:
 * every course_attempts update made on behalf of the content (SCORM commit,
 * xAPI statements, xAPI State) is conditional on `status <> 'abandoned'` and a
 * write that matches no row answers 410 `{ error: "attempt_abandoned" }`.
 * Every path that abandons also expires the attempt's cmi5/xAPI launch tokens,
 * so a stale tab cannot keep talking to the LRS endpoints.
 *
 * Deliberately free of next/* imports so unit tests can load it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk, fetchAll } from "@/lib/db/chunked";

export const ATTEMPT_ABANDONED = "attempt_abandoned";

/** Thrown by the progress writers when the target attempt is abandoned. */
export class AttemptAbandonedError extends Error {
  readonly code = ATTEMPT_ABANDONED;
  constructor(readonly attemptId: string) {
    super(`attempt ${attemptId} is abandoned`);
    this.name = "AttemptAbandonedError";
  }
}

export function isAttemptAbandonedError(e: unknown): e is AttemptAbandonedError {
  return (
    e instanceof AttemptAbandonedError ||
    (typeof e === "object" && e !== null && (e as { code?: unknown }).code === ATTEMPT_ABANDONED)
  );
}

/** The 410 every content-facing write route answers for an abandoned attempt. */
export function attemptAbandonedResponse(): Response {
  return new Response(JSON.stringify({ error: ATTEMPT_ABANDONED }), {
    status: 410,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Expire every still-live cmi5/xAPI launch token of these attempts
 * (`expires_at = now()`), in the same code path that abandoned them. Returns
 * the first error (the abandon itself already happened; callers log it).
 */
export async function expireLaunchTokens(
  svc: SupabaseClient,
  attemptIds: string[]
): Promise<{ message: string } | null> {
  const ids = [...new Set(attemptIds.filter(Boolean))];
  const nowIso = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await svc
      .from("cmi5_launch_tokens")
      .update({ expires_at: nowIso })
      .in("attempt_id", ids.slice(i, i + 200))
      .gt("expires_at", nowIso);
    if (error) return { message: error.message };
  }
  return null;
}

/**
 * The user ids in one token read of expireLaunchTokensForMembers: the
 * `.in()` house rule of lib/db/chunked.ts (150), since the ids travel in
 * the read's URL as an embedded filter.
 */
export const MEMBER_TOKEN_CHUNK = 150;

/**
 * ADR 0030 decision 4: a deactivation ends that person's open launches.
 *
 * Expire every still-live cmi5/xAPI launch token of these people's attempts
 * in this organisation, whatever the attempt's status. The statement routes
 * refuse only an abandoned attempt, so a completed attempt with a live token
 * could still be written to; that is why the tokens are found by being live
 * and not by the attempt's status. One read of the live tokens, found
 * through the attempt's user and organisation (user ids in chunks of
 * MEMBER_TOKEN_CHUNK, each read paged), then the existing expiry above. The
 * attempts are not touched and nothing is queued.
 *
 * Called by each writer that leaves a membership row in a status other than
 * `active`, and by the two routes that remove a membership row, in the same
 * request and after that write. Returns the first error and never throws:
 * the deactivation or removal already happened and stands, and the caller
 * logs the ids and reports the failure in its answer.
 */
export async function expireLaunchTokensForMembers(
  svc: SupabaseClient,
  orgId: string,
  userIds: string[]
): Promise<{ message: string } | null> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!orgId || ids.length === 0) return null;
  try {
    const nowIso = new Date().toISOString();
    const attemptIds = new Set<string>();
    for (const part of chunk(ids, MEMBER_TOKEN_CHUNK)) {
      const live = await fetchAll<{ attempt_id: string }>(
        svc,
        "cmi5_launch_tokens",
        "attempt_id, course_attempts!inner(user_id, organization_id)",
        (q) =>
          q
            .eq("course_attempts.organization_id", orgId)
            .in("course_attempts.user_id", part)
            .gt("expires_at", nowIso),
        "fetch_token"
      );
      for (const t of live) if (t.attempt_id) attemptIds.add(t.attempt_id);
    }
    return await expireLaunchTokens(svc, [...attemptIds]);
  } catch (e) {
    return { message: e instanceof Error ? e.message : String(e) };
  }
}

/** The log line of a failed expiry: ids only, never an address. */
export function logLaunchTokenExpiryFailed(
  where: string,
  orgId: string,
  userIds: string[],
  err: { message: string }
): void {
  console.error(
    JSON.stringify({
      event: "launch_token_expiry_failed",
      where,
      organization_id: orgId,
      user_ids: [...new Set(userIds.filter(Boolean))],
      error: err.message,
    })
  );
}

/** The line a Users form shows when the expiry failed. */
export const LAUNCH_TOKENS_NOT_EXPIRED =
  "Saved, but their open course launches could not be closed. Each one stops on its own within 24 hours of its launch.";

/** The same line after a member is removed. */
export const LAUNCH_TOKENS_NOT_EXPIRED_ON_REMOVE =
  "Removed, but their open course launches could not be closed. Each one stops on its own within 24 hours of its launch.";
