import { NextResponse } from "next/server";
import { loadOrgGovernance } from "@/lib/org/field-options";
import { checkScopeTarget, ensureScopeGroup } from "@/lib/org/scope-groups";
import { describeScopes, loadScopesFor, scopeLabel, scopesCover, type ScopePair } from "@/lib/content/scopes";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { countingMemberIds } from "@/lib/auth/org-membership";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";
import { originFromRequest } from "@/lib/http/origin";
import { resolveManyGroups } from "@/lib/org/groups";
import { convertSelfEnrolments } from "@/lib/assignments/direct";

/**
 *   POST /api/learning-path-assignments
 *   body: { orgSlug, pathId, assignToOrg?, userIds?, teamIds?, groupIds?, dueAt? }
 *
 * Admin-only: requireOrgAdminApi checks the caller's role before any write
 * and before the service-role notification pass. The path and every named
 * user, team and group must belong to the org (ids from elsewhere are
 * refused or dropped, as in POST /api/assignments). A failed check read
 * answers 503 and writes nothing, so no named assignee is dropped silently.
 *
 * After successful inserts, expands each row to the affected learners and
 * fires path_assignment notifications in the background. A learner's own
 * self-enrolment (source 'self', ADR 0024 step 24) becomes an assignment.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    pathId?: string;
    assignToOrg?: boolean;
    userIds?: string[];
    teamIds?: string[];
    groupIds?: string[];
    /** 0096: assign to a Vertical / Department — each pair becomes a system group assignment. */
    scopes?: Array<{ vertical?: string; department?: string | null }>;
    dueAt?: string | null;
  };
  if (!body.orgSlug || !body.pathId) {
    return NextResponse.json(
      { error: "orgSlug and pathId required" },
      { status: 400 }
    );
  }
  const auth = await requireOrgAdminApi(body.orgSlug);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, org, userId } = auth;

  // Tenant guard: the path and the named assignees must belong to this org.
  // The notification pass below reads and emails with the service role, so
  // an id from another org must never reach the rows.
  const checkFailed = () =>
    NextResponse.json(
      { error: "Could not check the path and its assignees. Nothing was assigned; try again." },
      { status: 503 }
    );
  const { data: path, error: pathErr } = await supabase
    .from("learning_paths")
    .select("id")
    .eq("id", body.pathId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (pathErr) return checkFailed();
  if (!path) {
    return NextResponse.json({ error: "Learning path not found" }, { status: 404 });
  }
  const reqUserIds = (body.userIds ?? []).filter(Boolean);
  const reqTeamIds = (body.teamIds ?? []).filter(Boolean);
  let validUserIds: string[] = [];
  let validTeamIds: string[] = [];
  if (reqUserIds.length) {
    const { data: m, error: mErr } = await supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id)
      .in("user_id", reqUserIds);
    if (mErr) return checkFailed();
    validUserIds = ((m ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  }
  if (reqTeamIds.length) {
    const { data: t, error: tErr } = await supabase
      .from("teams")
      .select("id")
      .eq("organization_id", org.id)
      .in("id", reqTeamIds);
    if (tErr) return checkFailed();
    validTeamIds = ((t ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  const dueAt =
    body.dueAt && body.dueAt.trim() ? new Date(body.dueAt).toISOString() : null;

  // Custom Group assignees (0069): only groups belonging to THIS org count.
  const requestedGroupIds = (body.groupIds ?? []).filter(Boolean);
  let validGroupIds: string[] = [];
  if (requestedGroupIds.length > 0) {
    const { data: groupRows, error: gErr } = await supabase
      .from("org_groups")
      .select("id")
      .eq("organization_id", org.id)
      .in("id", requestedGroupIds);
    if (gErr) return checkFailed();
    validGroupIds = ((groupRows ?? []) as Array<{ id: string }>).map((g) => g.id);
    if (validGroupIds.length !== requestedGroupIds.length) {
      return NextResponse.json(
        { error: "One or more groups not found in this organization" },
        { status: 400 }
      );
    }
  }


  // ---- Assign to a Vertical / Department (0096, decision 18): each pair maps
  // to a system-managed dynamic group. Decision 20: warn, never block, when
  // the content's mapping does not cover the target.
  const warnings: string[] = [];
  const reqScopes = Array.isArray(body.scopes) ? body.scopes : [];
  if (reqScopes.length > 20) return NextResponse.json({ error: "At most 20 vertical / department targets per call" }, { status: 400 });
  const scopeTargets: ScopePair[] = [];
  if (reqScopes.length) {
    const gov = await loadOrgGovernance(supabase, org.id);
    for (const raw of reqScopes) {
      const t = checkScopeTarget(gov, raw);
      if (!t.ok) return NextResponse.json({ error: t.error }, { status: 400 });
      scopeTargets.push(t.pair);
    }
    for (const pair of scopeTargets) {
      const g = await ensureScopeGroup(supabase, org.id, pair, userId);
      if ("error" in g) {
        const msg = /system_key|does not exist|schema cache/.test(g.error) ? "Assigning to a vertical / department needs migration 0096" : g.error;
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      if (!validGroupIds.includes(g.id)) validGroupIds.push(g.id);
    }
  }
  {
    const mapping = await loadScopesFor(supabase, org.id, "path", body.pathId);
    if (mapping.common || mapping.pairs.length) {
      for (const pair of scopeTargets) {
        if (!scopesCover(mapping, pair)) warnings.push(`${scopeLabel(pair)} is outside this learning path's mapping (${describeScopes(mapping)}).`);
      }
      const namedIds = validUserIds;
      if (namedIds.length) {
        const { data: mm } = await supabase
          .from("organization_members")
          .select("user_id, business_vertical, department")
          .eq("organization_id", org.id)
          .in("user_id", namedIds);
        const outside = ((mm ?? []) as Array<{ user_id: string; business_vertical: string | null; department: string | null }>)
          .filter((m) => !m.business_vertical || !scopesCover(mapping, { vertical: m.business_vertical, department: m.department }));
        if (outside.length) warnings.push(`${outside.length} of ${namedIds.length} named ${outside.length === 1 ? "person is" : "people are"} outside this learning path's mapping (${describeScopes(mapping)}).`);
      }
    }
  }

  type Row = {
    path_id: string;
    organization_id: string;
    assignee_type: "user" | "org" | "team" | "group";
    user_id: string | null;
    team_id: string | null;
    // Optional so pre-0069 databases never see the column on non-group rows.
    group_id?: string | null;
    due_at: string | null;
    assigned_by: string;
  };
  const rows: Row[] = [];

  if (body.assignToOrg) {
    rows.push({
      path_id: body.pathId,
      organization_id: org.id,
      assignee_type: "org",
      user_id: null,
      team_id: null,
      due_at: dueAt,
      assigned_by: userId,
    });
  }
  for (const uid of validUserIds) {
    rows.push({
      path_id: body.pathId,
      organization_id: org.id,
      assignee_type: "user",
      user_id: uid,
      team_id: null,
      due_at: dueAt,
      assigned_by: userId,
    });
  }
  for (const tid of validTeamIds) {
    rows.push({
      path_id: body.pathId,
      organization_id: org.id,
      assignee_type: "team",
      user_id: null,
      team_id: tid,
      due_at: dueAt,
      assigned_by: userId,
    });
  }
  for (const gid of validGroupIds) {
    rows.push({
      path_id: body.pathId,
      organization_id: org.id,
      assignee_type: "group",
      user_id: null,
      team_id: null,
      group_id: gid,
      due_at: dueAt,
      assigned_by: userId,
    });
  }
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No assignees specified" },
      { status: 400 }
    );
  }

  const inserted: unknown[] = [];
  /** Learners whose direct row was already there: each may be their own self-enrolment (converted below). */
  const alreadyUserIds: string[] = [];
  for (const row of rows) {
    const { data, error } = await supabase
      .from("learning_path_assignments")
      .insert(row)
      .select("id, assignee_type, user_id, team_id, due_at, assigned_at")
      .maybeSingle();
    if (data) inserted.push(data);
    else if (error && error.code !== "23505") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    } else if (error && row.assignee_type === "user" && row.user_id) {
      alreadyUserIds.push(row.user_id);
    }
  }

  // ADR 0024 step 24 (P2-6 item 2): a learner who only pressed Start on an
  // "Everyone" path holds a self row; this assignment converts it (source
  // 'admin', assigned_by this admin, the due date given here). Any other
  // existing row stays as it is (the 23505 is a no-op, as before), and
  // without 0107's column so does every row. The notification block below is
  // unchanged: it runs when a row was inserted and reaches every named row.
  const conversion = await convertSelfEnrolments(
    supabase, "learning_path_assignments",
    { orgId: org.id, column: "path_id", id: body.pathId, userIds: alreadyUserIds },
    { assignedBy: userId, ...(dueAt ? { dueAt } : {}) }
  );
  if (conversion.error) {
    return NextResponse.json({ error: conversion.error.message ?? "Could not convert a self-enrolment" }, { status: 400 });
  }

  // Fire path_assignment notifications in the background.
  if (inserted.length > 0) {
    await (async () => {
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const { data: pathRow } = await svc
          .from("learning_paths")
          .select("name")
          .eq("id", body.pathId)
          .maybeSingle();
        const pathName =
          (pathRow as { name?: string } | null)?.name ?? "a learning path";

        // ADR 0030 rule 10: the organisation mails only members that count
        // (active, in an organisation that is not deleted). One read of them
        // for this request: it is the org-wide audience and the filter on
        // every other one. Unreadable: no mail.
        const counting = await countingMemberIds(svc, org.id);
        if (counting === "unreadable") {
          console.warn(JSON.stringify({ event: "mail_recipients_unreadable", site: "learning-path-assignments", org_id: org.id }));
          return;
        }
        const recipientIds = new Set<string>();
        for (const row of rows) {
          if (row.assignee_type === "user" && row.user_id) {
            recipientIds.add(row.user_id);
          } else if (row.assignee_type === "team" && row.team_id) {
            const { data: tm } = await svc
              .from("team_members")
              .select("user_id")
              .eq("team_id", row.team_id);
            for (const m of tm ?? []) recipientIds.add(m.user_id as string);
          } else if (row.assignee_type === "group" && row.group_id) {
            for (const uid of await resolveManyGroups(svc, org.id, [row.group_id])) {
              recipientIds.add(uid);
            }
          } else if (row.assignee_type === "org") {
            for (const uid of counting) recipientIds.add(uid);
          }
        }
        // A person named directly, in a team or in a static group may hold a
        // row that does not count: they get no mail.
        for (const uid of recipientIds) if (!counting.has(uid)) recipientIds.delete(uid);

        const emailById = await resolveEmails(svc, recipientIds);

        const portalBase = await originFromRequest();
        const directLink = portalBase
          ? `${portalBase}/${org.slug}/dashboard`
          : `/${org.slug}/dashboard`;

        for (const uid of recipientIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          await notifyBackground({
            organizationId: org.id,
            event: "path_assignment",
            to: { user_id: uid, email },
            context: {
              learner_name: email,
              learner_email: email,
              path_name: pathName,
              path_id: body.pathId,
              org_name: org.name,
              direct_link: directLink,
              due_date: dueAt
                ? `Due ${new Date(dueAt).toISOString().slice(0, 10)}.`
                : "",
            },
          });
        }
      } catch (e) {
        console.warn("[path-assignment] notify failed:", e);
      }
    })();
  }

  return NextResponse.json({ assigned: inserted.length, assignments: inserted, warnings });
}
