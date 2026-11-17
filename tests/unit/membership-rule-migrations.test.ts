/**
 * The SQL scan of ADR 0030 (build prerequisites point 2): a membership counts
 * only while it is active and its organisation is live, and no migration
 * other than the eleven legacy files may restate the four helpers or the
 * seven member policies without that rule.
 *
 *   - LEGACY_MEMBERSHIP_FILES, a frozen list by full file name, equals the
 *     never-paste line of docs/MIGRATIONS.md, of 0115's header and of
 *     ops/RUNBOOK.md ("After 0115, none of … is pasted again");
 *   - every other file in supabase/migrations/, whatever its number, read
 *     with comments dropped, fails when it
 *       (a) creates or replaces is_org_member, is_org_admin,
 *           is_org_super_owner or is_org_data_analyst with a body that lacks
 *           the test status = 'active' or the test deleted_at is null;
 *       (b) creates, alters or drops one of the seven policies by name,
 *           unless the file's last statement on it holds the rule: both
 *           tests for the two policies on organizations, a call to
 *           is_org_member for the other five (a drop alone fails);
 *       (c) creates or alters a policy, on any table, whose using or with
 *           check reads organization_members together with auth.uid() and
 *           neither holds both tests nor calls one of the four helpers.
 *           The rule in full: the reader's own membership row is tested,
 *           and where the row read belongs to an organisation, that row is
 *           the reader's membership of the same organisation. The scan tests
 *           the words only; which organisation an argument names is held by
 *           the later migration's review and its rehearsal;
 *       (d) drops policies by a loop over the catalogue (a `drop policy`
 *           inside `execute`);
 *       (e) drops or alters one of the four helpers;
 *       (f) creates a function (other than the four) or a view that reads
 *           organization_members together with auth.uid() and neither holds
 *           both tests nor calls one of the four helpers: the class of
 *           0115's before-check B4c, whose expected set holds only the
 *           helpers and 0053's two functions (allowed in 0053 only);
 *     names are matched quoted or not, with or without their schema, and
 *     each rule also reads the statements inside a DO block or a function
 *     body and inside the strings a statement runs with `execute`;
 *   - 0115 passes these rules and holds no `drop policy`, no `create policy`
 *     and no `drop function`;
 *   - the after-check block of 0115 and ops/0115-after-checks.sql are the
 *     same text between their two marker lines;
 *   - planted cases prove each rule fires.
 *
 * It is not keyed on file numbers: lower numbers than 0115 are still to be
 * written (0109, 0110, 0111, 0114), and the rule holds for them too.
 *
 * No database.
 *
 * Run:  npx tsx tests/unit/membership-rule-migrations.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const MIG_DIR = "supabase/migrations";
const RULE_FILE = "0115_membership_status_enforced.sql";
const AFTER_CHECKS = "ops/0115-after-checks.sql";

/** The files that restore an old helper body or an old member policy when pasted again (ADR 0030). */
const LEGACY_MEMBERSHIP_FILES = [
  "0001_initial.sql",
  "0002_courses.sql",
  "0006_profiles.sql",
  "0010_rbac_expansion_part2.sql",
  "0019_org_update_rls.sql",
  "0026_tenant_subscription_admin_read.sql",
  "0027_profiles_schema_reconciliation.sql",
  "0030_multi_language_packages.sql",
  "0031_reports_foundation.sql",
  "0055_org_field_options.sql",
  "0056_business_verticals.sql",
];

const HELPERS = ["is_org_member", "is_org_admin", "is_org_super_owner", "is_org_data_analyst"];

/** The seven policies that read organization_members themselves, and the form of the rule each must hold. */
const MEMBER_POLICIES: { table: string; name: string; rule: "both" | "helper" }[] = [
  { table: "organizations", name: "members can read their orgs", rule: "both" },
  { table: "organizations", name: "owners and admins can update orgs", rule: "both" },
  { table: "tenant_subscriptions", name: "tenant admins read own subscription", rule: "helper" },
  { table: "profiles", name: "users read profiles in shared orgs", rule: "helper" },
  { table: "course_packages", name: "org members read packages", rule: "helper" },
  { table: "course_packages", name: "org admins write packages", rule: "helper" },
  { table: "course_ratings", name: "org admins read all ratings", rule: "helper" },
];

