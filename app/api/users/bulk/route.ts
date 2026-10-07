import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";
import { originFromRequest } from "@/lib/http/origin";
import { checkQuota } from "@/lib/billing/enforce-quota";
import {
  GOVERNED_FIELDS,
  loadOrgGovernance,
  checkGovernedField,
  checkDepartmentInVertical,
} from "@/lib/org/field-options";
import {
  fetchHierarchyMembers,
  messagesOf,
  upsertSnapshot,
  validateManagerAssignment,
  type ManagerAssignment,
} from "@/lib/org/reporting-line";

/**
 *   POST /api/users/bulk
 *   body: { orgSlug: string, csv: string }
 *
 * The CSV header row (case-insensitive) must include these columns; order
 * is flexible:
 *   first_name, last_name, unique_id, gender, status, dob, doj, email,
 *   username, password, phone, grade, designation, role, line_manager_id,
 *   indirect_manager_id, lms_role, node_id, city, state,
 *   team_name (optional — auto-creates the team in this org if missing,
 *              or adds to an existing team if name matches case-insensitively),
 *   business_vertical, branch, l3_manager_id, department
 *
 * Manager cells (L1/L2/L3, migration 0091) take an email or user id. The
 * reporting-line integrity rules apply per row (self-reference, a manager
 * who is not an active member, a cycle → row skipped; a chain mismatch →
 * noted in the row message). Rows are processed managers-first: a manager
 * referenced by email that is itself a row of this file is written before
 * the rows that point at them, whatever the file order. A manager column
 * that is ABSENT from the file leaves that level untouched (like
 * business_vertical/branch); a present-but-empty cell clears it.
 *
 * For every row:
 *   - If email already exists in auth.users -> existing user_id reused.
 *   - Else if password provided -> createUser (immediate password).
 *   - Else -> inviteUserByEmail (system emails a magic link).
 *   - profile + membership are upserted.
 *
 * Returns { summary, results[] }.
 */

