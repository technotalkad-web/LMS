/**
 * Cloudflare for SaaS — Custom Hostnames client.
 *
 * To serve a tenant's own domain (learn.acme.com) from our Worker, the hostname
 * must be registered with Cloudflare for SaaS on our zone. Cloudflare then
 * issues a DV certificate for it and routes matching traffic to our Worker's
 * fallback origin. This module is the thin API wrapper for that lifecycle.
 *
 * Required env (Worker secrets):
 *   CF_API_TOKEN          - token with "SSL and Certificates: Edit" on the zone
 *   CF_ZONE_ID            - the zone that owns the SaaS config
 *   CF_SAAS_CNAME_TARGET  - the CNAME target tenants point their domain at
 *                           (your fallback-origin hostname, e.g.
 *                           saas.mentora.app). Shown in the setup UI.
 *
 * Every function throws CloudflareNotConfigured if the env isn't present, so
 * callers can degrade gracefully (store the domain as "unconfigured" rather
 * than 500).
 */

const API = "https://api.cloudflare.com/client/v4";

export class CloudflareNotConfigured extends Error {
  constructor() {
    super("Cloudflare for SaaS is not configured (missing CF_API_TOKEN / CF_ZONE_ID)");
    this.name = "CloudflareNotConfigured";
  }
}

export class CloudflareApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export function cloudflareSaasConfigured(): boolean {
  return Boolean(process.env.CF_API_TOKEN && process.env.CF_ZONE_ID);
}

export function saasCnameTarget(): string | null {
  return process.env.CF_SAAS_CNAME_TARGET ?? null;
}

export type CustomHostnameStatus = {
  id: string;
  hostname: string;
  /** Overall hostname status: pending, active, etc. */
  status: string;
  /** Certificate status: pending_validation, active, etc. */
  sslStatus: string;
  /** DNS/TXT records the tenant must add for cert validation (if any). */
  validationRecords: Array<{ type: string; name: string; value: string }>;
};

function cfg(): { token: string; zone: string } {
  const token = process.env.CF_API_TOKEN;
  const zone = process.env.CF_ZONE_ID;
  if (!token || !zone) throw new CloudflareNotConfigured();
  return { token, zone };
}

type CfEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
};

type CfHostname = {
  id: string;
  hostname: string;
  status: string;
  ssl?: {
    status?: string;
    validation_records?: Array<{
      txt_name?: string;
      txt_value?: string;
      http_url?: string;
      http_body?: string;
    }>;
  };
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { token } = cfg();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
  if (!res.ok || !json?.success) {
    const msg =
      json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ||
      `Cloudflare API ${method} ${path} failed (${res.status})`;
    throw new CloudflareApiError(msg);
  }
  return json.result;
}

function normalize(h: CfHostname): CustomHostnameStatus {
  const records: CustomHostnameStatus["validationRecords"] = [];
  for (const r of h.ssl?.validation_records ?? []) {
    if (r.txt_name && r.txt_value) {
      records.push({ type: "TXT", name: r.txt_name, value: r.txt_value });
    }
  }
  return {
    id: h.id,
    hostname: h.hostname,
    status: h.status,
    sslStatus: h.ssl?.status ?? "unknown",
    validationRecords: records,
  };
}

/** Register a tenant hostname for SaaS routing + DV cert issuance. */
export async function createCustomHostname(hostname: string): Promise<CustomHostnameStatus> {
  const { zone } = cfg();
  const result = await call<CfHostname>(
    "POST",
    `/zones/${zone}/custom_hostnames`,
    { hostname, ssl: { method: "txt", type: "dv" } }
  );
  return normalize(result);
}

/** Poll current status (hostname active + cert issued?). */
export async function getCustomHostname(id: string): Promise<CustomHostnameStatus> {
  const { zone } = cfg();
  const result = await call<CfHostname>(
    "GET",
    `/zones/${zone}/custom_hostnames/${id}`
  );
  return normalize(result);
}

/** Remove a tenant hostname (on domain change / removal). */
export async function deleteCustomHostname(id: string): Promise<void> {
  const { zone } = cfg();
  await call<unknown>("DELETE", `/zones/${zone}/custom_hostnames/${id}`);
}

/** True when both the hostname and its certificate are active. */
export function isActive(s: CustomHostnameStatus): boolean {
  return s.status === "active" && s.sslStatus === "active";
}
