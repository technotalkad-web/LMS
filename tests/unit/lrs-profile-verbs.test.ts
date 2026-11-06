/**
 * Unit test for the `responded` verb of the LRS profile (ADR 0016 step 14).
 *
 *  - `verb.responded` is the ADL IRI and `verbDisplay` names it; every IRI that
 *    was already in the profile keeps its value, so no LRS history splits.
 *  - An enriched statement with the verb and no display gains
 *    `{ "en-US": "responded" }`; a statement that carries its own display keeps
 *    it; `answered` is unchanged by the addition.
 *  - The enrichment only adds: a feedback statement gains no `result.success`
 *    and no key, and the raw copy is not touched.
 *  - `PROFILE_VERSION` is the value this build carries, the profile document's
 *    title agrees with it, and the document's verb table lists the row.
 *  - The interaction breakdown still counts `answered` only, so feedback stays
 *    out of the question analytics.
 *  - Spec 45's batch carries a `responded` statement and asserts its display
 *    (ADR 0016 step 17). That spec needs a local LMS, so this is its check in the
 *    unit job.
 *
 * Run:  npx tsx tests/unit/lrs-profile-verbs.test.ts   (or npm run test:unit)
 * (Pure: no DB and no network. The last three sections read a document, two
 * migrations and spec 45 from the repository.)
 */
import fs from "node:fs";
import path from "node:path";
import { enrichStatement, type AttemptContext } from "../../lib/lrs/enrich";
import { PROFILE_VERSION, ext, verb, verbDisplay } from "../../lib/lrs/profile";
import type { XapiStatement } from "../../lib/xapi/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const RESPONDED = "http://adlnet.gov/expapi/verbs/responded";
const ANSWERED = "http://adlnet.gov/expapi/verbs/answered";
const ACTIVITY = "urn:elearning-engine:profile-verbs-test";
const COURSE = "44444444-5555-4666-8777-888888888888";

/** The version this build carries. ADR 0016 step 14: PROFILE_VERSION moves once per release. */
const THIS_BUILD_PROFILE_VERSION = "1.1.0";

// Every field of AttemptContext: the compiler holds this fixture to the type.
const ctx: AttemptContext = {
  attemptId: "11111111-2222-4333-8444-555555555555",
  attemptNumber: 1,
  startedAt: "2026-10-21T10:00:00.000Z",
  scored: true,
  isRevision: false,
  notAppliedIds: new Set<string>(),
  scoringBasis: null,
  scoringMaxAttempts: null,
  org: { id: "99999999-8888-4777-8666-555555555555", slug: "profile-verbs", name: null },
  learner: {
    userId: "22222222-3333-4444-8555-666666666666",
    email: null,
    displayName: null,
    employeeId: null,
    role: "member",
    vertical: null,
    branch: null,
    city: null,
    state: null,
    node: null,
    designation: null,
    jobRole: null,
    grade: null,
    lineManagerId: null,
    dateOfJoining: null,
    teams: [],
    groups: [],
  },
  content: {
    courseId: COURSE,
    courseTitle: null,
    versionId: "33333333-4444-4555-8666-777777777777",
    versionNumber: 1,
    packageId: null,
    language: "hi",
    manifestType: "xapi",
    engineVersion: null,
    launchedIds: [ACTIVITY],
  },
  path: null,
  journey: null,
  environment: null,
};

const statement = (verbId: string, over: Record<string, unknown> = {}): XapiStatement =>
  ({
    id: "55555555-6666-4777-8888-999999999999",
    actor: { objectType: "Agent", account: { homePage: "https://example.test", name: "engine-actor" } },
    verb: { id: verbId },
    object: {
      objectType: "Activity",
      id: `${ACTIVITY}/16_q1`,
      definition: {
        type: "http://adlnet.gov/expapi/activities/cmi.interaction",
        interactionType: "likert",
        name: { "hi-Latn": "Course clear tha?" },
      },
    },
    result: { response: "likert_3" },
    timestamp: "2026-10-21T10:05:00.000Z",
    ...over,
  }) as unknown as XapiStatement;

console.log("\nthe profile");
eq("verb.responded is the ADL IRI", verb.responded, RESPONDED);
eq("verbDisplay[verb.responded]", verbDisplay[verb.responded], "responded");
eq("PROFILE_VERSION is the value this build carries", PROFILE_VERSION, THIS_BUILD_PROFILE_VERSION);
eq("every verb has a display", Object.values(verb).filter((iri) => !verbDisplay[iri]), []);

