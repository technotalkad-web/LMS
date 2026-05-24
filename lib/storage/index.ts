import type { StorageAdapter } from "./types";

let cached: StorageAdapter | null = null;

/**
 * Returns the active storage adapter based on STORAGE_DRIVER env var.
 *  - "supabase" (default): Supabase Storage with the service-role key
 *  - "r2": Cloudflare R2 via the S3 API
 *
 * Lazily imports the implementation so the AWS SDK isn't pulled in when
 * we're using Supabase, and vice versa.
 */
export async function getStorage(): Promise<StorageAdapter> {
  if (cached) return cached;

  const driver = (process.env.STORAGE_DRIVER ?? "supabase").toLowerCase();

  switch (driver) {
    case "supabase": {
      const { SupabaseStorageAdapter } = await import("./supabase");
      cached = new SupabaseStorageAdapter();
      break;
    }
    case "r2": {
      const { R2StorageAdapter } = await import("./r2");
      cached = new R2StorageAdapter();
      break;
    }
    default:
      throw new Error(`Unknown STORAGE_DRIVER: ${driver} (expected "supabase" or "r2")`);
  }

  return cached;
}

export type { StorageAdapter } from "./types";
