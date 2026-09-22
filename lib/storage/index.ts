import type { StorageAdapter } from "./types";

export type StorageDriver = "supabase" | "r2";

const cache = new Map<StorageDriver, StorageAdapter>();

/** The driver NEW uploads go to (STORAGE_DRIVER env, default supabase). */
export function activeStorageDriver(): StorageDriver {
  const d = (process.env.STORAGE_DRIVER ?? "supabase").toLowerCase();
  if (d === "r2" || d === "supabase") return d;
  throw new Error(`Unknown STORAGE_DRIVER: ${d} (expected "supabase" or "r2")`);
}

/**
 * Adapter for a specific driver. Course versions record the driver their
 * files were written to (course_versions.storage_driver, 0077), so reads
 * always go to the right backend during and after the R2 migration.
 *
 * Lazily imports the implementation so the AWS SDK isn't pulled in when
 * we're using Supabase, and vice versa.
 */
export async function getStorageFor(driver: string | null | undefined): Promise<StorageAdapter> {
  const d: StorageDriver = driver === "r2" ? "r2" : driver === "supabase" ? "supabase" : activeStorageDriver();
  const hit = cache.get(d);
  if (hit) return hit;
  let adapter: StorageAdapter;
  if (d === "r2") {
    const { R2StorageAdapter } = await import("./r2");
    adapter = new R2StorageAdapter();
  } else {
    const { SupabaseStorageAdapter } = await import("./supabase");
    adapter = new SupabaseStorageAdapter();
  }
  cache.set(d, adapter);
  return adapter;
}

/** Returns the active storage adapter based on STORAGE_DRIVER env var. */
export async function getStorage(): Promise<StorageAdapter> {
  return getStorageFor(activeStorageDriver());
}

export type { StorageAdapter } from "./types";
