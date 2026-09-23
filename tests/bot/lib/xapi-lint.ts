/**
 * Minimal xAPI 1.0.3 statement lint — the structural rules strict LRSs
 * (Veracity, Watershed, SQL LRS) enforce on ingest. Returns problems; an
 * empty array means the statement would be accepted structurally.
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isIri = (v: unknown): boolean => typeof v === "string" && /^[a-z][a-z0-9+.-]*:/i.test(v) && !/\s/.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DUR = /^P(?!$)(\d+(?:\.\d+)?Y)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?W)?(\d+(?:\.\d+)?D)?(T(?=\d)(\d+(?:\.\d+)?H)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?S)?)?$/;
const INTERACTION_TYPES = new Set(["true-false", "choice", "fill-in", "long-fill-in", "matching", "performance", "sequencing", "likert", "numeric", "other"]);

function lintAgent(a: unknown, where: string, out: string[]) {
  if (!isObj(a)) return out.push(`${where}: missing`);
  if (a.objectType && a.objectType !== "Agent" && a.objectType !== "Group") out.push(`${where}: objectType ${String(a.objectType)}`);
  const ifis = ["mbox", "mbox_sha1sum", "openid", "account"].filter((k) => a[k] !== undefined);
  if (ifis.length !== 1) out.push(`${where}: exactly one IFI required, got ${ifis.length} (${ifis.join(",")})`);
  if (typeof a.mbox === "string" && !/^mailto:[^@\s]+@[^@\s]+$/.test(a.mbox)) out.push(`${where}: mbox must be mailto:<email>`);
  if (isObj(a.account)) {
    if (!isIri(a.account.homePage)) out.push(`${where}: account.homePage must be an IRI`);
    if (typeof a.account.name !== "string" || !a.account.name) out.push(`${where}: account.name required`);
  }
}

function lintActivity(o: unknown, where: string, out: string[]) {
  if (!isObj(o)) return out.push(`${where}: missing`);
  if (o.objectType && o.objectType !== "Activity") return; // agents/statement refs not linted here
  if (!isIri(o.id)) out.push(`${where}: id must be an IRI (${String(o.id)})`);
  if (o.definition !== undefined) {
    if (!isObj(o.definition)) return out.push(`${where}: definition must be an object`);
    const d = o.definition;
    if (d.type !== undefined && !isIri(d.type)) out.push(`${where}: definition.type must be an IRI`);
    if (d.name !== undefined && !isObj(d.name)) out.push(`${where}: definition.name must be a language map`);
    if (d.description !== undefined && !isObj(d.description)) out.push(`${where}: definition.description must be a language map`);
    if (d.interactionType !== undefined && !INTERACTION_TYPES.has(String(d.interactionType))) out.push(`${where}: unknown interactionType ${String(d.interactionType)}`);
    if (d.correctResponsesPattern !== undefined && !Array.isArray(d.correctResponsesPattern)) out.push(`${where}: correctResponsesPattern must be an array`);
    if (d.extensions !== undefined) {
      if (!isObj(d.extensions)) out.push(`${where}: definition.extensions must be an object`);
      else for (const k of Object.keys(d.extensions)) if (!isIri(k)) out.push(`${where}: extension key not an IRI: ${k}`);
    }
  }
}

export function lintStatement(s: unknown): string[] {
  const out: string[] = [];
  if (!isObj(s)) return ["statement: not an object"];
  if (s.id !== undefined && !UUID.test(String(s.id))) out.push(`id: not a UUID (${String(s.id)})`);
  lintAgent(s.actor, "actor", out);
  if (!isObj(s.verb) || !isIri(s.verb.id)) out.push("verb.id must be an IRI");
  else if (s.verb.display !== undefined && !isObj(s.verb.display)) out.push("verb.display must be a language map");
  lintActivity(s.object, "object", out);
  if (s.result !== undefined) {
    if (!isObj(s.result)) out.push("result must be an object");
    else {
      const r = s.result;
      if (isObj(r.score)) {
        const sc = r.score.scaled;
        if (sc !== undefined && (typeof sc !== "number" || sc < -1 || sc > 1)) out.push("result.score.scaled must be -1..1");
        for (const k of ["raw", "min", "max"]) if (r.score[k] !== undefined && typeof r.score[k] !== "number") out.push(`result.score.${k} must be a number`);
        if (typeof r.score.min === "number" && typeof r.score.max === "number" && r.score.min > r.score.max) out.push("result.score.min > max");
        if (typeof r.score.raw === "number" && typeof r.score.max === "number" && r.score.raw > r.score.max) out.push("result.score.raw > max");
      }
      if (r.success !== undefined && typeof r.success !== "boolean") out.push("result.success must be boolean");
      if (r.completion !== undefined && typeof r.completion !== "boolean") out.push("result.completion must be boolean");
      if (r.response !== undefined && typeof r.response !== "string") out.push("result.response must be a string");
      if (r.duration !== undefined && !ISO_DUR.test(String(r.duration))) out.push(`result.duration not ISO 8601 (${String(r.duration)})`);
      if (r.extensions !== undefined) {
        if (!isObj(r.extensions)) out.push("result.extensions must be an object");
        else for (const k of Object.keys(r.extensions)) if (!isIri(k)) out.push(`result extension key not an IRI: ${k}`);
      }
    }
  }
  if (s.context !== undefined) {
    if (!isObj(s.context)) out.push("context must be an object");
    else {
      const c = s.context;
      if (c.registration !== undefined && !UUID.test(String(c.registration))) out.push("context.registration must be a UUID");
      if (c.language !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(c.language))) out.push(`context.language not RFC 5646 (${String(c.language)})`);
      if (c.platform !== undefined && typeof c.platform !== "string") out.push("context.platform must be a string");
      if (c.contextActivities !== undefined) {
        if (!isObj(c.contextActivities)) out.push("contextActivities must be an object");
        else
          for (const k of ["parent", "grouping", "category", "other"]) {
            const v = c.contextActivities[k];
            if (v === undefined) continue;
            const arr = Array.isArray(v) ? v : [v];
            arr.forEach((a, i) => lintActivity(a, `contextActivities.${k}[${i}]`, out));
          }
      }
      if (c.extensions !== undefined) {
        if (!isObj(c.extensions)) out.push("context.extensions must be an object");
        else for (const k of Object.keys(c.extensions)) if (!isIri(k)) out.push(`context extension key not an IRI: ${k}`);
      }
    }
  }
  if (s.timestamp !== undefined && Number.isNaN(Date.parse(String(s.timestamp)))) out.push("timestamp not ISO 8601");
  return out;
}
