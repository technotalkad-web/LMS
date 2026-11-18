/**
 * Source scan of every read of organization_members (ADR 0030 section B,
 * test H.2): who belongs to an organisation is answered in one place,
 * lib/auth/org-membership.ts, and nowhere else.
 *
 * Every read under app/, lib/ and components/ is classified below, with its
 * reason, in one of these classes:
 *
 *   own-access  the reader's own row, read to decide access. Allowed only in
 *               lib/auth/: everywhere else the resolver (resolveOrgMembership,
 *               requireOrgAccess, requireOrgAdminApi, isOrgAdminCaller,
 *               listCountingMemberships) answers it;
 *   own-other   the reader's own row, read for something other than access
 *               (a frozen list of five; a sixth is a review decision);
 *   subject     other people's rows (a target, a roster, an audience);
 *   recipient   a subject read that chooses who gets the organisation's mail
 *               (rule 10). Each says whether it filters the status in the
 *               query, or is one of the sites step 6 of section I filters
 *               (marked "step-6": the scan lists them and does not yet ask
 *               for the filter; step 6 removes that mark).
 *
 * A read is a `.from("organization_members")` chain with no insert, update,
 * upsert or delete in it, or a fetchByIds / fetchAll call naming the table.
 * It is keyed on its file, the nearest named function and its order there
 * (`file#function#n`), not on a line number, so the edits of later steps do
 * not move it. A string naming the table anywhere else (a table name held in
 * a variable, an embed in a select list) fails until it is read here.
 *
 * Tripwires besides the list:
 *   - a read filtered on the caller's own id (`.eq("user_id", user.id)` and
 *     the like) must be own-access or own-other, unless its entry says why
 *     that id is not the caller (`notCaller`);
 *   - a recipient read marked "query" filters `status = 'active'` in the
 *     query;
 *   - the resolver's reads select `status` (the member reads) and
 *     `deleted_at` (the organisation reads).
 *
 * Planted cases at the end prove each part fires. TypeScript's parser, no
 * type checker, no database, no network.
 *
 * Run:  npx tsx tests/unit/org-role-resolution.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const TABLE = "organization_members";
const RESOLVER = "lib/auth/org-membership.ts";

/* ---------------- the classification ---------------- */

type Cls = "own-access" | "own-other" | "subject" | "recipient";
type Entry = { cls: Cls; reason: string; status?: "query" | "step-6"; notCaller?: string };

/** The reader's own row read for another purpose: exactly these five (H.2). */
const OWN_OTHER = [
  "app/api/scorm/[attemptId]/commit/route.ts#POST#1",
  "app/[org]/(learner)/leaderboard/_components/vertical-board.tsx#VerticalBoard#1",
  "app/[org]/(learner)/profile/page.tsx#memQ#1",
  "lib/manager/coverage.ts#memQ#1",
  "lib/org/groups.ts#meQ#1",
];

