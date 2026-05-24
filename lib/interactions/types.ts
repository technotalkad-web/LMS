/**
 * Normalized interaction record extracted from either a cmi5 xAPI
 * "answered" statement or a SCORM 1.2 cmi.interactions.N.* block.
 * Both standards capture the same conceptual data; we collapse them
 * into one shape so the UI renders one table either way.
 */
export interface Interaction {
  /** Question id (xAPI activity id or SCORM interaction id). */
  id: string;
  /** Friendly name pulled from cmi5 object.definition.name (en preferred). */
  name?: string;
  /** Question prompt text if the package included one. */
  description?: string;
  /** "choice" | "fill-in" | "matching" | "sequencing" | "true-false" | "long-fill-in" | ... */
  type: string;
  /** Learner's response, as the package recorded it. */
  response?: string;
  /** Correct answer pattern from the manifest. */
  correctResponse?: string;
  /** true = correct, false = wrong, null = ungraded / not reported. */
  success: boolean | null;
  /** 0-1 if the package reported a per-question score. */
  score?: number | null;
  /** Per-question weight (SCORM cmi.interactions.N.weighting). */
  weight?: number;
  /** ISO 8601 duration, or whatever the package gave us. */
  duration?: string;
  /** When the interaction was recorded. */
  timestamp?: string;
}