type Row = Partial<Record<string, string>>;
type ResultRow = {
  row: number;
  email: string;
  status: "created" | "updated" | "invited" | "skipped" | "error";
  message?: string;
  // #162: if the row had a team_name and we successfully added them
  // to that team, the team name is surfaced here so admins see
  // "added to Marketing" in the result UI.
  team_added?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_LMS_ROLES = ["user", "data_analyst", "admin", "super_owner"] as const;
const VALID_STATUSES = ["active", "inactive", "suspended"] as const;
const VALID_GENDERS = ["male", "female", "other", "prefer_not_to_say"] as const;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    csv?: string;
  };
  const orgSlug = body.orgSlug?.trim();
  const csv = body.csv ?? "";
  if (!orgSlug || !csv) {
    return NextResponse.json(
      { error: "orgSlug and csv required" },
      { status: 400 }
    );
  }

  // ---- Caller auth + admin check ----
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, slug, allowed_email_domains")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: callerMem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", caller.id)
    .maybeSingle();
  const cr = callerMem?.role as string | undefined;
  const canWrite = cr === "super_owner" || cr === "owner" || cr === "admin";
  if (!canWrite) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const isSuperOwner = cr === "super_owner" || cr === "owner";

  const allowedDomains = ((org.allowed_email_domains ?? []) as string[])
    .map((d) => d.toLowerCase().trim())
    .filter(Boolean);
  const enforceDomain = allowedDomains.length > 0;

  // ---- Parse CSV ----
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "CSV had no data rows" },
      { status: 400 }
    );
  }

  // ---- Service client + pre-fetch existing auth users (for email lookup) ----
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: listed } = await svc.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const userIdByEmail = new Map<string, string>();
  for (const u of listed?.users ?? []) {
    if (u.email) userIdByEmail.set(u.email.toLowerCase(), u.id);
  }

  // ---- Master-data governance (migration 0055), one load for all rows ----
  const gov = await loadOrgGovernance(svc, org.id as string);

  // Reporting-line snapshot (migration 0091) for per-row integrity checks;
  // each written row updates it in place. Rows are processed managers-first
  // (see managerFirstOrder) so a manager that is itself a row of this file
  // is already a member — or has already failed, in which case the rows
  // pointing at them are refused like any other non-member reference.
  const hierarchy = await fetchHierarchyMembers(svc, org.id as string);
  const order = managerFirstOrder(rows);

  // line_manager_id / indirect_manager_id / l3_manager_id cells accept a
  // user UUID or an email (resolved against auth users) — emails are what HR
  // exports carry, and the mandatory-manager rule makes raw UUIDs
  // impractical in CSVs.
  const resolveManager = (
    raw: string | undefined
  ): { id: string | null; error?: string } => {
    const v = (raw ?? "").trim();
    if (!v) return { id: null };
    if (v.includes("@")) {
      const id = userIdByEmail.get(v.toLowerCase());
      return id
        ? { id }
        : { id: null, error: `manager "${v}" not found` };
    }
    return { id: v };
  };

  // ---- Quota + suspension gate (parity with POST /api/users) ----
  // The single-user create path calls checkQuota; this loop previously did
  // not, letting an admin bypass the plan's seat cap and add users to a
  // suspended/cancelled tenant. Count distinct NEW emails (rows that will
  // consume a seat) and gate the whole upload on them.
  const prospectiveNewEmails = new Set<string>();
  for (const r of rows) {
    const e = (r.email ?? "").trim().toLowerCase();
    if (e && !userIdByEmail.has(e)) prospectiveNewEmails.add(e);
  }
  if (prospectiveNewEmails.size > 0) {
    const quota = await checkQuota(org.id as string, "users", prospectiveNewEmails.size);
    if (!quota.ok) {
      return NextResponse.json(
        { error: quota.message, reason: quota.reason },
        { status: 402 }
      );
    }
  }

  // ---- #162: Pre-fetch / batch-create teams referenced in the CSV ----
  // Collect unique team names (case-insensitive). One DB read for existing
  // teams + at most one INSERT for any missing ones, keeping the per-row
  // loop on a fixed team_id lookup.
  const teamIdByLowerName = new Map<string, string>();
  const teamsCreated: string[] = [];
  const requestedTeamNames = new Set<string>();
  for (const r of rows) {
    const n = r.team_name?.trim();
    if (n) requestedTeamNames.add(n);
  }
  if (requestedTeamNames.size > 0) {
    const { data: existingTeams } = await supabase
      .from("teams")
      .select("id, name")
      .eq("organization_id", org.id);
    for (const t of (existingTeams ?? []) as Array<{
      id: string;
      name: string;
    }>) {
      teamIdByLowerName.set(t.name.trim().toLowerCase(), t.id);
    }
    // Determine which team names aren't already present.
    const seenLower = new Set<string>();
    const toCreate: Array<{ organization_id: string; name: string }> = [];
    for (const name of requestedTeamNames) {
      const k = name.toLowerCase();
      if (seenLower.has(k)) continue;
      seenLower.add(k);
      if (!teamIdByLowerName.has(k)) {
        toCreate.push({ organization_id: org.id, name });
      }
    }
    if (toCreate.length > 0) {
      const { data: created, error: teamErr } = await svc
        .from("teams")
        .insert(toCreate)
        .select("id, name");
      if (teamErr) {
        return NextResponse.json(
          {
            error: `Failed to create one or more teams: ${teamErr.message}`,
          },
          { status: 500 }
        );
      }
      for (const t of (created ?? []) as Array<{
        id: string;
        name: string;
      }>) {
        teamIdByLowerName.set(t.name.trim().toLowerCase(), t.id);
        teamsCreated.push(t.name);
      }
    }
  }
  // Track pending team memberships to upsert in a single batch after
  // the per-row loop. (Each upsert is cheap but batching keeps the
  // loop tight and limits round-trips at scale.)
  const pendingTeamMemberships: Array<{ team_id: string; user_id: string }> =
    [];

  const results: ResultRow[] = [];

  for (const i of order) {
    const r = rows[i];
    const rowNum = i + 1;
    const email = (r.email ?? "").trim().toLowerCase();

    // ---- Per-row validation ----
    const missing: string[] = [];
    if (!r.first_name?.trim()) missing.push("first_name");
    if (!email) missing.push("email");
    if (!r.unique_id?.trim()) missing.push("unique_id");
    if (!r.lms_role?.trim()) missing.push("lms_role");
    if (!r.node_id?.trim()) missing.push("node_id");
    if (missing.length > 0) {
      results.push({
        row: rowNum,
        email,
        status: "skipped",
        message: `missing: ${missing.join(", ")}`,
      });
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      results.push({ row: rowNum, email, status: "skipped", message: "bad email" });
      continue;
    }
    if (enforceDomain) {
      const domain = email.split("@")[1] ?? "";
      if (!allowedDomains.includes(domain)) {
        results.push({
          row: rowNum,
          email,
          status: "skipped",
          message: `domain "${domain}" not in allowlist`,
        });
        continue;
      }
    }
    const lmsRoleRaw = r.lms_role!.trim().toLowerCase().replace(/\s+/g, "_");
    if (!VALID_LMS_ROLES.includes(lmsRoleRaw as (typeof VALID_LMS_ROLES)[number])) {
      results.push({
        row: rowNum,
        email,
        status: "skipped",
        message: `bad lms_role "${r.lms_role}"`,
      });
      continue;
    }
    const lmsRole = lmsRoleRaw as (typeof VALID_LMS_ROLES)[number];
    if (lmsRole === "super_owner" && !isSuperOwner) {
      results.push({
        row: rowNum,
        email,
        status: "skipped",
        message: "only super owners can grant super_owner",
      });
      continue;
    }

    const statusRaw = (r.status?.trim().toLowerCase() ?? "active") as
      | "active"
      | "inactive"
      | "suspended";
    const status = VALID_STATUSES.includes(statusRaw) ? statusRaw : "active";

    const genderRaw = (r.gender?.trim().toLowerCase() ?? "") as
      | typeof VALID_GENDERS[number]
      | "";
    const gender =
      genderRaw && VALID_GENDERS.includes(genderRaw as typeof VALID_GENDERS[number])
        ? genderRaw
        : null;

    const password = (r.password ?? "").trim();
    const wantsInvite = password.length === 0;
    if (!wantsInvite && password.length < 8) {
      results.push({
        row: rowNum,
        email,
        status: "skipped",
        message: "password < 8 chars",
      });
      continue;
    }

    // ---- Master-data governance: only Super-Owner-defined values pass ----
    // CSV column "role" is the job_role/title field.
    const csvKeyByField = {
      designation: r.designation,
      node_id: r.node_id,
      job_role: r.role,
      city: r.city,
      state: r.state,
      business_vertical: r.business_vertical,
      branch: r.branch,
      department: r.department,
    } as const;
    const governedRow: Record<string, string | null> = {};
    let governanceError: string | null = null;
    for (const field of GOVERNED_FIELDS) {
      const check = checkGovernedField(gov, field, csvKeyByField[field]);
      if (!check.ok) {
        governanceError = check.error;
        break;
      }
      governedRow[field] = check.canonical;
    }
    if (governanceError) {
      results.push({
        row: rowNum,
        email,
        status: "skipped",
        message: governanceError,
      });
      continue;
    }

    // Managers: accept UUID or email; mandatory when the org requires them.
    // A column that is absent from the file (undefined) leaves that level
    // untouched — re-running last quarter's export must not wipe the L3s
    // set since, nor be refused for a mandatory level that is already set.
    const lm = resolveManager(r.line_manager_id);
    const ilm = resolveManager(r.indirect_manager_id);
    const l3m = resolveManager(r.l3_manager_id);
    if (lm.error || ilm.error || l3m.error) {
      results.push({
        row: rowNum,
        email,
        status: "skipped",
        message: lm.error ?? ilm.error ?? l3m.error,
      });
      continue;
    }
    const existingId = userIdByEmail.get(email) ?? null;
    const existingMem = existingId ? hierarchy.find((m) => m.user_id === existingId) : undefined;
    const managerNext: ManagerAssignment = {};
    if (r.line_manager_id !== undefined) managerNext.line_manager_id = lm.id;
    if (r.indirect_manager_id !== undefined) managerNext.indirect_manager_id = ilm.id;
    if (r.l3_manager_id !== undefined) managerNext.l3_manager_id = l3m.id;
    const effective = {
      line_manager_id: managerNext.line_manager_id !== undefined ? managerNext.line_manager_id : existingMem?.line_manager_id ?? null,
      indirect_manager_id: managerNext.indirect_manager_id !== undefined ? managerNext.indirect_manager_id : existingMem?.indirect_manager_id ?? null,
      l3_manager_id: managerNext.l3_manager_id !== undefined ? managerNext.l3_manager_id : existingMem?.l3_manager_id ?? null,
    };
    if (gov.requireManagers && (!effective.line_manager_id || !effective.indirect_manager_id || !effective.l3_manager_id)) {
      results.push({
        row: rowNum,
        email,
        status: "skipped",
        message: !effective.line_manager_id
          ? "Line Manager (L1) is required."
          : !effective.indirect_manager_id
            ? "Indirect Line Manager (L2) is required."
            : "L3 Manager is required.",
      });
      continue;
    }
    // Reporting-line integrity (0091). A brand-new account cannot be in
    // anyone's chain, so an existing id (or null) is enough for the cycle
    // check, and nothing has been written for this row yet.
    const managerCheck = validateManagerAssignment(hierarchy, existingId, managerNext);
    if (managerCheck.errors.length > 0) {
      results.push({
        row: rowNum,
        email,
        status: "skipped",
        message: messagesOf(managerCheck.errors).join(" "),
      });
      continue;
    }
    const managerNote = messagesOf(managerCheck.warnings).join(" ") || undefined;

    // ---- Find or create auth user ----
    let authUserId = userIdByEmail.get(email) ?? null;
    let createdThisRow: "created" | "invited" | null = null;
    let inviteTokenHash: string | null = null;
    if (!authUserId) {
      try {
        if (wantsInvite) {
          // Mint the invite link WITHOUT Supabase auto-sending; we email the
          // branded activation link via the tenant pipeline below.
          const { data: inv, error: invErr } =
            await svc.auth.admin.generateLink({ type: "invite", email });
          if (invErr || !inv?.user) {
            results.push({
              row: rowNum,
              email,
              status: "error",
              message: invErr?.message ?? "invite failed",
            });
            continue;
          }
          authUserId = inv.user.id;
          inviteTokenHash =
            (inv.properties as { hashed_token?: string }).hashed_token ?? null;
          createdThisRow = "invited";
        } else {
          const { data: created, error: createErr } =
            await svc.auth.admin.createUser({
              email,
              password,
              email_confirm: true,
            });
          if (createErr || !created?.user) {
            results.push({
              row: rowNum,
              email,
              status: "error",
              message: createErr?.message ?? "create failed",
            });
            continue;
          }
          authUserId = created.user.id;
          createdThisRow = "created";
        }
        userIdByEmail.set(email, authUserId);
      } catch (e) {
        results.push({
          row: rowNum,
          email,
          status: "error",
          message: e instanceof Error ? e.message : "unknown auth error",
        });
        continue;
      }
    }

    // ---- Upsert profile ----
    const username = (r.username?.trim() || email).toLowerCase();
    // NOTE: profiles PK is `id`, not `user_id` (Supabase starter schema).
    const profilePayload = {
      id: authUserId,
      email, // NOT NULL in profiles — must be set on insert
      first_name: r.first_name!.trim(),
      last_name: r.last_name?.trim() || null,
      username,
      gender,
      date_of_birth: r.dob?.trim() || null,
      phone: r.phone?.trim() || null,
    };
    const { error: profErr } = await svc
      .from("profiles")
      .upsert(profilePayload, { onConflict: "id" });
    if (profErr) {
      results.push({
        row: rowNum,
        email,
        status: "error",
        message: `profile: ${profErr.message}`,
      });
      continue;
    }

    // ---- Insert or update membership ----
    const pmQ = (cols: string) => svc.from("organization_members").select(cols).eq("organization_id", org.id).eq("user_id", authUserId).maybeSingle();
    let pmRes = await pmQ("user_id, business_vertical, department");
    if (pmRes.error && /department/.test(pmRes.error.message)) pmRes = await pmQ("user_id, business_vertical"); // pre-0096
    const priorMem = pmRes.data as { user_id: string; business_vertical?: string | null; department?: string | null } | null;
    let clearDepartment = false;
    {
      // 0096: the department must sit under the row's vertical (or the stored one when the file has no vertical column);
      // a vertical change that orphans the stored department clears it.
      const vertical = governedRow.business_vertical ?? priorMem?.business_vertical ?? null;
      const department = governedRow.department ?? priorMem?.department ?? null;
      if (department) {
        const dv = checkDepartmentInVertical(gov, department, vertical);
        if (!dv.ok) {
          if (governedRow.department) { results.push({ row: rowNum, email, status: "skipped", message: dv.error }); continue; }
          clearDepartment = true;
        } else if (governedRow.department) governedRow.department = dv.canonical;
      }
    }

    const memPayload: Record<string, unknown> = {
      organization_id: org.id,
      user_id: authUserId,
      role: lmsRole,
      employee_id: r.unique_id!.trim(),
      status,
      date_of_joining: r.doj?.trim() || null,
      grade: r.grade?.trim() || null,
      designation: governedRow.designation,
      job_role: governedRow.job_role,
      ...managerNext, // only the manager columns present in the file
      node_id: governedRow.node_id ?? r.node_id!.trim(),
      city: governedRow.city,
      state: governedRow.state,
      business_vertical: governedRow.business_vertical,
      branch: governedRow.branch,
      // 0096 deploy safety: only sent when set (and never cleared by bulk, like vertical / branch —
      // except when a vertical change orphans the stored department).
      ...(governedRow.department ? { department: governedRow.department } : clearDepartment ? { department: null } : {}),
    };
    // OPTIONAL governed fields are never CLEARED by bulk upload: a CSV
    // without these columns (or with empty cells) must preserve values
    // assigned via the UI — otherwise re-running last quarter's HR export
    // would silently wipe every member's vertical/branch. Clearing is an
    // explicit act done on the edit form.
    if (governedRow.business_vertical === null) delete memPayload.business_vertical;
    if (governedRow.branch === null) delete memPayload.branch;

    const memOp = priorMem
      ? svc
          .from("organization_members")
          .update(memPayload)
          .eq("organization_id", org.id)
          .eq("user_id", authUserId)
      : svc.from("organization_members").insert(memPayload);

    const { error: memErr } = await memOp;
    if (memErr) {
      results.push({
        row: rowNum,
        email,
        status: "error",
        message: `membership: ${memErr.message}`,
      });
      continue;
    }

    upsertSnapshot(hierarchy, { user_id: authUserId, status, ...effective });

    let outcome: ResultRow["status"];
    if (createdThisRow === "invited") outcome = "invited";
    else if (createdThisRow === "created") outcome = "created";
    else outcome = priorMem ? "updated" : "created";

    // ---- #162: queue team membership if team_name was provided ----
    let teamAdded: string | undefined;
    const teamNameRaw = r.team_name?.trim();
    if (teamNameRaw) {
      const teamId = teamIdByLowerName.get(teamNameRaw.toLowerCase());
      if (teamId) {
        pendingTeamMemberships.push({
          team_id: teamId,
          user_id: authUserId,
        });
        teamAdded = teamNameRaw;
      }
    }

    // Fire welcome email for new accounts (skip when we just updated metadata).
    if (!priorMem) {
      const origin = await originFromRequest();
      const learnerName =
        r.first_name!.trim() + (r.last_name ? " " + r.last_name.trim() : "");
      if (inviteTokenHash) {
        const base = (origin || "").replace(/\/$/, "");
        const link =
          `${base}/auth/callback?token_hash=${encodeURIComponent(inviteTokenHash)}` +
          `&type=invite&next=${encodeURIComponent(`/${orgSlug}/dashboard`)}`;
        await notifyBackground({
          organizationId: org.id,
          event: "account_invite",
          to: { user_id: authUserId, email },
          context: {
            learner_name: learnerName,
            learner_email: email,
            direct_link: link,
            portal_url: link,
            org_name: (org as { name: string }).name,
          },
        });
      } else {
        await notifyBackground({
          organizationId: org.id,
          event: "account_creation",
          to: { user_id: authUserId, email },
          context: {
            learner_name: learnerName,
            learner_email: email,
            username,
            login_id: email,
            password,
            org_name: (org as { name: string }).name,
            portal_url: origin
              ? `${origin}/${orgSlug}/dashboard`
              : "your learning portal",
          },
        });
      }
    }

    results.push({
      row: rowNum,
      email,
      status: outcome,
      ...(managerNote ? { message: managerNote } : {}),
      ...(teamAdded ? { team_added: teamAdded } : {}),
    });
  }
  // Rows were processed managers-first; report them in file order.
  results.sort((a, b) => a.row - b.row);

  // ---- #162: flush queued team memberships in one batch ----
  let teamMembershipsAdded = 0;
  if (pendingTeamMemberships.length > 0) {
    // ignoreDuplicates so re-uploading a CSV that already added users
    // to a team is a no-op, not an error. The composite PK on
    // team_members (team_id, user_id) handles dedup.
    const { error: tmErr, count } = await svc
      .from("team_members")
      .upsert(pendingTeamMemberships, {
        onConflict: "team_id,user_id",
        ignoreDuplicates: true,
        count: "exact",
      });
    if (tmErr) {
      // Don't fail the whole upload — the user-creation half succeeded,
      // and admins can re-run for the team part. Flag in result rows
      // so they know.
      for (const r of results) {
        if (r.team_added) {
          r.message = `${r.message ? r.message + " · " : ""}team add failed: ${tmErr.message}`;
          delete r.team_added;
        }
      }
    } else {
      teamMembershipsAdded = count ?? pendingTeamMemberships.length;
    }
  }

  const summary = {
    total: rows.length,
    created: results.filter((r) => r.status === "created").length,
    invited: results.filter((r) => r.status === "invited").length,
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errored: results.filter((r) => r.status === "error").length,
    teams_created: teamsCreated.length,
    teams_created_names: teamsCreated,
    team_memberships_added: teamMembershipsAdded,
  };
  return NextResponse.json({ summary, results });
}

