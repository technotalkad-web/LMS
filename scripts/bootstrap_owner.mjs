// One-time bootstrap: create the platform-owner auth user + add to platform_owners.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const EMAIL = "agrawaladarsh910@gmail.com";

// Generate a strong password.
const alphabet =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
const bytes = randomBytes(20);
let password = "";
for (const b of bytes) password += alphabet[b % alphabet.length];

// 1) Find or create the auth user.
const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
let user = list?.users?.find((u) => u.email?.toLowerCase() === EMAIL);
let created = false;
if (!user) {
  const { data: c, error } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password,
    email_confirm: true,
  });
  if (error) { console.error("createUser:", error); process.exit(1); }
  user = c.user;
  created = true;
} else {
  // Account already exists — set the password instead.
  const { error } = await supabase.auth.admin.updateUserById(user.id, { password });
  if (error) { console.error("updatePassword:", error); process.exit(1); }
}

// 2) Insert into platform_owners (idempotent).
const { error: poErr } = await supabase
  .from("platform_owners")
  .upsert({ user_id: user.id, note: "bootstrapped via setup script" });
if (poErr) { console.error("platform_owners:", poErr); process.exit(1); }

console.log("\n========================================");
console.log("Platform owner is ready.");
console.log("Email:    ", EMAIL);
console.log("Password: ", password);
console.log(created ? "(account created)" : "(account existed; password reset)");
console.log("========================================\n");
console.log("Sign in at /login, then visit /super/organizations.\n");