const READS: Record<string, Entry> = {
  // ---- the resolver (lib/auth/org-membership.ts) ----
  "lib/auth/org-membership.ts#memberRead#1": { cls: "own-access", reason: "resolveOrgMembership: the caller's own row (role, status)" },
  "lib/auth/org-membership.ts#listCountingMemberships#1": { cls: "own-access", reason: "listCountingMemberships: the caller's own rows in every org (role, status)" },
  "lib/auth/org-membership.ts#countingMemberIds#1": { cls: "recipient", status: "query", reason: "countingMemberIds: an org's active members, the rule 10 recipient filter" },

  // ---- own row, another purpose (OWN_OTHER) ----
  "app/api/scorm/[attemptId]/commit/route.ts#POST#1": { cls: "own-other", reason: "the learner's employee id for the CRM webhook, after the resolver let the commit in" },
  "app/[org]/(learner)/leaderboard/_components/vertical-board.tsx#VerticalBoard#1": { cls: "own-other", reason: "the viewer's own vertical, for the vertical board (page behind requireOrgAccess)" },
  "app/[org]/(learner)/profile/page.tsx#memQ#1": { cls: "own-other", reason: "the viewer's own profile fields (page behind requireOrgAccess)" },
  "lib/manager/coverage.ts#memQ#1": { cls: "own-other", reason: "the viewer's own vertical and department, for the manager's coverage" },
  "lib/org/groups.ts#meQ#1": { cls: "own-other", reason: "one person's row for dynamic group rules (the viewer on learner pages; a subject from the CRM summary and the LRS)" },

  // ---- recipients of the organisation's mail (rule 10) ----
  "app/api/assignments/route.ts#POST#3": { cls: "recipient", status: "step-6", reason: "org-wide audience of asset_assignment" },
  "app/api/assignments/[id]/route.ts#DELETE#1": { cls: "recipient", status: "step-6", reason: "org-wide audience of asset_unassignment" },
  "app/api/cron/journey-nudges/route.ts#run#1": { cls: "recipient", status: "step-6", reason: "L1 managers for journey_escalation" },
  "app/api/cron/reminders/route.ts#POST#1": { cls: "recipient", status: "step-6", reason: "org-wide audience of asset_reminder" },
  "app/api/learning-path-assignments/route.ts#POST#3": { cls: "recipient", status: "step-6", reason: "org-wide audience of path_assignment" },
  "app/api/learning-path-assignments/[id]/route.ts#DELETE#1": { cls: "recipient", status: "step-6", reason: "org-wide audience of path_unassignment" },
  "app/api/learning-paths/[id]/courses/route.ts#resolvePathLearners#1": { cls: "recipient", status: "step-6", reason: "org-wide audience of asset_update (resolvePathLearners)" },
  "app/api/notifications/broadcast/route.ts#resolveAssignedUserIds#1": { cls: "recipient", status: "step-6", reason: "org-wide branch of a course or path broadcast audience" },
  "app/api/notifications/broadcast/route.ts#POST#1": { cls: "recipient", status: "step-6", reason: "broadcast audience all" },
  "app/api/notifications/broadcast/route.ts#POST#2": { cls: "recipient", status: "step-6", reason: "broadcast tenant guard on the final recipient set" },
  "lib/attempts/requests.ts#notifyAdminsOfRequest#1": { cls: "recipient", status: "step-6", reason: "admin recipients of an attempt request" },
  "lib/courses/notify-update.ts#resolveAssignedUserIds#1": { cls: "recipient", status: "step-6", reason: "org-wide audience of asset_update" },
  "lib/tickets/notify.ts#notifyAdminsOfTicket#1": { cls: "recipient", status: "query", reason: "active admins mailed about a ticket, first 25" },

  // ---- subjects: other people's rows ----
  "app/(super-owner)/super/organizations/page.tsx#OrganizationsPage#1": { cls: "subject", reason: "platform console: member count per tenant" },
  "app/(super-owner)/super/organizations/[id]/page.tsx#TenantDetailPage#1": { cls: "subject", reason: "platform console: a tenant's member list" },
  "app/api/assignments/route.ts#POST#1": { cls: "subject", reason: "the named assignees are rows of the org" },
  "app/api/assignments/route.ts#POST#2": { cls: "subject", reason: "the named assignees' vertical and department" },
  "app/api/auth/forgot-password/request/route.ts#POST#1": { cls: "subject", reason: "the account's first row, to pick the sender of its reset code (ADR 0029 replaces it)", notCaller: "`user` is the account found by the address in the form; the request has no session" },
  "app/api/courses/[courseId]/learners/export/route.ts#GET#1": { cls: "subject", reason: "learners' employee ids for the CSV" },
  "app/api/gamification/avatar/remove/route.ts#POST#1": { cls: "subject", reason: "the target person is a row of the org" },
  "app/api/integrations/employees/route.ts#memQ#1": { cls: "subject", reason: "API key: an employee by employee id" },
  "app/api/integrations/employees/route.ts#GET#1": { cls: "subject", reason: "API key: the managers' employee ids" },
  "app/api/integrations/employees/route.ts#exQ#1": { cls: "subject", reason: "API key: an existing row by employee id, any status" },
  "app/api/integrations/employees/route.ts#DELETE#1": { cls: "subject", reason: "API key: the row the deactivation changes" },
  "app/api/journey/enrollments/route.ts#POST#1": { cls: "subject", reason: "the named users are rows of the org" },
  "app/api/journey/program/route.ts#memQ#1": { cls: "subject", reason: "journey audience candidates (active rows)" },
  "app/api/learning-path-assignments/route.ts#POST#1": { cls: "subject", reason: "the named assignees are rows of the org" },
  "app/api/learning-path-assignments/route.ts#POST#2": { cls: "subject", reason: "the named assignees' vertical and department" },
  "app/api/learning-paths/[id]/learners/export/route.ts#GET#1": { cls: "subject", reason: "learners' employee ids for the CSV" },
  "app/api/manager-coverage/route.ts#POST#1": { cls: "subject", reason: "the manager a pair is granted to must be active" },
  "app/api/org/groups/route.ts#POST#1": { cls: "subject", reason: "a static group's members" },
  "app/api/organization-members/[userId]/route.ts#authorize#1": { cls: "subject", reason: "the target member's role" },
  "app/api/organization-members/[userId]/route.ts#superOwnerCount#1": { cls: "subject", reason: "the count of super owners" },
  "app/api/super/tenants/[id]/admins/route.ts#GET#1": { cls: "subject", reason: "platform console: a tenant's administrators" },
  "app/api/teams/[id]/members/route.ts#POST#1": { cls: "subject", reason: "the named users are rows of the org" },
  "app/api/users/bulk/route.ts#pmQ#1": { cls: "subject", reason: "the uploaded person's prior row" },
  "app/api/users/route.ts#POST#1": { cls: "subject", reason: "the added person is already a member" },
  "app/api/users/search/route.ts#GET#1": { cls: "subject", reason: "people search" },
  "app/api/users/[userId]/route.ts#PATCH#1": { cls: "subject", reason: "the edited person's row" },
  "app/api/users/[userId]/route.ts#PATCH#2": { cls: "subject", reason: "the edited person's vertical and department" },
  "app/[org]/(admin)/groups/page.tsx#GroupsPage#1": { cls: "subject", reason: "group builder roster" },
  "app/[org]/(admin)/journey-admin/page.tsx#JourneyAdminPage#1": { cls: "subject", reason: "journey audience roster" },
  "app/[org]/(admin)/learning-paths/page.tsx#LearningPathsPage#1": { cls: "subject", reason: "path audience counts" },
  "app/[org]/(admin)/learning-paths/page.tsx#LearningPathsPage#2": { cls: "subject", reason: "path assignee pickers" },
  "app/[org]/(admin)/learning-paths/[pathId]/learners/page.tsx#PathLearnersPage#1": { cls: "subject", reason: "path learner table" },
  "app/[org]/(admin)/learning-paths/[pathId]/reports/page.tsx#PathReportsPage#1": { cls: "subject", reason: "path report" },
  "app/[org]/(admin)/library/[courseId]/learners/page.tsx#LearnersPage#1": { cls: "subject", reason: "course learners table" },
  "app/[org]/(admin)/library/[courseId]/page.tsx#AdminCourseDetailPage#1": { cls: "subject", reason: "course people" },
  "app/[org]/(admin)/notifications/page.tsx#NotificationsPage#1": { cls: "subject", reason: "broadcast audience size" },
  "app/[org]/(admin)/reports/page.tsx#ReportsPage#1": { cls: "subject", reason: "reports roster (service role, client named supabase)" },
  "app/[org]/(admin)/teams/page.tsx#TeamsPage#1": { cls: "subject", reason: "team pickers" },
  "app/[org]/(admin)/users/new/page.tsx#NewUserPage#1": { cls: "subject", reason: "manager pickers" },
  "app/[org]/(admin)/users/page.tsx#LearnersPage#1": { cls: "subject", reason: "the Users list, every status" },
  "app/[org]/(admin)/users/[userId]/edit/page.tsx#memQ#1": { cls: "subject", reason: "the edited person's row" },
  "app/[org]/(admin)/users/[userId]/edit/page.tsx#EditUserPage#1": { cls: "subject", reason: "manager pickers" },
  "app/[org]/(learner)/leaderboard/page.tsx#LeaderboardPage#1": { cls: "subject", reason: "leaderboard dimensions" },
  "app/[org]/(learner)/leaderboard/page.tsx#LeaderboardPage#2": { cls: "subject", reason: "leaderboard rows" },
  "app/[org]/(learner)/leaderboard/_components/vertical-board.tsx#fetchMembers#1": { cls: "subject", reason: "vertical board members" },
  "lib/integrations/auth.ts#resolveMember#1": { cls: "subject", reason: "API key: a member by employee id (active)" },
  "lib/integrations/auth.ts#resolveMember#2": { cls: "subject", reason: "API key: a member by user id (active)" },
  "lib/integrations/progress.ts#loadMembers#1": { cls: "subject", reason: "API key: the progress feed's members" },
  "lib/integrations/webhook.ts#fireCompletionWebhookForAttempt#1": { cls: "subject", reason: "the attempt owner's employee id" },
  "lib/lrs/context.ts#loadLearnerDims#1": { cls: "subject", reason: "learner dimensions for LRS statements" },
  "lib/manager/access.ts#isNamedManager#1": { cls: "subject", reason: "count of active members naming the viewer as a manager (the viewer's own row is the guard's)" },
  "lib/manager/cache.ts#refreshOrgCache#1": { cls: "subject", reason: "Report Card refresh (cron)" },
  "lib/manager/cache.ts#orgsNeedingCache#1": { cls: "subject", reason: "orgs needing the refresh (cron)" },
  "lib/manager/coverage.ts#q#1": { cls: "subject", reason: "manager list" },
  "lib/manager/insights.ts#computeLearnerInsights#1": { cls: "subject", reason: "learner dimensions (fetchByIds)" },
  "lib/manager/insights.ts#computeLearnerInsights#2": { cls: "subject", reason: "learner dimensions, pre-0096 columns (fetchByIds)" },
  "lib/org/groups.ts#q#1": { cls: "subject", reason: "dynamic group members (active rows)" },
  "lib/org/reporting-line.ts#q#1": { cls: "subject", reason: "the whole hierarchy, every status by design" },
  "lib/tickets/actions.ts#actOnTicket#1": { cls: "subject", reason: "the people a ticket names (active rows)" },
  "lib/users/people.ts#memberIdsInOrg#1": { cls: "subject", reason: "ids that are rows of the org (fetchByIds)" },
};

