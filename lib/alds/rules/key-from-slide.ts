/**
 * The answer key of a KIVO slide or assessment bank question, in oid form
 * (ADR 0022 item 14): the `correctResponsesPattern` entries the KIVO 2.0
 * engine sends after mapping its positional ids to the slide's oid lists, so
 * a manifest's `correct[]` built here equals the statement's patterns byte
 * for byte (what the gate and SEM compare is canonicalPatternKey of both).
 *
 * The reference is the G2 engine (ENGINE_VERSION 2026.11.11): its pattern
 * builder (buildInteractionData), its oid map (aldsOidDict / aldsRemapIds)
 * and its grader (the self-check hook's gradeSlide, the renderers'
 * matchesBlank, the assessment's gradeAll). Field names are the editor's as
 * built at G1 (the KIVO names record): optionOids, choiceOids, cardOids with
 * swipeTargetOids, pairOids [{src, tgt}], itemOids with categoryOids,
 * stepOids, questionBank[i].optionOids; true-false and fill-blanks carry no
 * oid list.
 *
 * Returns:
 *   string[]  the key (never sorted or canonicalised here);
 *   []        a slide type that has no key by design (dialogue, game,
 *             image-id, hotspot, interactive-timeline, feedback, slider,
 *             dial, assessment, every non-question type, an unknown type);
 *   null      a keyed slide type with no usable key (fail closed): the
 *             authored right-answer field is absent or malformed, the
 *             pattern would need an id with no oid, the list that defines
 *             the pattern is empty, or the engine's pattern builder and its
 *             grader would disagree on the authored state. KIVO's export
 *             refuses on null and the gate reads config_not_certified.
 * Callers decide keyed-ness from LABELS_BY_AUTHORING_KIND, never from []
 * versus null.
 *
 * Oid lists: a list that is missing, whose length differs in either
 * direction from the string list it runs beside, or that holds an entry not
 * of the form o1..oN gives null (the editor's export refuses the same
 * project on any length difference).
 */
import { isInt, isObj, isOid, isStr, type Obj } from "./util";

/** The xAPI delimiters (the same values as grammar.ts, which keeps its own private). */
const ITEM_DELIM = "[,]";
const PAIR_DELIM = "[.]";
/** The engine's FILL_IN_PATTERN_CAP: at most this many fill-in patterns per slide. */
const FILL_IN_PATTERN_CAP = 64;

type Key = string[] | null;

const lengthOf = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** The oid list beside a string list of length n, or null. */
function oidList(v: unknown, n: number): string[] | null {
  if (!Array.isArray(v) || v.length !== n || !v.every(isOid)) return null;
  return v as string[];
}

/** An integer index in [0, n). */
function isIndex(v: unknown, n: number): v is number {
  return isInt(v, 0) && v < n;
}

/** quiz, timed-quiz, confidence: the option at correctAnswer. */
function singleChoiceKey(options: unknown, optionOids: unknown, correctAnswer: unknown): Key {
  const n = lengthOf(options);
  const ids = oidList(optionOids, n);
  if (!ids || !isIndex(correctAnswer, n)) return null;
  return [ids[correctAnswer]];
}

/** multi-response and the bank's multi: every correct index, sorted numerically, mapped and joined. */
function multiChoiceKey(options: unknown, optionOids: unknown, correct: unknown): Key {
  const n = lengthOf(options);
  const ids = oidList(optionOids, n);
  if (!ids || !Array.isArray(correct) || correct.length === 0) return null;
  if (!correct.every((i) => isIndex(i, n))) return null;
  const sorted = (correct as number[]).slice().sort((a, b) => a - b);
  for (let k = 1; k < sorted.length; k++) if (sorted[k] === sorted[k - 1]) return null; // o1[,]o1: R10 duplicate_id
  return [sorted.map((i) => ids[i]).join(ITEM_DELIM)];
}

/**
 * scenario: the key exists only when exactly one choice has a truthy isBest
 * (the builder's test, choices.findIndex(c => c && c.isBest)) and that value
 * is true (the grader's test, c.isBest === true).
 */
function scenarioKey(slide: Obj): Key {
  const choices = Array.isArray(slide.choices) ? slide.choices : [];
  const ids = oidList(slide.choiceOids, choices.length);
  if (!ids) return null;
  let best = -1;
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i];
    if (isObj(c) && c.isBest) {
      if (best >= 0) return null;
      best = i;
    }
  }
  if (best < 0 || (choices[best] as Obj).isBest !== true) return null;
  return [ids[best]];
}

/**
 * swipe-decision: card oid [.] the target oid of its direction, every card in
 * order. A slide with no cards array is the legacy single card (cardOids
 * ["o1"], direction slide.correctDirection); an empty cards array is null (the
 * engine synthesises a card the editor minted no oid for).
 */
