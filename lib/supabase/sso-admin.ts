/**
 * Supabase Auth — SAML SSO provider management (Admin API).
 *
 * Enterprise tenants sign in through their own IdP (Okta / Azure AD / Google
 * Workspace SAML). The provider is registered in Supabase Auth via the admin
 * SSO endpoints (service-role authed). This module wraps that REST API and
 * exposes the Service-Provider (SP) details a tenant must enter in their IdP.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (already a Worker secret) and a Supabase
 * project on a plan with the SAML SSO add-on enabled. Throws SsoNotConfigured
 * when the service role / URL isn't present so callers can degrade gracefully.
 *
 * Docs: https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml
 */

export class SsoNotConfigured extends Error {
  constructor() {
    super("Supabase service role / URL not configured for SSO management");
    this.name = "SsoNotConfigured";
  }
}

export class SsoApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsoApiError";
  }
}

/** Public project URL — enough to render the SP (our-side) details. */
function urlBase(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new SsoNotConfigured();
  return url.replace(/\/$/, "");
}

/** Admin operations also require the service role key. */
function projectBase(): string {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new SsoNotConfigured();
  return urlBase();
}

function headers() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

export type SsoProvider = {
  id: string;
  domains: string[];
  /** Raw provider payload from Supabase (saml metadata, etc.). */
  saml?: { metadata_url?: string; entity_id?: string };
};

/**
 * Service-Provider (our side) values the tenant configures in their IdP. These
 * are fixed per Supabase project.
 */
export function serviceProviderDetails(): {
  acsUrl: string;
  entityId: string;
  metadataUrl: string;
} {
  const base = urlBase();
  return {
    acsUrl: `${base}/auth/v1/sso/saml/acs`,
    entityId: `${base}/auth/v1/sso/saml/metadata`,
    metadataUrl: `${base}/auth/v1/sso/saml/metadata`,
  };
}

type ProviderResponse = {
  id: string;
  saml?: { metadata_url?: string; entity_id?: string };
  domains?: Array<{ domain: string } | string>;
};

function normalize(p: ProviderResponse): SsoProvider {
  const domains = (p.domains ?? []).map((d) =>
    typeof d === "string" ? d : d.domain
  );
  return { id: p.id, domains, saml: p.saml };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${projectBase()}/auth/v1/admin/sso/providers${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (json && (json.msg || json.error || json.message)) ||
      `Supabase SSO admin ${method} failed (${res.status})`;
    throw new SsoApiError(String(msg));
  }
  return json as T;
}

/**
 * Register (or re-register) a SAML provider from IdP metadata. Supply either a
 * metadata URL or raw metadata XML, plus the email domains it serves.
 */
export async function createSamlProvider(input: {
  metadataUrl?: string;
  metadataXml?: string;
  domains: string[];
}): Promise<SsoProvider> {
  if (!input.metadataUrl && !input.metadataXml) {
    throw new SsoApiError("Provide either metadataUrl or metadataXml");
  }
  const body: Record<string, unknown> = {
    type: "saml",
    domains: input.domains,
    ...(input.metadataUrl
      ? { metadata_url: input.metadataUrl }
      : { metadata_xml: input.metadataXml }),
  };
  const res = await call<ProviderResponse>("POST", "", body);
  return normalize(res);
}

export async function getSamlProvider(id: string): Promise<SsoProvider> {
  const res = await call<ProviderResponse>("GET", `/${id}`);
  return normalize(res);
}

export async function deleteSamlProvider(id: string): Promise<void> {
  await call<unknown>("DELETE", `/${id}`);
}
