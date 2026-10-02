"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import {
  Bell,
  Settings2,
  ExternalLink,
  Check,
  X,
  CheckCheck,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { AdminPageHeader, KpiCard, KpiStrip, Card, EmptyState } from "@/components/admin";
import { LocalDateTime } from "@/components/ui/local-datetime";
import {
  PRIORITY_META,
  PRIORITY_ORDER,
  type AttentionItem,
  type AttentionPriority,
  type AttentionProviderMeta,
  type AttentionTypeConfig,
} from "@/lib/attention/types";

export function AttentionCenter({
  orgSlug,
  orgName,
  items,
  byPriority,
  total,
  providers,
  masterEnabled,
  config,
}: {
  orgSlug: string;
  orgName?: string;
  items: AttentionItem[];
  byPriority: Record<AttentionPriority, number>;
  total: number;
  providers: AttentionProviderMeta[];
  masterEnabled: boolean;
  config: Record<string, AttentionTypeConfig>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  async function act(busyKey: string, fn: () => Promise<Response>) {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const approve = (id: string) =>
    act(`approve:${id}`, () =>
      fetch(`/api/attempt-requests/${id}?orgSlug=${encodeURIComponent(orgSlug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      })
    );
  const reject = (id: string) =>
    act(`reject:${id}`, () =>
      fetch(`/api/attempt-requests/${id}?orgSlug=${encodeURIComponent(orgSlug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      })
    );
  const resolveTicket = (id: string) =>
    act(`ticket:${id}`, () =>
      fetch(`/api/tickets/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
      })
    );
  const markRead = (it: AttentionItem) =>
    act(`read:${it.key}`, () =>
      fetch(`/api/attention/dismiss?orgSlug=${encodeURIComponent(orgSlug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemKey: it.key, occurredAt: it.occurredAt }),
      })
    );

  return (
    <div>
      <AdminPageHeader
        title="Attention Center"
        description={`What needs your attention${orgName ? ` in ${orgName}` : ""}, most urgent first.`}
        action={
          <button
            type="button"
            onClick={() => setShowConfig((v) => !v)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 border border-line rounded-lg hover:border-ink"
          >
            <Settings2 className="w-4 h-4" /> Configure
          </button>
        }
      />

      <KpiStrip>
        {PRIORITY_ORDER.map((p) => (
          <KpiCard
            key={p}
            label={PRIORITY_META[p].label}
            value={byPriority[p] ?? 0}
            icon={<span aria-hidden>{PRIORITY_META[p].emoji}</span>}
            accent={
              p === "critical" ? "text-red-600" : p === "high" ? "text-orange-600" : p === "normal" ? "text-amber-600" : "text-slate-500"
            }
          />
        ))}
      </KpiStrip>

      {showConfig && (
        <ConfigPanel
          orgSlug={orgSlug}
          providers={providers}
          masterEnabled={masterEnabled}
          config={config}
          onClose={() => setShowConfig(false)}
          onSaved={() => {
            setShowConfig(false);
            router.refresh();
          }}
        />
      )}

      {error && (
        <div className="mb-3 border border-red-200 bg-red-50 text-red-900 rounded-xl px-3 py-2 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {total === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={<Bell className="w-5 h-5" />}
            title="You're all caught up"
            description="Nothing needs your attention right now. New requests, tickets and alerts will appear here, most urgent first."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {PRIORITY_ORDER.filter((p) => (byPriority[p] ?? 0) > 0).map((p) => (
            <section key={p}>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <span aria-hidden>{PRIORITY_META[p].emoji}</span>
                {PRIORITY_META[p].label}
                <span className="text-xs text-muted font-normal">· {byPriority[p]}</span>
              </h2>
              <div className="space-y-2">
                {items
                  .filter((it) => it.priority === p)
                  .map((it) => (
                    <ItemRow
                      key={it.key}
                      item={it}
                      busy={busy}
                      onApprove={approve}
                      onReject={reject}
                      onResolveTicket={resolveTicket}
                      onMarkRead={markRead}
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemRow({
  item: it,
  busy,
  onApprove,
  onReject,
  onResolveTicket,
  onMarkRead,
}: {
  item: AttentionItem;
  busy: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onResolveTicket: (id: string) => void;
  onMarkRead: (it: AttentionItem) => void;
}) {
  const anyBusy = busy !== null;
  return (
    <article className="bg-paper border border-line rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <span className={`hidden sm:block w-2 h-2 rounded-full shrink-0 ${PRIORITY_META[it.priority].dot}`} aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-ink text-sm leading-snug">{it.title}</div>
        <div className="text-xs text-muted mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {it.who && <span className="truncate">{it.who}</span>}
          {it.who && it.context && <span aria-hidden>·</span>}
          {it.context && <span className="truncate">{it.context}</span>}
          <span aria-hidden>·</span>
          <LocalDateTime iso={it.occurredAt} />
        </div>
        <div className="text-[11px] text-muted mt-1 uppercase tracking-wide">{it.actionLabel}</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {it.inline?.kind === "attempt-request" && (
          <>
            <button
              type="button"
              onClick={() => onReject(it.inline!.id)}
              disabled={anyBusy}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 border border-line rounded-lg hover:border-red-400 hover:text-red-700 disabled:opacity-50"
            >
              {busy === `reject:${it.inline.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              Reject
            </button>
            <button
              type="button"
              onClick={() => onApprove(it.inline!.id)}
              disabled={anyBusy}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy === `approve:${it.inline.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Approve
            </button>
          </>
        )}
        {it.inline?.kind === "ticket" && (
          <button
            type="button"
            onClick={() => onResolveTicket(it.inline!.id)}
            disabled={anyBusy}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
          >
            {busy === `ticket:${it.inline.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Resolve
          </button>
        )}
        {it.href && (
          <Link
            href={it.href}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 border border-line rounded-lg hover:border-ink"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open
          </Link>
        )}
        {it.dismissible && (
          <button
            type="button"
            onClick={() => onMarkRead(it)}
            disabled={anyBusy}
            title="Mark as read"
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 border border-line rounded-lg hover:border-ink text-muted hover:text-ink disabled:opacity-50"
          >
            {busy === `read:${it.key}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCheck className="w-3.5 h-3.5" />}
            Done
          </button>
        )}
      </div>
    </article>
  );
}

function ConfigPanel({
  orgSlug,
  providers,
  masterEnabled,
  config,
  onClose,
  onSaved,
}: {
  orgSlug: string;
  providers: AttentionProviderMeta[];
  masterEnabled: boolean;
  config: Record<string, AttentionTypeConfig>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [master, setMaster] = useState(masterEnabled);
  const [state, setState] = useState<Record<string, AttentionTypeConfig>>(() => ({ ...config }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    const res = await fetch(`/api/attention/settings?orgSlug=${encodeURIComponent(orgSlug)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: master, config: state }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(j.error ?? `HTTP ${res.status}`);
      return;
    }
    onSaved();
  }

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="serif text-lg leading-tight text-ink">Configure</h3>
          <p className="text-xs text-muted mt-0.5">
            Choose which notifications appear and how urgent each type is. New notification types can be added
            later without changing this screen.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <label className="flex items-center gap-2 mt-3 text-sm">
        <input type="checkbox" checked={master} onChange={(e) => setMaster(e.target.checked)} />
        <span className="font-medium">Attention Center enabled</span>
      </label>

      <div className={`mt-3 divide-y divide-line border border-line rounded-lg ${master ? "" : "opacity-50 pointer-events-none"}`}>
        {providers.map((p) => {
          const c = state[p.type] ?? { enabled: p.defaultEnabled, priority: p.defaultPriority };
          return (
            <div key={p.type} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <label className="flex items-start gap-2 min-w-0">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={c.enabled}
                  onChange={(e) => setState((s) => ({ ...s, [p.type]: { ...c, enabled: e.target.checked } }))}
                />
                <span className="min-w-0">
                  <span className="text-sm font-medium block">{p.label}</span>
                  <span className="text-xs text-muted block">{p.description}</span>
                </span>
              </label>
              {p.configurablePriority ? (
                <select
                  value={c.priority}
                  onChange={(e) => setState((s) => ({ ...s, [p.type]: { ...c, priority: e.target.value as AttentionPriority } }))}
                  disabled={!c.enabled}
                  className="text-xs px-2 py-1 border border-line rounded-md bg-canvas outline-none hover:border-ink disabled:opacity-50"
                >
                  {PRIORITY_ORDER.map((pr) => (
                    <option key={pr} value={pr}>
                      {PRIORITY_META[pr].label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-muted whitespace-nowrap">Auto (by ticket)</span>
              )}
            </div>
          );
        })}
      </div>

      {err && <p className="text-xs text-red-700 mt-2">{err}</p>}
      <div className="flex justify-end gap-2 mt-3">
        <button type="button" onClick={onClose} className="px-3 py-1.5 border border-line rounded-lg text-sm">
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-ink text-canvas rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Save
        </button>
      </div>
    </Card>
  );
}
