/** Per-person outcome of a bulk action (reminder, grant, assignment). */
export type PerLearnerResult = {
  userId: string;
  status: "sent" | "skipped" | "failed" | "granted" | "assigned" | "already";
  reason?: string;
  /**
   * Set only on a row that another press of the same action finishes (ADR
   * 0029, note of 2026-11-25, part 2, point 6): not saved for want of the
   * request's room, or its save not confirmed. A caller reads this mark,
   * never the reason's words.
   */
  retry?: true;
};

/** 503: a check could not be read (ADR 0030: "try again", never a refusal or a grant). */
export type ActionError = { error: string; status: 400 | 401 | 403 | 404 | 409 | 503 };

export const isActionError = (x: unknown): x is ActionError =>
  !!x && typeof x === "object" && "error" in x && "status" in x;

/**
 * What an action's answer says of its mail, as a page reads it (ADR 0029
 * rule T4; the shape of MailOutcome in lib/notifications/send.ts, restated
 * here so a page can import it): emailed and not emailed, a timeout as
 * "not confirmed", or nobody emailed because the recipients could not be
 * read.
 */
export type MailOutcomeAnswer =
  | { recipients_unreadable: true }
  | { recipients_unreadable: false; emailed: number; not_emailed: number; not_confirmed: number };

/** The words a page shows for a mail outcome; null when there was no mail to speak of. */
export function mailOutcomeWords(o: MailOutcomeAnswer | null | undefined): string | null {
  if (!o) return null;
  if (o.recipients_unreadable) return "Nobody was emailed: the recipients could not be read. The change is saved; tell them another way or try again later.";
  if (o.emailed + o.not_emailed + o.not_confirmed === 0) return null;
  const parts = [`Emailed ${o.emailed}.`];
  if (o.not_emailed > 0) parts.push(`Not emailed ${o.not_emailed}.`);
  if (o.not_confirmed > 0) parts.push(`Not confirmed ${o.not_confirmed}: the mail may still arrive.`);
  return parts.join(" ");
}
