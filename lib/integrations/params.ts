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
  const add = (k: string, v: unknown, fresh: Set<string>) => {
    // Repeated keys accumulate into a list (?employee_id=A&employee_id=B);
    // a body value replaces a query value of the same name.
    if (!fresh.has(k)) {
      fresh.add(k);
      out[k] = v;
    } else {
      out[k] = ([] as unknown[]).concat(out[k] as unknown[], v);
    }
  };
  const seenQuery = new Set<string>();
  for (const [k, v] of new URL(request.url).searchParams) add(k, v, seenQuery);
  if (request.method === "POST") {
    const ct = (request.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      const body = await request.json().catch(() => null);
      if (body && typeof body === "object" && !Array.isArray(body)) Object.assign(out, body);
    } else if (ct.includes("form")) {
      const fd = await request.formData().catch(() => null);
      const seenForm = new Set<string>();
      if (fd) for (const [k, v] of fd) add(k, typeof v === "string" ? v : String(v), seenForm);
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

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Minutes to ADD to a UTC instant to get wall-clock time in `tz` at that instant. */
function tzOffsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((wall - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** A wall-clock time in `tz` → the UTC instant (two passes cover DST edges). */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let utc = guess - tzOffsetMinutes(guess, tz) * 60000;
  utc = guess - tzOffsetMinutes(utc, tz) * 60000;
  return utc;
}

/**
 * Accepts ISO 8601 (with offset or Z), "YYYY-MM-DD HH:MM[:SS]" (Upside's
 * format) or a bare date. Times without an offset and bare dates are read
 * in `tz` (the organisation's calendar, e.g. Asia/Kolkata): a bare date
 * covers that whole local day, start-of-day for `from`, end-of-day for `to`.
 * Returns null when absent, "invalid" when unparseable.
 */
export function iso(v: unknown, edge: "from" | "to", tz = "UTC"): string | null | "invalid" {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  let t: number;
  try {
    if (day) {
      const [y, mo, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
      t = edge === "from" ? wallToUtc(y, mo, d, 0, 0, 0, 0, tz) : wallToUtc(y, mo, d, 23, 59, 59, 999, tz);
    } else if (naive) {
      t = wallToUtc(Number(naive[1]), Number(naive[2]), Number(naive[3]), Number(naive[4]), Number(naive[5]), Number(naive[6] ?? "0"), 0, tz);
    } else {
      t = Date.parse(s);
    }
  } catch {
    // Unknown time zone name → fall back to UTC rather than failing the call.
    return iso(v, edge, "UTC");
  }
  if (!Number.isFinite(t)) return "invalid";
  return new Date(t).toISOString();
}
