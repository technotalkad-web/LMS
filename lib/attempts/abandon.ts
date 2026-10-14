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
