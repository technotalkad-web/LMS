/**
 * Request parsing shared by the list-style integration endpoints
 * (catalog, progress). Each accepts the same parameters three ways so a
 * CRM can call it however its HTTP client prefers:
 *   - GET  ?page=2&employee_id=A,B&employee_id=C
 *   - POST application/json            { "page": 2, "employee_id": ["A","B"] }
 *   - POST application/x-www-form-urlencoded (what the UpsideLMS APIs took)
 */
export type Params = Record<string, unknown>;

export async function readParams(request: Request): Promise<Params> {
  const out: Params = {};
  for (const [k, v] of new URL(request.url).searchParams) {
    const prev = out[k];
    out[k] = prev === undefined ? v : ([] as unknown[]).concat(prev as unknown[], v);
  }
  if (request.method === "POST") {
    const ct = (request.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      const body = await request.json().catch(() => null);
      if (body && typeof body === "object" && !Array.isArray(body)) Object.assign(out, body);
    } else if (ct.includes("form")) {
      const fd = await request.formData().catch(() => null);
      if (fd) for (const [k, v] of fd) out[k] = typeof v === "string" ? v : String(v);
    }
  }
  return out;
}

/** First present key wins — lets Upside-era names (email_id, curriculum_id) keep working. */
export function pick(p: Params, ...keys: string[]): unknown {
  for (const k of keys) if (p[k] !== undefined && p[k] !== null && p[k] !== "") return p[k];
  return undefined;
}

/** Arrays, JSON-encoded arrays, or comma-separated strings → trimmed list. */
export function list(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.flatMap((x) => list(x));
  const s = String(v).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      /* fall through to comma split */
    }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

export function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export function int(v: unknown, def: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Accepts ISO 8601, "YYYY-MM-DD HH:MM" (Upside's format) or a bare date.
 * A bare date covers the whole UTC day: start-of-day for `from`, end-of-day
 * for `to`. Returns null when absent, "invalid" when unparseable.
 */
export function iso(v: unknown, edge: "from" | "to"): string | null | "invalid" {
  if (v === undefined || v === null || v === "") return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += edge === "from" ? "T00:00:00.000Z" : "T23:59:59.999Z";
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(" ", "T") + "Z";
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return "invalid";
  return new Date(t).toISOString();
}
