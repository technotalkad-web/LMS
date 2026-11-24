import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { finalizeAnswer, finalizeDirectUpload } from "@/lib/courses/direct-upload";
import { originFromRequest } from "@/lib/http/origin";
import { reissueNotifier } from "@/lib/attempts/requests";
import { ADMIN_REQUEST_OWN_CALLS, requestBudget } from "@/lib/notifications/smtp-state";

/**
 *   POST /api/courses/upload/finalize   { orgSlug, versionId, notify_update?, mode? }
 *
 * Step 3 of a direct upload: verifies the files are in storage, counts
 * learning units, marks the version ready and makes it current. A 409 with
 * `retryable: true` means files are still missing — the browser re-sends
 * them and calls finalize again.
 *
 * Three outcomes (ADR 0011 step 6):
 *   - refused: `{ error, retryable }` with its status; nothing was published;
 *   - published: 200 with the result; with `mode: "force_restart"` it carries
 *     `restart` (status "ok", the counts and a message);
 *   - published, but the forced restart failed: 500 with the result plus
 *     `ok: false`, `published: true`, `error` (the restart's message) and
 *     `retryable: false`. The version IS ready and current; the retry is
 *     "Restart learners on this version" on each older version. A client
 *     must not abort the upload on this answer.
 *
 * ADR 0029 rule T4: when the forced restart re-issued grants and mailed
 * their learners, the answer carries those mails' outcome as `reissueEmail`,
 * beside `restart` and never inside it.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as null | {
    orgSlug?: string;
    versionId?: string;
    notify_update?: boolean;
    mode?: string;
  };
  if (!body?.versionId) return NextResponse.json({ error: "versionId required" }, { status: 400 });
  const auth = await requireOrgAdminApi(body.orgSlug);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // ADR 0029 rule T4: the request's two budgets, shared by the forced
  // restart's re-issue mails and the update mail.
  const mailBudget = requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
  const reissue = reissueNotifier({ budget: mailBudget });
  const result = await finalizeDirectUpload({
    supabase: auth.supabase,
    org: auth.org,
    userId: auth.userId,
    versionId: body.versionId,
    notifyUpdate: body.notify_update === true,
    restartMode: body.mode === "force_restart" ? "force_restart" : "grandfather",
    // ADR 0014 step 8: what a forced restart's re-issued grant needs to tell the learner.
    origin: await originFromRequest(),
    notify: reissue.notify,
    mailBudget,
  });
  const answer = finalizeAnswer(result);
  const reissueEmail = reissue.outcome();
  return NextResponse.json(result.ok && reissueEmail ? { ...answer.body, reissueEmail } : answer.body, { status: answer.status });
}