/* ---------------- the scan ---------------- */

type Site = {
  key: string;
  file: string;
  line: number;
  /** `.eq("user_id", X)`: the source text of X, when the chain has one. */
  userId: string | null;
  /** The chain filters status = 'active' in the query. */
  activeInQuery: boolean;
  /** The text of the select argument, when there is one. */
  select: string | null;
};
type Stray = { file: string; line: number; text: string };
type Scan = { reads: Site[]; writes: number; strays: Stray[] };

const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);
const HELPERS = new Set(["fetchByIds", "fetchAll"]);
const isStr = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

/** The nearest named function: a declaration, a method, or a function held in a variable. */
function fnName(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return "<module>";
}

function scanFile(file: string, text: string, out: Scan) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const seen = new Set<ts.Node>();
  const count = new Map<string, number>();
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      let read: { userId: string | null; activeInQuery: boolean; select: string | null } | null = null;
      let isWrite = false;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "from" && isStr(n.arguments[0]) && n.arguments[0].text === TABLE) {
        seen.add(n.arguments[0]);
        let userId: string | null = null;
        let active = false;
        let select: string | null = null;
        // Up the chain: .from(t).select(…).eq(…)…
        for (let top: ts.Node = n; ts.isPropertyAccessExpression(top.parent) && ts.isCallExpression(top.parent.parent); top = top.parent.parent) {
          const name = top.parent.name.text;
          const args = (top.parent.parent as ts.CallExpression).arguments;
          if (WRITE_METHODS.has(name)) isWrite = true;
          if (name === "select" && args[0]) select = args[0].getText(sf);
          if (name === "eq" && isStr(args[0]) && args[0].text === "user_id" && args[1]) userId = args[1].getText(sf);
          if (name === "eq" && isStr(args[0]) && args[0].text === "status" && isStr(args[1]) && args[1].text === "active") active = true;
        }
        if (!isWrite) read = { userId, activeInQuery: active, select };
      }
      if (ts.isIdentifier(callee) && HELPERS.has(callee.text) && isStr(n.arguments[1]) && n.arguments[1].text === TABLE) {
        seen.add(n.arguments[1]);
        const sel = callee.text === "fetchByIds" || callee.text === "fetchAll" ? n.arguments[2]?.getText(sf) ?? null : null;
        const apply = n.arguments.find((a) => ts.isArrowFunction(a))?.getText(sf) ?? "";
        read = { userId: null, activeInQuery: /\.eq\(\s*"status"\s*,\s*"active"\s*\)/.test(apply), select: sel };
      }
      if (read) {
        const fn = fnName(n);
        const k = (count.get(fn) ?? 0) + 1;
        count.set(fn, k);
        out.reads.push({ key: `${file}#${fn}#${k}`, file, line: lineOf(n), ...read });
      } else if (isWrite) out.writes++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // Any other string naming the table: a name held in a variable, or an embed in a select list.
  const strays = (n: ts.Node) => {
    if (isStr(n) && !seen.has(n) && (n.text === TABLE || new RegExp(`\\b${TABLE}\\s*[(!]`).test(n.text))) {
      out.strays.push({ file, line: lineOf(n), text: n.text.slice(0, 80) });
    }
    ts.forEachChild(n, strays);
  };
  strays(sf);
}

