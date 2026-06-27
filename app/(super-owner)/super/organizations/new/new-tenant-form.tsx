"use client";


import { useToast } from "@/components/ui/toast";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, CheckCircle2 } from "lucide-react";

type Plan = { slug: string; name: string; monthly_price_cents: number };

export function NewTenantForm({ plans }: { plans: Plan[] }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [planSlug, setPlanSlug] = useState(plans[0]?.slug ?? "basic");
  const [adminEmail, setAdminEmail] = useState("");
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ slug: string; invite_url: string | null } | null>(null);

  function slugify(s: string) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42);
  }

  function onNameChange(v: string) {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/super/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        slug,
        plan_slug: planSlug,
        admin_email: adminEmail || undefined,
        allowed_email_domains: domains
          ? domains.split(",").map((d) => d.trim()).filter(Boolean)
          : undefined,
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(j.error ?? "Failed to create tenant");
      return;
    }
    setResult({ slug: j.slug, invite_url: j.invite_url });
  }

  if (result) {
    return (
      <div className="bg-paper border border-emerald-200 rounded-xl shadow-sm p-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-6 h-6 text-emerald-600 mt-0.5" />
          <div>
            <h2 className="font-bold text-lg text-ink">Tenant created</h2>
            <p className="text-sm text-muted mt-1">
              The workspace is live at{" "}
              <a href={`/${result.slug}/login`} className="text-accent underline font-mono">
                /{result.slug}/login
              </a>
              .
            </p>
            {result.invite_url && (
              <div className="mt-4">
                <p className="text-xs uppercase font-bold tracking-wider text-muted mb-1">
                  Invitation link for initial admin
                </p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={result.invite_url}
                    className="flex-1 border border-line rounded-md px-2 py-1.5 text-xs font-mono bg-canvas"
                  />
                  <button
                    onClick={() => navigator.clipboard.writeText(result.invite_url!)}
                    className="bg-slate-900 text-white px-3 py-1.5 rounded-md text-xs flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                </div>
              </div>
            )}
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => router.push("/super/organizations")}
                className="bg-ink text-canvas hover:opacity-90 px-4 py-2 rounded-lg font-semibold text-sm"
              >
                Back to organizations
              </button>
              <button
                onClick={() => setResult(null)}
                className="text-muted px-4 py-2 rounded-lg text-sm hover:bg-canvas"
              >
                Create another
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="bg-paper border border-line rounded-xl shadow-sm p-6 space-y-4">
      <Field label="Workspace name">
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          required
          maxLength={120}
          className="w-full border border-line rounded-md px-3 py-2 text-sm"
          placeholder="Acme Corp"
        />
      </Field>
      <Field label="URL slug" hint="3-42 chars, lowercase letters/digits/hyphens. Becomes the URL prefix.">
        <div className="flex gap-1 items-center">
          <span className="text-muted text-sm">/</span>
          <input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(slugify(e.target.value));
            }}
            required
            minLength={3}
            maxLength={42}
            className="flex-1 border border-line rounded-md px-3 py-2 text-sm font-mono"
            placeholder="acme"
          />
        </div>
      </Field>
      <Field label="Subscription plan">
        <select
          value={planSlug}
          onChange={(e) => setPlanSlug(e.target.value)}
          className="w-full border border-line rounded-md px-3 py-2 text-sm bg-paper"
        >
          {plans.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name} — ${Math.round(p.monthly_price_cents / 100)}/mo
            </option>
          ))}
        </select>
      </Field>
      <Field label="Initial admin email (optional)" hint="They'll get an invitation link with super_owner role.">
        <input
          type="email"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          className="w-full border border-line rounded-md px-3 py-2 text-sm"
          placeholder="admin@acme.com"
        />
      </Field>
      <Field label="Allowed email domains (optional)" hint="Comma-separated, e.g. acme.com, acme.co.uk. Blank = allow any.">
        <input
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          className="w-full border border-line rounded-md px-3 py-2 text-sm"
          placeholder="acme.com, acme.co.uk"
        />
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={() => router.push("/super/organizations")}
          className="text-muted px-4 py-2 rounded-lg text-sm hover:bg-canvas"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !name || !slug}
          className="bg-ink text-canvas hover:opacity-90 px-5 py-2 rounded-lg font-semibold text-sm disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create tenant"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-ink">{label}</span>
      {hint && <span className="block text-xs text-muted mt-0.5 mb-1.5">{hint}</span>}
      {!hint && <span className="block mb-1.5" />}
      {children}
    </label>
  );
}
