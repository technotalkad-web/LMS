/**
 * Diagnostic: does an ADMIN's RLS-scoped read of organization_members return
 * the whole org, or only their own row? Creates a throwaway org + admin + 2
 * learners via service role, then signs in as the admin (anon key) and counts.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.test") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.test.local"), override: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = createClient(url, secret, { auth: { persistSession: false } });

const rand = Math.random().toString(16).slice(2, 8);
const adminEmail = `qa+diagadmin-${rand}@example.test`;
const pass = `Test!${rand}Aa1`;

const { data: org } = await svc.from("organizations").insert({ name: `Diag ${rand}`, slug: `qa-diag-${rand}` }).select("id, slug").single();

async function mkUser(role, label) {
  const { data } = await svc.auth.admin.createUser({ email: `qa+${label}-${rand}@example.test`, password: pass, email_confirm: true });
  await svc.from("profiles").upsert({ id: data.user.id, email: data.user.email, first_name: label, must_change_password: false }, { onConflict: "id" });
  await svc.from("organization_members").upsert({ organization_id: org.id, user_id: data.user.id, role, employee_id: `E-${label}-${rand}`, status: "active" }, { onConflict: "organization_id,user_id" });
  return data.user;
}

const admin = await svc.auth.admin.createUser({ email: adminEmail, password: pass, email_confirm: true });
await svc.from("profiles").upsert({ id: admin.data.user.id, email: adminEmail, first_name: "Admin", must_change_password: false }, { onConflict: "id" });
await svc.from("organization_members").upsert({ organization_id: org.id, user_id: admin.data.user.id, role: "admin", employee_id: `E-admin-${rand}`, status: "active" }, { onConflict: "organization_id,user_id" });
await mkUser("user", "learner1");
await mkUser("user", "learner2");

// Service-role count (ground truth).
const { count: svcCount } = await svc.from("organization_members").select("user_id", { count: "exact", head: true }).eq("organization_id", org.id);

// Admin RLS-scoped read.
const adminClient = createClient(url, anon, { auth: { persistSession: false } });
const { error: signErr } = await adminClient.auth.signInWithPassword({ email: adminEmail, password: pass });
if (signErr) { console.error("sign-in failed:", signErr.message); process.exit(1); }
const { data: adminRows, error: readErr } = await adminClient.from("organization_members").select("user_id, role").eq("organization_id", org.id);

// Also check is_org_admin RPC under the admin session.
const { data: isAdmin } = await adminClient.rpc("is_org_admin", { org_id: org.id });

console.log(JSON.stringify({
  org: org.slug,
  serviceRoleMemberCount: svcCount,
  adminRlsVisibleCount: adminRows?.length ?? null,
  adminRlsReadError: readErr?.message ?? null,
  isOrgAdminRpc: isAdmin,
}, null, 2));
