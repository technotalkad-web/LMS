/**
 * Learner Analytics `?content=` filter guard (ALDS step 0, P5).
 *
 * The filter names one piece of content as `course:<id>`, `path:<id>` or
 * `journey:<programId>`. It is honoured only when that id is in the
 * organisation's own maps; the course lens drives question-level views that
 * are read with the service role and keyed by course id alone, so a foreign
 * id would read another organisation's question statistics.
 */
type IdSet = { has(id: string): boolean };

export function contentFilterInOrg(
  value: string,
  maps: { courseIds: IdSet; pathIds: IdSet; programIds: IdSet }
): boolean {
  const sep = value.indexOf(":");
  if (sep <= 0) return false;
  const kind = value.slice(0, sep);
  const id = value.slice(sep + 1);
  if (!id) return false;
  if (kind === "course") return maps.courseIds.has(id);
  if (kind === "path") return maps.pathIds.has(id);
  if (kind === "journey") return maps.programIds.has(id);
  return false;
}