function swipeKey(slide: Obj): Key {
  let cards: unknown[];
  if (Array.isArray(slide.cards)) {
    if (slide.cards.length === 0) return null;
    cards = slide.cards;
  } else {
    cards = [{ correctDirection: slide.correctDirection }];
  }
  const ids = oidList(slide.cardOids, cards.length);
  const targets = slide.swipeTargetOids;
  if (!ids || !isObj(targets) || !isOid(targets.left) || !isOid(targets.right)) return null;
  const parts: string[] = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const dir = isObj(c) ? c.correctDirection : undefined;
    if (dir !== "left" && dir !== "right") return null;
    parts.push(ids[i] + PAIR_DELIM + (dir === "left" ? targets.left : targets.right));
  }
  return [parts.join(ITEM_DELIM)];
}

/** matching, drag-match: src [.] tgt of every pair, in authored order. */
function pairsKey(slide: Obj): Key {
  const n = lengthOf(slide.pairs);
  const pairOids = slide.pairOids;
  if (n === 0 || !Array.isArray(pairOids) || pairOids.length !== n) return null;
  const parts: string[] = [];
  for (const p of pairOids) {
    if (!isObj(p) || !isOid(p.src) || !isOid(p.tgt)) return null;
    parts.push(p.src + PAIR_DELIM + p.tgt);
  }
  return [parts.join(ITEM_DELIM)];
}

/**
 * drag-drop: item oid [.] the oid of the category whose key is the item's
 * category, items in authored order. A category's key: an object with a
 * truthy key → that key; a string → the string; else its index as a string.
 */
function dragDropKey(slide: Obj): Key {
  const items = Array.isArray(slide.items) ? slide.items : [];
  const categories = Array.isArray(slide.categories) ? slide.categories : [];
  const itemIds = oidList(slide.itemOids, items.length);
  const categoryIds = oidList(slide.categoryOids, categories.length);
  if (items.length === 0 || !itemIds || !categoryIds) return null;
  const keys: unknown[] = [];
  for (let j = 0; j < categories.length; j++) {
    const cat = categories[j];
    // a null category stops the engine's pattern builder (it reads cat.text): no key
    if (cat === null || cat === undefined) return null;
    keys.push(isObj(cat) && cat.key ? cat.key : isStr(cat) ? cat : String(j));
  }
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!isObj(it) || !it.category) return null;
    const j = keys.indexOf(it.category);
    if (j < 0) return null; // the engine would send the raw key, which is no target id
    parts.push(itemIds[i] + PAIR_DELIM + categoryIds[j]);
  }
  return [parts.join(ITEM_DELIM)];
}

/**
 * sequencing: every step oid in authored order. The list is `steps`; with no
 * steps (absent or empty-valued) the legacy `items` list. A `steps` value that
 * is present but not an array is null: the builder would read `items` and the
 * grader `steps`.
 */
function sequencingKey(slide: Obj): Key {
  let list: unknown[] | null;
  if (Array.isArray(slide.steps)) list = slide.steps;
  else if (!slide.steps) list = Array.isArray(slide.items) ? slide.items : null;
  else list = null;
  if (!list || list.length === 0) return null;
  const ids = oidList(slide.stepOids, list.length);
  return ids ? [ids.join(ITEM_DELIM)] : null;
}

// --- fill-blanks ---------------------------------------------------------------

/** The engine's text normalisation for fill-in variants (no NFC). */
const fillNorm = (v: unknown): string => String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim();

