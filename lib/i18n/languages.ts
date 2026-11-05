/**
 * Hard-coded language list for multi-language SCORM packages (#158).
 *
 * Per the RFC at docs/roadmap/multi-language-courses.md §12.1: start
 * with a curated list of 20 commonly-used codes. Per-org allow-list
 * configuration is a follow-up.
 *
 * Source: rough industry research (Docebo, TalentLMS, SAP SuccessFactors
 * default language lists), filtered to the languages the parent group\'s
 * tenants are most likely to need across India + South Asia + global
 * enterprise.
 *
 * Codes follow ISO 639-1 (two-letter) where one exists, falling back to
 * BCP-47 region-tagged where ambiguity matters (e.g. zh-Hans vs zh-Hant).
 *
 * The suggestion functions at the end (ADR 0016 steps 5 and 8) read the language
 * a package declares. The suggestion is advisory: an admin confirms it, and an
 * explicit language always wins. The slot codes are unchanged, and there is no
 * `hi-Latn` code (ADR 0016 step 10): `hi-Latn` is a value a package may declare,
 * compared with a slot by primary subtag. For an existing course with no chosen
 * slot, declaredLanguageRowSlot applies the upload dialog's own rule.
 */

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export const SUPPORTED_LANGUAGES = [
  // Indian languages — primary use case for AMBAK tenants
  { code: "en", native: "English", english: "English" },
  { code: "hi", native: "हिन्दी", english: "Hindi" },
  { code: "bn", native: "বাংলা", english: "Bengali" },
  { code: "ta", native: "தமிழ்", english: "Tamil" },
  { code: "te", native: "తెలుగు", english: "Telugu" },
  { code: "mr", native: "मराठी", english: "Marathi" },
  { code: "gu", native: "ગુજરાતી", english: "Gujarati" },
  { code: "kn", native: "ಕನ್ನಡ", english: "Kannada" },
  { code: "ml", native: "മലയാളം", english: "Malayalam" },
  { code: "pa", native: "ਪੰਜਾਬੀ", english: "Punjabi" },
  // Other widely-used business languages
  { code: "es", native: "Español", english: "Spanish" },
  { code: "fr", native: "Français", english: "French" },
  { code: "de", native: "Deutsch", english: "German" },
  { code: "pt", native: "Português", english: "Portuguese" },
  { code: "ar", native: "العربية", english: "Arabic" },
  { code: "ja", native: "日本語", english: "Japanese" },
  { code: "ko", native: "한국어", english: "Korean" },
  { code: "zh-Hans", native: "简体中文", english: "Chinese (Simplified)" },
  { code: "zh-Hant", native: "繁體中文", english: "Chinese (Traditional)" },
  { code: "ru", native: "Русский", english: "Russian" },
] as const;

const CODE_TO_INFO = new Map(
  SUPPORTED_LANGUAGES.map((l) => [l.code, l] as const)
);

/**
 * Returns true if the given string is one of our supported language codes.
 * Useful for validating admin uploads against the curated list.
 */
export function isSupportedLanguage(code: string): code is LanguageCode {
  return CODE_TO_INFO.has(code as LanguageCode);
}

/**
 * Friendly display name for a language code. Falls back to the code
 * itself if unknown (defensive — DB may hold codes not in our list
 * yet during transitional periods).
 */
export function languageDisplay(
  code: string | null | undefined,
  prefer: "native" | "english" = "native"
): string {
  if (!code) return "Default";
  const info = CODE_TO_INFO.get(code as LanguageCode);
  if (!info) return code;
  return prefer === "native" ? info.native : info.english;
}

/**
 * The part of a language tag before the first `-`, lower-cased. Defined here
 * and not imported from lib/alds: client components import this file, which
 * stays free of lib/alds.
 */
export function primarySubtag(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}

/**
 * The slot a declared language suggests (ADR 0016 step 5): the tag itself when
 * it is a supported code, else its primary subtag when that is, else null.
 */
export function suggestLanguageSlot(declared: string | null | undefined): LanguageCode | null {
  if (!declared) return null;
  const tag = declared.trim();
  if (isSupportedLanguage(tag)) return tag;
  const primary = primarySubtag(tag);
  return isSupportedLanguage(primary) ? primary : null;
}

/** The display name a declared language suggests (ADR 0016 step 5). */
export function suggestDisplayName(declared: string | null | undefined): string | null {
  return declared?.toLowerCase() === "hi-latn" ? "Hinglish" : null;
}

/**
 * What a validation knows of the slot a package is going to. `chosen`: an
 * explicit language, or the language of the package being replaced.
 * `newCourse`: no course was named. `takenLanguages`: the course's labelled
 * package languages, nulls excluded.
 */
export type DeclaredLanguageTarget = {
  chosen: string | null;
  newCourse: boolean;
  takenLanguages: readonly string[];
};

/**
 * The slot the `declared-language` validator row compares against (ADR 0016
 * step 8): (i) the chosen slot when one was chosen; (ii) on a new course, the
 * slot the upload's default takes; (iii) on an existing course, the slot an
 * untouched upload dialog stands at, which is the suggestion when the course
 * does not hold it and `en` otherwise.
 */
export function declaredLanguageRowSlot(
  declared: string | null | undefined,
  target: DeclaredLanguageTarget
): { slot: string; source: "chosen" | "default" } {
  if (typeof target.chosen === "string") return { slot: target.chosen, source: "chosen" };
  const suggested = suggestLanguageSlot(declared);
  if (target.newCourse) return { slot: suggested ?? "en", source: "default" };
  if (suggested !== null && !target.takenLanguages.includes(suggested)) {
    return { slot: suggested, source: "default" };
  }
  return { slot: "en", source: "default" };
}
