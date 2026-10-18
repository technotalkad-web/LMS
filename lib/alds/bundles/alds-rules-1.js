var AldsRules = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // lib/alds/rules/index.ts
  var index_exports = {};
  __export(index_exports, {
    ALDS_VERSION: () => ALDS_VERSION,
    EXT: () => EXT,
    EXT_RESULT_UNANSWERED: () => EXT_RESULT_UNANSWERED,
    KEY_CLASS_BY_AUTHORING_KIND: () => KEY_CLASS_BY_AUTHORING_KIND,
    RULE_IDS: () => RULE_IDS,
    SCRIPT_FOR_LANGUAGE: () => SCRIPT_FOR_LANGUAGE,
    U4_SCRIPT_SHARE: () => U4_SCRIPT_SHARE,
    UNANSWERED_REASONS: () => UNANSWERED_REASONS,
    auActivityId: () => auActivityId,
    canonicalBcp47: () => canonicalBcp47,
    canonicalContentJson: () => canonicalContentJson,
    canonicalPatternKey: () => canonicalPatternKey,
    checkPackage: () => checkPackage,
    checkSession: () => checkSession,
    checkStatement: () => checkStatement,
    classifyStatement: () => classifyStatement,
    contentHash: () => contentHash,
    courseFamily: () => courseFamily,
    decodeXmlEntities: () => decodeXmlEntities,
    detectScript: () => detectScript,
    isBcp47: () => isBcp47,
    keyClassOf: () => keyClassOf,
    langPath: () => langPath,
    normalizeText: () => normalizeText,
    parseInteraction: () => parseInteraction,
    parseQuizRunIri: () => parseQuizRunIri,
    questionFamily: () => questionFamily,
    questionObject: () => questionObject,
    quizRun: () => quizRun,
    responseMatches: () => responseMatches,
    scriptForLanguage: () => scriptForLanguage,
    sha256Hex: () => sha256Hex,
    sha256HexOfString: () => sha256HexOfString,
    utf8Encode: () => utf8Encode,
    xmlAttributeValues: () => xmlAttributeValues
  });

  // lib/alds/rules/findings.ts
  var RULE_IDS = [
    "G1",
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
    "S7",
    "S8",
    "S9",
    "E1",
    "R10",
    "R3",
    "SEM",
    "POOL",
    "G3",
    "R5",
    "U1",
    "U2",
    "U3",
    "U4",
    "U5",
    "U7",
    "R4"
  ];
  var Report = class {
    constructor() {
      __publicField(this, "findings", []);
      __publicField(this, "checkedSet", /* @__PURE__ */ new Set());
    }
    check(rule) {
      this.checkedSet.add(rule);
    }
    add(rule, code, message, opts = {}) {
      this.checkedSet.add(rule);
      const f = {
        rule,
        code,
        severity: opts.severity ?? "error",
        attribution: opts.attribution ?? "package",
        message
      };
      if (opts.path !== void 0) f.path = opts.path;
      if (opts.index !== void 0) f.index = opts.index;
      this.findings.push(f);
    }
    result() {
      const checked = RULE_IDS.filter((r) => this.checkedSet.has(r));
      return {
        ok: !this.findings.some((f) => f.severity === "error"),
        findings: this.findings.slice(),
        checked
      };
    }
  };

  // lib/alds/types.ts
  var ALDS_VERSION = "2.0";
  var XAPI_NS = "https://ambak.com/xapi/";
  var E = `${XAPI_NS}ext/`;
  var CMI5_SESSION_EXT = "https://w3id.org/xapi/cmi5/context/extensions/sessionid";
  var CMI5_CATEGORY = "https://w3id.org/xapi/cmi5/context/categories/cmi5";
  var CMI5_MOVEON_CATEGORY = "https://w3id.org/xapi/cmi5/context/categories/moveon";
  var CMI_INTERACTION_TYPE = "http://adlnet.gov/expapi/activities/cmi.interaction";
  var QUESTION_FAMILY_TYPE = `${XAPI_NS}activitytypes/question-family`;
  var VERB = {
    // sent by the AU (cmi5-defined)
    initialized: "http://adlnet.gov/expapi/verbs/initialized",
    completed: "http://adlnet.gov/expapi/verbs/completed",
    passed: "http://adlnet.gov/expapi/verbs/passed",
    failed: "http://adlnet.gov/expapi/verbs/failed",
    terminated: "http://adlnet.gov/expapi/verbs/terminated",
    // sent by the LMS only (cmi5-defined)
    launched: "http://adlnet.gov/expapi/verbs/launched",
    abandoned: "https://w3id.org/xapi/adl/verbs/abandoned",
    waived: "https://w3id.org/xapi/adl/verbs/waived",
    satisfied: "https://w3id.org/xapi/adl/verbs/satisfied",
    // other
    answered: "http://adlnet.gov/expapi/verbs/answered",
    voided: "http://adlnet.gov/expapi/verbs/voided"
  };
  var EXT = {
    profileVersion: `${E}profile-version`,
    // v1 key, value bumped to "2.0"
    standardVersion: `${E}content/standard-version`,
    engineVersion: `${E}content/engine-version`,
    // v1 key
    courseUlid: `${E}content/course-ulid`,
    courseVersion: `${E}content/course-version`,
    packageBuild: `${E}content/package-build`,
    language: `${E}content/language`,
    // v1 key
    packageId: `${E}content/package-id`,
    // v1 key (LMS-supplied)
    versionId: `${E}content/version-id`,
    // v1 key (LMS-supplied)
    attemptId: `${E}attempt/id`,
    // v1 key (LMS-supplied)
    registrationKind: `${E}registration/kind`,
    // LMS-supplied
    attemptIndex: `${E}registration/attempt-index`,
    // LMS-supplied: 1-based index of the attempt within its registration
    attemptNumber: `${E}attempt/number`,
    // v1 key, forwarder only (lib/lrs/context.ts); the engine MUST NOT set it
    questionQid: `${E}question/qid`,
    questionLanguage: `${E}question/language`,
    questionRevision: `${E}question/revision`,
    questionContentHash: `${E}question/content-hash`,
    questionDisplayOrder: `${E}question/display-order`,
    questionRun: `${E}question/run`,
    questionTry: `${E}question/try`,
    questionFinal: `${E}question/final`,
    questionDrawn: `${E}question/drawn`
  };
  var EXT_RESULT_UNANSWERED = `${E}question/unanswered`;
  var UNANSWERED_REASONS = ["timeout", "unanswered"];
  var REGISTRATION_KINDS = ["enrollment", "retake", "grant_retake"];
  var INTERACTION_KINDS = [
    "true-false",
    "choice",
    "fill-in",
    "long-fill-in",
    "matching",
    "performance",
    "sequencing",
    "likert",
    "numeric",
    "other"
  ];
  var SCRIPT_FOR_LANGUAGE = {
    en: "Latin",
    "en-IN": "Latin",
    "hi-Latn": "Latin",
    hi: "Devanagari",
    mr: "Devanagari",
    gu: "Gujarati",
    bn: "Bengali",
    pa: "Gurmukhi",
    ta: "Tamil",
    te: "Telugu",
    kn: "Kannada",
    ml: "Malayalam"
  };
  var KEY_CLASS_BY_AUTHORING_KIND = {
    choice: "keyed",
    "true-false": "keyed",
    "multi-response": "keyed",
    sequencing: "keyed",
    matching: "keyed",
    "drag-match": "keyed",
    "drag-drop": "keyed",
    "fill-in": "keyed",
    confidence: "keyed",
    swipe: "keyed",
    dialogue: "scored-unkeyed",
    game: "scored-unkeyed",
    "image-id": "scored-unkeyed",
    hotspot: "completion-only",
    "interactive-timeline": "completion-only",
    feedback: "unscored",
    slider: "unscored",
    dial: "unscored"
  };
  function langPath(lang) {
    return lang.toLowerCase();
  }
  function questionFamily(qid) {
    return `${XAPI_NS}activities/question/${qid}`;
  }
  function questionObject(qid, lang) {
    return `${XAPI_NS}activities/question/${qid}/${langPath(lang)}`;
  }
  function courseFamily(courseUlid) {
    return `${XAPI_NS}activities/course/${courseUlid}`;
  }
  function quizRun(quizId, lang) {
    return `${XAPI_NS}activities/quiz/${quizId}/${langPath(lang)}`;
  }
  function auActivityId(coursePackageId) {
    return `${XAPI_NS}activities/au/${coursePackageId}/1`;
  }

  // lib/alds/rules/util.ts
  function isObj(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function isStr(v) {
    return typeof v === "string";
  }
  function isNonEmptyStr(v) {
    return typeof v === "string" && v.length > 0;
  }
  function isInt(v, min) {
    return typeof v === "number" && Number.isInteger(v) && v >= min;
  }
  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }
  function get(o, k) {
    return isObj(o) && hasOwn(o, k) ? o[k] : void 0;
  }
  function getObj(o, k) {
    const v = get(o, k);
    return isObj(v) ? v : void 0;
  }
  function getArr(o, k) {
    const v = get(o, k);
    return Array.isArray(v) ? v : void 0;
  }
  var ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var SHA256_RE = /^sha256:[0-9a-f]{64}$/;
  var SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
  var OID_RE = /^o[1-9][0-9]*$/;
  var TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2}|[+-]\d{4})?$/;
  var DURATION_RE = /^P(?=\d|T\d)(?:\d+(?:\.\d+)?Y)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?W)?(?:\d+(?:\.\d+)?D)?(?:T(?=\d)(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/;
  function isUlid(v) {
    return typeof v === "string" && ULID_RE.test(v);
  }
  function isUuid(v) {
    return typeof v === "string" && UUID_RE.test(v);
  }
  function isSha256(v) {
    return typeof v === "string" && SHA256_RE.test(v);
  }
  function isSemver(v) {
    return typeof v === "string" && SEMVER_RE.test(v);
  }
  function isOid(v) {
    return typeof v === "string" && OID_RE.test(v);
  }
  function isDuration(v) {
    return typeof v === "string" && DURATION_RE.test(v);
  }
  function timestampState(v) {
    if (typeof v !== "string") return "invalid";
    const m = TIMESTAMP_RE.exec(v);
    if (!m) return "invalid";
    if (!m[1]) return "missing_offset";
    if (/^[+-]\d{4}$/.test(m[1])) return "invalid";
    return Number.isNaN(Date.parse(v)) ? "invalid" : "ok";
  }
  var BCP47_RE = /^[a-z]{2,3}(?:-[a-z]{3}){0,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[0-9a-wy-z](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?$/i;
  function isBcp47(v) {
    return typeof v === "string" && BCP47_RE.test(v);
  }
  function canonicalBcp47(tag) {
    const parts = tag.split("-");
    let pastSingleton = false;
    return parts.map((p, i) => {
      if (i === 0) return p.toLowerCase();
      if (pastSingleton) return p.toLowerCase();
      if (p.length === 1) {
        pastSingleton = true;
        return p.toLowerCase();
      }
      if (p.length === 4 && /^[a-z]{4}$/i.test(p)) return p[0].toUpperCase() + p.slice(1).toLowerCase();
      if (p.length === 2 && /^[a-z]{2}$/i.test(p)) return p.toUpperCase();
      return p.toLowerCase();
    }).join("-");
  }
  function primarySubtag(tag) {
    return tag.split("-")[0].toLowerCase();
  }
  function sameLanguageTag(a, b) {
    return a.toLowerCase() === b.toLowerCase();
  }
  function normalizeText(s) {
    return s.normalize("NFC").replace(/\s+/g, " ").trim();
  }
  function jsonEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
      return true;
    }
    if (isObj(a)) {
      if (!isObj(b)) return false;
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) if (!hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
      return true;
    }
    return false;
  }
  function duplicates(list) {
    const seen = /* @__PURE__ */ new Set();
    const dup = /* @__PURE__ */ new Set();
    for (const s of list) {
      if (seen.has(s)) dup.add(s);
      seen.add(s);
    }
    return Array.from(dup);
  }
  function sameSet(a, b) {
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size !== sb.size) return false;
    for (const x of sa) if (!sb.has(x)) return false;
    return true;
  }

  // lib/alds/rules/grammar.ts
  var LIST = "[,]";
  var PAIR = "[.]";
  var RANGE = "[:]";
  var ID_RE = /^[^\s[\]{}]+$/;
  var NUM_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
  function fail(code, message) {
    return { ok: false, code, message };
  }
  function splitList(text) {
    return text.split(LIST);
  }
  function badId(id) {
    return !ID_RE.test(id);
  }
  function parseIds(text, mode, ordered) {
    if (text === "") {
      if (mode === "pattern") return fail("empty", "an empty correct-response pattern");
      return [];
    }
    const ids = splitList(text);
    for (const id of ids) {
      if (badId(id)) return fail("bad_id", `"${id}" is not an id (no whitespace, brackets or braces)`);
    }
    if (new Set(ids).size !== ids.length) {
      return fail("duplicate_id", ordered ? "an id appears twice in the sequence" : "an id appears twice in the selection");
    }
    return ids;
  }
  function parseNumber(s) {
    return NUM_RE.test(s) ? Number(s) : null;
  }
  function parseRange(s) {
    const i = s.indexOf(RANGE);
    if (i < 0) {
      const n = parseNumber(s);
      return n === null ? null : { min: n, max: n };
    }
    const a = s.slice(0, i);
    const b = s.slice(i + RANGE.length);
    if (b.includes(RANGE)) return null;
    const min = a === "" ? null : parseNumber(a);
    const max = b === "" ? null : parseNumber(b);
    if (a !== "" && min === null || b !== "" && max === null) return null;
    if (min === null && max === null) return null;
    if (min !== null && max !== null && min > max) return null;
    return { min, max };
  }
  function takeFlags(text, allowed) {
    const flags = {};
    let rest = text;
    for (; ; ) {
      const m = /^\{(case_matters|order_matters)=([^}]*)\}/.exec(rest);
      if (!m) break;
      const name = m[1];
      if (!allowed.includes(name)) return { ok: false, code: "bad_parameter", message: `{${name}} is not valid here` };
      if (name in flags) return { ok: false, code: "bad_parameter", message: `{${name}} appears twice` };
      if (m[2] !== "true" && m[2] !== "false") {
        return { ok: false, code: "bad_parameter", message: `{${name}=${m[2]}} must be true or false` };
      }
      flags[name] = m[2] === "true";
      rest = rest.slice(m[0].length);
    }
    return { ok: true, rest, flags };
  }
  function parseInteraction(kind, text, mode) {
    switch (kind) {
      case "true-false": {
        if (text === "true" || text === "false") return { ok: true, value: { type: "true-false", value: text === "true" } };
        return fail("bad_boolean", `true-false expects "true" or "false", got "${text}"`);
      }
      case "choice":
      case "sequencing": {
        const r = parseIds(text, mode, kind === "sequencing");
        if (!Array.isArray(r)) return r;
        return { ok: true, value: { type: kind, ids: r } };
      }
      case "likert": {
        if (text === "" || text.includes(LIST) || badId(text)) return fail("bad_id", `likert expects a single scale id, got "${text}"`);
        return { ok: true, value: { type: "likert", id: text } };
      }
      case "matching": {
        if (text === "") {
          if (mode === "pattern") return fail("empty", "an empty correct-response pattern");
          return { ok: true, value: { type: "matching", pairs: [] } };
        }
        const pairs = [];
        const seen = /* @__PURE__ */ new Set();
        for (const item of splitList(text)) {
          const parts = item.split(PAIR);
          if (parts.length !== 2) return fail("bad_pair", `matching expects source[.]target, got "${item}"`);
          const [src, tgt] = parts;
          if (badId(src) || badId(tgt)) return fail("bad_id", `"${item}" holds an invalid id`);
          const key = `${src}\0${tgt}`;
          if (seen.has(key)) return fail("duplicate_pair", `the pair "${item}" appears twice`);
          seen.add(key);
          pairs.push([src, tgt]);
        }
        return { ok: true, value: { type: "matching", pairs } };
      }
      case "performance": {
        let body = text;
        let orderMatters = true;
        if (mode === "pattern") {
          const f = takeFlags(text, ["order_matters"]);
          if (!f.ok) return f;
          body = f.rest;
          if ("order_matters" in f.flags) orderMatters = f.flags.order_matters;
        } else if (/^\{(case_matters|order_matters)=/.test(text)) {
          return fail("parameter_in_response", "order_matters belongs in the pattern, not the response");
        }
        if (body === "") return fail("empty", "performance expects step[.]answer items");
        const steps = [];
        for (const item of splitList(body)) {
          const i = item.indexOf(PAIR);
          if (i < 0) return fail("bad_pair", `performance expects step[.]answer, got "${item}"`);
          const step = item.slice(0, i);
          const answer = item.slice(i + PAIR.length);
          if (badId(step)) return fail("bad_id", `"${step}" is not a step id`);
          if (answer === "" || answer.includes(PAIR)) return fail("bad_pair", `performance step "${step}" has no single answer`);
          let range = null;
          if (answer.includes(RANGE)) {
            if (mode === "response") return fail("bad_number", "a numeric range is valid in a pattern only");
            range = parseRange(answer);
            if (!range) return fail("bad_number", `"${answer}" is not a numeric range`);
          }
          steps.push({ step, answer, range });
        }
        return { ok: true, value: { type: "performance", steps, orderMatters } };
      }
      case "numeric": {
        if (mode === "response") {
          const n = parseNumber(text);
          if (n === null) return fail("bad_number", `numeric expects a number, got "${text}"`);
          return { ok: true, value: { type: "numeric", range: { min: n, max: n } } };
        }
        const r = parseRange(text);
        if (!r) return fail("bad_number", `numeric expects n or min[:]max, got "${text}"`);
        return { ok: true, value: { type: "numeric", range: r } };
      }
      case "fill-in":
      case "long-fill-in": {
        let body = text;
        let caseMatters = false;
        let orderMatters = true;
        if (mode === "pattern") {
          const f = takeFlags(text, ["case_matters", "order_matters"]);
          if (!f.ok) return f;
          body = f.rest;
          if ("case_matters" in f.flags) caseMatters = f.flags.case_matters;
          if ("order_matters" in f.flags) orderMatters = f.flags.order_matters;
          if (body === "") return fail("empty", "an empty correct-response pattern");
        } else if (/^\{(case_matters|order_matters)=/.test(text)) {
          return fail("parameter_in_response", "case_matters/order_matters belong in the pattern, not the response");
        }
        const items = [];
        if (body !== "") {
          for (const raw of splitList(body)) {
            let item = raw;
            let lang = null;
            const m = /^\{lang=([^}]*)\}/.exec(item);
            if (m) {
              if (!isBcp47(m[1])) return fail("bad_lang", `{lang=${m[1]}} is not a BCP 47 tag`);
              lang = m[1];
              item = item.slice(m[0].length);
            }
            if (mode === "pattern" && item === "") return fail("empty", "an empty accepted answer in the pattern");
            items.push({ text: item, lang });
          }
        }
        return { ok: true, value: { type: kind, items, caseMatters, orderMatters } };
      }
      case "other":
        return { ok: true, value: { type: "other", raw: text } };
      default:
        return fail("unknown_interaction_type", `"${kind}" is not an xAPI interactionType`);
    }
  }
  function referencedIds(p) {
    const out = { ids: [], sources: [], targets: [], steps: [] };
    if (p.type === "choice" || p.type === "sequencing") out.ids = p.ids.slice();
    else if (p.type === "likert") out.ids = [p.id];
    else if (p.type === "matching") {
      out.sources = p.pairs.map((x) => x[0]);
      out.targets = p.pairs.map((x) => x[1]);
    } else if (p.type === "performance") out.steps = p.steps.map((s) => s.step);
    return out;
  }
  function inRange(v, r) {
    return (r.min === null || v >= r.min) && (r.max === null || v <= r.max);
  }
  function fillText(s, caseMatters) {
    const n = normalizeText(s);
    return caseMatters ? n : n.toLowerCase();
  }
  function responseMatches(response, pattern) {
    if (response.type === "other" || pattern.type === "other") return null;
    if (response.type !== pattern.type) {
      const fill = (t) => t === "fill-in" || t === "long-fill-in";
      if (!(fill(response.type) && fill(pattern.type))) return false;
    }
    switch (pattern.type) {
      case "true-false":
        return response.type === "true-false" && response.value === pattern.value;
      case "choice": {
        if (response.type !== "choice") return false;
        const want = new Set(pattern.ids);
        return response.ids.length === want.size && response.ids.every((id) => want.has(id));
      }
      case "sequencing":
        return response.type === "sequencing" && response.ids.length === pattern.ids.length && response.ids.every((id, i) => id === pattern.ids[i]);
      case "likert":
        return response.type === "likert" && response.id === pattern.id;
      case "matching": {
        if (response.type !== "matching") return false;
        const want = new Set(pattern.pairs.map((x) => `${x[0]}\0${x[1]}`));
        return response.pairs.length === want.size && response.pairs.every((x) => want.has(`${x[0]}\0${x[1]}`));
      }
      case "numeric": {
        if (response.type !== "numeric" || response.range.min === null) return false;
        return inRange(response.range.min, pattern.range);
      }
      case "performance": {
        if (response.type !== "performance" || response.steps.length !== pattern.steps.length) return false;
        const stepOk = (r, p) => {
          if (r.step !== p.step) return false;
          if (p.range) {
            const n = parseNumber(r.answer);
            return n !== null && inRange(n, p.range);
          }
          return r.answer === p.answer;
        };
        if (pattern.orderMatters) return pattern.steps.every((p, i) => stepOk(response.steps[i], p));
        const used = /* @__PURE__ */ new Set();
        return pattern.steps.every((p) => {
          const j = response.steps.findIndex((r, k) => !used.has(k) && stepOk(r, p));
          if (j < 0) return false;
          used.add(j);
          return true;
        });
      }
      case "fill-in":
      case "long-fill-in": {
        if (response.type !== "fill-in" && response.type !== "long-fill-in") return false;
        if (response.items.length !== pattern.items.length) return false;
        const r = response.items.map((x) => fillText(x.text, pattern.caseMatters));
        const p = pattern.items.map((x) => fillText(x.text, pattern.caseMatters));
        if (pattern.orderMatters) return r.every((x, i) => x === p[i]);
        return r.slice().sort().join("\0") === p.slice().sort().join("\0");
      }
    }
    return null;
  }
  function canonicalPatternKey(p) {
    const sep = "";
    switch (p.type) {
      case "true-false":
        return `tf${sep}${p.value}`;
      case "choice":
        return `c${sep}${p.ids.slice().sort().join(sep)}`;
      case "sequencing":
        return `s${sep}${p.ids.join(sep)}`;
      case "likert":
        return `l${sep}${p.id}`;
      case "matching":
        return `m${sep}${p.pairs.map((x) => `${x[0]}\0${x[1]}`).sort().join(sep)}`;
      case "numeric":
        return `n${sep}${p.range.min}${sep}${p.range.max}`;
      case "performance": {
        const steps = p.steps.map((s) => s.range ? `${s.step}\0${s.range.min}:${s.range.max}` : `${s.step}\0${s.answer}`);
        return `p${sep}${p.orderMatters}${sep}${(p.orderMatters ? steps : steps.slice().sort()).join(sep)}`;
      }
      case "fill-in":
      case "long-fill-in": {
        const items = p.items.map((x) => `${x.lang ?? ""}\0${normalizeText(x.text)}`);
        return `f${sep}${p.caseMatters}${sep}${p.orderMatters}${sep}${(p.orderMatters ? items : items.slice().sort()).join(sep)}`;
      }
      case "other":
        return `o${sep}${p.raw}`;
    }
  }

  // lib/alds/rules/statement.ts
  var AU_VERBS = [VERB.initialized, VERB.completed, VERB.passed, VERB.failed, VERB.terminated];
  var OUTCOME_VERBS = [VERB.completed, VERB.passed, VERB.failed];
  var LMS_VERBS = [VERB.launched, VERB.abandoned, VERB.waived, VERB.satisfied];
  var QUIZ_PREFIX = `${XAPI_NS}activities/quiz/`;
  function extPath(key) {
    return `context.extensions[${key.startsWith(E) ? `E:${key.slice(E.length)}` : key}]`;
  }
  function parseQuizRunIri(id) {
    if (!isStr(id) || !id.startsWith(QUIZ_PREFIX)) return null;
    const rest = id.slice(QUIZ_PREFIX.length).split("/");
    if (rest.length !== 2 || rest[0] === "" || rest[1] === "") return null;
    return { quizId: rest[0], lang: rest[1] };
  }
  function categoryIds(context) {
    const cats = getArr(getObj(context, "contextActivities"), "category") ?? [];
    return cats.map((c) => get(c, "id")).filter(isStr);
  }
  function groupingIds(context) {
    const g = getArr(getObj(context, "contextActivities"), "grouping") ?? [];
    return g.map((c) => get(c, "id")).filter(isStr);
  }
  function expectedAuId(statement, ctx) {
    if (ctx.auActivityId) return ctx.auActivityId;
    const fromTemplate = ctx.launchData?.contextTemplate?.extensions?.[EXT.packageId];
    if (isUuid(fromTemplate)) return auActivityId(fromTemplate);
    const own = get(getObj(getObj(statement, "context"), "extensions"), EXT.packageId);
    return isUuid(own) ? auActivityId(own) : void 0;
  }
  function classifyStatement(statement, auId) {
    const verbId = get(getObj(statement, "verb"), "id");
    const objectId = get(getObj(statement, "object"), "id");
    const cats = categoryIds(getObj(statement, "context"));
    if (!isStr(verbId)) return "other";
    if (OUTCOME_VERBS.includes(verbId) && parseQuizRunIri(objectId)) return "run-summary";
    if (AU_VERBS.includes(verbId) && (auId !== void 0 && objectId === auId || cats.includes(CMI5_CATEGORY))) return "au-defined";
    if (verbId === VERB.answered) return "answered";
    if (LMS_VERBS.includes(verbId)) return "lms-defined";
    return "other";
  }
  function keyClassOf(entry) {
    const k = entry.authoringKind;
    if (isStr(k) && hasOwn(KEY_CLASS_BY_AUTHORING_KIND, k)) return KEY_CLASS_BY_AUTHORING_KIND[k];
    return Array.isArray(entry.correct) && entry.correct.length > 0 ? "keyed" : "scored-unkeyed";
  }
  var COMPONENTS = {
    choice: ["choices"],
    sequencing: ["choices"],
    likert: ["scale"],
    matching: ["source", "target"],
    performance: ["steps"]
  };
  function langMapKeys(v) {
    if (!isObj(v)) return null;
    const keys = Object.keys(v);
    return keys.every((k) => isStr(v[k])) ? keys : null;
  }
  function langMapText(v, lang) {
    if (!isObj(v)) return void 0;
    for (const k of Object.keys(v)) if (sameLanguageTag(k, lang) && isStr(v[k])) return v[k];
    return void 0;
  }
  function safeQuestions(m) {
    return m && Array.isArray(m.questions) ? m.questions.filter(isObj) : [];
  }
  function safeQuizzes(m) {
    return m && Array.isArray(m.quizzes) ? m.quizzes.filter(isObj) : [];
  }
  function checkStatement(statement, ctx = {}) {
    const r = new Report();
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
    const object = statement.object;
    r.check("S9");
    if (verbId === VERB.voided) r.add("S9", "void_not_allowed", "content must not send a voiding statement", { path: "verb.id" });
    if (object.objectType === "StatementRef") r.add("S9", "statement_ref_not_allowed", "content must not send a StatementRef object", { path: "object.objectType" });
    if (object.objectType === "SubStatement") r.add("S9", "substatement_not_allowed", "content must not send a SubStatement object", { path: "object.objectType" });
    if (r.findings.length > 0) return r.result();
    r.check("S8");
    if (statement.id === void 0) r.add("S8", "id_missing", "id (UUID) is required", { path: "id" });
    else if (!isUuid(statement.id)) r.add("S8", "id_invalid", "id is not a UUID", { path: "id" });
    if (statement.timestamp === void 0) r.add("S8", "timestamp_missing", "timestamp is required", { path: "timestamp" });
    else {
      const ts = timestampState(statement.timestamp);
      if (ts === "missing_offset") r.add("S8", "timestamp_no_offset", "timestamp needs an explicit offset (Z or \xB1hh:mm)", { path: "timestamp" });
      else if (ts === "invalid") r.add("S8", "timestamp_invalid", "timestamp is not ISO 8601", { path: "timestamp" });
    }
    const context = getObj(statement, "context");
    const ext = getObj(context, "extensions") ?? {};
    const result = getObj(statement, "result");
    const tpl = ctx.launchData?.contextTemplate;
    r.check("E1");
    const engineExt = [
      [EXT.profileVersion, (v) => v === "2.0", '"2.0"'],
      [EXT.standardVersion, (v) => v === "2.0", '"2.0"'],
      [EXT.engineVersion, isNonEmptyStr, "a non-empty string"],
      [EXT.courseUlid, isUlid, "a ULID"],
      [EXT.courseVersion, isSemver, "semver MAJOR.MINOR.PATCH"],
      [EXT.packageBuild, isUuid, "a UUID"]
    ];
    for (const [key, ok, want] of engineExt) {
      if (!hasOwn(ext, key)) r.add("E1", "engine_extension_missing", `${key} is required on every statement`, { path: extPath(key) });
      else if (!ok(ext[key])) r.add("E1", "engine_extension_invalid", `${key} must be ${want}`, { path: extPath(key) });
    }
    if (hasOwn(ext, EXT.attemptNumber)) {
      r.add("E1", "attempt_number_set_by_engine", "attempt/number is set by the LMS forwarder only; the engine must not send it", { path: extPath(EXT.attemptNumber) });
    }
    r.check("S1");
    const lmsExt = [
      [EXT.language, isBcp47, "a BCP 47 tag"],
      [EXT.packageId, isUuid, "a UUID"],
      [EXT.versionId, isUuid, "a UUID"],
      [EXT.attemptId, isUuid, "a UUID"],
      [EXT.registrationKind, (v) => isStr(v) && REGISTRATION_KINDS.includes(v), "enrollment | retake | grant_retake"],
      [EXT.attemptIndex, (v) => isInt(v, 1), "an integer \u2265 1"]
    ];
    const lms = { attribution: "lms" };
    for (const [key, ok, want] of lmsExt) {
      if (!hasOwn(ext, key)) r.add("S1", "template_extension_missing", `${key} from the LMS contextTemplate is missing`, { ...lms, path: extPath(key) });
      else if (!ok(ext[key])) r.add("S1", "template_extension_invalid", `${key} must be ${want}`, { ...lms, path: extPath(key) });
    }
    if (tpl && isObj(tpl.extensions)) {
      for (const key of Object.keys(tpl.extensions)) {
        if (key === CMI5_SESSION_EXT || !hasOwn(ext, key)) continue;
        if (!jsonEqual(ext[key], tpl.extensions[key])) {
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
    r.check("S7");
    const registration = get(context, "registration");
    if (registration === void 0) r.add("S7", "registration_missing", "context.registration is missing", { ...lms, path: "context.registration" });
    else if (!isUuid(registration)) r.add("S7", "registration_invalid", "context.registration is not a UUID", { ...lms, path: "context.registration" });
    const sessionId = ext[CMI5_SESSION_EXT];
    if (!isNonEmptyStr(sessionId)) r.add("S7", "session_id_missing", "the cmi5 sessionid extension is missing", { ...lms, path: extPath(CMI5_SESSION_EXT) });
    if (tpl) {
      if (isUuid(registration) && registration !== tpl.registration) {
        r.add("S7", "registration_changed", "context.registration differs from the template", { ...lms, path: "context.registration" });
      }
      const tplSession = isObj(tpl.extensions) ? tpl.extensions[CMI5_SESSION_EXT] : void 0;
      if (isNonEmptyStr(sessionId) && tplSession !== void 0 && sessionId !== tplSession) {
        r.add("S7", "session_id_changed", "the sessionid extension differs from the template", { ...lms, path: extPath(CMI5_SESSION_EXT) });
      }
    }
    const auId = expectedAuId(statement, ctx);
    const cls = classifyStatement(statement, auId);
    const cats = categoryIds(context);
    const hasCmi5 = cats.includes(CMI5_CATEGORY);
    const hasMoveOn = cats.includes(CMI5_MOVEON_CATEGORY);
    const objectId = object.id;
    r.check("S2");
    if (cls === "au-defined") {
      if (!hasCmi5) r.add("S2", "cmi5_category_missing", "a cmi5-defined statement must carry the cmi5 category", { path: "context.contextActivities.category" });
      if (auId !== void 0 && objectId !== auId) r.add("S2", "object_not_au_activity", `object.id must be the LMS AU id ${auId}`, { path: "object.id" });
      const isOutcome = OUTCOME_VERBS.includes(verbId);
      if (isOutcome && !hasMoveOn) r.add("S2", "moveon_category_missing", "completed/passed/failed must carry the moveOn category", { path: "context.contextActivities.category" });
      if (!isOutcome && hasMoveOn) r.add("S2", "moveon_category_on_non_outcome", "only completed/passed/failed carry the moveOn category", { path: "context.contextActivities.category" });
      if (isOutcome || verbId === VERB.terminated) {
        const d = get(result, "duration");
        if (d === void 0) r.add("S2", "duration_missing", "result.duration is required", { path: "result.duration" });
        else if (!isDuration(d)) r.add("S2", "duration_invalid", "result.duration is not an ISO 8601 duration", { path: "result.duration" });
      }
      if (verbId === VERB.completed && get(result, "completion") !== true) {
        r.add("S2", "completion_missing", "completed must carry result.completion = true", { path: "result.completion" });
      }
      if (verbId === VERB.passed || verbId === VERB.failed) {
        const want = verbId === VERB.passed;
        const s = get(result, "success");
        if (s === void 0) r.add("S2", "success_missing", `${verbId === VERB.passed ? "passed" : "failed"} must carry result.success`, { path: "result.success" });
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
    const runTarget = parseQuizRunIri(objectId);
    if (cls === "answered" && runTarget) {
      r.add("S4", "run_summary_as_answered", "a quiz run summary must not be sent as answered", { path: "verb.id" });
      return r.result();
    }
    if (cls === "run-summary" && runTarget) {
      r.check("S4");
      if (hasCmi5) r.add("S4", "cmi5_category_on_run_summary", "a quiz run summary carries no cmi5 category", { path: "context.contextActivities.category" });
      if (hasMoveOn) r.add("S4", "moveon_category_on_run_summary", "a quiz run summary carries no moveOn category", { path: "context.contextActivities.category" });
      if (!isInt(ext[EXT.questionRun], 1)) r.add("S4", "run_missing", "question/run (integer \u2265 1) is required", { path: extPath(EXT.questionRun) });
      const drawn = ext[EXT.questionDrawn];
      if (!Array.isArray(drawn) || drawn.length === 0) r.add("S4", "drawn_missing", "question/drawn (the drawn qids) is required", { path: extPath(EXT.questionDrawn) });
      else if (!drawn.every(isUlid) || duplicates(drawn).length > 0) {
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
          const outside = drawn.filter((q) => !bank.includes(q));
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
  function checkAnswered(r, statement, object, ext, result, ctx) {
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
    const kind = isStr(it) && INTERACTION_KINDS.includes(it) ? it : null;
    if (!kind) r.add("S3", "interaction_type_invalid", "object.definition.interactionType is not an xAPI interaction type", { path: "object.definition.interactionType" });
    const qid = ext[EXT.questionQid];
    const qlang = ext[EXT.questionLanguage];
    const qExt = [
      [EXT.questionQid, isUlid, "a ULID"],
      [EXT.questionLanguage, isBcp47, "a BCP 47 tag"],
      [EXT.questionRevision, (v) => isInt(v, 1), "an integer \u2265 1"],
      [EXT.questionContentHash, isSha256, "sha256:<64 hex>"],
      [EXT.questionTry, (v) => isInt(v, 1), "an integer \u2265 1"],
      [EXT.questionFinal, (v) => typeof v === "boolean", "a boolean"]
    ];
    for (const [key, ok, want] of qExt) {
      if (!hasOwn(ext, key)) r.add("S3", "question_extension_missing", `${key} is required on answered`, { path: extPath(key) });
      else if (!ok(ext[key])) r.add("S3", "question_extension_invalid", `${key} must be ${want}`, { path: extPath(key) });
    }
    if (hasOwn(ext, EXT.questionRun) && !isInt(ext[EXT.questionRun], 1)) {
      r.add("S3", "question_extension_invalid", `${EXT.questionRun} must be an integer \u2265 1`, { path: extPath(EXT.questionRun) });
    }
    const qidOk = isUlid(qid);
    const langOk = isBcp47(qlang);
    if (qidOk && langOk && object.id !== questionObject(qid, qlang)) {
      r.add("S3", "object_id_not_question_iri", `object.id must be ${questionObject(qid, qlang)}`, { path: "object.id" });
    }
    if (qidOk && !groupingIds(getObj(statement, "context")).includes(questionFamily(qid))) {
      r.add("S3", "question_family_missing", `contextActivities.grouping must include ${questionFamily(qid)}`, { path: "context.contextActivities.grouping" });
    }
    const checkLangMap = (v, path) => {
      if (!langOk) return;
      const keys = langMapKeys(v);
      if (!keys || keys.length !== 1 || !sameLanguageTag(keys[0], qlang)) {
        r.add("S3", "label_language_mismatch", `${path} must be keyed by the question language ${qlang} only`, { path });
      }
    };
    if (def.name === void 0) r.add("S3", "name_missing", "object.definition.name is required", { path: "object.definition.name" });
    else checkLangMap(def.name, "object.definition.name");
    if (def.description === void 0) r.add("S5", "description_missing", "object.definition.description must hold the full stem", { path: "object.definition.description" });
    else checkLangMap(def.description, "object.definition.description");
    const componentIds = {};
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
    const allComponentIds = [].concat(...Object.keys(componentIds).map((k) => componentIds[k]));
    if (kind === "choice" || kind === "sequencing") {
      const order = ext[EXT.questionDisplayOrder];
      if (order === void 0) r.add("S3", "display_order_missing", "question/display-order should list the oids in the order shown", { severity: "warn", path: extPath(EXT.questionDisplayOrder) });
      else if (!Array.isArray(order) || !order.every(isStr) || order.length !== (componentIds.choices ?? []).length || !sameSet(order, componentIds.choices ?? [])) {
        r.add("S3", "display_order_mismatch", "question/display-order should be a permutation of the choice ids", { severity: "warn", path: extPath(EXT.questionDisplayOrder) });
      }
    }
    const idsKnown = (p) => {
      const ref = referencedIds(p);
      const pool = (name) => componentIds[name] ?? [];
      if (kind === "choice" || kind === "sequencing") return ref.ids.every((id) => pool("choices").includes(id));
      if (kind === "likert") return ref.ids.every((id) => pool("scale").includes(id));
      if (kind === "matching") return ref.sources.every((id) => pool("source").includes(id)) && ref.targets.every((id) => pool("target").includes(id));
      if (kind === "performance") return ref.steps.every((id) => pool("steps").includes(id));
      return true;
    };
    r.check("R10");
    const patternsRaw = def.correctResponsesPattern;
    const stmtPatterns = [];
    let patternsValid = true;
    if (patternsRaw !== void 0) {
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
    let response = null;
    let markerValid = false;
    const success = get(result, "success");
    if (!result) {
      r.add("S3", "result_missing", "answered needs a result", { path: "result" });
    } else {
      const marker = get(getObj(result, "extensions"), EXT_RESULT_UNANSWERED);
      markerValid = isStr(marker) && UNANSWERED_REASONS.includes(marker);
      if (marker !== void 0 && !markerValid) {
        r.add("S3", "unanswered_marker_invalid", `the unanswered marker must be one of ${UNANSWERED_REASONS.join(", ")}`, { path: "result.extensions" });
      }
      const resp = result.response;
      if (resp === void 0) r.add("S3", "response_missing", "result.response is required", { path: "result.response" });
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
    const questions = safeQuestions(ctx.manifest);
    const entry = ctx.manifest && qidOk && langOk ? questions.find((q) => q.qid === qid && isStr(q.language) && sameLanguageTag(q.language, qlang)) : void 0;
    const cls = entry ? keyClassOf(entry) : null;
    if (result) {
      if (markerValid) {
        if (success === true) r.add("S3", "unanswered_marked_success", "an unanswered/timed-out question cannot be successful", { path: "result.success" });
        else if (success !== void 0 && success !== false) r.add("S3", "success_invalid", "result.success must be a boolean", { path: "result.success" });
      } else if (cls === "unscored") {
      } else if (cls === "completion-only") {
        if (success !== void 0 && typeof success !== "boolean") r.add("S3", "success_invalid", "result.success must be a boolean", { path: "result.success" });
      } else if (typeof success !== "boolean") {
        r.add("S3", success === void 0 ? "success_missing" : "success_invalid", "result.success (boolean) is required on answered", { path: "result.success" });
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
    const desc = langOk ? langMapText(def.description, qlang) : void 0;
    if (desc !== void 0 && isStr(entry.prompt) && normalizeText(desc) !== normalizeText(entry.prompt)) {
      r.add("S5", "description_not_full_stem", "object.definition.description differs from the manifest prompt (truncated or edited)", { path: "object.definition.description" });
    }
    const options = Array.isArray(entry.options) ? entry.options.filter(isObj) : [];
    if (kind && langOk) {
      for (const list of COMPONENTS[kind] ?? []) {
        for (const c of getArr(def, list) ?? []) {
          const id = get(c, "id");
          const opt = options.find((o) => o.oid === id);
          const text = langMapText(get(c, "description"), qlang);
          if (opt && isStr(opt.label) && text !== void 0 && normalizeText(text) !== normalizeText(opt.label)) {
            r.add("S5", "option_text_differs", `the text of ${String(id)} differs from the manifest label`, { path: `object.definition.${list}` });
          }
        }
      }
    }
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
      if (success !== void 0) r.add("SEM", "success_on_unscored", "an unscored item must not report result.success", { path: "result.success" });
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
    const manifestPatterns = [];
    for (const p of correct) {
      const parsed = parseInteraction(kind, p, "pattern");
      if (parsed.ok) manifestPatterns.push(parsed.value);
    }
    if (patternsRaw === void 0) {
      r.add("SEM", "pattern_missing", "a keyed question must send correctResponsesPattern", { path: "object.definition.correctResponsesPattern" });
    } else if (patternsValid) {
      const a = stmtPatterns.map(canonicalPatternKey);
      const b = manifestPatterns.map(canonicalPatternKey);
      if (!sameSet(a, b) || a.length !== b.length) {
        r.add("SEM", "pattern_differs_from_manifest", "correctResponsesPattern differs from the manifest key", { path: "object.definition.correctResponsesPattern" });
      }
    }
    if (response && !markerValid && typeof success === "boolean" && manifestPatterns.length > 0) {
      const expected = manifestPatterns.some((p) => responseMatches(response, p) === true);
      if (expected !== success) {
        r.add("SEM", "success_contradicts_key", `result.success is ${success} but the response ${expected ? "matches" : "does not match"} the key`, { path: "result.success" });
      }
    }
  }

  // lib/alds/rules/session.ts
  function checkSession(statements, ctx = {}) {
    const r = new Report();
    r.check("G3");
    r.check("R5");
    if (!Array.isArray(statements)) {
      r.add("G3", "not_an_array", "checkSession expects an array of statements");
      return r.result();
    }
    const seenIds = /* @__PURE__ */ new Set();
    const sessions = /* @__PURE__ */ new Map();
    const regs = /* @__PURE__ */ new Map();
    statements.forEach((s, index) => {
      if (!isObj(s)) return;
      const verbId = get(getObj(s, "verb"), "id");
      if (!isStr(verbId) || !isObj(s.object)) return;
      if (isNonEmptyStr(s.id)) {
        if (seenIds.has(s.id)) return;
        seenIds.add(s.id);
      }
      const context = getObj(s, "context");
      const sessionKey = String(get(getObj(context, "extensions"), CMI5_SESSION_EXT) ?? "");
      const regKey = String(get(context, "registration") ?? "");
      const cls = classifyStatement(s, expectedAuId(s, ctx));
      const isAu = cls === "au-defined";
      const state = sessions.get(sessionKey) ?? "before-init";
      if (isAu && verbId === VERB.initialized) {
        if (state === "open") {
          r.add("G3", "initialized_twice", "a second initialized while the session is open", { index });
        } else if (state === "closed") {
          r.add("G3", "session_reinitialized", "initialized again after terminated under the same sessionid (new launch without a new sessionid, or an engine reopen)", {
            index,
            severity: "warn",
            attribution: "lms"
          });
        }
        sessions.set(sessionKey, "open");
      } else if (state === "before-init") {
        if (cls !== "lms-defined") r.add("G3", "statement_before_initialized", "a statement before initialized in its session", { index });
      } else if (state === "closed") {
        if (cls !== "lms-defined") r.add("G3", "statement_after_terminated", "a statement after terminated in its session", { index });
      } else if (isAu && verbId === VERB.terminated) {
        sessions.set(sessionKey, "closed");
      }
      if (!isAu) return;
      const reg = regs.get(regKey) ?? { completed: 0, passed: 0, passedAt: -1 };
      regs.set(regKey, reg);
      if (verbId === VERB.completed) {
        reg.completed++;
        if (reg.completed > 1) r.add("R5", "completed_twice", "a second AU-level completed in one registration", { index });
      } else if (verbId === VERB.passed) {
        reg.passed++;
        if (reg.passed > 1) r.add("R5", "passed_twice", "a second AU-level passed in one registration", { index });
        if (reg.passedAt < 0) reg.passedAt = index;
      } else if (verbId === VERB.failed && reg.passedAt >= 0) {
        r.add("R5", "failed_after_passed", "an AU-level failed after passed in one registration", { index });
      }
    });
    return r.result();
  }

  // lib/alds/rules/sha256.ts
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  function utf8Encode(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let cp = s.charCodeAt(i);
      if (cp >= 55296 && cp <= 56319) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (next >= 56320 && next <= 57343) {
          cp = 65536 + (cp - 55296 << 10) + (next - 56320);
          i++;
        } else {
          cp = 65533;
        }
      } else if (cp >= 56320 && cp <= 57343) {
        cp = 65533;
      }
      if (cp < 128) out.push(cp);
      else if (cp < 2048) out.push(192 | cp >> 6, 128 | cp & 63);
      else if (cp < 65536) out.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
      else out.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
    }
    return new Uint8Array(out);
  }
  function sha256Hex(bytes) {
    const len = bytes.length;
    const bitLenHi = Math.floor(len / 536870912);
    const bitLenLo = len * 8 >>> 0;
    const padded = new Uint8Array(len + 9 + 63 >> 6 << 6);
    padded.set(bytes);
    padded[len] = 128;
    const end = padded.length;
    padded[end - 8] = bitLenHi >>> 24 & 255;
    padded[end - 7] = bitLenHi >>> 16 & 255;
    padded[end - 6] = bitLenHi >>> 8 & 255;
    padded[end - 5] = bitLenHi & 255;
    padded[end - 4] = bitLenLo >>> 24 & 255;
    padded[end - 3] = bitLenLo >>> 16 & 255;
    padded[end - 2] = bitLenLo >>> 8 & 255;
    padded[end - 1] = bitLenLo & 255;
    const h = new Uint32Array([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    const w = new Uint32Array(64);
    for (let off = 0; off < end; off += 64) {
      for (let t = 0; t < 16; t++) {
        const j = off + t * 4;
        w[t] = (padded[j] << 24 | padded[j + 1] << 16 | padded[j + 2] << 8 | padded[j + 3]) >>> 0;
      }
      for (let t = 16; t < 64; t++) {
        const x = w[t - 15];
        const y = w[t - 2];
        const s0 = (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3;
        const s1 = (y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10;
        w[t] = w[t - 16] + s0 + w[t - 7] + s1 >>> 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let t = 0; t < 64; t++) {
        const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        const ch = e & f ^ ~e & g;
        const t1 = hh + S1 + ch + K[t] + w[t] >>> 0;
        const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = S0 + maj >>> 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      h[0] = h[0] + a >>> 0;
      h[1] = h[1] + b >>> 0;
      h[2] = h[2] + c >>> 0;
      h[3] = h[3] + d >>> 0;
      h[4] = h[4] + e >>> 0;
      h[5] = h[5] + f >>> 0;
      h[6] = h[6] + g >>> 0;
      h[7] = h[7] + hh >>> 0;
    }
    let hex = "";
    for (let i = 0; i < 8; i++) hex += ("00000000" + h[i].toString(16)).slice(-8);
    return hex;
  }
  function sha256HexOfString(s) {
    return sha256Hex(utf8Encode(s));
  }

  // lib/alds/rules/content-hash.ts
  function canonicalContentJson(entry) {
    const s = (v) => JSON.stringify(normalizeText(v));
    const options = entry.options.map((o) => `{"label":${s(o.label)},"oid":${s(o.oid)}}`).join(",");
    const correct = entry.correct.map(s).join(",");
    return `{"correct":[${correct}],"kind":${s(entry.kind)},"lang":${s(entry.language)},"options":[${options}],"prompt":${s(entry.prompt)},"qid":${s(entry.qid)}}`;
  }
  function contentHash(entry) {
    return `sha256:${sha256HexOfString(canonicalContentJson(entry))}`;
  }

  // lib/alds/rules/script.ts
  var BLOCKS = [
    [65, 90, "Latin"],
    [97, 122, "Latin"],
    [192, 591, "Latin"],
    [7680, 7935, "Latin"],
    [2304, 2431, "Devanagari"],
    [43232, 43263, "Devanagari"],
    [2432, 2559, "Bengali"],
    [2560, 2687, "Gurmukhi"],
    [2688, 2815, "Gujarati"],
    [2944, 3071, "Tamil"],
    [3072, 3199, "Telugu"],
    [3200, 3327, "Kannada"],
    [3328, 3455, "Malayalam"]
  ];
  var SCRIPT_SUBTAG = {
    latn: "Latin",
    deva: "Devanagari",
    gujr: "Gujarati",
    beng: "Bengali",
    guru: "Gurmukhi",
    taml: "Tamil",
    telu: "Telugu",
    knda: "Kannada",
    mlym: "Malayalam"
  };
  var HINGLISH_WORDS = /* @__PURE__ */ new Set([
    "hai",
    "hain",
    "ka",
    "ki",
    "ke",
    "ko",
    "se",
    "mein",
    "aur",
    "nahi",
    "nahin",
    "kya",
    "aap",
    "hum",
    "ham",
    "yeh",
    "ye",
    "woh",
    "wo",
    "toh",
    "bhi",
    "par",
    "kaise",
    "kyun",
    "kyon",
    "apna",
    "apne",
    "apni",
    "karna",
    "karein",
    "kare",
    "karo",
    "hota",
    "hoti",
    "hote",
    "tha",
    "thi",
    "ek",
    "sab",
    "jab",
    "agar"
  ]);
  var ENGLISH_WORDS = /* @__PURE__ */ new Set([
    "the",
    "and",
    "is",
    "are",
    "of",
    "in",
    "you",
    "your",
    "for",
    "with",
    "this",
    "that",
    "it",
    "on",
    "be",
    "can",
    "will",
    "what",
    "how",
    "when",
    "if",
    "or",
    "not",
    "a",
    "an",
    "we",
    "our",
    "they",
    "from",
    "by"
  ]);
  function blockOf(cp) {
    for (const [lo, hi, s] of BLOCKS) if (cp >= lo && cp <= hi) return s;
    return null;
  }
  function detectScript(text) {
    const counts = {
      Latin: 0,
      Devanagari: 0,
      Gujarati: 0,
      Bengali: 0,
      Gurmukhi: 0,
      Tamil: 0,
      Telugu: 0,
      Kannada: 0,
      Malayalam: 0,
      Other: 0
    };
    let letters = 0;
    for (const ch of text) {
      if (!/[\p{L}\p{M}]/u.test(ch)) continue;
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 215 || cp === 247) continue;
      counts[blockOf(cp) ?? "Other"]++;
      letters++;
    }
    let dominant = null;
    let best = 0;
    for (const k of Object.keys(counts)) {
      if (counts[k] > best) {
        best = counts[k];
        dominant = k;
      }
    }
    let h = 0;
    let e = 0;
    for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (HINGLISH_WORDS.has(w)) h++;
      else if (ENGLISH_WORDS.has(w)) e++;
    }
    return {
      letters,
      counts,
      dominant,
      dominantPct: letters === 0 ? 0 : Math.round(best / letters * 1e3) / 10,
      hinglishWords: h,
      englishWords: e,
      hinglishScore: h + e > 0 ? Math.round(h / (h + e) * 100) / 100 : null
    };
  }
  function scriptForLanguage(tag) {
    const lower = tag.toLowerCase();
    for (const k of Object.keys(SCRIPT_FOR_LANGUAGE)) if (k.toLowerCase() === lower) return SCRIPT_FOR_LANGUAGE[k];
    for (const part of lower.split("-").slice(1)) {
      if (part.length === 4 && SCRIPT_SUBTAG[part]) return SCRIPT_SUBTAG[part];
    }
    const primary = primarySubtag(tag);
    for (const k of Object.keys(SCRIPT_FOR_LANGUAGE)) if (k.toLowerCase() === primary) return SCRIPT_FOR_LANGUAGE[k];
    return null;
  }

  // lib/alds/rules/package.ts
  var U4_SCRIPT_SHARE = 0.9;
  var XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  function decodeXmlEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, ref) => {
      if (ref[0] === "#") {
        const cp = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return cp <= 1114111 ? String.fromCodePoint(cp) : m;
      }
      return XML_ENTITIES[ref] ?? m;
    });
  }
  function xmlAttributeValues(xml, element, attr) {
    const out = [];
    const el = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${element}(?=[\\s/>])([^>]*)>`, "g");
    const at = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`);
    let m;
    while ((m = el.exec(xml)) !== null) {
      const a = at.exec(m[1]);
      if (a) out.push(decodeXmlEntities(a[2] ?? a[3] ?? ""));
    }
    return out;
  }
  function stripXmlComments(xml) {
    return xml.replace(/<!--[\s\S]*?-->/g, "");
  }
  function checkPackage(input) {
    const r = new Report();
    const done = (manifest) => ({ ...r.result(), manifest });
    if (input.manifestText === null || input.manifestText === void 0) return done(null);
    r.check("U1");
    let raw;
    try {
      const text = input.manifestText;
      raw = JSON.parse(text.charCodeAt(0) === 65279 ? text.slice(1) : text);
    } catch {
      r.add("U1", "manifest_unparseable", "alds-manifest.json is not valid JSON", { path: "alds-manifest.json" });
      return done(null);
    }
    if (!isObj(raw)) {
      r.add("U1", "manifest_unparseable", "alds-manifest.json must hold a JSON object", { path: "alds-manifest.json" });
      return done(null);
    }
    if (raw.standardVersion !== "2.0") {
      r.add("U1", "standard_version_unsupported", `standardVersion ${JSON.stringify(raw.standardVersion)} is not supported (2.0)`, { path: "standardVersion" });
      return done(null);
    }
    const before = r.findings.length;
    const field = (path, ok, want) => {
      if (!ok) r.add("U1", "manifest_field_invalid", `${path} must be ${want}`, { path });
    };
    field("engineVersion", isNonEmptyStr(raw.engineVersion), "a non-empty string");
    field("courseUlid", isUlid(raw.courseUlid), "a ULID");
    field("courseTitle", isStr(raw.courseTitle), "a string");
    field("courseVersion", isSemver(raw.courseVersion), "semver");
    field("packageBuild", isUuid(raw.packageBuild), "a UUID");
    field("language", isStr(raw.language) && raw.language !== "", "a language tag");
    field("manifestType", raw.manifestType === "cmi5" || raw.manifestType === "xapi" || raw.manifestType === "scorm12", "cmi5 | xapi | scorm12");
    const pub = raw.publisherIds;
    field(
      "publisherIds",
      isObj(pub) && isNonEmptyStr(pub.course) && Array.isArray(pub.au) && pub.au.every(isNonEmptyStr),
      "{ course: string, au: string[] }"
    );
    field("rulesBundleHash", isSha256(raw.rulesBundleHash), "sha256:<64 hex>");
    const questions = Array.isArray(raw.questions) ? raw.questions : null;
    field("questions", questions !== null, "an array");
    const quizzes = Array.isArray(raw.quizzes) ? raw.quizzes : null;
    field("quizzes", quizzes !== null, "an array");
    if (raw.selfCheck !== void 0) {
      const sc = raw.selfCheck;
      field(
        "selfCheck",
        isObj(sc) && isSha256(sc.reportHash) && isSha256(sc.engineDigest) && Array.isArray(sc.kindsCovered) && sc.kindsCovered.every(isStr),
        "{ reportHash, engineDigest, kindsCovered[] }"
      );
    }
    if (raw.manifestType !== void 0 && raw.manifestType !== input.manifestType) {
      r.add("U1", "manifest_type_mismatch", `manifestType ${String(raw.manifestType)} differs from the package type ${input.manifestType}`, { path: "manifestType" });
    }
    (questions ?? []).forEach((q, i) => {
      const p = `questions[${i}]`;
      if (!isObj(q)) {
        field(p, false, "an object");
        return;
      }
      field(`${p}.qid`, isUlid(q.qid), "a ULID");
      field(`${p}.slideId`, isStr(q.slideId), "a string");
      field(`${p}.kind`, isStr(q.kind) && INTERACTION_KINDS.includes(q.kind), "an xAPI interaction type");
      field(`${p}.language`, isStr(q.language) && q.language !== "", "a language tag");
      field(`${p}.revision`, isInt(q.revision, 1), "an integer \u2265 1");
      field(`${p}.contentHash`, isSha256(q.contentHash), "sha256:<64 hex>");
      field(`${p}.prompt`, isStr(q.prompt), "a string");
      const opts = Array.isArray(q.options) ? q.options : null;
      field(`${p}.options`, opts !== null && opts.every((o) => isObj(o) && isOid(o.oid) && isStr(o.label)), "an array of { oid: o1..oN, label }");
      if (opts && duplicates(opts.map((o) => String(get(o, "oid")))).length > 0) {
        r.add("U1", "option_id_duplicate", `${p}.options has a duplicate oid`, { path: `${p}.options` });
      }
      field(`${p}.correct`, Array.isArray(q.correct) && q.correct.every(isStr), "an array of strings");
      if (q.derivedFrom !== void 0 && q.derivedFrom !== null) field(`${p}.derivedFrom`, isUlid(q.derivedFrom), "a ULID or null");
      if (q.authoringKind !== void 0) {
        field(`${p}.authoringKind`, isStr(q.authoringKind), "a string");
        if (isStr(q.authoringKind) && !hasOwn(KEY_CLASS_BY_AUTHORING_KIND, q.authoringKind)) {
          r.add("U1", "authoring_kind_unknown", `${p}.authoringKind "${q.authoringKind}" is not in the known vocabulary; its class is derived from the key`, { severity: "warn", path: `${p}.authoringKind` });
        }
      }
    });
    const qkeys = (questions ?? []).filter(isObj).map((q) => `${String(q.qid)}\0${String(q.language).toLowerCase()}`);
    if (duplicates(qkeys).length > 0) r.add("U1", "duplicate_question", "a (qid, language) pair appears twice in questions", { path: "questions" });
    (quizzes ?? []).forEach((z, i) => {
      const p = `quizzes[${i}]`;
      if (!isObj(z)) {
        field(p, false, "an object");
        return;
      }
      field(`${p}.quizId`, isNonEmptyStr(z.quizId) && !z.quizId.includes("/"), "a non-empty id without '/'");
      field(`${p}.slideId`, isStr(z.slideId), "a string");
      field(`${p}.bankQids`, Array.isArray(z.bankQids) && z.bankQids.every(isUlid), "an array of ULIDs");
      field(`${p}.drawCount`, z.drawCount === null || isInt(z.drawCount, 1), "null or an integer \u2265 1");
      field(`${p}.retakesAllowed`, typeof z.retakesAllowed === "boolean", "a boolean");
      if (z.pools !== void 0) {
        field(
          `${p}.pools`,
          Array.isArray(z.pools) && z.pools.every((pl) => isObj(pl) && Array.isArray(pl.tags) && pl.tags.every(isStr) && isInt(pl.draw, 1) && Array.isArray(pl.candidateQids) && pl.candidateQids.every(isUlid)),
          "an array of { tags[], draw \u2265 1, candidateQids[] }"
        );
      }
    });
    if (r.findings.slice(before).some((f) => f.severity === "error")) return done(null);
    const m = raw;
    r.check("R10");
    m.questions.forEach((q, i) => {
      q.correct.forEach((c, j) => {
        const parsed = parseInteraction(q.kind, c, "pattern");
        if (!parsed.ok) r.add("R10", "pattern_grammar", `${parsed.code}: ${parsed.message}`, { path: `questions[${i}].correct[${j}]` });
      });
    });
    r.check("U2");
    checkPublisherIds(r, m, input);
    r.check("U3");
    m.questions.forEach((q, i) => {
      if (contentHash(q) !== q.contentHash) {
        r.add("U3", "content_hash_mismatch", `questions[${i}].contentHash does not recompute`, { path: `questions[${i}].contentHash` });
      }
    });
    r.check("U4");
    checkLanguages(r, m);
    if (input.knownBundleHashes) {
      r.check("U5");
      if (!input.knownBundleHashes.includes(m.rulesBundleHash)) {
        r.add("U5", "rules_bundle_unknown", "rulesBundleHash is not a registered rules bundle (stale editor)", { path: "rulesBundleHash" });
      }
    }
    r.check("U7");
    if (m.publisherIds.au.length !== 1) {
      r.add("U7", "multi_au_unsupported", `publisherIds.au lists ${m.publisherIds.au.length} AUs; exactly one is supported`, { path: "publisherIds.au" });
    }
    if (input.manifestType === "cmi5" && isStr(input.cmi5Xml)) {
      const aus = xmlAttributeValues(stripXmlComments(input.cmi5Xml), "au", "id").length;
      if (aus !== 1) r.add("U7", "multi_au_unsupported", `cmi5.xml declares ${aus} AUs; exactly one is supported`, { path: "cmi5.xml" });
    }
    if (isStr(input.slotLanguage) && input.slotLanguage !== "") {
      r.check("R4");
      if (primarySubtag(m.language) !== primarySubtag(input.slotLanguage)) {
        r.add("R4", "declared_language_differs_from_slot", `the package declares ${m.language}; the slot is ${input.slotLanguage}`, { path: "language" });
      }
    }
    r.check("POOL");
    const catalogueQids = new Set(m.questions.map((q) => q.qid));
    m.quizzes.forEach((z, i) => {
      const p = `quizzes[${i}]`;
      const missing = z.bankQids.filter((q) => !catalogueQids.has(q));
      if (missing.length > 0) r.add("POOL", "bank_qid_not_in_catalogue", `${p}.bankQids not in questions: ${missing.join(", ")}`, { path: `${p}.bankQids` });
      if (z.drawCount !== null && z.drawCount > new Set(z.bankQids).size) {
        r.add("POOL", "pool_underdraw", `${p} draws ${z.drawCount} from a bank of ${new Set(z.bankQids).size}`, { path: `${p}.drawCount` });
      }
      (z.pools ?? []).forEach((pl, j) => {
        const pp = `${p}.pools[${j}]`;
        const outside = pl.candidateQids.filter((q) => !z.bankQids.includes(q));
        if (outside.length > 0) r.add("POOL", "pool_candidate_not_in_bank", `${pp}.candidateQids outside the bank: ${outside.join(", ")}`, { path: `${pp}.candidateQids` });
        if (pl.draw > new Set(pl.candidateQids).size) {
          r.add("POOL", "pool_underdraw", `${pp} draws ${pl.draw} from ${new Set(pl.candidateQids).size} candidates`, { path: `${pp}.draw` });
        }
      });
      if (z.pools && z.pools.length > 0 && z.drawCount !== null) {
        const total = z.pools.reduce((n, pl) => n + pl.draw, 0);
        if (total !== z.drawCount) r.add("POOL", "pool_draw_mismatch", `${p} pools draw ${total}, drawCount is ${z.drawCount}`, { path: `${p}.pools` });
      }
    });
    return done(m);
  }
  function checkPublisherIds(r, m, input) {
    let courseIds;
    let auIds;
    if (input.manifestType === "cmi5") {
      if (!isStr(input.cmi5Xml)) {
        r.add("U2", "launch_manifest_missing", "cmi5.xml is needed to verify publisherIds", { path: "cmi5.xml" });
        return;
      }
      const xml = stripXmlComments(input.cmi5Xml);
      courseIds = xmlAttributeValues(xml, "course", "id");
      auIds = xmlAttributeValues(xml, "au", "id");
    } else if (input.manifestType === "xapi") {
      if (!isStr(input.tincanXml)) {
        r.add("U2", "launch_manifest_missing", "tincan.xml is needed to verify publisherIds", { path: "tincan.xml" });
        return;
      }
      courseIds = auIds = xmlAttributeValues(stripXmlComments(input.tincanXml), "activity", "id");
    } else {
      if (!isStr(input.imsManifestXml)) {
        r.add("U2", "launch_manifest_missing", "imsmanifest.xml is needed to verify publisherIds", { path: "imsmanifest.xml" });
        return;
      }
      const xml = stripXmlComments(input.imsManifestXml);
      courseIds = auIds = ["manifest", "organization", "item", "resource"].flatMap((e) => xmlAttributeValues(xml, e, "identifier"));
    }
    if (!courseIds.includes(m.publisherIds.course)) {
      r.add("U2", "publisher_course_id_not_found", `publisherIds.course ${m.publisherIds.course} is not in the launch manifest`, { path: "publisherIds.course" });
    }
    m.publisherIds.au.forEach((au, i) => {
      if (!auIds.includes(au)) r.add("U2", "publisher_au_id_not_found", `publisherIds.au[${i}] ${au} is not in the launch manifest`, { path: `publisherIds.au[${i}]` });
    });
  }
  function checkLanguages(r, m) {
    const info = { severity: "info" };
    const tags = [["language", m.language], ...m.questions.map((q, i) => [`questions[${i}].language`, q.language])];
    for (const [path, tag] of tags) {
      if (!isBcp47(tag)) r.add("U4", "language_malformed", `${tag} is not a well-formed BCP 47 tag`, { ...info, path });
      else if (canonicalBcp47(tag) !== tag) r.add("U4", "language_not_canonical", `${tag} is not in canonical case (${canonicalBcp47(tag)})`, { ...info, path });
    }
    const byLang = /* @__PURE__ */ new Map();
    for (const q of m.questions) {
      const k = q.language.toLowerCase();
      byLang.set(k, (byLang.get(k) ?? []).concat(q));
    }
    byLang.forEach((qs) => {
      const tag = qs[0].language;
      if (!isBcp47(tag)) return;
      const script = scriptForLanguage(tag);
      if (!script) {
        r.add("U4", "language_unmapped", `${tag} has no expected script; script not checked`, { ...info, path: "questions" });
        return;
      }
      const withText = qs.filter((q) => detectScript(q.prompt).letters > 0);
      if (withText.length === 0) return;
      const inScript = withText.filter((q) => detectScript(q.prompt).dominant === script).length;
      if (inScript / withText.length < U4_SCRIPT_SHARE) {
        r.add("U4", "script_mismatch", `${inScript} of ${withText.length} ${tag} prompts are in ${script} script (needs ${U4_SCRIPT_SHARE * 100} %)`, { ...info, path: "questions" });
      }
    });
  }
  return __toCommonJS(index_exports);
})();
