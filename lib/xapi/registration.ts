/**
 * Rule R-3, the registration rule (ADR 0014 step 5). Pure,
 * no imports.
 *
 * A statement whose `context.registration` names ANOTHER attempt of the same
 * learner on the same course (a sibling) is answered 200 with its id by the
 * statements route and is not stored, processed or mirrored: an engine that
 * kept a stale registration after a new attempt opened must never write
 * into the bound attempt under another attempt's name. Absent, non-UUID,
 * same-attempt and unknown registrations behave as before (third-party
 * engines that mint their own registration keep working). The rule becomes
 * a 403 when the strict gateway lands (blueprint G3).
 */

export type RegistrationVerdict = "absent" | "not_uuid" | "same" | "sibling" | "unknown";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this a UUID (any version, case-insensitive)? */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export function registrationVerdict(i: {
  /** The statement's context.registration, as sent. */
  registration: unknown;
  /** The attempt the request's token is bound to. */
  attemptId: string;
  /** Every attempt id of the bound attempt's learner on the bound attempt's course. */
  siblingAttemptIds: ReadonlySet<string>;
}): RegistrationVerdict {
  const r = i.registration;
  if (r === undefined || r === null || typeof r !== "string" || r === "") return "absent";
  if (!isUuid(r)) return "not_uuid";
  const norm = r.toLowerCase();
  if (norm === i.attemptId.toLowerCase()) return "same";
  for (const id of i.siblingAttemptIds) if (id.toLowerCase() === norm) return "sibling";
  return "unknown";
}
