import type { Interaction } from "./types";
import type { XapiStatement } from "@/lib/xapi/types";

/**
 * Walk an xAPI statement log and pull out interaction records.
 * Any statement whose object.definition has an `interactionType` is treated
 * as an interaction, regardless of verb (cmi5 packages mostly use
 * `answered` but some use `attempted` or `experienced` for question events).
 */
export function extractInteractionsFromXapi(
  stmts: XapiStatement[]
): Interaction[] {
  const out: Interaction[] = [];
  for (const s of stmts) {
    const obj = (s.object ?? {}) as Record<string, unknown>;
    const def = (obj.definition ?? {}) as Record<string, unknown>;
    const interactionType = def.interactionType;
    if (typeof interactionType !== "string") continue;

    const id = (obj.id as string) ?? "";
    const name = readLang(def.name);
    const description = readLang(def.description);

    const correctPattern = def.correctResponsesPattern;
    const correctResponse = Array.isArray(correctPattern)
      ? (correctPattern as string[]).join(", ")
      : undefined;

    const response = s.result?.response;
    const success =
      typeof s.result?.success === "boolean" ? s.result.success : null;
    const scaled = s.result?.score?.scaled;
    const score = typeof scaled === "number" ? scaled : null;
    const duration = s.result?.duration;
    const timestamp = s.timestamp;

    out.push({
      id,
      name,
      description,
      type: interactionType,
      response,
      correctResponse,
      success,
      score,
      duration,
      timestamp,
    });
  }
  // Sort by timestamp ascending if present, otherwise by insertion order.
  out.sort((a, b) => {
    if (a.timestamp && b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    return 0;
  });
  return out;
}

function readLang(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const m = node as Record<string, unknown>;
  for (const key of ["en-US", "en", "und"]) {
    const v = m[key];
    if (typeof v === "string") return v;
  }
  for (const v of Object.values(m)) {
    if (typeof v === "string") return v;
  }
  return undefined;
}
