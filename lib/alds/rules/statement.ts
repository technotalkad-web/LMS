/**
 * checkStatement: shape (G1, S1–S9, E1), grammar (R10) and semantic (R3, SEM,
 * POOL) checks of one ALDS 2.0 statement as sent by content (BLUEPRINT §1.3,
 * §7 R3/R10; ADR 0005 steps 6–8).
 *
 * Context is optional and widens what is checked:
 *   manifest    → R3 catalogue membership, SEM key comparison, S5 full text,
 *                 S4 quiz ids and POOL drawn sets, S3 bank `run`
 *   launchData  → S1/S7 template equality, S6 launch mode, S2 masteryScore
 *   auActivityId→ S2 object id (else derived from the template's or the
 *                 statement's package id with the §1.2 formula)
 * The result's `checked` lists the rules actually evaluated.
 *
 * Decisions taken here (listed for the owner/architect, see the PR):
 *   - S3 is class-aware: `result.success` is required on `answered` unless the
 *     manifest classes the question `unscored` (ADR 0005 step 6 "success must
 *     be absent", which then wins over S3's MUST) or `completion-only`, or the
 *     unanswered marker is present (then success may be absent or false).
 *   - An empty `result.response` is valid only with EXT_RESULT_UNANSWERED.
 */
import {
  CMI5_CATEGORY,
  CMI5_MOVEON_CATEGORY,
  CMI5_SESSION_EXT,
  CMI_INTERACTION_TYPE,
  E,
  EXT,
  EXT_RESULT_UNANSWERED,
  INTERACTION_KINDS,
  KEY_CLASS_BY_AUTHORING_KIND,
  REGISTRATION_KINDS,
  UNANSWERED_REASONS,
  VERB,
  XAPI_NS,
  auActivityId,
  langPath,
  questionFamily,
  questionObject,
  type AldsCatalogueEntry,
  type AldsKeyClass,
  type AldsLaunchData,
  type AldsPackageManifest,
  type InteractionKind,
} from "../types";
import { Report, type CheckResult } from "./findings";
import { canonicalPatternKey, parseInteraction, referencedIds, responseMatches, type Parsed } from "./grammar";
import {
  duplicates,
  get,
  getArr,
  getObj,
  hasOwn,
  isBcp47,
  isDuration,
  isInt,
  isNonEmptyStr,
  isObj,
  isOid,
  isSemver,
  isSha256,
  isStr,
  isUlid,
  isUuid,
  jsonEqual,
  normalizeText,
  sameLanguageTag,
  sameSet,
  timestampState,
  type Obj,
} from "./util";

export interface StatementContext {
  manifest?: AldsPackageManifest;
  launchData?: AldsLaunchData;
  auActivityId?: string;
}

/** What a statement is, for the S2/S4/S6 rules and the session checker. */
export type StatementClass = "au-defined" | "run-summary" | "answered" | "lms-defined" | "other";

const AU_VERBS: readonly string[] = [VERB.initialized, VERB.completed, VERB.passed, VERB.failed, VERB.terminated];
const OUTCOME_VERBS: readonly string[] = [VERB.completed, VERB.passed, VERB.failed];
const LMS_VERBS: readonly string[] = [VERB.launched, VERB.abandoned, VERB.waived, VERB.satisfied];
const QUIZ_PREFIX = `${XAPI_NS}activities/quiz/`;

/** Short path for an extension key: context.extensions[E:question/qid]. */
function extPath(key: string): string {
  return `context.extensions[${key.startsWith(E) ? `E:${key.slice(E.length)}` : key}]`;
}

/** quizRun(quizId, lang) → its parts, or null. */
export function parseQuizRunIri(id: unknown): { quizId: string; lang: string } | null {
  if (!isStr(id) || !id.startsWith(QUIZ_PREFIX)) return null;
  const rest = id.slice(QUIZ_PREFIX.length).split("/");
  if (rest.length !== 2 || rest[0] === "" || rest[1] === "") return null;
  return { quizId: rest[0], lang: rest[1] };
}

function categoryIds(context: Obj | undefined): string[] {
  const cats = getArr(getObj(context, "contextActivities"), "category") ?? [];
  return cats.map((c) => get(c, "id")).filter(isStr);
}

function groupingIds(context: Obj | undefined): string[] {
  const g = getArr(getObj(context, "contextActivities"), "grouping") ?? [];
  return g.map((c) => get(c, "id")).filter(isStr);
}