/** The blanks of a template: the captures of [[...]], in order. */
function blanksOf(template: unknown): string[] {
  const out: string[] = [];
  if (!isStr(template)) return out;
  const re = /\[\[(.+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) out.push(m[1]);
  return out;
}

/** acceptedAnswers[i] when it is an array (the engine's and the grader's reading), else []. */
function acceptedAt(accepted: unknown, i: number): unknown[] {
  if (!isObj(accepted) && !Array.isArray(accepted)) return [];
  const v = (accepted as { [k: number]: unknown })[i];
  return Array.isArray(v) ? v : [];
}

/**
 * The accepted variants of each blank of a fill-blanks slide, after
 * normalisation and de-duplication by lower case (the first spelling kept):
 * blank i's list is [blank text, ...acceptedAnswers[i]], empty values
 * dropped. Uncapped: the product of the list lengths is the number of
 * accepted combinations (ADR 0022 D item 7; the owner's D12). null when the
 * value is not a fill-blanks slide or its template has no blank.
 */
export function fillBlanksVariants(slide: unknown): string[][] | null {
  if (!isObj(slide) || slide.type !== "fill-blanks") return null;
  const blanks = blanksOf(slide.template);
  if (blanks.length === 0) return null;
  return blanks.map((b, i) => {
    const seen = new Set<string>();
    const list: string[] = [];
    [b as unknown].concat(acceptedAt(slide.acceptedAnswers, i)).forEach((v) => {
      const t = fillNorm(v);
      const k = t.toLowerCase();
      if (t && !seen.has(k)) {
        seen.add(k);
        list.push(t);
      }
    });
    return list;
  });
}

/**
 * True when the grader (matchesBlank, which compares (s || "").toLowerCase()
 * with whitespace collapsed) and the pattern builder disagree on the slide:
 * a blank or an accepted entry that normalises to "" makes the grader accept
 * an empty answer the patterns do not hold, and an accepted entry that is not
 * a string is stringified by the builder but stops the grader.
 */
function fillBlanksGraderDiffers(slide: Obj): boolean {
  const blanks = blanksOf(slide.template);
  for (let i = 0; i < blanks.length; i++) {
    if (fillNorm(blanks[i]) === "") return true;
    if (acceptedAt(slide.acceptedAnswers, i).some((v) => !isStr(v) || fillNorm(v) === "")) return true;
  }
  return false;
}

/**
 * fill-blanks: every accepted combination in blank order and list order,
 * "{case_matters=false}" + the parts joined [,], built as the engine builds
 * it: the cap is tested at every push, so after a blank the list holds at
 * most FILL_IN_PATTERN_CAP combinations, the first ones in generation order.
 */
function fillBlanksKey(slide: Obj): Key {
  const lists = fillBlanksVariants(slide);
  if (!lists || lists.some((l) => l.length === 0) || fillBlanksGraderDiffers(slide)) return null;
  let combos: Array<string | null> = [null];
  for (const list of lists) {
    const next: string[] = [];
    for (const c of combos) {
      for (const v of list) {
        if (next.length < FILL_IN_PATTERN_CAP) next.push(c === null ? v : c + ITEM_DELIM + v);
      }
    }
    combos = next;
  }
  return combos.map((c) => "{case_matters=false}" + c);
}

// --- entry points ----------------------------------------------------------------

/** The key of a KIVO slide (the editor's slide object as written in the config block). */
export function keyFromSlide(slide: unknown): string[] | null {
  if (!isObj(slide) || !isStr(slide.type)) return null;
  switch (slide.type) {
    case "quiz":
    case "timed-quiz":
    case "confidence":
      return singleChoiceKey(slide.options, slide.optionOids, slide.correctAnswer);
    case "multi-response":
      return multiChoiceKey(slide.options, slide.optionOids, slide.correctAnswers);
    case "true-false":
      return typeof slide.correct === "boolean" ? [slide.correct ? "true" : "false"] : null;
    case "scenario":
      return scenarioKey(slide);
    case "swipe-decision":
      return swipeKey(slide);
    case "matching":
    case "drag-match":
      return pairsKey(slide);
    case "drag-drop":
      return dragDropKey(slide);
    case "sequencing":
      return sequencingKey(slide);
    case "fill-blanks":
      return fillBlanksKey(slide);
    default:
      return [];
  }
}

/**
 * The key of an assessment bank question (questionBank[i]; type mcq,
 * dropdown, multi or truefalse). mcq and dropdown: the option at the single
 * correct index. multi: as multi-response. truefalse: "true" or "false" from
 * the label of the single correct option ("true" / "false" after trim and
 * lower case, else index 0 means true); its optionOids are not read. A
 * question that is not an object, of another type, or whose correct list does
 * not fit the type is null.
 */
export function keyFromBankQuestion(q: unknown): string[] | null {
  if (!isObj(q)) return null;
  const type = q.type;
  if (type !== "mcq" && type !== "dropdown" && type !== "multi" && type !== "truefalse") return null;
  const correct = q.correct;
  if (!Array.isArray(correct)) return null;
  if (type === "multi") return multiChoiceKey(q.options, q.optionOids, correct);
  // mcq, dropdown and truefalse hold exactly one correct index (two would make the
  // self-check grader, which reads the first, and the assessment's gradeAll disagree)
  if (correct.length !== 1) return null;
  if (type === "truefalse") {
    const options = Array.isArray(q.options) ? q.options : [];
    const idx = correct[0];
    if (!isIndex(idx, options.length)) return null;
    const label = String(options[idx] || "").trim().toLowerCase();
    const value = label === "true" ? true : label === "false" ? false : idx === 0;
    return [value ? "true" : "false"];
  }
  return singleChoiceKey(q.options, q.optionOids, correct[0]);
}
