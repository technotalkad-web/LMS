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
