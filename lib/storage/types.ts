/**
 * Backend-agnostic storage interface. Implementations: Supabase Storage and
 * Cloudflare R2 (S3-compatible). The active driver is selected at runtime
 * via the STORAGE_DRIVER env var, and per course version via
 * course_versions.storage_driver (0077) so content can be migrated between
 * backends one version at a time.
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

  /**
   * Signed URL the BROWSER can PUT one object to, no server in the path.
   * The URL is bound to the exact key and expires; the client must send the
   * returned headers verbatim (the content type is part of the signature on
   * S3-style backends).
   */
  getSignedUploadUrl(
    key: string,
    opts: { contentType: string; expiresInSeconds?: number }
  ): Promise<SignedUpload>;

  /** Metadata for one object, or null when it does not exist. */
  head(key: string): Promise<StorageHead | null>;

  /**
   * Stream one object, honouring an HTTP Range header value when given
   * ("bytes=0-1023"). null when the object does not exist. Throws
   * StorageRangeError when the range cannot be satisfied.
   */
  getObject(key: string, range?: string | null): Promise<StorageObject | null>;

  /** Delete a single object. No-op if it doesn't exist. */
  delete(key: string): Promise<void>;

  /** Delete every object under `prefix`. Used when removing a course version. */
  deletePrefix(prefix: string): Promise<void>;

  /** List object keys under `prefix`. */
  list(prefix: string): Promise<string[]>;
}

export interface SignedUpload {
  url: string;
  method: "PUT";
  /** Headers the browser must send with the PUT. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StorageHead {
  size: number;
  contentType: string | null;
  etag: string | null;
}

export interface StorageObject {
  body: ReadableStream<Uint8Array> | null;
  /** 200 for a full object, 206 for a partial one. */
  status: 200 | 206;
  /** Bytes in this response body. */
  contentLength: number;
  /** Total object size (also the denominator of contentRange). */
  size: number;
  contentRange: string | null;
  contentType: string | null;
  etag: string | null;
}

export class StorageRangeError extends Error {
  constructor(public readonly size: number) {
    super("Requested range not satisfiable");
  }
}

/**
 * Parse "bytes=a-b" / "bytes=a-" / "bytes=-n" against a known size into
 * inclusive [start, end]. Returns null for an absent or malformed header and
 * throws StorageRangeError when the range lies outside the object.
 */
export function resolveRange(
  range: string | null | undefined,
  size: number
): { start: number; end: number } | null {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start: number;
  let end: number;
  if (a === "") {
    // suffix range: last n bytes
    const n = Number(b);
    if (n <= 0) throw new StorageRangeError(size);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) throw new StorageRangeError(size);
  return { start, end };
}