const KNOWN_COLS = [
  "first_name",
  "last_name",
  "unique_id",
  "gender",
  "status",
  "dob",
  "doj",
  "email",
  "username",
  "password",
  "phone",
  "grade",
  "designation",
  "role",
  "line_manager_id",
  "indirect_manager_id",
  "lms_role",
  "node_id",
  "city",
  "state",
  // #162: optional team assignment. If the named team exists in this
  // org, the user is added to it; otherwise the team is created
  // (idempotent — same team_name across multiple rows reuses the row
  // we just created).
  "team_name",
  // ORDER MATTERS for header-less CSVs (positional mapping): new columns
  // must APPEND so a legacy 21-column file keeps its old meaning — inserting
  // before team_name would silently parse team names as verticals.
  "business_vertical",
  "branch",
  // Explicit reporting line, level 3 (migration 0091).
  "l3_manager_id",
  // Department under the business vertical (migration 0096). Appended last.
  "department",
] as const;

/**
 * Processing order with managers before their reports (migration 0091): a
 * manager referenced by EMAIL that is itself a row of this file is visited
 * first (depth-first over the three manager cells), so by the time a report's
 * row is validated the manager's row has been written — or has failed, and
 * the reference is refused as a non-member like any other. Rows that
 * reference each other in a loop keep file order; the integrity check
 * decides. Returns row indexes.
 */
