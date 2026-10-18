/**
 * ALDS rules as code (ADR 0005 §3 step 8; BLUEPRINT §1.3, §2, §5.2 G3, §7).
 *
 * The public surface of the rules bundle. scripts/build-alds-rules.mjs compiles
 * this file (and only what it imports, all inside lib/alds) to an IIFE that
 * defines the global `AldsRules`; its sha256 is the `rulesBundleHash`.
 *
 * Entry points:
 *   checkStatement(statement, { manifest?, launchData?, auActivityId? })
 *       shape, grammar and semantic checks of one statement (the KIVO
 *       in-editor export self-check, ADR 0006 step 14; P5 ingest)
 *   checkSession(statements, { auActivityId?, launchData? })
 *       ordering within sessions and once-per-registration
 *   checkPackage({ manifestText, manifestType, cmi5Xml, …, knownBundleHashes, slotLanguage })
 *       U-rules, R4 and the pool rule over a package's manifests (an
 *       addition to the two entry points of step 8, for the mini-package
 *       fixtures and the P4 static check)
 * Helpers: contentHash, parseInteraction, responseMatches, detectScript.
 *
 * Pure: no imports outside lib/alds, no DOM or Node APIs, no I/O, no clock,
 * no randomness; the same input always gives the same result.
 */
export { RULE_IDS, type Attribution, type CheckResult, type Finding, type RuleId, type Severity } from "./findings";
export { checkStatement, classifyStatement, keyClassOf, parseQuizRunIri, type StatementClass, type StatementContext } from "./statement";
export { checkSession, type SessionContext } from "./session";
export { checkPackage, decodeXmlEntities, xmlAttributeValues, U4_SCRIPT_SHARE, type PackageInput, type PackageResult } from "./package";
export { canonicalContentJson, contentHash, type ContentHashInput } from "./content-hash";
export { canonicalPatternKey, parseInteraction, responseMatches, type GrammarMode, type Parsed, type ParseResult } from "./grammar";
export { detectScript, scriptForLanguage, type DetectedScript, type ScriptProfile } from "./script";
export { sha256Hex, sha256HexOfString, utf8Encode } from "./sha256";
export { canonicalBcp47, isBcp47, normalizeText } from "./util";
export {
  ALDS_VERSION,
  EXT,
  EXT_RESULT_UNANSWERED,
  KEY_CLASS_BY_AUTHORING_KIND,
  SCRIPT_FOR_LANGUAGE,
  UNANSWERED_REASONS,
  auActivityId,
  courseFamily,
  langPath,
  questionFamily,
  questionObject,
  quizRun,
} from "../types";