console.log("\nno IRI changed: an addition splits no LRS history");
const BEFORE: Record<string, string> = {
  launched: "http://adlnet.gov/expapi/verbs/launched",
  initialized: "http://adlnet.gov/expapi/verbs/initialized",
  experienced: "http://adlnet.gov/expapi/verbs/experienced",
  answered: ANSWERED,
  progressed: "http://adlnet.gov/expapi/verbs/progressed",
  completed: "http://adlnet.gov/expapi/verbs/completed",
  passed: "http://adlnet.gov/expapi/verbs/passed",
  failed: "http://adlnet.gov/expapi/verbs/failed",
  terminated: "http://adlnet.gov/expapi/verbs/terminated",
  registered: "http://adlnet.gov/expapi/verbs/registered",
  abandoned: "https://w3id.org/xapi/adl/verbs/abandoned",
  satisfied: "https://w3id.org/xapi/adl/verbs/satisfied",
  earned: "http://id.tincanapi.com/verb/earned",
  rated: "http://id.tincanapi.com/verb/rated",
  missedDeadline: "https://ambak.com/xapi/verbs/missed-deadline",
};
for (const [key, iri] of Object.entries(BEFORE)) {
  eq(`verb.${key}`, (verb as Record<string, string>)[key], iri);
}

console.log("\nenrichStatement: the display fill");
const raw = statement(RESPONDED);
const rawBefore = JSON.stringify(raw);
const enriched = enrichStatement(raw, ctx);
eq("responded, no display → the profile's display", enriched.verb.display, { "en-US": "responded" });
eq("the verb id is kept", enriched.verb.id, RESPONDED);
eq("the raw copy is not touched", JSON.stringify(raw), rawBefore);

const own = enrichStatement(statement(RESPONDED, { verb: { id: RESPONDED, display: { "en-US": "gave feedback" } } }), ctx);
eq("a statement with its own display keeps it", own.verb.display, { "en-US": "gave feedback" });

const answered = enrichStatement(statement(ANSWERED, { result: { response: "a", success: true } }), ctx);
eq("answered, no display → answered", answered.verb.display, { "en-US": "answered" });
eq("answered keeps its verb id", answered.verb.id, ANSWERED);
eq("answered keeps its result", answered.result, { response: "a", success: true });

const unlisted = enrichStatement(statement("https://example.test/verbs/unlisted"), ctx);
eq("a verb the profile does not list gains no display", unlisted.verb.display === undefined, true);

console.log("\nenrichStatement: a feedback statement gains no outcome");
const def = (enriched.object as unknown as { definition: Record<string, unknown> }).definition;
eq("the result is as sent: no success", enriched.result, { response: "likert_3" });
eq("no key is added", "correctResponsesPattern" in def, false);
eq("the name is as sent", def.name, { "hi-Latn": "Course clear tha?" });
eq(
  "the object sits under the course",
  (enriched.object as unknown as { id: string }).id,
  `https://ambak.com/xapi/activities/course/${COURSE}/question/16_q1`
);
const cext = (enriched.context as unknown as { extensions: Record<string, unknown> }).extensions;
eq("the statement carries the profile version", cext[ext.profileVersion], PROFILE_VERSION);

console.log("\nthe profile document");
const profileDoc = read("docs/LRS_ANALYTICS_PROFILE.md");
const title = /^# Ambak xAPI Analytics Profile \(v(\d+\.\d+\.\d+)\)\r?$/m.exec(profileDoc);
eq("the title's version is PROFILE_VERSION", title?.[1], PROFILE_VERSION);
eq(
  "the verb table lists responded",
  profileDoc.includes(
    "| `adlnet…/responded` | engine (enriched) | a feedback or survey item answered; no `result.success`, no key (KIVO Release A, D-7 (b)) |"
  ),
  true
);

console.log("\nthe question analytics still count answered only");
for (const [file, view] of [
  ["supabase/migrations/0031_reports_foundation.sql", "mv_course_interaction_breakdown"],
  ["supabase/migrations/0035_interaction_top_wrong.sql", "mv_course_interaction_top_wrong"],
] as const) {
  const sql = read(file);
  const from = sql.indexOf(`create materialized view if not exists public.${view}`);
  const filter = from >= 0 ? /where s\.verb in \(([^)]*)\)/.exec(sql.slice(from))?.[1] ?? "" : "";
  eq(`${view}: the verb filter`, filter.split(",").map((v) => v.trim()), [`'${ANSWERED}'`, "'answered'"]);
}

console.log("\nspec 45's forwarded responded statement");
const spec45 = read("tests/bot/lifecycle/45-lrs-analytics.spec.ts").replace(/\r\n/g, "\n");
eq("the batch holds a responded statement", spec45.includes(`{ id: ids[3], actor, verb: { id: "${RESPONDED}" }`), true);
eq("four ids", spec45.includes("const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];"), true);
eq("four rows in the outbox", spec45.includes("expect(outbox!.length).toBe(4);"), true);
eq("the display is asserted on the outbox's copy", spec45.includes('expect(feedback.verb.display).toEqual({ "en-US": "responded" });'), true);
eq("the delivery waits for four", spec45.includes("if (mock.received.length < 4) await drain(baseURL!);"), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
