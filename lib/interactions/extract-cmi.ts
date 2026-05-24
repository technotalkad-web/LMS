import type { Interaction } from "./types";
import type { CmiData } from "@/lib/scorm/types";

/**
 * Pull SCORM 1.2 interactions out of a CMI snapshot.
 *
 * Layout per the SCORM 1.2 RTE spec:
 *   cmi.interactions.N.id
 *   cmi.interactions.N.type            ("choice" | "fill-in" | "matching" | ...)
 *   cmi.interactions.N.student_response
 *   cmi.interactions.N.correct_responses.0.pattern
 *   cmi.interactions.N.result          ("correct" | "wrong" | "neutral" | numeric)
 *   cmi.interactions.N.weighting
 *   cmi.interactions.N.latency         (ISO 8601 PT-style or HH:MM:SS.SS)
 *   cmi.interactions.N.time            (HH:MM:SS)
 */
export function extractInteractionsFromCmi(cmi: CmiData): Interaction[] {
  const indices = new Set<number>();
  for (const key of Object.keys(cmi)) {
    const m = key.match(/^cmi\.interactions\.(\d+)\./);
    if (m) indices.add(parseInt(m[1], 10));
  }
  const out: Interaction[] = [];
  for (const i of Array.from(indices).sort((a, b) => a - b)) {
    const base = `cmi.interactions.${i}`;
    const id = cmi[`${base}.id`] ?? `interaction-${i}`;
    const type = cmi[`${base}.type`] ?? "unknown";
    const response = cmi[`${base}.student_response`];
    const correctResponse = cmi[`${base}.correct_responses.0.pattern`];

    const result = (cmi[`${base}.result`] ?? "").toLowerCase();
    let success: boolean | null = null;
    if (result === "correct") success = true;
    else if (result === "wrong") success = false;

    const weightStr = cmi[`${base}.weighting`];
    const weight = weightStr ? parseFloat(weightStr) : NaN;

    const duration = cmi[`${base}.latency`];
    const timestamp = cmi[`${base}.time`];

    out.push({
      id,
      type,
      response,
      correctResponse,
      success,
      weight: Number.isNaN(weight) ? undefined : weight,
      duration,
      timestamp,
    });
  }
  return out;
}