function managerFirstOrder(rows: Row[]): number[] {
  const idxByEmail = new Map<string, number>();
  rows.forEach((r, i) => {
    const e = (r.email ?? "").trim().toLowerCase();
    if (e && !idxByEmail.has(e)) idxByEmail.set(e, i);
  });
  const deps = (i: number): number[] => {
    const out: number[] = [];
    for (const k of ["line_manager_id", "indirect_manager_id", "l3_manager_id"] as const) {
      const v = (rows[i][k] ?? "").trim().toLowerCase();
      const j = v.includes("@") ? idxByEmail.get(v) : undefined;
      if (j !== undefined && j !== i) out.push(j);
    }
    return out;
  };
  const state: Array<0 | 1 | 2> = new Array(rows.length).fill(0);
  const order: number[] = [];
  for (let start = 0; start < rows.length; start++) {
    if (state[start] !== 0) continue;
    const stack: Array<{ i: number; deps: number[]; next: number }> = [{ i: start, deps: deps(start), next: 0 }];
    state[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.next < top.deps.length) {
        const d = top.deps[top.next++];
        if (state[d] === 0) {
          state[d] = 1;
          stack.push({ i: d, deps: deps(d), next: 0 });
        }
        continue;
      }
      state[top.i] = 2;
      order.push(top.i);
      stack.pop();
    }
  }
  return order;
}

function parseCsv(csv: string): Row[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  // Header detection: if first row contains "email" treat as headers.
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes("email");
  const headers = hasHeader
    ? splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())
    : (KNOWN_COLS as readonly string[]).slice();
  const data = hasHeader ? lines.slice(1) : lines;
  return data.map((line) => {
    const cells = splitCsvLine(line);
    const row: Row = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i];
      // A column the line does not reach stays undefined ("not provided"),
      // which is how a legacy, shorter header-less file keeps its trailing
      // columns (branch, l3_manager_id, …) untouched instead of cleared.
      if ((KNOWN_COLS as readonly string[]).includes(key) && cells[i] !== undefined) {
        row[key] = cells[i].trim();
      }
    }
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
