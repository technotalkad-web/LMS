/**
 * Script and lexical detection (U4 / R4; informational only, ADR 0004 step 6
 * and ADR 0005 step 5). Works on plain text (prompts), not launch HTML.
 *
 * Letters and combining marks are classified by Unicode block (fixed code
 * point ranges, so results do not depend on the JS engine's Unicode version).
 * The Hinglish/English lexical score uses the same function-word lists as the
 * P0 upload report (lib/courses/validation/integrity.ts), which P4 can switch
 * to this module.
 */
import { SCRIPT_FOR_LANGUAGE, type AldsScript } from "../types";
import { primarySubtag } from "./util";

export type DetectedScript = AldsScript | "Other";

const BLOCKS: ReadonlyArray<[number, number, AldsScript]> = [
  [0x0041, 0x005a, "Latin"],
  [0x0061, 0x007a, "Latin"],
  [0x00c0, 0x024f, "Latin"],
  [0x1e00, 0x1eff, "Latin"],
  [0x0900, 0x097f, "Devanagari"],
  [0xa8e0, 0xa8ff, "Devanagari"],
  [0x0980, 0x09ff, "Bengali"],
  [0x0a00, 0x0a7f, "Gurmukhi"],
  [0x0a80, 0x0aff, "Gujarati"],
  [0x0b80, 0x0bff, "Tamil"],
  [0x0c00, 0x0c7f, "Telugu"],
  [0x0c80, 0x0cff, "Kannada"],
  [0x0d00, 0x0d7f, "Malayalam"],
];

const SCRIPT_SUBTAG: Readonly<Record<string, AldsScript>> = {
  latn: "Latin", deva: "Devanagari", gujr: "Gujarati", beng: "Bengali", guru: "Gurmukhi",
  taml: "Tamil", telu: "Telugu", knda: "Kannada", mlym: "Malayalam",
};

const HINGLISH_WORDS = new Set([
  "hai", "hain", "ka", "ki", "ke", "ko", "se", "mein", "aur", "nahi", "nahin", "kya", "aap", "hum", "ham",
  "yeh", "ye", "woh", "wo", "toh", "bhi", "par", "kaise", "kyun", "kyon", "apna", "apne", "apni",
  "karna", "karein", "kare", "karo", "hota", "hoti", "hote", "tha", "thi", "ek", "sab", "jab", "agar",
]);
const ENGLISH_WORDS = new Set([
  "the", "and", "is", "are", "of", "in", "you", "your", "for", "with", "this", "that", "it", "on", "be",
  "can", "will", "what", "how", "when", "if", "or", "not", "a", "an", "we", "our", "they", "from", "by",
]);

export interface ScriptProfile {
  /** Letters and marks counted. */
  letters: number;
  /** Count per script ("Other" = letters outside the mapped blocks). */
  counts: Record<DetectedScript, number>;
  /** The script with the most letters; null when there are none. */
  dominant: DetectedScript | null;
  /** Share of the dominant script, 0–100, one decimal. */
  dominantPct: number;
  hinglishWords: number;
  englishWords: number;
  /** hinglish / (hinglish + english) function words, 0–1 (two decimals); null without a signal. */
  hinglishScore: number | null;
}

function blockOf(cp: number): AldsScript | null {
  for (const [lo, hi, s] of BLOCKS) if (cp >= lo && cp <= hi) return s;
  return null;
}

export function detectScript(text: string): ScriptProfile {
  const counts: Record<DetectedScript, number> = {
    Latin: 0, Devanagari: 0, Gujarati: 0, Bengali: 0, Gurmukhi: 0,
    Tamil: 0, Telugu: 0, Kannada: 0, Malayalam: 0, Other: 0,
  };
  let letters = 0;
  for (const ch of text) {
    if (!/[\p{L}\p{M}]/u.test(ch)) continue;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xd7 || cp === 0xf7) continue; // × ÷ sit inside the Latin-1 letter range
    counts[blockOf(cp) ?? "Other"]++;
    letters++;
  }
  let dominant: DetectedScript | null = null;
  let best = 0;
  for (const k of Object.keys(counts) as DetectedScript[]) {
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
    dominantPct: letters === 0 ? 0 : Math.round((best / letters) * 1000) / 10,
    hinglishWords: h,
    englishWords: e,
    hinglishScore: h + e > 0 ? Math.round((h / (h + e)) * 100) / 100 : null,
  };
}

/**
 * The script expected for a language tag: an exact SCRIPT_FOR_LANGUAGE entry
 * (case-insensitive), else the tag's script subtag, else its primary language.
 * null = unmapped (U4 reports it as informational).
 */
export function scriptForLanguage(tag: string): AldsScript | null {
  const lower = tag.toLowerCase();
  for (const k of Object.keys(SCRIPT_FOR_LANGUAGE)) if (k.toLowerCase() === lower) return SCRIPT_FOR_LANGUAGE[k];
  for (const part of lower.split("-").slice(1)) {
    if (part.length === 4 && SCRIPT_SUBTAG[part]) return SCRIPT_SUBTAG[part];
  }
  const primary = primarySubtag(tag);
  for (const k of Object.keys(SCRIPT_FOR_LANGUAGE)) if (k.toLowerCase() === primary) return SCRIPT_FOR_LANGUAGE[k];
  return null;
}
