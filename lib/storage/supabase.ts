import { createClient } from "@supabase/supabase-js";
import {
  StorageRangeError,
  resolveRange,
  type SignedUpload,
  type StorageAdapter,
  type StorageHead,
  type StorageObject,
} from "./types";

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "course-content";

/**
 * Supabase Storage adapter. Uses the service-role key so uploads bypass
 * client-facing RLS. NEVER import this from a client component.
 *
 * Still the driver for versions uploaded before the R2 move (their
 * course_versions.storage_driver is 'supabase'); new uploads go to R2.
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

  async getSignedUploadUrl(
    key: string,
    opts: { contentType: string; expiresInSeconds?: number }
  ): Promise<SignedUpload> {
    // Supabase signed upload URLs are valid for 2 hours and cannot be
    // shortened; the token is single-use per key.
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .createSignedUploadUrl(key, { upsert: true });
    if (error || !data) {
      throw new Error(`Supabase signed upload url failed (${key}): ${error?.message}`);
    }
    return {
      url: data.signedUrl,
      method: "PUT",
      headers: { "content-type": opts.contentType, "x-upsert": "true" },
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    };
  }

  async head(key: string): Promise<StorageHead | null> {
    const folder = key.split("/").slice(0, -1).join("/");
    const name = key.split("/").pop() ?? "";
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .list(folder, { limit: 1, search: name });
    if (error) throw new Error(`Supabase head failed (${key}): ${error.message}`);
    const hit = (data ?? []).find((e) => e.name === name && e.metadata);
    if (!hit) return null;
    const meta = hit.metadata as { size?: number; mimetype?: string; eTag?: string };
    return {
      size: Number(meta.size ?? 0),
      contentType: meta.mimetype ?? null,
      etag: meta.eTag ?? null,
    };
  }

  async getObject(key: string, range?: string | null): Promise<StorageObject | null> {
    const url = await this.getSignedDownloadUrl(key, 300).catch(() => null);
    if (!url) return null;
    // identity: the gateway would otherwise gzip text and report the
    // compressed Content-Length while fetch() hands us the inflated stream —
    // the browser then truncates the document at the wrong byte.
    const res = await fetch(url, {
      headers: { "accept-encoding": "identity", ...(range ? { range } : {}) },
    });
    if (res.status === 404 || res.status === 400) return null;
    if (res.status === 416) {
      const h = await this.head(key);
      throw new StorageRangeError(h?.size ?? 0);
    }
    if (!res.ok) {
      throw new Error(`Supabase getObject failed (${key}): HTTP ${res.status}`);
    }
    const contentRange = res.headers.get("content-range");
    // If the gateway still compressed the body, the length is unknown (-1)
    // and the caller must not advertise one.
    const encoded = !!res.headers.get("content-encoding") && res.headers.get("content-encoding") !== "identity";
    const contentLength = encoded ? -1 : Number(res.headers.get("content-length") ?? 0);
    let size = contentRange ? Number(contentRange.split("/")[1]) : Math.max(contentLength, 0);
    // Some gateways ignore Range and return 200 with the whole object; treat
    // that as a full response so the caller never mislabels it.
    if (range && res.status === 200 && !contentRange) {
      const r = resolveRange(range, size);
      if (r && r.start === 0 && r.end === size - 1) size = contentLength;
    }
    return {
      body: res.body,
      status: res.status === 206 ? 206 : 200,
      contentLength,
      size: Number.isFinite(size) ? size : contentLength,
      contentRange,
      contentType: res.headers.get("content-type"),
      etag: res.headers.get("etag"),
    };
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