/** The AU activity id this statement should use, when it can be known. */
export function expectedAuId(statement: unknown, ctx: { auActivityId?: string; launchData?: AldsLaunchData }): string | undefined {
  if (ctx.auActivityId) return ctx.auActivityId;
  const fromTemplate = ctx.launchData?.contextTemplate?.extensions?.[EXT.packageId];
  if (isUuid(fromTemplate)) return auActivityId(fromTemplate);
  const own = get(getObj(getObj(statement, "context"), "extensions"), EXT.packageId);
  return isUuid(own) ? auActivityId(own) : undefined;
}

/** Classify a statement (assumes verb.id and object exist). */
export function classifyStatement(statement: unknown, auId: string | undefined): StatementClass {
  const verbId = get(getObj(statement, "verb"), "id");
  const objectId = get(getObj(statement, "object"), "id");
  const cats = categoryIds(getObj(statement, "context"));
  if (!isStr(verbId)) return "other";
  if (OUTCOME_VERBS.includes(verbId) && parseQuizRunIri(objectId)) return "run-summary";
  if (AU_VERBS.includes(verbId) && ((auId !== undefined && objectId === auId) || cats.includes(CMI5_CATEGORY))) return "au-defined";
  if (verbId === VERB.answered) return "answered";
  if (LMS_VERBS.includes(verbId)) return "lms-defined";
  return "other";
}

export function keyClassOf(entry: Pick<AldsCatalogueEntry, "authoringKind" | "correct">): AldsKeyClass {
  const k = entry.authoringKind;
  if (isStr(k) && hasOwn(KEY_CLASS_BY_AUTHORING_KIND as Obj, k)) return KEY_CLASS_BY_AUTHORING_KIND[k];
  return Array.isArray(entry.correct) && entry.correct.length > 0 ? "keyed" : "scored-unkeyed";
}

/** Component lists an interaction type carries in its definition (xAPI 1.0.3). */
const COMPONENTS: Readonly<Record<string, readonly string[]>> = {
  choice: ["choices"],
  sequencing: ["choices"],
  likert: ["scale"],
  matching: ["source", "target"],
  performance: ["steps"],
};

/** Keys of a language map, or null when it is not a map of strings. */
function langMapKeys(v: unknown): string[] | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  return keys.every((k) => isStr(v[k])) ? keys : null;
}

function langMapText(v: unknown, lang: string): string | undefined {
  if (!isObj(v)) return undefined;
  for (const k of Object.keys(v)) if (sameLanguageTag(k, lang) && isStr(v[k])) return v[k] as string;
  return undefined;
}

function safeQuestions(m: AldsPackageManifest | undefined): AldsCatalogueEntry[] {
  return m && Array.isArray(m.questions) ? m.questions.filter(isObj) : [];
}
function safeQuizzes(m: AldsPackageManifest | undefined): AldsPackageManifest["quizzes"] {
  return m && Array.isArray(m.quizzes) ? m.quizzes.filter(isObj) : [];
}

