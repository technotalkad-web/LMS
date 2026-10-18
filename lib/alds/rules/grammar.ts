/**
 * R10: the xAPI 1.0.3 response grammar per interactionType (BLUEPRINT §7 R10,
 * §8.1 "grammar parser (all rows)"), for `result.response` ("response" mode)
 * and `correctResponsesPattern` entries ("pattern" mode). No legacy pre-pass
 * (cut by ADR 0002 decision 4): a response is either well-formed or not.
 *
 *   true-false   "true" | "false"
 *   choice       id[,]id…            (a set; a single id has no delimiter)
 *   sequencing   id[,]id…            (ordered)
 *   likert       id
 *   matching     src[.]tgt[,]src[.]tgt…
 *   performance  [{order_matters=b}]step[.]answer[,]…   (pattern answers may be n[:]m)
 *   numeric      n          (pattern: n | n[:]m | [:]m | n[:])
 *   fill-in, long-fill-in
 *                [{case_matters=b}][{order_matters=b}]{lang=x}text[,]…  (the two flags in patterns only)
 *   other        any string
 *
 * Ids are tokens without whitespace, brackets or braces (KIVO oids are
 * "o1".."oN"); the old engine's "option_0,2,3" and "option_0 (confidence=2)"
 * shapes therefore fail here or against the definition's ids (S3).
 * Matching follows xAPI defaults: case_matters=false, order_matters=true.
 */
import { isBcp47, normalizeText } from "./util";

export type NumRange = { min: number | null; max: number | null };

export type Parsed =
  | { type: "true-false"; value: boolean }
  | { type: "choice"; ids: string[] }
  | { type: "sequencing"; ids: string[] }
  | { type: "likert"; id: string }
  | { type: "matching"; pairs: Array<[string, string]> }
  | { type: "performance"; steps: Array<{ step: string; answer: string; range: NumRange | null }>; orderMatters: boolean }
  | { type: "numeric"; range: NumRange }
  | { type: "fill-in" | "long-fill-in"; items: Array<{ text: string; lang: string | null }>; caseMatters: boolean; orderMatters: boolean }
  | { type: "other"; raw: string };

export type GrammarMode = "pattern" | "response";
export type ParseResult = { ok: true; value: Parsed } | { ok: false; code: string; message: string };

const LIST = "[,]";
const PAIR = "[.]";
const RANGE = "[:]";
const ID_RE = /^[^\s[\]{}]+$/;
const NUM_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

function fail(code: string, message: string): ParseResult {
  return { ok: false, code, message };
}

function splitList(text: string): string[] {
  return text.split(LIST);
}

function badId(id: string): boolean {
  return !ID_RE.test(id);
}

function parseIds(text: string, mode: GrammarMode, ordered: boolean): ParseResult | string[] {
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

function parseNumber(s: string): number | null {
  return NUM_RE.test(s) ? Number(s) : null;
}

function parseRange(s: string): NumRange | null {
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
  if ((a !== "" && min === null) || (b !== "" && max === null)) return null;
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) return null;
  return { min, max };
}

