/** Default life of an approved grant. The admin may choose another span or "never". */
export const DEFAULT_GRANT_EXPIRY_DAYS = 30;

/** Allowed expiry choices (days); null = never expires. Client-safe (no server imports). */
export const GRANT_EXPIRY_CHOICES: Array<number | null> = [7, 14, 30, 60, 90, null];
