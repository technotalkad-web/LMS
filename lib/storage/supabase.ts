import { createClient } from "@supabase/supabase-js";
import type { StorageAdapter } from "./types";

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "course-content";

/**
 * Supabase Storage adapter. Uses the service-role key so uploads bypass
 * client-facing RLS. NEVER import this from a client component.
 */
export class SupabaseStorageAdapter implements StorageAdapter {
  private client;

  constructor() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new Error(
        "SupabaseStorageAdapter: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"
      );
    }
    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
  }

  async upload(
    key: string,
    body: Buffer | Uint8Array | Blob,
    contentType?: string
  ): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(key, body, {
        contentType,
        upsert: true,
      });
    if (error) throw new Error(`Supabase upload failed (${key}): ${error.message}`);
  }

  async getSignedDownloadUrl(
    key: string,
    expiresInSeconds = 60 * 60 * 24
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(key, expiresInSeconds);
    if (error || !data) {
      throw new Error(`Supabase signed url failed (${key}): ${error?.message}`);
    }
    return data.signedUrl;
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).remove([key]);
    if (error) throw new Error(`Supabase delete failed (${key}): ${error.message}`);
  }

  async deletePrefix(prefix: string): Promise<void> {
    const keys = await this.list(prefix);
    if (keys.length === 0) return;
    const { error } = await this.client.storage.from(BUCKET).remove(keys);
    if (error) {
      throw new Error(`Supabase deletePrefix failed (${prefix}): ${error.message}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];

    // Supabase storage list is per-folder; recurse manually.
    const stack: string[] = [prefix];
    while (stack.length > 0) {
      const folder = stack.pop()!;
      const { data, error } = await this.client.storage
        .from(BUCKET)
        .list(folder, { limit: 1000 });
      if (error) throw new Error(`Supabase list failed (${folder}): ${error.message}`);
      if (!data) continue;
      for (const entry of data) {
        const fullPath = folder ? `${folder.replace(/\/$/, "")}/${entry.name}` : entry.name;
        // entries with no metadata are folders in Supabase Storage
        if (entry.id === null || entry.metadata === null) {
          stack.push(fullPath);
        } else {
          out.push(fullPath);
        }
      }
    }
    return out;
  }
}
