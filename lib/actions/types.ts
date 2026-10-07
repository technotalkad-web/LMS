/** Per-person outcome of a bulk action (reminder, grant, assignment). */
export type PerLearnerResult = {
  userId: string;
  status: "sent" | "skipped" | "failed" | "granted" | "assigned" | "already";
  reason?: string;
};

export type ActionError = { error: string; status: 400 | 401 | 403 | 404 | 409 };

export const isActionError = (x: unknown): x is ActionError =>
  !!x && typeof x === "object" && "error" in x && "status" in x;
