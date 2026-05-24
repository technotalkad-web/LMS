import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";

/**
 *   POST /api/users/bulk
 *   body: { orgSlug: string, csv: string }
 *
 * The CSV header row (case-insensitive) must include these columns; order
 * is flexible:
 *   first_name, last_name, unique_id, gender, status, dob, doj, email,
 *   username, password, phone, grade, designation, role, line_manager_id,
 *   indirect_manager_id, lms_role, node_id, city, state
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

  const results: ResultRow[] = [];

  for (let i = 0; i < rows.length; i++) {
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

    // ---- Find or create auth user ----
    let authUserId = userIdByEmail.get(email) ?? null;
    let createdThisRow: "created" | "invited" | null = null;
    if (!authUserId) {
      try {
        if (wantsInvite) {
          const { data: inv, error: invErr } =
            await svc.auth.admin.inviteUserByEmail(email);
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
    const { data: priorMem } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id)
      .eq("user_id", authUserId)
      .maybeSingle();

    const memPayload = {
      organization_id: org.id,
      user_id: authUserId,
      role: lmsRole,
      employee_id: r.unique_id!.trim(),
      status,
      date_of_joining: r.doj?.trim() || null,
      grade: r.grade?.trim() || null,
      designation: r.designation?.trim() || null,
      job_role: r.role?.trim() || null,
      line_manager_id: r.line_manager_id?.trim() || null,
      indirect_manager_id: r.indirect_manager_id?.trim() || null,
      node_id: r.node_id!.trim(),
      city: r.city?.trim() || null,
      state: r.state?.trim() || null,
    };

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

    let outcome: ResultRow["status"];
    if (createdThisRow === "invited") outcome = "invited";
    else if (createdThisRow === "created") outcome = "created";
    else outcome = priorMem ? "updated" : "created";

    // Fire welcome email for new accounts (skip when we just updated metadata).
    if (!priorMem) {
      const origin =
        process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
      await notifyBackground({
        organizationId: org.id,
        event: "account_creation",
        to: { user_id: authUserId, email },
        context: {
          learner_name:
            r.first_name!.trim() +
            (r.last_name ? " " + r.last_name.trim() : ""),
          learner_email: email,
          username,
          login_id: email,
          password: wantsInvite ? "(set via the invite link)" : password,
          org_name: (org as { name: string }).name,
          portal_url: origin
            ? `${origin}/${orgSlug}/dashboard`
            : "your learning portal",
        },
      });
    }

    results.push({ row: rowNum, email, status: outcome });
  }

  const summary = {
    total: rows.length,
    created: results.filter((r) => r.status === "created").length,
    invited: results.filter((r) => r.status === "invited").length,
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errored: results.filter((r) => r.status === "error").length,
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
] as const;

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
      if ((KNOWN_COLS as readonly string[]).includes(key)) {
        row[key] = cells[i] ? cells[i].trim() : "";
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
