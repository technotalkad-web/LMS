import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkQuota } from "@/lib/billing/enforce-quota";

/**
 *   POST /api/invitations/bulk
 *   body: { orgSlug, csv: "email,role,employee_id,display_name\n..." }
 *
 * Parses the CSV, validates each row against the org's allowed email
 * domains, creates one invitation per valid row. Returns per-row outcome
 * so the admin can see what landed.
 */
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

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, allowed_email_domains")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  // ---- Admin gate (parity with the single POST /api/invitations) ----
  // The `invitations` admin-only RLS policy already blocks non-admin inserts,
  // but check explicitly so a non-admin gets a clean 403 instead of a 200
  // with every row errored — and so the gate doesn't silently depend on RLS.
  const { data: callerMem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const cr = callerMem?.role as string | undefined;
  if (!(cr === "super_owner" || cr === "owner" || cr === "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ---- Quota + suspension gate (parity with the single-invite path) ----
  const quota = await checkQuota(org.id as string, "users", 1);
  if (!quota.ok) {
    return NextResponse.json(
      { error: quota.message, reason: quota.reason },
      { status: 402 }
    );
  }

  const allowedDomains = ((org.allowed_email_domains ?? []) as string[]).map(
    (d) => d.toLowerCase().trim()
  );
  const enforceDomain = allowedDomains.length > 0;

  const rows = parseCsv(csv);
  const results: Array<{
    row: number;
    email: string;
    status: "invited" | "skipped" | "error";
    message?: string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const email = (r.email ?? "").trim().toLowerCase();
    if (!email) {
      results.push({
        row: i + 1,
        email: r.email ?? "",
        status: "skipped",
        message: "empty email",
      });
      continue;
    }
    if (enforceDomain) {
      const domain = email.split("@")[1] ?? "";
      if (!allowedDomains.includes(domain)) {
        results.push({
          row: i + 1,
          email,
          status: "skipped",
          message: `domain "${domain}" not in allowlist`,
        });
        continue;
      }
    }
    const role =
      r.role === "admin"
        ? "admin"
        : r.role === "data_analyst"
          ? "data_analyst"
          : "user";

    const { error } = await supabase
      .from("invitations")
      .insert({
        organization_id: org.id,
        email,
        role,
        invited_by: user.id,
      });
    if (error) {
      results.push({
        row: i + 1,
        email,
        status: "error",
        message: error.message,
      });
      continue;
    }
    results.push({ row: i + 1, email, status: "invited" });
  }

  const summary = {
    total: rows.length,
    invited: results.filter((r) => r.status === "invited").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errored: results.filter((r) => r.status === "error").length,
  };

  return NextResponse.json({ summary, results });
}

interface CsvRow {
  email?: string;
  role?: string;
  employee_id?: string;
  display_name?: string;
}

function parseCsv(csv: string): CsvRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  // Header row: detect whether first row is a header (contains "email").
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes("email");
  const headers = hasHeader
    ? splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())
    : ["email", "role", "employee_id", "display_name"];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const cells = splitCsvLine(line);
    const row: CsvRow = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i] as keyof CsvRow;
      if (key === "email" || key === "role" || key === "employee_id" || key === "display_name") {
        row[key] = cells[i]?.trim();
      }
    }
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  // Simple CSV: split on comma, respect "quoted strings, with commas".
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
