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