function scan(files: Array<{ file: string; text: string }>): Scan {
  const out: Scan = { reads: [], writes: 0, strays: [] };
  for (const f of files) if (f.text.includes(TABLE)) scanFile(f.file, f.text, out);
  return out;
}

/** The caller's own id, as the code names it. `userId` alone is not here: it names a target as often as the caller. */
const CALLER_ID = /^(user|caller|me|viewer|authUser|sessionUser|c\.user|ctx\.user|auth\.user)!?\.id$|^(callerId|viewerId|actorId|auth\.userId|c\.userId|ctx\.userId)$/;

function check(found: Scan, table: Record<string, Entry>, ownOther: string[]): string[] {
  const problems: string[] = [];
  const keys = new Set(found.reads.map((r) => r.key));
  for (const r of found.reads) {
    const e = table[r.key];
    if (!e) { problems.push(`unclassified read ${r.key} (:${r.line})`); continue; }
    if (!e.reason.trim()) problems.push(`${r.key}: no reason`);
    if (e.cls === "own-access" && !r.file.startsWith("lib/auth/")) problems.push(`${r.key}: an access test on the reader's own row outside lib/auth/ (use the resolver)`);
    if (e.cls === "own-other" && !ownOther.includes(r.key)) problems.push(`${r.key}: own row for another purpose, not on the frozen list`);
    if (r.userId && CALLER_ID.test(r.userId) && e.cls !== "own-access" && e.cls !== "own-other" && !e.notCaller) {
      problems.push(`${r.key}: filtered on the caller's own id (${r.userId}) but classified ${e.cls}`);
    }
    if (e.cls === "recipient" && e.status !== "query" && e.status !== "step-6") problems.push(`${r.key}: a recipient read must say query or step-6`);
    if (e.cls === "recipient" && e.status === "query" && !r.activeInQuery) problems.push(`${r.key}: a recipient read marked query does not filter status = 'active'`);
    if (e.cls !== "recipient" && e.status) problems.push(`${r.key}: status is for recipient reads only`);
  }
  for (const k of Object.keys(table)) if (!keys.has(k)) problems.push(`stale entry ${k}: no such read`);
  for (const k of ownOther) if (table[k]?.cls !== "own-other") problems.push(`${k}: on the frozen own-other list but classified ${table[k]?.cls ?? "nowhere"}`);
  for (const s of found.strays) problems.push(`the table named outside a read or write: ${s.file}:${s.line} "${s.text}"`);
  return problems;
}