/** Leading `{name=value}` parameters (fill-in / performance patterns). */
function takeFlags(
  text: string,
  allowed: readonly string[],
): { ok: true; rest: string; flags: Record<string, boolean> } | { ok: false; code: string; message: string } {
  const flags: Record<string, boolean> = {};
  let rest = text;
  for (;;) {
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

export function parseInteraction(kind: string, text: string, mode: GrammarMode): ParseResult {
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
      const pairs: Array<[string, string]> = [];
      const seen = new Set<string>();
      for (const item of splitList(text)) {
        const parts = item.split(PAIR);
        if (parts.length !== 2) return fail("bad_pair", `matching expects source[.]target, got "${item}"`);
        const [src, tgt] = parts;
        if (badId(src) || badId(tgt)) return fail("bad_id", `"${item}" holds an invalid id`);
        const key = `${src}\u0000${tgt}`;
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
      const steps: Array<{ step: string; answer: string; range: NumRange | null }> = [];
      for (const item of splitList(body)) {
        const i = item.indexOf(PAIR);
        if (i < 0) return fail("bad_pair", `performance expects step[.]answer, got "${item}"`);
        const step = item.slice(0, i);
        const answer = item.slice(i + PAIR.length);
        if (badId(step)) return fail("bad_id", `"${step}" is not a step id`);
        if (answer === "" || answer.includes(PAIR)) return fail("bad_pair", `performance step "${step}" has no single answer`);
        let range: NumRange | null = null;
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
      const items: Array<{ text: string; lang: string | null }> = [];
      if (body !== "") {
        for (const raw of splitList(body)) {
          let item = raw;
          let lang: string | null = null;
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

/** Ids a parsed value refers to, by role (for the S3/SEM id checks). */
export function referencedIds(p: Parsed): { ids: string[]; sources: string[]; targets: string[]; steps: string[] } {
  const out = { ids: [] as string[], sources: [] as string[], targets: [] as string[], steps: [] as string[] };
  if (p.type === "choice" || p.type === "sequencing") out.ids = p.ids.slice();
  else if (p.type === "likert") out.ids = [p.id];
  else if (p.type === "matching") {
    out.sources = p.pairs.map((x) => x[0]);
    out.targets = p.pairs.map((x) => x[1]);
  } else if (p.type === "performance") out.steps = p.steps.map((s) => s.step);
  return out;
}

function inRange(v: number, r: NumRange): boolean {
  return (r.min === null || v >= r.min) && (r.max === null || v <= r.max);
}

function fillText(s: string, caseMatters: boolean): string {
  const n = normalizeText(s);
  return caseMatters ? n : n.toLowerCase();
}

/**
 * Does a parsed response satisfy a parsed pattern? Set semantics for choice
 * and matching, ordered for sequencing, every accepted variant is its own
 * pattern (the caller tries each). `null` when the kind has no decidable
 * comparison (other).
 */
export function responseMatches(response: Parsed, pattern: Parsed): boolean | null {
  if (response.type === "other" || pattern.type === "other") return null;
  if (response.type !== pattern.type) {
    const fill = (t: string) => t === "fill-in" || t === "long-fill-in";
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
      return (
        response.type === "sequencing" &&
        response.ids.length === pattern.ids.length &&
        response.ids.every((id, i) => id === pattern.ids[i])
      );
    case "likert":
      return response.type === "likert" && response.id === pattern.id;
    case "matching": {
      if (response.type !== "matching") return false;
      const want = new Set(pattern.pairs.map((x) => `${x[0]}\u0000${x[1]}`));
      return response.pairs.length === want.size && response.pairs.every((x) => want.has(`${x[0]}\u0000${x[1]}`));
    }
    case "numeric": {
      if (response.type !== "numeric" || response.range.min === null) return false;
      return inRange(response.range.min, pattern.range);
    }
    case "performance": {
      if (response.type !== "performance" || response.steps.length !== pattern.steps.length) return false;
      const stepOk = (r: { step: string; answer: string }, p: { step: string; answer: string; range: NumRange | null }) => {
        if (r.step !== p.step) return false;
        if (p.range) {
          const n = parseNumber(r.answer);
          return n !== null && inRange(n, p.range);
        }
        return r.answer === p.answer;
      };
      if (pattern.orderMatters) return pattern.steps.every((p, i) => stepOk(response.steps[i], p));
      const used = new Set<number>();
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
      return r.slice().sort().join("\u0000") === p.slice().sort().join("\u0000");
    }
  }
  return null;
}

/**
 * The canonical text of a parsed pattern: one spelling per meaning, and a
 * valid pattern of the same kind. Two patterns are the same key exactly when
 * their canonical texts are equal; the semantic check (SEM) compares keys and
 * contentHash hashes the canonical text, so both use this one definition.
 *
 *   choice                  ids sorted (a set)
 *   sequencing              ids in order
 *   matching                pairs sorted (a set)
 *   performance             {order_matters=false} written only when false;
 *                           steps sorted when order does not matter; a range
 *                           answer written min[:]max with numbers as
 *                           JavaScript prints them
 *   numeric                 n when min = max, else min[:]max (open ends empty)
 *   fill-in, long-fill-in   {case_matters=true|false} always, then
 *                           {order_matters=false} only when false; items
 *                           {lang=x}text with text normalised (NFC, single
 *                           spaces, trimmed), sorted when order does not matter
 *   true-false, likert      as parsed
 *   other                   the raw text
 */
export function canonicalPatternText(p: Parsed): string {
  const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const num = (n: number | null): string => (n === null ? "" : String(n));
  switch (p.type) {
    case "true-false":
      return String(p.value);
    case "choice":
      return p.ids.slice().sort(byCodeUnit).join(LIST);
    case "sequencing":
      return p.ids.join(LIST);
    case "likert":
      return p.id;
    case "matching":
      return p.pairs
        .slice()
        .sort((a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]))
        .map(([src, tgt]) => `${src}${PAIR}${tgt}`)
        .join(LIST);
    case "numeric":
      return p.range.min !== null && p.range.min === p.range.max ? String(p.range.min) : `${num(p.range.min)}${RANGE}${num(p.range.max)}`;
    case "performance": {
      const steps = p.steps.map((s) => `${s.step}${PAIR}${s.range ? `${num(s.range.min)}${RANGE}${num(s.range.max)}` : s.answer}`);
      return `${p.orderMatters ? "" : "{order_matters=false}"}${(p.orderMatters ? steps : steps.slice().sort(byCodeUnit)).join(LIST)}`;
    }
    case "fill-in":
    case "long-fill-in": {
      const items = p.items.map((x) => `${x.lang === null ? "" : `{lang=${x.lang}}`}${normalizeText(x.text)}`);
      return `{case_matters=${p.caseMatters}}${p.orderMatters ? "" : "{order_matters=false}"}${(p.orderMatters ? items : items.slice().sort(byCodeUnit)).join(LIST)}`;
    }
    case "other":
      return p.raw;
  }
}

/** The key SEM compares patterns by (patterns of one interactionType): their canonical text. */
export function canonicalPatternKey(p: Parsed): string {
  return canonicalPatternText(p);
}

/**
 * The canonical text of a correct-response pattern given as text, for
 * contentHash: the pattern parsed for `kind` and rewritten by
 * canonicalPatternText; a pattern that does not parse is returned unchanged
 * (R10 reports it).
 */
export function canonicalPattern(kind: string, text: string): string {
  const parsed = parseInteraction(kind, text, "pattern");
  return parsed.ok ? canonicalPatternText(parsed.value) : text;
}
