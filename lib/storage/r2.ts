import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  StorageRangeError,
  type SignedUpload,
  type StorageAdapter,
  type StorageHead,
  type StorageObject,
} from "./types";

/**
 * Cloudflare R2 adapter. R2 speaks the S3 API, so we use the AWS SDK with
 * R2's endpoint. Set STORAGE_DRIVER=r2 to activate.
 *
 * Env:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET  (required)
 *   R2_ENDPOINT   optional override for any S3-compatible endpoint (local
 *                 s3rver/MinIO in tests, Supabase's S3 gateway); path-style
 *                 addressing is used when set.
 *
 * Presigning is a local HMAC computation — no network call — so issuing a
 * signed upload URL per file costs the Worker nothing, which is what makes
 * browser-direct uploads of thousands of files possible.
 */
export class R2StorageAdapter implements StorageAdapter {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET;
    const endpointOverride = process.env.R2_ENDPOINT?.trim();
    if ((!accountId && !endpointOverride) || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        "R2StorageAdapter: R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET are required"
      );
    }
    this.bucket = bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: endpointOverride || `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: !!endpointOverride,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async upload(
    key: string,
    body: Buffer | Uint8Array | Blob,
    contentType?: string
  ): Promise<void> {
    let bodyBytes: Buffer | Uint8Array;
    if (body instanceof Blob) {
      bodyBytes = Buffer.from(await body.arrayBuffer());
    } else {
      bodyBytes = body;
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bodyBytes,
        ContentType: contentType,
      })
    );
  }

  async getSignedDownloadUrl(
    key: string,
    expiresInSeconds = 60 * 60 * 24
  ): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
  }

  async getSignedUploadUrl(
    key: string,
    opts: { contentType: string; expiresInSeconds?: number }
  ): Promise<SignedUpload> {
    const expiresIn = opts.expiresInSeconds ?? 15 * 60;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: opts.contentType,
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn });
    return {
      url,
      method: "PUT",
      headers: { "content-type": opts.contentType },
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async head(key: string): Promise<StorageHead | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? null,
        etag: res.ETag ?? null,
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async getObject(key: string, range?: string | null): Promise<StorageObject | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: range || undefined,
        })
      );
      const contentRange = res.ContentRange ?? null;
      const total = contentRange
        ? Number(contentRange.split("/")[1])
        : res.ContentLength ?? 0;
      const body = res.Body
        ? (res.Body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream()
        : null;
      return {
        body,
        status: contentRange ? 206 : 200,
        contentLength: res.ContentLength ?? 0,
        size: Number.isFinite(total) ? total : res.ContentLength ?? 0,
        contentRange,
        contentType: res.ContentType ?? null,
        etag: res.ETag ?? null,
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 416 || (e as { name?: string })?.name === "InvalidRange") {
        const h = await this.head(key);
        throw new StorageRangeError(h?.size ?? 0);
      }
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    const keys = await this.list(prefix);
    if (keys.length === 0) return;
    // S3 DeleteObjects accepts up to 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        })
      );
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) out.push(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }
}

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err?.name === "NoSuchKey" ||
    err?.name === "NotFound" ||
    err?.$metadata?.httpStatusCode === 404
  );
}