export function checkStatement(statement: unknown, ctx: StatementContext = {}): CheckResult {
  const r = new Report();

  // --- G1: the minimal shape ------------------------------------------------
  r.check("G1");
  if (!isObj(statement)) {
    r.add("G1", "not_an_object", "a statement must be a JSON object");
    return r.result();
  }
  if (!isObj(statement.actor)) r.add("G1", "actor_missing", "actor is missing", { path: "actor" });
  const verbId = get(statement.verb, "id");
  if (!isNonEmptyStr(verbId)) r.add("G1", "verb_missing", "verb.id is missing", { path: "verb.id" });
  if (!isObj(statement.object)) r.add("G1", "object_missing", "object is missing", { path: "object" });
  if (r.findings.length > 0 || !isStr(verbId)) return r.result();
  const object = statement.object as Obj;

  // --- S9: content never voids ----------------------------------------------
  r.check("S9");
  if (verbId === VERB.voided) r.add("S9", "void_not_allowed", "content must not send a voiding statement", { path: "verb.id" });
  if (object.objectType === "StatementRef") r.add("S9", "statement_ref_not_allowed", "content must not send a StatementRef object", { path: "object.objectType" });
  if (object.objectType === "SubStatement") r.add("S9", "substatement_not_allowed", "content must not send a SubStatement object", { path: "object.objectType" });
  if (r.findings.length > 0) return r.result();

  // --- S8: id and timestamp -------------------------------------------------
  r.check("S8");
  if (statement.id === undefined) r.add("S8", "id_missing", "id (UUID) is required", { path: "id" });
  else if (!isUuid(statement.id)) r.add("S8", "id_invalid", "id is not a UUID", { path: "id" });
  if (statement.timestamp === undefined) r.add("S8", "timestamp_missing", "timestamp is required", { path: "timestamp" });
  else {
    const ts = timestampState(statement.timestamp);
    if (ts === "missing_offset") r.add("S8", "timestamp_no_offset", "timestamp needs an explicit offset (Z or ±hh:mm)", { path: "timestamp" });
    else if (ts === "invalid") r.add("S8", "timestamp_invalid", "timestamp is not ISO 8601", { path: "timestamp" });
  }

  const context = getObj(statement, "context");
  const ext: Obj = getObj(context, "extensions") ?? {};
  const result = getObj(statement, "result");
  const tpl = ctx.launchData?.contextTemplate;

  // --- E1: engine-supplied extensions (§1.3 table, "all") -------------------
  r.check("E1");
  const engineExt: Array<[string, (v: unknown) => boolean, string]> = [
    [EXT.profileVersion, (v) => v === "2.0", '"2.0"'],
    [EXT.standardVersion, (v) => v === "2.0", '"2.0"'],
    [EXT.engineVersion, isNonEmptyStr, "a non-empty string"],
    [EXT.courseUlid, isUlid, "a ULID"],
    [EXT.courseVersion, isSemver, "semver MAJOR.MINOR.PATCH"],
    [EXT.packageBuild, isUuid, "a UUID"],
  ];
  for (const [key, ok, want] of engineExt) {
    if (!hasOwn(ext, key)) r.add("E1", "engine_extension_missing", `${key} is required on every statement`, { path: extPath(key) });
    else if (!ok(ext[key])) r.add("E1", "engine_extension_invalid", `${key} must be ${want}`, { path: extPath(key) });
  }
  if (hasOwn(ext, EXT.attemptNumber)) {
    r.add("E1", "attempt_number_set_by_engine", "attempt/number is set by the LMS forwarder only; the engine must not send it", { path: extPath(EXT.attemptNumber) });
  }

  // --- S1: the LMS contextTemplate is the base of context (LMS-attributable) --
  r.check("S1");
  const lmsExt: Array<[string, (v: unknown) => boolean, string]> = [
    [EXT.language, isBcp47, "a BCP 47 tag"],
    [EXT.packageId, isUuid, "a UUID"],
    [EXT.versionId, isUuid, "a UUID"],
    [EXT.attemptId, isUuid, "a UUID"],
    [EXT.registrationKind, (v) => isStr(v) && (REGISTRATION_KINDS as readonly string[]).includes(v), "enrollment | retake | grant_retake"],
    [EXT.attemptIndex, (v) => isInt(v, 1), "an integer ≥ 1"],
  ];
  const lms = { attribution: "lms" as const };
  for (const [key, ok, want] of lmsExt) {
    if (!hasOwn(ext, key)) r.add("S1", "template_extension_missing", `${key} from the LMS contextTemplate is missing`, { ...lms, path: extPath(key) });
    else if (!ok(ext[key])) r.add("S1", "template_extension_invalid", `${key} must be ${want}`, { ...lms, path: extPath(key) });
  }
  if (tpl && isObj(tpl.extensions)) {
    for (const key of Object.keys(tpl.extensions)) {
      if (key === CMI5_SESSION_EXT || !hasOwn(ext, key)) continue; // session id: S7; missing: reported above
      if (!jsonEqual(ext[key], (tpl.extensions as Obj)[key])) {
        r.add("S1", "template_value_changed", `${key} differs from the LMS contextTemplate`, { ...lms, path: extPath(key) });
      }
    }
    const have = groupingIds(context);
    for (const g of tpl.contextActivities?.grouping ?? []) {
      if (isObj(g) && isStr(g.id) && !have.includes(g.id)) {
        r.add("S1", "template_grouping_missing", `contextActivities.grouping lacks ${g.id} from the template`, { ...lms, path: "context.contextActivities.grouping" });
      }
    }
  }

  // --- S7: registration and session id (LMS-attributable) --------------------
  r.check("S7");
  const registration = get(context, "registration");
  if (registration === undefined) r.add("S7", "registration_missing", "context.registration is missing", { ...lms, path: "context.registration" });
  else if (!isUuid(registration)) r.add("S7", "registration_invalid", "context.registration is not a UUID", { ...lms, path: "context.registration" });
  const sessionId = ext[CMI5_SESSION_EXT];
  if (!isNonEmptyStr(sessionId)) r.add("S7", "session_id_missing", "the cmi5 sessionid extension is missing", { ...lms, path: extPath(CMI5_SESSION_EXT) });
  if (tpl) {
    if (isUuid(registration) && registration !== tpl.registration) {
      r.add("S7", "registration_changed", "context.registration differs from the template", { ...lms, path: "context.registration" });
    }
    const tplSession = isObj(tpl.extensions) ? (tpl.extensions as Obj)[CMI5_SESSION_EXT] : undefined;
    if (isNonEmptyStr(sessionId) && tplSession !== undefined && sessionId !== tplSession) {
      r.add("S7", "session_id_changed", "the sessionid extension differs from the template", { ...lms, path: extPath(CMI5_SESSION_EXT) });
    }
  }

  // --- classification ----------------------------------------------------------
  const auId = expectedAuId(statement, ctx);
  const cls = classifyStatement(statement, auId);
  const cats = categoryIds(context);
  const hasCmi5 = cats.includes(CMI5_CATEGORY);
  const hasMoveOn = cats.includes(CMI5_MOVEON_CATEGORY);
  const objectId = object.id;

  // --- S2: cmi5-defined statements ----------------------------------------------
  r.check("S2");
  if (cls === "au-defined") {
    if (!hasCmi5) r.add("S2", "cmi5_category_missing", "a cmi5-defined statement must carry the cmi5 category", { path: "context.contextActivities.category" });
    if (auId !== undefined && objectId !== auId) r.add("S2", "object_not_au_activity", `object.id must be the LMS AU id ${auId}`, { path: "object.id" });
    const isOutcome = OUTCOME_VERBS.includes(verbId);
    if (isOutcome && !hasMoveOn) r.add("S2", "moveon_category_missing", "completed/passed/failed must carry the moveOn category", { path: "context.contextActivities.category" });
    if (!isOutcome && hasMoveOn) r.add("S2", "moveon_category_on_non_outcome", "only completed/passed/failed carry the moveOn category", { path: "context.contextActivities.category" });
    if (isOutcome || verbId === VERB.terminated) {
      const d = get(result, "duration");
      if (d === undefined) r.add("S2", "duration_missing", "result.duration is required", { path: "result.duration" });
      else if (!isDuration(d)) r.add("S2", "duration_invalid", "result.duration is not an ISO 8601 duration", { path: "result.duration" });
    }
    if (verbId === VERB.completed && get(result, "completion") !== true) {
      r.add("S2", "completion_missing", "completed must carry result.completion = true", { path: "result.completion" });
    }
    if (verbId === VERB.passed || verbId === VERB.failed) {
      const want = verbId === VERB.passed;
      const s = get(result, "success");
      if (s === undefined) r.add("S2", "success_missing", `${verbId === VERB.passed ? "passed" : "failed"} must carry result.success`, { path: "result.success" });
      else if (s !== want) r.add("S2", "success_inconsistent", `result.success must be ${want}`, { path: "result.success" });
      const mastery = ctx.launchData?.masteryScore;
      if (typeof mastery === "number") {
        const scaled = get(getObj(result, "score"), "scaled");
        if (typeof scaled !== "number") r.add("S2", "score_missing", "result.score.scaled is required when a masteryScore was launched", { path: "result.score.scaled" });
        else if (want ? scaled < mastery : scaled >= mastery) {
          r.add("S2", "score_contradicts_mastery", `the scaled score ${scaled} contradicts masteryScore ${mastery}`, { path: "result.score.scaled" });
        }
      }
    }
  } else if (cls === "answered" || cls === "other") {
    if (hasCmi5) r.add("S2", "cmi5_category_on_non_defined", "only cmi5-defined statements carry the cmi5 category", { path: "context.contextActivities.category" });
    if (hasMoveOn) r.add("S2", "moveon_category_on_non_defined", "only completed/passed/failed on the AU carry the moveOn category", { path: "context.contextActivities.category" });
  }

  // --- S6: Browse/Review launches ----------------------------------------------------
  if (ctx.launchData) {
    r.check("S6");
    const mode = ctx.launchData.launchMode;
    if (mode === "Browse" || mode === "Review") {
      if (cls === "au-defined" && verbId !== VERB.initialized && verbId !== VERB.terminated) {
        r.add("S6", "defined_statement_in_browse", `a ${mode} launch sends no cmi5-defined statement other than initialized/terminated`, { path: "verb.id" });
      }
      if (cls === "answered") r.add("S6", "answered_in_browse", `a ${mode} launch sends no answered statement`, { path: "verb.id" });
    }
  }

  // --- S4: quiz-run summary -----------------------------------------------------------
  const runTarget = parseQuizRunIri(objectId);
  if (cls === "answered" && runTarget) {
    r.add("S4", "run_summary_as_answered", "a quiz run summary must not be sent as answered", { path: "verb.id" });
    return r.result();
  }
  if (cls === "run-summary" && runTarget) {
    r.check("S4");
    if (hasCmi5) r.add("S4", "cmi5_category_on_run_summary", "a quiz run summary carries no cmi5 category", { path: "context.contextActivities.category" });
    if (hasMoveOn) r.add("S4", "moveon_category_on_run_summary", "a quiz run summary carries no moveOn category", { path: "context.contextActivities.category" });
    if (!isInt(ext[EXT.questionRun], 1)) r.add("S4", "run_missing", "question/run (integer ≥ 1) is required", { path: extPath(EXT.questionRun) });
    const drawn = ext[EXT.questionDrawn];
    if (!Array.isArray(drawn) || drawn.length === 0) r.add("S4", "drawn_missing", "question/drawn (the drawn qids) is required", { path: extPath(EXT.questionDrawn) });
    else if (!drawn.every(isUlid) || duplicates(drawn as string[]).length > 0) {
      r.add("S4", "drawn_invalid", "question/drawn must list distinct ULIDs", { path: extPath(EXT.questionDrawn) });
    }
    const lang = ext[EXT.language];
    if (isStr(lang) && runTarget.lang !== langPath(lang)) {
      r.add("S4", "run_language_mismatch", "the quiz run IRI's language differs from content/language", { path: "object.id" });
    }
    if (ctx.manifest) {
      const quiz = safeQuizzes(ctx.manifest).find((q) => q.quizId === runTarget.quizId);
      if (!quiz) r.add("S4", "quiz_unknown", `quiz ${runTarget.quizId} is not in the manifest`, { path: "object.id" });
      else if (Array.isArray(drawn) && drawn.every(isStr)) {
        r.check("POOL");
        const bank = Array.isArray(quiz.bankQids) ? quiz.bankQids : [];
        const outside = (drawn as string[]).filter((q) => !bank.includes(q));
        if (outside.length > 0) r.add("POOL", "drawn_not_in_bank", `drawn qids outside the quiz bank: ${outside.join(", ")}`, { path: extPath(EXT.questionDrawn) });
        if (typeof quiz.drawCount === "number" && drawn.length !== quiz.drawCount) {
          r.add("POOL", "drawn_count_mismatch", `drew ${drawn.length} questions, the manifest says ${quiz.drawCount}`, { path: extPath(EXT.questionDrawn) });
        }
      }
    }
    return r.result();
  }

  if (cls !== "answered") return r.result();
  checkAnswered(r, statement, object, ext, result, ctx);
  return r.result();
}

