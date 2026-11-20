import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PostgREST house rules in one place: `.in()` lists chunked at 150 ids and
 * every read paged at 1000 rows (the server-side cap), ordered by a stable
 * key so a page boundary can't skip or duplicate a row.
 *
 * `apply` is loosely typed on purpose: supabase-js builder generics explode
 * ("excessively deep") when threaded through helper signatures.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function fetchByIds<T>(
  svc: SupabaseClient,
  table: string,
  select: string,
  col: string,
  ids: string[],
  apply?: (q: any) => any,
  orderBy = "id"
): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(ids.filter(Boolean))];
  for (const part of chunk(uniq, 150)) {
    for (let from = 0; ; from += 1000) {
      let q: any = svc.from(table).select(select).in(col, part).order(orderBy).range(from, from + 999);
      if (apply) q = apply(q);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      const page = (data ?? []) as T[];
      out.push(...page);
      if (page.length < 1000) break;
    }
  }
  return out;
}

export async function fetchAll<T>(
  svc: SupabaseClient,
  table: string,
  select: string,
  apply: (q: any) => any,
  orderBy = "id"
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(
      svc.from(table).select(select).order(orderBy).range(from, from + 999)
    );
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Asked before each outbound call a reader makes (ADR 0029, rule FP2: the
 * sum counts the calls made, every paged read included). True: the call is
 * made, and a caller that counts its calls has counted it. False: the read
 * stops there and answers "no_room", never part of a set.
 */
export type CallGate = () => boolean;
/** A gate that only counts and never refuses: its reader never answers "no_room". */
export type CallCounter = () => true;

/**
 * The same house rules for a read that decides who is mailed (ADR 0029):
 * it never throws and never answers part of a set. `page(from, to)` builds
 * one page's query, ordered by a stable key; pages of 1000 rows are read
 * until a short one. `beforePage`, when given, is asked before every page
 * and may refuse it (a caller that counts its calls has no room left).
 *
 * The answer is every row, "unreadable" when a page failed, threw or
 * answered no list, or "no_room" when `beforePage` refused a page.
 */
export async function readAllStrict<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  beforePage?: CallGate
): Promise<T[] | "unreadable" | "no_room"> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    if (beforePage && !beforePage()) return "no_room";
    let answer: { data: unknown; error: unknown };
    try {
      answer = await page(from, from + 999);
    } catch {
      return "unreadable";
    }
    if (answer.error || !Array.isArray(answer.data)) return "unreadable";
    out.push(...(answer.data as T[]));
    if (answer.data.length < 1000) break;
  }
  return out;
}

/**
 * readAllStrict over an `.in()` list: the ids in chunks of 150, each chunk
 * read in pages of 1000. `page(part, from, to)` builds one page's query for
 * one chunk. The same three answers; an empty list reads nothing.
 */
export async function readByIdsStrict<T>(
  ids: Iterable<string>,
  page: (part: string[], from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  beforePage?: CallGate
): Promise<T[] | "unreadable" | "no_room"> {
  const out: T[] = [];
  for (const part of chunk([...new Set([...ids].filter(Boolean))], 150)) {
    const rows = await readAllStrict<T>((from, to) => page(part, from, to), beforePage);
    if (rows === "unreadable" || rows === "no_room") return rows;
    out.push(...rows);
  }
  return out;
}
