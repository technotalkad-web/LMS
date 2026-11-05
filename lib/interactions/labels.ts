import type { SupabaseClient } from "@supabase/supabase-js";
import { readLang } from "./extract-xapi";

/**
 * Readable question labels for the two admin report pages (ADR 0016 steps 12
 * and 13; its readings note, items 3 and 12).
 *
 * mv_course_interaction_breakdown labels a question from name->>'en-US' only,
 * so a course whose statements key the name another way (a Hinglish package
 * keys it hi-Latn) reads as bare ids. These helpers fill the nulls at read time
 * from the course's own answered statements, by the rule the learner attempt
 * page uses (readLang). The matview is unchanged: a CSV export or an analyst's
 * SQL still sees ids until the matview change of ADR 0005 step 14 removes this
 * lookup.
 *
 * Only the object id and the name path are selected, so learner data never
 * enters the page's memory.
 *
 * Type-only Supabase import and no next/* import, so unit tests load this file.
 * It never imports lib/courses/upload, which carries a runtime client and
 * storage.
 */

export type LabelRow = { interaction_id: string; interaction_label: string | null };

/** The ids whose label is null, in row order, each once. */
export function missingLabelIds(rows: readonly LabelRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) if (r.interaction_label === null) ids.add(r.interaction_id);
  return [...ids];
}

/**
 * The rows with each null label replaced by the map's value when it has one.
 * Otherwise the label stays null and the renderers keep their id fallback. The
 * input is not mutated.
 */
export function mergeInteractionLabels<T extends LabelRow>(rows: T[], labels: Map<string, string>): T[] {
  return rows.map((r) => {
    if (r.interaction_label !== null) return r;
    const label = labels.get(r.interaction_id);
    return label === undefined ? r : { ...r, interaction_label: label };
  });
}

/**
 * The two verb spellings the matview counts (migration 0031), so every id it
 * can hold can find its statement.
 */
export const ANSWERED_VERBS = ["http://adlnet.gov/expapi/verbs/answered", "answered"] as const;

/**
 * Rows per read, inside PostgREST's 1000-row cap. A read holds only ids still
 * waiting for a label, and each needs just its first row.
 */
export const LABEL_READ_LIMIT = 500;

/**
 * Room for the two in() lists of one read, in URL-encoded characters: what the
 * house chunk of 150 uuids (lib/db/chunked.ts) already sends. Question ids are
 * long URNs of no fixed length, so they chunk by encoded length, not by count.
 */
const MAX_IN_LIST_CHARS = 5500;

/** Room kept for the ids when a course's version list takes the whole budget. */
const MIN_ID_LIST_CHARS = 1000;

/** The URL-encoded length of an id in an in() list, with its comma (%2C). */
function encodedLength(id: string): number {
  return encodeURIComponent(id).length + 3;
}

/**
 * The ids split so that each chunk's list fits the URL beside `reservedChars`
 * of other in() lists. Order is kept; an id too long for the budget goes alone.
 */
export function chunkLabelIds(ids: readonly string[], reservedChars = 0): string[][] {
  const budget = Math.max(MIN_ID_LIST_CHARS, MAX_IN_LIST_CHARS - reservedChars);
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const id of ids) {
    const size = encodedLength(id);
    if (current.length > 0 && used + size > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(id);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

type StatementNameRow = { iid: string | null; name: unknown };

/**
 * The label of each id: the first statement carrying a readable name under the
 * total order (stored, id), restricted to the course's versions and to answered
 * statements. It is the same label one `limit 1` per id would give, read in one
 * batched in() read per chunk rather than one round trip per id.
 *
 * No row cap can let some ids crowd out the others: an id leaves the in() list
 * once it has its label, so the chunk's next read holds only the ids still
 * waiting, whatever their share of the course's statements. The rows already read
 * for those ids hold only names with no readable string, and the next read's
 * offset skips them, so no row is read twice. So reads are bounded by the number
 * of ids plus one per 500 such rows, never by the statements of an id already
 * labelled. Each id's label comes from its own rows alone, so the same id yields
 * the same label on every load however the ids are chunked. New statements sort
 * after the old ones.
 *
 * A failed read leaves its chunk's waiting ids on the fallback for this load;
 * one warning per call carries their count and no id.
 */
export async function fetchInteractionLabels(
  svc: SupabaseClient,
  versionIds: string[],
  ids: string[],
  opts?: { concurrency?: number }
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  // supabase-js does not escape a double quote inside an in() list, and one such
  // id would fail its whole chunk on every load: it keeps the fallback alone.
  const wanted = [...new Set(ids)].filter((id) => id !== "" && !id.includes('"'));
  if (wanted.length === 0 || versionIds.length === 0) return labels;

  const versionChars = versionIds.reduce((sum, id) => sum + encodedLength(id), 0);
  const chunks = chunkLabelIds(wanted, versionChars);
  let failedIds = 0;

  const readChunk = async (chunk: string[]) => {
    const waiting = new Set(chunk);
    let offset = 0;
    // The rows read so far, per id.
    const seen = new Map<string, number>();
    while (waiting.size > 0) {
      let rows: StatementNameRow[];
      try {
        const { data, error } = await svc
          .from("xapi_statements")
          .select("iid:raw->object->>id, name:raw->object->definition->name, course_attempts!inner(course_version_id)")
          .in("course_attempts.course_version_id", versionIds)
          .in("verb", ANSWERED_VERBS)
          .in("raw->object->>id", [...waiting])
          .not("raw->object->definition->name", "is", null)
          .order("stored", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + LABEL_READ_LIMIT - 1);
        if (error) throw error;
        rows = (data ?? []) as unknown as StatementNameRow[];
      } catch {
        failedIds += waiting.size;
        return;
      }

      for (const row of rows) {
        if (typeof row.iid !== "string") continue;
        seen.set(row.iid, (seen.get(row.iid) ?? 0) + 1);
        if (!waiting.has(row.iid)) continue;
        const label = readLang(row.name);
        if (typeof label !== "string" || label.trim() === "") continue;
        labels.set(row.iid, label);
        waiting.delete(row.iid);
      }
      // A short read holds every row left. Otherwise the next read lists only the
      // ids still waiting, and a narrower in() list keeps its order, so the rows
      // already read for those ids are its head.
      if (rows.length < LABEL_READ_LIMIT) return;
      offset = [...waiting].reduce((n, id) => n + (seen.get(id) ?? 0), 0);
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < chunks.length) await readChunk(chunks[next++]);
  };
  const workers = Math.min(Math.max(1, opts?.concurrency ?? 4), chunks.length);
  await Promise.all(Array.from({ length: workers }, worker));

  if (failedIds > 0) console.warn(`[interaction-labels] label read failed; ${failedIds} id(s) keep the id fallback`);
  return labels;
}
