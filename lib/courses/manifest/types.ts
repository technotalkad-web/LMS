export type ManifestType = "scorm12" | "cmi5";

export interface ParsedManifest {
  type: ManifestType;
  title: string;
  description?: string;
  /** Path inside the package zip that the iframe should load. */
  launchUrl: string;
  /** Mastery / passing score (0-1 fraction) if defined in the manifest. */
  masteryScore?: number;
  /** Standard-specific raw extracted fields, persisted as JSONB. */
  raw: Record<string, unknown>;
}
