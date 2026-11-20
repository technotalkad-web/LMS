import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { CHECK_FAILED } from "@/lib/auth/api-admin";
import { countingMemberIds, resolveOrgMembership } from "@/lib/auth/org-membership";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { mailCounts, sendMany } from "@/lib/notifications/send";
import { ADMIN_REQUEST_OWN_CALLS, countCalls, openRun, requestBudget, spendCalls } from "@/lib/notifications/smtp-state";
import { resolveEmailsStrict } from "@/lib/users/emails";
import { assignedRecipientsStrict, teamMemberIdsStrict } from "@/lib/org/groups";

// Action-button types the admin can attach to a broadcast. Course/Path
// types reference an org-scoped entity and are resolved to a deep link
// at send time. "profile" is a well-known org-relative URL. "custom"
// accepts a raw http(s) URL.
type BroadcastButtonInput =
  | { type: "course"; label: string; course_id: string }
  | { type: "path"; label: string; path_id: string }
  | { type: "profile"; label: string }
  | { type: "custom"; label: string; url: string };

const MAX_BUTTONS = 3;

/**
 *   POST /api/notifications/broadcast
 *   body: {
 *     orgSlug,
 *     subject, body_md,
 *     audience: "all" | "team" | "users" | "course" | "path",
 *     team_id?, user_ids?, course_id?, path_id?,
 *     buttons?: Array<{ type, label, course_id?, path_id?, url? }>  (max 3)
 *   }
 *
 * Sends a custom email to a selected audience. Admin-only.
 *
 * ADR 0029 (rule T4; part 3 of the note of 2026-11-20): the answer rests on
 * the reads of the audience, so a failed read of the members that count, of
 * a team, of an assignment's people or of the addresses answers 503 and
 * sends nothing. The mail is one run within the request's budgets; the
 * answer says how many were emailed and how many were not.
 */
