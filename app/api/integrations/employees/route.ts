import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { authenticateApiKey, resolveMember } from "@/lib/integrations/auth";
import {
  GOVERNED_FIELDS,
  loadOrgGovernance,
  checkGovernedField,
  type GovernedField,
} from "@/lib/org/field-options";
import { checkQuota } from "@/lib/billing/enforce-quota";

/**
 * Employee sync — the "CRM is master of employee records" half of the
 * integration (0071). API-key auth; the CRM backend pushes joiners,
 * transfers, and leavers so nobody uploads CSVs by hand.
 *
 *   GET    /api/integrations/employees?employee_id=…   read one record
 *   PUT    /api/integrations/employees                 upsert by employee_id
 *   DELETE /api/integrations/employees                 { employee_id } → deactivate
 *
 * Rules the CRM can rely on:
 *   - employee_id is the identity key; upserting an existing id UPDATES and
 *     re-activates (rehire = same call as hire). DELETE = leaver
 *     (deactivated, history preserved — never hard-deleted).
 *   - Integration-created accounts are always LEARNERS ('user'); role can
 *     never be set or escalated here, and existing ADMIN accounts are
 *     refused entirely (403) — a CRM compromise cannot touch admins.
 *   - Master-data governance applies exactly as in the admin UI: governed
 *     fields (designation, city, …) must use master values → 400 with the
 *     same message admins see.
 *   - Managers are referenced by THEIR employee_id (line_manager_employee_id
 *     / indirect_manager_employee_id); an unresolvable manager is reported
 *     in `warnings` and skipped, never fails the sync.
 *   - Email is identity: it is required at create and cannot be changed via
 *     sync (reported in warnings) — change it in the LMS admin if ever
 *     needed.
 *   - New accounts get no password and must_change_password=false: employees
 *     enter through the CRM's sso-link and never see a password screen.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_GENDERS = ["male", "female", "other", "prefer_not_to_say"];

type UpsertBody = {
  employee_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string | null;
  phone?: string | null;
  gender?: string | null;
  date_of_joining?: string | null;
  grade?: string | null;
  designation?: string | null;
  job_role?: string | null;
  node_id?: string | null;
  city?: string | null;
  state?: string | null;
  business_vertical?: string | null;
  branch?: string | null;
  line_manager_employee_id?: string | null;
  indirect_manager_employee_id?: string | null;
};

export async function GET(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  const employeeId = new URL(request.url).searchParams.get("employee_id")?.trim();
  if (!employeeId) return NextResponse.json({ error: "employee_id required" }, { status: 400 });

  const { data } = await auth.svc
    .from("organization_members")
    .select(
      "user_id, role, status, employee_id, designation, job_role, city, state, business_vertical, branch, grade, node_id, date_of_joining, line_manager_id, indirect_manager_id"
    )
    .eq("organization_id", auth.orgId)
    .eq("employee_id", employeeId)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
  const m = data as Record<string, unknown>;
  const { data: prof } = await auth.svc
    .from("profiles")
    .select("email, first_name, last_name")
    .eq("id", m.user_id as string)
    .maybeSingle();
  return NextResponse.json({
    employee_id: m.employee_id,
    status: m.status,
    is_admin: ["super_owner", "owner", "admin"].includes(m.role as string),
    email: (prof as { email?: string } | null)?.email ?? null,
    first_name: (prof as { first_name?: string } | null)?.first_name ?? null,
    last_name: (prof as { last_name?: string } | null)?.last_name ?? null,
    designation: m.designation,
    job_role: m.job_role,
    city: m.city,
    state: m.state,
    business_vertical: m.business_vertical,
    branch: m.branch,
    grade: m.grade,
    node_id: m.node_id,
    date_of_joining: m.date_of_joining,
  });
}

export async function PUT(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as UpsertBody;
  const employeeId = body.employee_id?.trim();
  if (!employeeId) return NextResponse.json({ error: "employee_id required" }, { status: 400 });
  const { svc, orgId } = auth;
  const warnings: string[] = [];

  // Existing member with this employee_id? (any status — rehires included)
  const { data: existingRow } = await svc
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", orgId)
    .eq("employee_id", employeeId)
    .maybeSingle();
  const existing = existingRow as { user_id: string; role: string } | null;
  if (existing && ["super_owner", "owner", "admin"].includes(existing.role)) {
    return NextResponse.json(
      { error: "Admin accounts are not managed via the integration" },
      { status: 403 }
    );
  }

  // ---- Governance: validate exactly the fields this sync provides.
  // On CREATE all governed fields are checked (mandatory rules included);
  // on UPDATE only the provided ones are validated and written.
  const gov = await loadOrgGovernance(svc, orgId);
  const governed: Partial<Record<GovernedField, string | null>> = {};
  for (const field of GOVERNED_FIELDS) {
    const provided = Object.prototype.hasOwnProperty.call(body, field);
    if (!existing || provided) {
      const check = checkGovernedField(gov, field, body[field]);
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      governed[field] = check.canonical;
    }
  }

  // ---- Manager linkage by employee_id (warn + skip when unresolvable).
  const managerIds: { line_manager_id?: string | null; indirect_manager_id?: string | null } = {};
  for (const [key, col] of [
    ["line_manager_employee_id", "line_manager_id"],
    ["indirect_manager_employee_id", "indirect_manager_id"],
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const ref = body[key]?.trim();
    if (!ref) {
      managerIds[col] = null;
      continue;
    }
    const mgr = await resolveMember(svc, orgId, { employee_id: ref });
    if (mgr) managerIds[col] = mgr.userId;
    else warnings.push(`${key} "${ref}" has no active LMS account yet — left unchanged`);
  }
  if (!existing && gov.requireManagers && managerIds.line_manager_id === undefined) {
    return NextResponse.json(
      { error: "line_manager_employee_id is required by this organization" },
      { status: 400 }
    );
  }

  // ================= UPDATE =================
  if (existing) {
    const memUpdate: Record<string, unknown> = { status: "active", ...managerIds };
    if (body.grade !== undefined) memUpdate.grade = body.grade?.trim() || null;
    if (body.date_of_joining !== undefined)
      memUpdate.date_of_joining = body.date_of_joining?.trim() || null;
    for (const field of GOVERNED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        memUpdate[field] = governed[field] ?? null;
      }
    }
    const { error: memErr } = await svc
      .from("organization_members")
      .update(memUpdate)
      .eq("organization_id", orgId)
      .eq("user_id", existing.user_id);
    if (memErr) return NextResponse.json({ error: memErr.message }, { status: 400 });

    const profUpdate: Record<string, unknown> = {};
    if (body.first_name !== undefined) profUpdate.first_name = body.first_name?.trim() || null;
    if (body.last_name !== undefined) profUpdate.last_name = body.last_name?.trim() || null;
    if (body.phone !== undefined) profUpdate.phone = body.phone?.trim() || null;
    if (Object.keys(profUpdate).length > 0) {
      await svc.from("profiles").update(profUpdate).eq("id", existing.user_id);
    }
    if (body.email) {
      const { data: prof } = await svc
        .from("profiles")
        .select("email")
        .eq("id", existing.user_id)
        .maybeSingle();
      const current = (prof as { email?: string } | null)?.email?.toLowerCase();
      if (current && current !== body.email.trim().toLowerCase()) {
        warnings.push("email changes are not supported via sync — update it in the LMS admin");
      }
    }
    return NextResponse.json({
      ok: true,
      action: "updated",
      employee_id: employeeId,
      user_id: existing.user_id,
      warnings,
    });
  }

  // ================= CREATE =================
  const email = body.email?.trim().toLowerCase() ?? "";
  const firstName = body.first_name?.trim() ?? "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email is required to create an employee" }, { status: 400 });
  }
  if (!firstName) {
    return NextResponse.json({ error: "first_name is required to create an employee" }, { status: 400 });
  }

  const quota = await checkQuota(orgId, "users");
  if (!quota.ok) {
    return NextResponse.json({ error: quota.message, reason: quota.reason }, { status: 402 });
  }
  const { data: orgRow } = await svc
    .from("organizations")
    .select("allowed_email_domains")
    .eq("id", orgId)
    .maybeSingle();
  const allowed = (((orgRow as { allowed_email_domains?: string[] } | null)
    ?.allowed_email_domains ?? []) as string[])
    .map((d) => d.toLowerCase().trim())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(email.split("@")[1] ?? "")) {
    return NextResponse.json(
      { error: `Email domain is not allowed for this organization` },
      { status: 400 }
    );
  }

  // Find-or-create the auth account. No password handed out: CRM employees
  // enter through sso-link, so must_change_password stays false.
  const { data: userList } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  let authUserId =
    userList?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
  if (!authUserId) {
    const { data: created, error: createErr } = await svc.auth.admin.createUser({
      email,
      password: randomBytes(24).toString("base64url"),
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      return NextResponse.json(
        { error: createErr?.message ?? "Could not create the account" },
        { status: 400 }
      );
    }
    authUserId = created.user.id;
  }

  const { error: profErr } = await svc.from("profiles").upsert(
    {
      id: authUserId,
      email,
      first_name: firstName,
      last_name: body.last_name?.trim() || null,
      phone: body.phone?.trim() || null,
      gender: body.gender && VALID_GENDERS.includes(body.gender) ? body.gender : null,
      must_change_password: false,
    },
    { onConflict: "id" }
  );
  if (profErr) {
    return NextResponse.json({ error: `Profile write failed: ${profErr.message}` }, { status: 400 });
  }

  const { error: memErr } = await svc.from("organization_members").upsert(
    {
      organization_id: orgId,
      user_id: authUserId,
      role: "user",
      status: "active",
      employee_id: employeeId,
      grade: body.grade?.trim() || null,
      date_of_joining: body.date_of_joining?.trim() || null,
      designation: governed.designation ?? null,
      job_role: governed.job_role ?? null,
      node_id: governed.node_id ?? null,
      city: governed.city ?? null,
      state: governed.state ?? null,
      business_vertical: governed.business_vertical ?? null,
      branch: governed.branch ?? null,
      line_manager_id: managerIds.line_manager_id ?? null,
      indirect_manager_id: managerIds.indirect_manager_id ?? null,
    },
    { onConflict: "organization_id,user_id" }
  );
  if (memErr) {
    return NextResponse.json({ error: `Membership write failed: ${memErr.message}` }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    action: "created",
    employee_id: employeeId,
    user_id: authUserId,
    warnings,
  });
}

export async function DELETE(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { employee_id?: string };
  const employeeId = body.employee_id?.trim();
  if (!employeeId) return NextResponse.json({ error: "employee_id required" }, { status: 400 });

  const { data } = await auth.svc
    .from("organization_members")
    .select("user_id, role, status")
    .eq("organization_id", auth.orgId)
    .eq("employee_id", employeeId)
    .maybeSingle();
  const m = data as { user_id: string; role: string; status: string } | null;
  if (!m) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
  if (["super_owner", "owner", "admin"].includes(m.role)) {
    return NextResponse.json(
      { error: "Admin accounts are not managed via the integration" },
      { status: 403 }
    );
  }
  const { error } = await auth.svc
    .from("organization_members")
    .update({ status: "inactive" })
    .eq("organization_id", auth.orgId)
    .eq("user_id", m.user_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, action: "deactivated", employee_id: employeeId });
}
