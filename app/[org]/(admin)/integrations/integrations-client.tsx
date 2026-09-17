"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, Plus, Webhook } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";

export type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
};

export function IntegrationsClient({
  orgSlug,
  initialKeys,
  initialWebhookUrl,
}: {
  orgSlug: string;
  initialKeys: ApiKeyRow[];
  initialWebhookUrl: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  // Shown exactly once, straight from the create response.
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState(initialWebhookUrl ?? "");
  const [webhookSecret, setWebhookSecret] = useState("");

  async function createKey() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/org/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, name: newName.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !j.key) {
        toast.error(j.error ?? "Could not create key");
        return;
      }
      setFreshKey(j.key);
      setNewName("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string, name: string) {
    if (!(await confirm({
      message: `Revoke "${name}"? The CRM integration using it stops working immediately.`,
      destructive: true,
      confirmText: "Revoke key",
    }))) return;
    const res = await fetch("/api/org/api-keys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, key_id: id }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(j.error ?? "Revoke failed");
      return;
    }
    toast.success("Key revoked");
    router.refresh();
  }

  async function saveWebhook() {
    setBusy(true);
    try {
      const res = await fetch("/api/org/integration-settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          webhook_url: webhookUrl,
          ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(j.error ?? "Save failed");
        return;
      }
      toast.success("Webhook saved");
      setWebhookSecret("");
    } finally {
      setBusy(false);
    }
  }

  const fmt = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

  return (
    <div className="space-y-6 max-w-3xl">
      {/* ---- API keys ---- */}
      <section className="border border-line rounded-xl bg-paper p-5">
        <h2 className="font-semibold flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> API keys
        </h2>
        <p className="text-xs text-muted mt-1 mb-4">
          Your CRM backend authenticates with{" "}
          <code className="bg-canvas px-1 rounded">Authorization: Bearer &lt;key&gt;</code>.
          Keys are org-scoped, revocable, and shown only once at creation.
        </p>

        {freshKey && (
          <div className="mb-4 border border-emerald-300 bg-emerald-50 rounded-lg p-4">
            <p className="text-sm font-semibold text-emerald-900">
              Copy this key now — it will never be shown again.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 text-xs bg-white border border-emerald-200 rounded px-2 py-1.5 break-all">
                {freshKey}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(freshKey);
                  toast.success("Copied");
                }}
                className="p-2 border border-emerald-300 rounded-lg hover:bg-emerald-100"
                aria-label="Copy key"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setFreshKey(null)}
              className="mt-2 text-xs underline text-emerald-800"
            >
              I have stored it safely
            </button>
          </div>
        )}

        {initialKeys.length > 0 && (
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line">
                <th className="py-2">Name</th>
                <th className="py-2">Key</th>
                <th className="py-2">Created</th>
                <th className="py-2">Last used</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {initialKeys.map((k) => (
                <tr key={k.id} className="border-b border-line last:border-0">
                  <td className="py-2 font-medium">{k.name}</td>
                  <td className="py-2 font-mono text-xs">{k.key_prefix}…</td>
                  <td className="py-2 text-muted text-xs">{fmt(k.created_at)}</td>
                  <td className="py-2 text-muted text-xs">{fmt(k.last_used_at)}</td>
                  <td className="py-2 text-right">
                    {k.is_active ? (
                      <button
                        type="button"
                        onClick={() => revoke(k.id, k.name)}
                        className="text-xs px-2 py-1 border border-line rounded hover:border-red-500 hover:text-red-700"
                      >
                        Revoke
                      </button>
                    ) : (
                      <span className="text-xs text-muted">revoked</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder='Key name, e.g. "CRM production"'
            maxLength={60}
            className="flex-1 px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
          <button
            type="button"
            onClick={createKey}
            disabled={busy || !newName.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> Create key
          </button>
        </div>
      </section>

      {/* ---- Completion webhook ---- */}
      <section className="border border-line rounded-xl bg-paper p-5">
        <h2 className="font-semibold flex items-center gap-2">
          <Webhook className="w-4 h-4" /> Completion webhook
        </h2>
        <p className="text-xs text-muted mt-1 mb-4">
          When a learner completes a course, the LMS POSTs the result to this
          URL (signed with the secret via{" "}
          <code className="bg-canvas px-1 rounded">x-ambak-signature</code>) so
          the employee&apos;s CRM record updates instantly.
        </p>
        <div className="space-y-2">
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://crm.ambak.com/api/lms-webhook"
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
          <input
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder="Signing secret (leave blank to keep current)"
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
          <button
            type="button"
            onClick={saveWebhook}
            disabled={busy}
            className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            Save webhook
          </button>
        </div>
      </section>

      {/* ---- Endpoint cheat-sheet for the CRM team ---- */}
      <section className="border border-line rounded-xl bg-paper p-5 text-sm">
        <h2 className="font-semibold mb-3">Endpoints for the CRM team</h2>
        <ul className="space-y-3 text-xs">
          <li>
            <code className="bg-canvas px-1 rounded">POST /api/integrations/sso-link</code>
            <span className="block text-muted mt-0.5">
              {"{ employee_id, target?, return_url? }"} → one-time login_url. Redirect the
              employee&apos;s browser to it: signed in, straight into the module. With
              return_url, the LMS hides its own navigation and shows a &quot;Back to CRM&quot;
              button. Learner accounts only — admin accounts are refused.
            </span>
          </li>
          <li>
            <code className="bg-canvas px-1 rounded">GET /api/integrations/learner-summary?employee_id=…</code>
            <span className="block text-muted mt-0.5">
              Everything for the CRM&apos;s learning card: courses with status/score/due,
              paths, journeys, XP and streak — plus ready-made `target` paths to feed
              into sso-link.
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}