const AUDIENCE_UNREADABLE = "Could not read who can receive this. Nothing was sent; try again.";
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    subject?: string;
    body_md?: string;
    audience?: "all" | "team" | "users" | "course" | "path";
    team_id?: string;
    user_ids?: string[];
    course_id?: string;
    path_id?: string;
    buttons?: BroadcastButtonInput[];
  };
  if (!body.orgSlug || !body.subject?.trim() || !body.body_md?.trim()) {
    return NextResponse.json(
      { error: "orgSlug, subject, body_md required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ADR 0030: the org and the caller's role, from a membership that counts.
  const callerMem = await resolveOrgMembership<{ id: string; name: string; slug: string }>(
    supabase,
    { slug: body.orgSlug },
    caller.id,
    "id, name, slug"
  );
  if (callerMem === "unreadable") {
    return NextResponse.json({ error: CHECK_FAILED }, { status: 503 });
  }
  if (callerMem === "none") {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  const org = callerMem.org;
  const r = callerMem.role;
  const canWrite = r === "super_owner" || r === "owner" || r === "admin";
  if (!canWrite) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ADR 0030 rule 10: the organisation mails only members that count
  // (active, in an organisation that is not deleted). One read of them for
  // this request: the audience "all", the org-wide branch of a course or
  // path audience, and the tenant guard below. Unreadable: nothing is sent.
  const budget = requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
  const countingRead = await countingMemberIds(svc, org.id, undefined, countCalls(budget));
  if (countingRead === "unreadable") {
    return NextResponse.json({ error: AUDIENCE_UNREADABLE }, { status: 503 });
  }
  const counting: ReadonlySet<string> = countingRead;

  // ---- Audience → recipient user_ids (strict reads) ---------------------
  let audienceRead: Set<string> | "unreadable" = new Set<string>();
  const audience = body.audience ?? "all";
  if (audience === "users" && body.user_ids) {
    audienceRead = new Set(body.user_ids);
  } else if (audience === "team" && body.team_id) {
    audienceRead = await teamMemberIdsStrict(svc, [body.team_id], countCalls(budget));
  } else if (audience === "course" && body.course_id) {
    audienceRead = await assignedRecipientsStrict(svc, org.id, { table: "course_assignments", column: "course_id", id: body.course_id }, counting, countCalls(budget));
  } else if (audience === "path" && body.path_id) {
    audienceRead = await assignedRecipientsStrict(svc, org.id, { table: "learning_path_assignments", column: "path_id", id: body.path_id }, counting, countCalls(budget));
  } else {
    audienceRead = new Set(counting);
  }
  if (audienceRead === "unreadable") {
    return NextResponse.json({ error: AUDIENCE_UNREADABLE }, { status: 503 });
  }
  const recipientIds = audienceRead;
  // Tenant guard and rule 10: restrict recipients to members of THIS org
  // whose membership counts, however the audience was specified.
  // user_ids/team_id/course_id/path_id come from the request and are resolved
  // via the service-role client (bypasses RLS), so without this an admin
  // could email/notify another tenant's users, and a direct, team or group
  // audience would reach a member who is inactive or suspended.
  for (const id of Array.from(recipientIds)) {
    if (!counting.has(id)) recipientIds.delete(id);
  }
  if (recipientIds.size === 0) {
    return NextResponse.json(
      { error: "No recipients in this organization" },
      { status: 400 }
    );
  }

  // ---- Resolve action buttons (course/path/profile/custom) → URLs -----
  // Derived from request headers per fix #145 so URLs work on staging,
  // prod, and any future custom domain without rebuilding.
  const h = await headers();
  const reqProto = h.get("x-forwarded-proto") ?? "https";
  const reqHost = h.get("host") ?? h.get("x-forwarded-host") ?? "";
  const originBase = reqHost ? `${reqProto}://${reqHost}` : "";

  const resolvedButtons: Array<{ label: string; url: string }> = [];
  const rawButtons = Array.isArray(body.buttons) ? body.buttons : [];
  if (rawButtons.length > MAX_BUTTONS) {
    return NextResponse.json(
      { error: `At most ${MAX_BUTTONS} buttons allowed per broadcast.` },
      { status: 400 }
    );
  }
  for (const btn of rawButtons) {
    const label = (btn?.label ?? "").trim();
    if (!label) continue; // silently skip blank rows
    if (label.length > 80) {
      return NextResponse.json(
        {
          error: `Button label too long (max 80 chars): "${label.slice(0, 40)}..."`,
        },
        { status: 400 }
      );
    }
    let url: string | null = null;
    if (btn.type === "course" && btn.course_id) {
      // Verify the course belongs to this org before exposing the link.
      const { data: ok } = await svc
        .from("courses")
        .select("id")
        .eq("id", btn.course_id)
        .eq("organization_id", org.id)
        .maybeSingle();
      if (!ok) {
        return NextResponse.json(
          { error: "Course button references a course not in this org." },
          { status: 400 }
        );
      }
      url = `${originBase}/${org.slug}/courses/${btn.course_id}`;
    } else if (btn.type === "path" && btn.path_id) {
      const { data: ok } = await svc
        .from("learning_paths")
        .select("id")
        .eq("id", btn.path_id)
        .eq("organization_id", org.id)
        .maybeSingle();
      if (!ok) {
        return NextResponse.json(
          { error: "Path button references a path not in this org." },
          { status: 400 }
        );
      }
      url = `${originBase}/${org.slug}/paths/${btn.path_id}`;
    } else if (btn.type === "profile") {
      url = `${originBase}/${org.slug}/profile`;
    } else if (btn.type === "custom" && btn.url) {
      const raw = btn.url.trim();
      // Only accept http(s) — block javascript:/data:/mailto: etc.
      if (!/^https?:\/\//i.test(raw)) {
        return NextResponse.json(
          { error: "Custom button URL must start with http:// or https://" },
          { status: 400 }
        );
      }
      try {
        new URL(raw);
        url = raw;
      } catch {
        return NextResponse.json(
          { error: `Custom button URL is not a valid URL: "${raw}"` },
          { status: 400 }
        );
      }
    }
    if (url) resolvedButtons.push({ label, url });
  }

  // ---- Addresses (indexed via profiles), strict: a failed read is never
  //      "no address" -----------------------------------------------------
  spendCalls(budget, Math.ceil(recipientIds.size / 150));
  const emailById = await resolveEmailsStrict(svc, recipientIds);
  if (emailById === "unreadable") {
    return NextResponse.json({ error: AUDIENCE_UNREADABLE }, { status: 503 });
  }

  // ---- One run: the run's shape and the request's budgets (rule T4) -----
  // Hoist the (already-validated at line ~45) subject/body into consts — TS
  // drops object-property narrowing inside the callback below.
  const subject = body.subject!;
  const bodyMd = body.body_md!;
  const people = [...recipientIds].flatMap((uid) => {
    const address = emailById.get(uid);
    return address ? [{ uid, email: address }] : [];
  });
  const run = await openRun({ organizationId: org.id, budget, db: svc });
  const results = await sendMany(run, people, (p) => ({
    event: "custom_broadcast",
    to: { user_id: p.uid, email: p.email },
    context: {
      learner_name: p.email,
      learner_email: p.email,
      org_name: org.name,
    },
    override: {
      subject,
      body_md: bodyMd,
      buttons: resolvedButtons.length > 0 ? resolvedButtons : undefined,
    },
  }));
  const email = mailCounts(results, recipientIds.size - people.length);
  const sent = email.emailed;
  const failed = recipientIds.size - sent;

  return NextResponse.json({
    sent,
    failed,
    total: recipientIds.size,
    email,
  });
}
