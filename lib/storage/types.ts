/**
 * Backend-agnostic storage interface. Implementations: Supabase Storage and
 * Cloudflare R2 (S3-compatible). The active driver is selected at runtime
 * via the STORAGE_DRIVER env var.
 */
export interface StorageAdapter {
  /** Upload a single object. Body can be Buffer/Uint8Array/Blob. */
  upload(
    key: string,
    body: Buffer | Uint8Array | Blob,
    contentType?: string
  ): Promise<void>;

  /** Generate a signed URL for the object, expiring in `expiresInSeconds`. */
  getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;

  /** Delete a single object. No-op if it doesn't exist. */
  delete(key: string): Promise<void>;

  /** Delete every object under `prefix`. Used when removing a course version. */
  deletePrefix(prefix: string): Promise<void>;

  /** List object keys under `prefix`. */
  list(prefix: string): Promise<string[]>;
}