/** S3, R10, S5, R3, SEM for an `answered` statement. */
function checkAnswered(r: Report, statement: Obj, object: Obj, ext: Obj, result: Obj | undefined, ctx: StatementContext): void {
  r.check("S3");
  r.check("S5");
  const def = getObj(object, "definition");
  if (!def) {
    r.add("S3", "definition_missing", "answered needs object.definition", { path: "object.definition" });
    return;
  }
  if (def.type !== CMI_INTERACTION_TYPE) {
    r.add("S3", "definition_type_invalid", `object.definition.type must be ${CMI_INTERACTION_TYPE}`, { path: "object.definition.type" });
  }
  const it = def.interactionType;
  const kind: InteractionKind | null = isStr(it) && (INTERACTION_KINDS as readonly string[]).includes(it) ? (it as InteractionKind) : null;
  if (!kind) r.add("S3", "interaction_type_invalid", "object.definition.interactionType is not an xAPI interaction type", { path: "object.definition.interactionType" });

  // question extensions
  const qid = ext[EXT.questionQid];
  const qlang = ext[EXT.questionLanguage];
  const qExt: Array<[string, (v: unknown) => boolean, string]> = [
    [EXT.questionQid, isUlid, "a ULID"],
    [EXT.questionLanguage, isBcp47, "a BCP 47 tag"],
    [EXT.questionRevision, (v) => isInt(v, 1), "an integer ≥ 1"],
    [EXT.questionContentHash, isSha256, "sha256:<64 hex>"],
    [EXT.questionTry, (v) => isInt(v, 1), "an integer ≥ 1"],
    [EXT.questionFinal, (v) => typeof v === "boolean", "a boolean"],
  ];
  for (const [key, ok, want] of qExt) {
    if (!hasOwn(ext, key)) r.add("S3", "question_extension_missing", `${key} is required on answered`, { path: extPath(key) });
    else if (!ok(ext[key])) r.add("S3", "question_extension_invalid", `${key} must be ${want}`, { path: extPath(key) });
  }
  if (hasOwn(ext, EXT.questionRun) && !isInt(ext[EXT.questionRun], 1)) {
    r.add("S3", "question_extension_invalid", `${EXT.questionRun} must be an integer ≥ 1`, { path: extPath(EXT.questionRun) });
  }
  const qidOk = isUlid(qid);
  const langOk = isBcp47(qlang);
  if (qidOk && langOk && object.id !== questionObject(qid, qlang)) {
    r.add("S3", "object_id_not_question_iri", `object.id must be ${questionObject(qid, qlang)}`, { path: "object.id" });
  }
  if (qidOk && !groupingIds(getObj(statement, "context")).includes(questionFamily(qid))) {
    r.add("S3", "question_family_missing", `contextActivities.grouping must include ${questionFamily(qid)}`, { path: "context.contextActivities.grouping" });
  }

  // definition texts keyed by the real language only
  const checkLangMap = (v: unknown, path: string) => {
    if (!langOk) return;
    const keys = langMapKeys(v);
    if (!keys || keys.length !== 1 || !sameLanguageTag(keys[0], qlang as string)) {
      r.add("S3", "label_language_mismatch", `${path} must be keyed by the question language ${qlang} only`, { path });
    }
  };
  if (def.name === undefined) r.add("S3", "name_missing", "object.definition.name is required", { path: "object.definition.name" });
  else checkLangMap(def.name, "object.definition.name");
  if (def.description === undefined) r.add("S5", "description_missing", "object.definition.description must hold the full stem", { path: "object.definition.description" });
  else checkLangMap(def.description, "object.definition.description");

  // interaction components
  const componentIds: Record<string, string[]> = {};
  const lists = kind ? COMPONENTS[kind] ?? [] : [];
  for (const list of lists) {
    const arr = getArr(def, list);
    const path = `object.definition.${list}`;
    if (!arr || arr.length === 0) {
      r.add("S3", "components_missing", `${kind} needs object.definition.${list}`, { path });
      componentIds[list] = [];
      continue;
    }
    const ids = arr.map((c) => get(c, "id"));
    componentIds[list] = ids.filter(isStr);
    if (!ids.every(isNonEmptyStr)) r.add("S3", "component_id_invalid", `every ${list} entry needs an id`, { path });
    if (duplicates(componentIds[list]).length > 0) r.add("S3", "component_id_duplicate", `${list} ids must be unique`, { path });
    if (list === "choices" && !componentIds[list].every(isOid)) r.add("S3", "choice_id_not_oid", "choices[].id must be the option's oid (o1..oN)", { path });
    arr.forEach((c, i) => checkLangMap(get(c, "description"), `${path}[${i}].description`));
  }
  const allComponentIds = ([] as string[]).concat(...Object.keys(componentIds).map((k) => componentIds[k]));

  // display order (SHOULD for choice kinds)
  if (kind === "choice" || kind === "sequencing") {
    const order = ext[EXT.questionDisplayOrder];
    if (order === undefined) r.add("S3", "display_order_missing", "question/display-order should list the oids in the order shown", { severity: "warn", path: extPath(EXT.questionDisplayOrder) });
    else if (!Array.isArray(order) || !order.every(isStr) || order.length !== (componentIds.choices ?? []).length || !sameSet(order as string[], componentIds.choices ?? [])) {
      r.add("S3", "display_order_mismatch", "question/display-order should be a permutation of the choice ids", { severity: "warn", path: extPath(EXT.questionDisplayOrder) });
    }
  }

  const idsKnown = (p: Parsed): boolean => {
    const ref = referencedIds(p);
    const pool = (name: string) => componentIds[name] ?? [];
    if (kind === "choice" || kind === "sequencing") return ref.ids.every((id) => pool("choices").includes(id));
    if (kind === "likert") return ref.ids.every((id) => pool("scale").includes(id));
    if (kind === "matching") return ref.sources.every((id) => pool("source").includes(id)) && ref.targets.every((id) => pool("target").includes(id));
    if (kind === "performance") return ref.steps.every((id) => pool("steps").includes(id));
    return true;
  };

  // correctResponsesPattern grammar (R10)
  r.check("R10");
  const patternsRaw = def.correctResponsesPattern;
  const stmtPatterns: Parsed[] = [];
  let patternsValid = true;
  if (patternsRaw !== undefined) {
    if (!Array.isArray(patternsRaw) || !patternsRaw.every(isStr)) {
      r.add("S3", "pattern_invalid", "correctResponsesPattern must be an array of strings", { path: "object.definition.correctResponsesPattern" });
      patternsValid = false;
    } else if (kind) {
      patternsRaw.forEach((p, i) => {
        const parsed = parseInteraction(kind, p, "pattern");
        const path = `object.definition.correctResponsesPattern[${i}]`;
        if (!parsed.ok) {
          r.add("R10", "pattern_grammar", `${parsed.code}: ${parsed.message}`, { path });
          patternsValid = false;
        } else {
          stmtPatterns.push(parsed.value);
          if (!idsKnown(parsed.value)) r.add("S3", "pattern_id_unknown", "the pattern refers to an id that is not in the definition", { path });
        }
      });
    }
  }

  // result
  let response: Parsed | null = null;
  let markerValid = false;
  const success = get(result, "success");
  if (!result) {
    r.add("S3", "result_missing", "answered needs a result", { path: "result" });
  } else {
    const marker = get(getObj(result, "extensions"), EXT_RESULT_UNANSWERED);
    markerValid = isStr(marker) && (UNANSWERED_REASONS as readonly string[]).includes(marker);
    if (marker !== undefined && !markerValid) {
      r.add("S3", "unanswered_marker_invalid", `the unanswered marker must be one of ${UNANSWERED_REASONS.join(", ")}`, { path: "result.extensions" });
    }
    const resp = result.response;
    if (resp === undefined) r.add("S3", "response_missing", "result.response is required", { path: "result.response" });
    else if (!isStr(resp)) r.add("S3", "response_invalid", "result.response must be a string", { path: "result.response" });
    else if (resp === "") {
      if (!markerValid) r.add("S3", "empty_response_without_marker", "an empty response needs the explicit unanswered/timeout marker", { path: "result.response" });
    } else {
      if (markerValid) r.add("S3", "unanswered_marker_with_response", "the unanswered marker is set but a response is present", { path: "result.response" });
      if (kind) {
        const parsed = parseInteraction(kind, resp, "response");
        if (!parsed.ok) r.add("R10", "response_grammar", `${parsed.code}: ${parsed.message}`, { path: "result.response" });
        else {
          response = parsed.value;
          if (!idsKnown(parsed.value)) r.add("S3", "response_id_unknown", "the response refers to an id that is not in the definition (ids, not positions)", { path: "result.response" });
        }
      }
    }
    const score = getObj(result, "score");
    if (score && hasOwn(score, "scaled")) {
      const sc = score.scaled;
      if (typeof sc !== "number" || sc < -1 || sc > 1) r.add("S3", "score_invalid", "result.score.scaled must be a number in [-1, 1]", { path: "result.score.scaled" });
    }
  }

  // manifest-backed checks
  const questions = safeQuestions(ctx.manifest);
  const entry = ctx.manifest && qidOk && langOk ? questions.find((q) => q.qid === qid && isStr(q.language) && sameLanguageTag(q.language, qlang)) : undefined;
  const cls: AldsKeyClass | null = entry ? keyClassOf(entry) : null;

  // success (class-aware S3)
  if (result) {
    if (markerValid) {
      if (success === true) r.add("S3", "unanswered_marked_success", "an unanswered/timed-out question cannot be successful", { path: "result.success" });
      else if (success !== undefined && success !== false) r.add("S3", "success_invalid", "result.success must be a boolean", { path: "result.success" });
    } else if (cls === "unscored") {
      // SEM decides (success must be absent)
    } else if (cls === "completion-only") {
      if (success !== undefined && typeof success !== "boolean") r.add("S3", "success_invalid", "result.success must be a boolean", { path: "result.success" });
    } else if (typeof success !== "boolean") {
      r.add("S3", success === undefined ? "success_missing" : "success_invalid", "result.success (boolean) is required on answered", { path: "result.success" });
    }
  }

  if (!ctx.manifest) return;
  r.check("R3");
  if (qidOk && langOk && !entry) {
    r.add("R3", "unmapped_question", `(${qid}, ${qlang}) is not in the manifest catalogue`, { path: extPath(EXT.questionQid) });
  }
  if (qidOk && safeQuizzes(ctx.manifest).some((q) => Array.isArray(q.bankQids) && q.bankQids.includes(qid)) && !hasOwn(ext, EXT.questionRun)) {
    r.add("S3", "run_missing", "question/run is required for an assessment-bank question", { path: extPath(EXT.questionRun) });
  }
  if (!entry || !cls) return;

  // S5: the full stem and option texts
  const desc = langOk ? langMapText(def.description, qlang as string) : undefined;
  if (desc !== undefined && isStr(entry.prompt) && normalizeText(desc) !== normalizeText(entry.prompt)) {
    r.add("S5", "description_not_full_stem", "object.definition.description differs from the manifest prompt (truncated or edited)", { path: "object.definition.description" });
  }
  const options = Array.isArray(entry.options) ? entry.options.filter(isObj) : [];
  if (kind && langOk) {
    for (const list of COMPONENTS[kind] ?? []) {
      for (const c of getArr(def, list) ?? []) {
        const id = get(c, "id");
        const opt = options.find((o) => o.oid === id);
        const text = langMapText(get(c, "description"), qlang as string);
        if (opt && isStr(opt.label) && text !== undefined && normalizeText(text) !== normalizeText(opt.label)) {
          r.add("S5", "option_text_differs", `the text of ${String(id)} differs from the manifest label`, { path: `object.definition.${list}` });
        }
      }
    }
  }

  // SEM: the semantic check against the manifest key (ADR 0005 step 6)
  r.check("SEM");
  if (kind && kind !== entry.kind) {
    r.add("SEM", "kind_mismatch", `interactionType ${kind} differs from the manifest kind ${entry.kind}`, { path: "object.definition.interactionType" });
    return;
  }
  if (isInt(ext[EXT.questionRevision], 1) && ext[EXT.questionRevision] !== entry.revision) {
    r.add("SEM", "revision_mismatch", `revision ${String(ext[EXT.questionRevision])} differs from the manifest revision ${entry.revision}`, { path: extPath(EXT.questionRevision) });
  }
  if (isSha256(ext[EXT.questionContentHash]) && ext[EXT.questionContentHash] !== entry.contentHash) {
    r.add("SEM", "content_hash_mismatch", "question/content-hash differs from the manifest", { path: extPath(EXT.questionContentHash) });
  }
  if (kind && !sameSet(allComponentIds, options.map((o) => o.oid).filter(isStr))) {
    r.add("SEM", "option_set_mismatch", "the definition's option ids differ from the manifest's oids", { path: "object.definition" });
  }
  if (!kind) return;

  if (cls === "unscored") {
    if (success !== undefined) r.add("SEM", "success_on_unscored", "an unscored item must not report result.success", { path: "result.success" });
    return;
  }
  if (cls !== "keyed") return;

  const correct = Array.isArray(entry.correct) ? entry.correct.filter(isStr) : [];
  if (correct.length === 0) {
    r.add("SEM", "key_missing", "the manifest has no key for a keyed question", { path: extPath(EXT.questionQid) });
    return;
  }
  if (kind === "other") {
    r.add("SEM", "key_not_comparable", "interactionType other has no comparable key; a keyed question needs a typed interaction", { path: "object.definition.interactionType" });
    return;
  }
  const manifestPatterns: Parsed[] = [];
  for (const p of correct) {
    const parsed = parseInteraction(kind, p, "pattern");
    if (parsed.ok) manifestPatterns.push(parsed.value);
  }
  if (patternsRaw === undefined) {
    r.add("SEM", "pattern_missing", "a keyed question must send correctResponsesPattern", { path: "object.definition.correctResponsesPattern" });
  } else if (patternsValid) {
    const a = stmtPatterns.map(canonicalPatternKey);
    const b = manifestPatterns.map(canonicalPatternKey);
    if (!sameSet(a, b) || a.length !== b.length) {
      r.add("SEM", "pattern_differs_from_manifest", "correctResponsesPattern differs from the manifest key", { path: "object.definition.correctResponsesPattern" });
    }
  }
  if (response && !markerValid && typeof success === "boolean" && manifestPatterns.length > 0) {
    const expected = manifestPatterns.some((p) => responseMatches(response as Parsed, p) === true);
    if (expected !== success) {
      r.add("SEM", "success_contradicts_key", `result.success is ${success} but the response ${expected ? "matches" : "does not match"} the key`, { path: "result.success" });
    }
  }
}