/** The resolver's reads: the member reads select status, the organisation reads deleted_at. */
function checkResolver(file: string, text: string): string[] {
  const problems: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let memberReads = 0, orgReads = 0;
  const fnBody = (name: string) => {
    let body = "";
    const v = (n: ts.Node) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) body = n.body.getText(sf); ts.forEachChild(n, v); };
    v(sf);
    return body;
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from" && isStr(n.arguments[0])) {
      const t = n.arguments[0].text;
      let select: ts.Expression | null = null;
      for (let top: ts.Node = n; ts.isPropertyAccessExpression(top.parent) && ts.isCallExpression(top.parent.parent); top = top.parent.parent) {
        if (top.parent.name.text === "select") select = (top.parent.parent as ts.CallExpression).arguments[0] ?? null;
      }
      const sel = select ? (isStr(select) ? select.text : select.getText(sf)) : "";
      if (t === TABLE) {
        memberReads++;
        if (!/\bstatus\b/.test(sel)) problems.push(`${file}: a member read that does not select status (${sel || "no select"})`);
      }
      if (t === "organizations") {
        orgReads++;
        const viaHelper = select && ts.isCallExpression(select) && ts.isIdentifier(select.expression) && /deleted_at/.test(fnBody(select.expression.text));
        if (!/\bdeleted_at\b/.test(sel) && !viaHelper) problems.push(`${file}: an organisation read that does not select deleted_at (${sel || "no select"})`);
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && HELPERS.has(n.expression.text) && isStr(n.arguments[1]) && n.arguments[1].text === TABLE) {
      memberReads++;
      const sel = n.arguments[2] && isStr(n.arguments[2]) ? n.arguments[2].text : "";
      if (!/\bstatus\b/.test(sel)) problems.push(`${file}: a member read that does not select status (${sel || "no select"})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (memberReads === 0) problems.push(`${file}: no member read found`);
  if (orgReads === 0) problems.push(`${file}: no organisation read found`);
  return problems;
}

/* ---------------- the repository ---------------- */

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); }
      else if (/\.(ts|tsx)$/.test(e.name)) out.push({ file: rel, text: fs.readFileSync(path.join(root, rel), "utf8") });
    }
  };
  for (const d of ["app", "lib", "components"]) walk(d);
  return out;
}

console.log("\nEvery read of organization_members under app/, lib/ and components/");
{
  const files = sources();
  const found = scan(files);
  eq(`non-vacuous: at least 300 source files and 60 reads (found ${files.length} files, ${found.reads.length} reads, ${found.writes} writes)`,
    files.length >= 300 && found.reads.length >= 60, true);
  const problems = check(found, READS, OWN_OTHER);
  eq("every read is classified with a reason, none is stale, and each class holds", problems, []);
  const by = (c: Cls) => found.reads.filter((r) => READS[r.key]?.cls === c);
  eq("the reader's own row is read to decide access only in lib/auth/",
    [...new Set(by("own-access").map((r) => r.file))], ["lib/auth/org-membership.ts"]);
  eq("the own row read for another purpose: exactly the five of H.2", by("own-other").map((r) => r.key).sort(), [...OWN_OTHER].sort());
  const pending = by("recipient").filter((r) => READS[r.key].status === "step-6").length;
  console.log(`  (${found.reads.length} reads: ${by("own-access").length} own-access, ${by("own-other").length} own-other, ${by("subject").length} subject, ${by("recipient").length} recipient, of which ${pending} wait for step 6's filter)`);
  eq("the resolver's reads select status (members) and deleted_at (organisations)",
    checkResolver(RESOLVER, fs.readFileSync(path.join(root, RESOLVER), "utf8")), []);
}

console.log("\nPlanted cases: each part of the scan fires");
{
  const plant = (file: string, body: string) => scan([{ file, text: body }]);
  const OWN = `export async function POST() { const { data } = await supabase.from("organization_members").select("role").eq("organization_id", o).eq("user_id", user.id).maybeSingle(); }`;
  const own = plant("app/api/x/route.ts", OWN);
  eq("a read is found and keyed on its file, function and order", own.reads.map((r) => [r.key, r.userId]), [["app/api/x/route.ts#POST#1", "user.id"]]);
  eq("an unlisted read fails until it is classified", check(own, {}, []), ["unclassified read app/api/x/route.ts#POST#1 (:1)"]);
  eq("an own-access read outside lib/auth/ fails",
    check(own, { "app/api/x/route.ts#POST#1": { cls: "own-access", reason: "r" } }, []),
    ["app/api/x/route.ts#POST#1: an access test on the reader's own row outside lib/auth/ (use the resolver)"]);
  eq("…in lib/auth/ it passes",
    check(plant("lib/auth/x.ts", OWN), { "lib/auth/x.ts#POST#1": { cls: "own-access", reason: "r" } }, []), []);
  eq("a read on the caller's own id classified as a subject fails",
    check(own, { "app/api/x/route.ts#POST#1": { cls: "subject", reason: "r" } }, []),
    ["app/api/x/route.ts#POST#1: filtered on the caller's own id (user.id) but classified subject"]);
  eq("…unless its entry says why that id is not the caller",
    check(own, { "app/api/x/route.ts#POST#1": { cls: "subject", reason: "r", notCaller: "the account the form names" } }, []), []);
  for (const id of ["caller.id", "viewerId", "user!.id", "auth.userId"]) {
    const p = plant("app/api/y/route.ts", OWN.replace("user.id", id));
    eq(`…the caller's id spelled ${id} is recognised`, check(p, { "app/api/y/route.ts#POST#1": { cls: "subject", reason: "r" } }, []).length, 1);
  }
  eq("a target's id (userId, body.user_id) is not taken for the caller's",
    [check(plant("app/api/y/route.ts", OWN.replace("user.id", "userId")), { "app/api/y/route.ts#POST#1": { cls: "subject", reason: "r" } }, []),
      check(plant("app/api/y/route.ts", OWN.replace("user.id", "body.user_id")), { "app/api/y/route.ts#POST#1": { cls: "subject", reason: "r" } }, [])], [[], []]);
  eq("an own-other read off the frozen list fails",
    check(own, { "app/api/x/route.ts#POST#1": { cls: "own-other", reason: "r" } }, []),
    ["app/api/x/route.ts#POST#1: own row for another purpose, not on the frozen list"]);
  eq("a stale entry fails", check(plant("app/api/z/route.ts", "export const a = 1;"), { "app/api/gone/route.ts#GET#1": { cls: "subject", reason: "r" } }, []),
    ["stale entry app/api/gone/route.ts#GET#1: no such read"]);
  eq("an entry with no reason fails", check(own, { "app/api/x/route.ts#POST#1": { cls: "own-other", reason: " " } }, ["app/api/x/route.ts#POST#1"]),
    ["app/api/x/route.ts#POST#1: no reason"]);
  const RCP = `export async function notify() { const { data } = await svc.from("organization_members").select("user_id").eq("organization_id", o); }`;
  const rcp = plant("lib/x/notify.ts", RCP);
  eq("a recipient read marked query without status = 'active' fails",
    check(rcp, { "lib/x/notify.ts#notify#1": { cls: "recipient", status: "query", reason: "r" } }, []),
    ["lib/x/notify.ts#notify#1: a recipient read marked query does not filter status = 'active'"]);
  eq("…with the filter it passes",
    check(plant("lib/x/notify.ts", RCP.replace(`.eq("organization_id", o)`, `.eq("organization_id", o).eq("status", "active")`)), { "lib/x/notify.ts#notify#1": { cls: "recipient", status: "query", reason: "r" } }, []), []);
  eq("a recipient read must say query or step-6",
    check(rcp, { "lib/x/notify.ts#notify#1": { cls: "recipient", reason: "r" } }, []), ["lib/x/notify.ts#notify#1: a recipient read must say query or step-6"]);
  eq("writes are not reads",
    [plant("app/api/w/route.ts", `export async function POST() { await svc.from("organization_members").update({ role: "user" }).eq("user_id", u); await svc.from("organization_members").insert({}); }`)].map((s) => [s.reads.length, s.writes]),
    [[0, 2]]);
  eq("fetchByIds and fetchAll naming the table are reads",
    plant("lib/x/h.ts", `export async function f() { await fetchByIds(svc, "organization_members", "user_id", "user_id", ids); await fetchAll(svc, "organization_members", "user_id, status", (q) => q.eq("status", "active")); }`).reads.map((r) => [r.key, r.activeInQuery]),
    [["lib/x/h.ts#f#1", false], ["lib/x/h.ts#f#2", true]]);
  eq("reads in a function held in a variable are keyed on its name, in order",
    plant("lib/x/v.ts", `const memQ = (c: string) => svc.from("organization_members").select(c); export async function g() { await svc.from("organization_members").select("a"); await svc.from("organization_members").select("b"); }`).reads.map((r) => r.key),
    ["lib/x/v.ts#memQ#1", "lib/x/v.ts#g#1", "lib/x/v.ts#g#2"]);
  eq("the table named in a variable, or embedded in a select list, fails until it is read here",
    check(plant("lib/x/s.ts", `const T = "organization_members"; export async function h() { await svc.from(T).select("a"); await svc.from("profiles").select("id, organization_members(role)"); }`), {}, []),
    [`the table named outside a read or write: lib/x/s.ts:1 "organization_members"`, `the table named outside a read or write: lib/x/s.ts:1 "id, organization_members(role)"`]);
  eq("a word in a comment is not a read", plant("lib/x/c.ts", `// reads organization_members\nexport const a = 1;`).strays.length, 0);
  eq("a resolver whose member read lacks status, or org read lacks deleted_at, fails",
    checkResolver("lib/auth/r.ts", `export async function r() { await c.from("organization_members").select("role").eq("user_id", u); await c.from("organizations").select("id, name").eq("id", o); }`),
    [`lib/auth/r.ts: a member read that does not select status (role)`, `lib/auth/r.ts: an organisation read that does not select deleted_at (id, name)`]);
  eq("…an org select built by a helper passes when the helper names deleted_at",
    checkResolver("lib/auth/r.ts", `function sel(c: string) { return [c, "deleted_at"].join(", "); } export async function r() { await c.from("organization_members").select("role, status"); await c.from("organizations").select(sel("id")); }`), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