const STATUS_TEST = /\bstatus\s*=\s*'active'/i;
const DELETED_TEST = /\bdeleted_at\s+is\s+null\b/i;
const HELPER_CALL = /\bis_org_member\s*\(/i;
const ANY_HELPER_CALL = /\bis_org_(?:member|admin|super_owner|data_analyst)\s*\(/i;
const holdsBoth = (t: string) => STATUS_TEST.test(t) && DELETED_TEST.test(t);

/**
 * Comments dropped in one left-to-right pass; string literals and quoted
 * identifiers kept as they are, so a `--` inside a string stays and a quote
 * inside a comment cannot shift what counts as code.
 */
const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (t) =>
    t.startsWith("/*") || t.startsWith("--") ? " " : t,
  );

/** Top-level statements, split at `;` outside quotes and dollar-quoted bodies. */
function statements(code: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const close = code.indexOf(ch, i + 1);
      i = close < 0 ? code.length : close + 1;
      continue;
    }
    if (ch === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(code.slice(i));
      if (m) {
        const close = code.indexOf(m[0], i + m[0].length);
        i = close < 0 ? code.length : close + m[0].length;
        continue;
      }
    }
    if (ch === ";") {
      out.push(code.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const last = code.slice(start).trim();
  if (last) out.push(last);
  return out.filter(Boolean);
}

/** A name as Postgres stores it: quotes removed, an unquoted name in lower case (a format() placeholder as written). */
const ident = (raw: string) =>
  raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.startsWith("%") ? raw : raw.toLowerCase();

/** An optional schema in front of a name, quoted or not (`public.`, `"public" . `). */
const SCHEMA = String.raw`(?:("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s*\.\s*)?`;
/** A name, quoted or not; `%I` and `%s` stand for a name filled in by format(). */
const NAME = String.raw`("(?:[^"]|"")+"|[A-Za-z_][\w$]*|%[IsL])`;
const HELPER_NAME = String.raw`"?(is_org_member|is_org_admin|is_org_super_owner|is_org_data_analyst)"?`;
const isPublic = (schema: string | undefined) => schema === undefined || ident(schema) === "public";

/**
 * Every piece of SQL a statement can run: the statement itself, then, read
 * the same way, the statements inside each dollar-quoted body (a DO block, a
 * function body) and, where the statement calls `execute`, the statements
 * inside each of its string literals. SQL assembled from pieces at run time
 * is not read here; 0115's after-check A4 lists such objects by class on the
 * database.
 */
function units(st: string, depth = 0): string[] {
  const out = [st];
  if (depth > 4) return out;
  const DOLLAR = /\$([A-Za-z_]\w*)?\$([\s\S]*?)\$\1\$/g;
  for (const m of st.matchAll(DOLLAR)) {
    for (const s of statements(m[2])) out.push(...units(s, depth + 1));
  }
  // the literals of this level only: those inside a body are read with it
  const outside = st.replace(DOLLAR, " ");
  if (/\bexecute\b/i.test(outside)) {
    for (const m of outside.matchAll(/'((?:[^']|'')*)'/g)) {
      for (const s of statements(m[1].replace(/''/g, "'"))) out.push(...units(s, depth + 1));
    }
  }
  return out;
}

/**
 * The two functions of 0053 that read the caller's own row with auth.uid()
 * and test the status inline (0115's header, B4c). They are allowed in 0053
 * only: a later file that restates either one calls a helper or holds both
 * tests (ADR 0030 section C point 4, "they take the helper when next
 * restated").
 */
const INLINE_READERS_ALLOWED = new Set(["0053_gamification.sql|get_my_gamification", "0053_gamification.sql|set_gamification_opt_out"]);

/** The rules of the header, applied to one migration's text. Answers one line per breach. */
function breaches(file: string, sql: string): string[] {
  const out = new Set<string>();
  const lastOn = new Map<string, { verb: string; text: string }>();
  const readsMembersAsCaller = (t: string) => /\borganization_members\b/i.test(t) && /\bauth\.uid\s*\(/i.test(t);
  for (const top of statements(stripComments(sql))) {
    // (d) policies dropped by a loop over the catalogue: a `drop policy` in a
    // string that the statement runs with execute
    if (/\bexecute\b/i.test(top) && (/'[^']*\bdrop\s+policy\b/i.test(top) || /\bexecute\s+(?:format\s*\(\s*)?\$([A-Za-z_]\w*)?\$(?:(?!\$\1\$)[\s\S])*?\bdrop\s+policy\b/i.test(top))) {
      out.add(`${file}: drops policies inside execute (a loop over the catalogue)`);
    }
    // A piece found inside a body starts with PL/pgSQL words (`begin`, `if …
    // then`), so each rule looks for its statement anywhere in the piece and
    // reads from there to the piece's end.
    for (const st of units(top)) {
      // (a) a helper restated without the rule (any schema spelling, also
      // inside a DO block or a string run by execute)
      const fn = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+${SCHEMA}${HELPER_NAME}\s*\(`, "i").exec(st);
      if (fn && isPublic(fn[1]) && !holdsBoth(st.slice(fn.index))) out.add(`${file}: ${fn[2]} restated without the rule`);
      // (e) a helper dropped, or altered (its security, search_path, owner or name)
      for (const m of st.matchAll(/\bdrop\s+(?:function|routine)\s+(?:if\s+exists\s+)?([^;]*)/gi)) {
        for (const h of m[1].matchAll(new RegExp(String.raw`(?:^|[\s,])${SCHEMA}${HELPER_NAME}\s*(?:\(|,|$|\s)`, "gi"))) {
          if (isPublic(h[1])) out.add(`${file}: ${h[2]} dropped`);
        }
      }
      for (const m of st.matchAll(new RegExp(String.raw`\balter\s+(?:function|routine)\s+${SCHEMA}${HELPER_NAME}\s*(?:\(|\s|$)`, "gi"))) {
        if (isPublic(m[1])) out.add(`${file}: ${m[2]} altered`);
      }
      // (f) any other function or view that reads organization_members with
      // auth.uid() neither holds both tests nor calls one of the four helpers
      const other = new RegExp(
        String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(function|(?:materialized\s+)?view)\s+(?:if\s+not\s+exists\s+)?${SCHEMA}${NAME}`,
        "i",
      ).exec(st);
      if (other && !(other[1].toLowerCase() === "function" && /^"?is_org_(?:member|admin|super_owner|data_analyst)"?$/i.test(other[3]))) {
        const name = ident(other[3]);
        const text = st.slice(other.index);
        if (readsMembersAsCaller(text) && !holdsBoth(text) && !ANY_HELPER_CALL.test(text) && !INLINE_READERS_ALLOWED.has(`${file}|${name}`)) {
          out.add(`${file}: ${other[1].toLowerCase().replace(/\s+/g, " ")} ${name} reads organization_members with auth.uid() without the rule`);
        }
      }
      // (b) and (c): a policy statement (a quoted or an unquoted name)
      const pol = new RegExp(String.raw`\b(create|alter|drop)\s+policy\s+(?:if\s+exists\s+)?${NAME}\s+on\s+${SCHEMA}${NAME}([\s\S]*)$`, "i").exec(st);
      if (!pol) continue;
      const verb = pol[1].toLowerCase();
      const name = ident(pol[2]);
      const table = ident(pol[4]);
      const rest = pol[5];
      const member = isPublic(pol[3]) ? MEMBER_POLICIES.find((p) => p.table === table && p.name === name) : undefined;
      if (member) lastOn.set(`${table}|${name}`, { verb, text: rest });
      if (verb !== "drop") {
        const exprAt = rest.search(/\b(?:using|with\s+check)\b/i);
        const expr = exprAt < 0 ? "" : rest.slice(exprAt);
        if (readsMembersAsCaller(expr) && !holdsBoth(expr) && !ANY_HELPER_CALL.test(expr)) {
          out.add(`${file}: policy "${name}" on ${table} reads organization_members with auth.uid() without the rule`);
        }
      }
    }
  }
  for (const p of MEMBER_POLICIES) {
    const last = lastOn.get(`${p.table}|${p.name}`);
    if (!last) continue;
    if (last.verb === "drop") {
      out.add(`${file}: policy "${p.name}" on ${p.table} dropped and not recreated with the rule`);
      continue;
    }
    const ok = p.rule === "both" ? holdsBoth(last.text) : HELPER_CALL.test(last.text);
    if (!ok) out.add(`${file}: policy "${p.name}" on ${p.table} restated without the rule`);
  }
  return [...out];
}

/** The numbers of a never-paste sentence: "After 0115, none of … is pasted again". */
const neverPaste = (text: string) => {
  const prose = text.replace(/^--[ \t]?/gm, "").replace(/\s*\n\s*/g, " ");
  const m = /After 0115, none of ([^.]*?) is pasted again/.exec(prose);
  return m ? [...m[1].matchAll(/\b(\d{4})\b/g)].map((x) => x[1]).sort() : null;
};

const files = fs.readdirSync(path.join(root, MIG_DIR)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const legacyNumbers = LEGACY_MEMBERSHIP_FILES.map((f) => f.slice(0, 4)).sort();

console.log("the frozen list of legacy files");
eq("eleven files", LEGACY_MEMBERSHIP_FILES.length, 11);
eq("every legacy file exists by its full name", LEGACY_MEMBERSHIP_FILES.filter((f) => !files.includes(f)), []);
eq("0115 exists", files.includes(RULE_FILE), true);
const header = (() => {
  const sql = read(`${MIG_DIR}/${RULE_FILE}`);
  const at = /^begin;[ \t]*$/m.exec(sql);
  return at ? sql.slice(0, at.index) : "";
})();
for (const [label, text] of [
  ["docs/MIGRATIONS.md", read("docs/MIGRATIONS.md")],
  ["0115's header", header],
  ["ops/RUNBOOK.md", read("ops/RUNBOOK.md")],
] as const) {
  eq(`the never-paste line of ${label} names exactly the legacy files`, neverPaste(text), legacyNumbers);
}

console.log("\nthe migrations of the repository");
const found: string[] = [];
for (const f of files) {
  if (LEGACY_MEMBERSHIP_FILES.includes(f)) continue;
  found.push(...breaches(f, read(`${MIG_DIR}/${f}`)));
}
eq("no file outside the legacy list breaks the rule", found, []);
eq(
  "every legacy file, read as any other file, breaks the rule (the frozen list is no wider than it must be)",
  LEGACY_MEMBERSHIP_FILES.filter((f) => breaches(f, read(`${MIG_DIR}/${f}`)).length === 0),
  [],
);

console.log("\n0115 itself");
const rule = read(`${MIG_DIR}/${RULE_FILE}`);
const ruleCode = stripComments(rule);
eq("0115 passes the rules", breaches(RULE_FILE, rule), []);
eq("0115 holds no drop policy, create policy or drop function", /\bdrop\s+policy\b|\bcreate\s+policy\b|\bdrop\s+function\b/i.test(ruleCode), false);
const ruleStmts = statements(ruleCode);
eq(
  "0115 restates the four helpers with both tests",
  HELPERS.map((h) => ruleStmts.some((s) => new RegExp(`^create\\s+or\\s+replace\\s+function\\s+public\\.${h}\\s*\\(`, "i").test(s) && holdsBoth(s))),
  [true, true, true, true],
);
eq(
  "0115 alters each of the seven policies",
  MEMBER_POLICIES.map((p) => ruleStmts.filter((s) => s.toLowerCase().startsWith(`alter policy "${p.name}"`)).length),
  [1, 1, 1, 1, 1, 1, 1],
);
eq(
  "0115 grants execute on the four helpers to anon, authenticated and service_role",
  HELPERS.map((h) => ruleStmts.some((s) => new RegExp(`^grant\\s+execute\\s+on\\s+function\\s+public\\.${h}\\(uuid\\)\\s+to\\s+anon,\\s*authenticated,\\s*service_role$`, "i").test(s))),
  [true, true, true, true],
);

console.log("\nthe after-checks run alone are the after-checks of 0115");
const block = (text: string) => {
  const b = text.indexOf("-- 0115 after-checks: begin\n");
  const e = text.indexOf("-- 0115 after-checks: end");
  return b < 0 || e < b ? null : text.slice(b, e);
};
const inFile = block(rule);
eq("0115 marks its after-check block", inFile !== null && inFile.length > 1000, true);
eq(`${AFTER_CHECKS} holds the same block, character for character`, block(read(AFTER_CHECKS)) === inFile, true);
eq(`${AFTER_CHECKS} ends in rollback and writes nothing`, /\nrollback;\s*$/.test(read(AFTER_CHECKS)) && !/\bcommit;/.test(stripComments(read(AFTER_CHECKS))), true);

console.log("\nplanted cases: each rule fires");
const stmtOf = (rel: string, re: RegExp) => {
  const st = statements(stripComments(read(rel))).find((s) => re.test(s));
  if (!st) throw new Error(`no statement matching ${re} in ${rel}`);
  return `${st};\n`;
};
const oldAdmin = stmtOf(`${MIG_DIR}/0056_business_verticals.sql`, /^create or replace function public\.is_org_admin\(/i);
const newAdmin = stmtOf(`${MIG_DIR}/${RULE_FILE}`, /^create or replace function public\.is_org_admin\(/i);
const oldPackagesRead =
  stmtOf(`${MIG_DIR}/0030_multi_language_packages.sql`, /^drop policy if exists "org members read packages"/i) +
  stmtOf(`${MIG_DIR}/0030_multi_language_packages.sql`, /^create policy "org members read packages"/i);
const loop0027 = stmtOf(`${MIG_DIR}/0027_profiles_schema_reconciliation.sql`, /^do \$\$[\s\S]*drop policy if exists/i);
eq("a file 0109 restating is_org_admin with 0056's body fails", breaches("0109_planted.sql", oldAdmin), ["0109_planted.sql: is_org_admin restated without the rule"]);
eq("a file 0116 restating is_org_admin with both tests passes", breaches("0116_planted.sql", newAdmin), []);
eq(
  "a file recreating \"org members read packages\" from 0030 fails",
  breaches("0116_planted.sql", oldPackagesRead),
  [
    '0116_planted.sql: policy "org members read packages" on course_packages reads organization_members with auth.uid() without the rule',
    '0116_planted.sql: policy "org members read packages" on course_packages restated without the rule',
  ],
);
eq(
  "a file that only drops one of the seven fails",
  breaches("0116_planted.sql", 'drop policy if exists "tenant admins read own subscription" on public.tenant_subscriptions;\n'),
  ['0116_planted.sql: policy "tenant admins read own subscription" on tenant_subscriptions dropped and not recreated with the rule'],
);
eq("a file with 0027's loop fails", breaches("0116_planted.sql", loop0027), ["0116_planted.sql: drops policies inside execute (a loop over the catalogue)"]);
eq("a file that drops a helper fails", breaches("0116_planted.sql", "drop function if exists public.is_org_member(uuid);\n"), ["0116_planted.sql: is_org_member dropped"]);
const inlinePolicy = (cond: string) =>
  `create policy "members read widgets" on public.widgets for select to authenticated\n` +
  `  using (exists (select 1 from public.organization_members m\n` +
  `    where m.organization_id = widgets.organization_id and m.user_id = auth.uid()${cond}));\n`;
eq(
  "a new policy that reads organization_members with auth.uid() inline fails",
  breaches("0117_planted.sql", inlinePolicy("")),
  ['0117_planted.sql: policy "members read widgets" on widgets reads organization_members with auth.uid() without the rule'],
);
eq("…and passes with both tests", breaches("0117_planted.sql", inlinePolicy(" and m.status = 'active' and o.deleted_at is null")), []);
eq("…and passes with a helper on the same organisation", breaches("0117_planted.sql", inlinePolicy(" and public.is_org_member(m.organization_id)")), []);
eq("a copy of 0107 passes", breaches("0107_copy.sql", read(`${MIG_DIR}/0107_learning_contexts.sql`)), []);
eq("a comment that names a helper's old body is not code", breaches("0116_planted.sql", "-- create or replace function public.is_org_member(org_id uuid)\nselect 1;\n"), []);

console.log("\nplanted cases: other spellings of the same statements");
eq(
  "a helper restated with a quoted schema and name, with 0056's body, fails",
  breaches("0116_planted.sql", oldAdmin.replace(/public\.is_org_admin\(/i, '"public" . "is_org_admin"(')),
  ["0116_planted.sql: is_org_admin restated without the rule"],
);
eq(
  "a helper restated by execute of a dollar-quoted string inside a DO block fails",
  breaches("0116_planted.sql", `do $do$\nbegin\n  execute $q$${oldAdmin.replace(/;\n$/, "")}$q$;\nend\n$do$;\n`),
  ["0116_planted.sql: is_org_admin restated without the rule"],
);
eq(
  "a helper restated by execute of a quoted string inside a DO block fails",
  breaches(
    "0116_planted.sql",
    "do $$\nbegin\n  execute 'create or replace function public.is_org_member(org_id uuid) returns boolean language sql stable security definer " +
      "as ''select exists (select 1 from public.organization_members m where m.organization_id = org_id and m.user_id = auth.uid())''';\nend\n$$;\n",
  ),
  ["0116_planted.sql: is_org_member restated without the rule"],
);
eq(
  "a helper restated directly inside a DO block fails",
  breaches("0116_planted.sql", `do $do$\nbegin\n  ${oldAdmin.replace(/;\n$/, "")};\nend\n$do$;\n`),
  ["0116_planted.sql: is_org_admin restated without the rule"],
);
eq(
  "a loop that drops policies through execute of a dollar-quoted string fails",
  breaches(
    "0116_planted.sql",
    "do $do$\ndeclare pol record;\nbegin\n  for pol in select policyname from pg_policies where tablename = $t$profiles$t$ loop\n" +
      "    execute format($f$drop policy if exists %I on public.profiles$f$, pol.policyname);\n  end loop;\nend\n$do$;\n",
  ),
  ["0116_planted.sql: drops policies inside execute (a loop over the catalogue)"],
);
eq("a helper altered to security invoker fails", breaches("0116_planted.sql", "alter function public.is_org_member(uuid) security invoker;\n"), [
  "0116_planted.sql: is_org_member altered",
]);
eq("a helper's search_path reset fails", breaches("0116_planted.sql", 'alter function "public"."is_org_admin"(uuid) reset search_path;\n'), [
  "0116_planted.sql: is_org_admin altered",
]);
eq(
  "a helper dropped second in a list of functions fails",
  breaches("0116_planted.sql", 'drop function if exists public.widget_count(uuid), "public".is_org_super_owner(uuid);\n'),
  ["0116_planted.sql: is_org_super_owner dropped"],
);
eq(
  "a policy with an unquoted name that reads organization_members with auth.uid() inline fails",
  breaches("0117_planted.sql", inlinePolicy("").replace('"members read widgets"', "members_read_widgets")),
  ['0117_planted.sql: policy "members_read_widgets" on widgets reads organization_members with auth.uid() without the rule'],
);
eq(
  "the same policy created inside a DO block fails",
  breaches("0117_planted.sql", `do $$\nbegin\n  if to_regclass('public.widgets') is not null then\n    ${inlinePolicy("").replace(/;\n$/, "")};\n  end if;\nend\n$$;\n`),
  ['0117_planted.sql: policy "members read widgets" on widgets reads organization_members with auth.uid() without the rule'],
);
eq(
  "the same policy created by execute format() fails",
  breaches(
    "0117_planted.sql",
    "do $$\nbegin\n  execute format('create policy %I on public.%I for select to authenticated using (exists (select 1 from public.organization_members m " +
      "where m.organization_id = widgets.organization_id and m.user_id = auth.uid()))', 'members read widgets', 'widgets');\nend\n$$;\n",
  ),
  ['0117_planted.sql: policy "%I" on %I reads organization_members with auth.uid() without the rule'],
);
eq(
  "the same policy created by execute format() passes with a helper",
  breaches(
    "0117_planted.sql",
    "do $$\nbegin\n  execute format('create policy %I on public.%I for select to authenticated using (public.is_org_member(widgets.organization_id))', " +
      "'members read widgets', 'widgets');\nend\n$$;\n",
  ),
  [],
);

console.log("\nplanted cases: functions and views (rule f, the class of 0115's B4c)");
const inlineFunction = (cond: string) =>
  `create or replace function public.widget_total(p_org uuid)\nreturns bigint\nlanguage sql\nstable\nsecurity definer\nset search_path = pg_catalog, public\nas $$\n` +
  `  select count(*) from public.widgets w\n  where w.organization_id = p_org\n    and exists (select 1 from public.organization_members m\n` +
  `                 where m.organization_id = p_org and m.user_id = auth.uid()${cond});\n$$;\n`;
eq("a new function that reads organization_members with auth.uid() inline fails", breaches("0118_planted.sql", inlineFunction("")), [
  "0118_planted.sql: function widget_total reads organization_members with auth.uid() without the rule",
]);
eq("…and passes with both tests", breaches("0118_planted.sql", inlineFunction(" and m.status = 'active' and o.deleted_at is null")), []);
eq("…and passes with a helper", breaches("0118_planted.sql", inlineFunction(" and public.is_org_member(p_org)")), []);
eq(
  "0053's two functions are allowed in 0053 only: restated in another file, both fail",
  breaches("0118_planted.sql", read(`${MIG_DIR}/0053_gamification.sql`)).sort(),
  [
    "0118_planted.sql: function get_my_gamification reads organization_members with auth.uid() without the rule",
    "0118_planted.sql: function set_gamification_opt_out reads organization_members with auth.uid() without the rule",
  ],
);
eq(
  "a view that reads organization_members with auth.uid() inline fails",
  breaches(
    "0118_planted.sql",
    "create or replace view public.v_my_widgets with (security_invoker = true) as\n  select w.* from public.widgets w\n" +
      "  join public.organization_members m on m.organization_id = w.organization_id and m.user_id = auth.uid();\n",
  ),
  ["0118_planted.sql: view v_my_widgets reads organization_members with auth.uid() without the rule"],
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
