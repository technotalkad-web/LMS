"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { mdToHtml } from "@/lib/notifications/templates";
import { substitute, KNOWN_TOKENS } from "@/lib/notifications/placeholders";
import type { NotificationEvent } from "@/lib/notifications/types";
import { ThumbnailPicker } from "../_components/thumbnail-picker";
import { Settings as SettingsIcon, Mail, Palette, FileText } from "lucide-react";
import { TabStrip, type Tab } from "@/components/admin";

type Settings = {
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_secure: boolean;
  from_email: string;
  from_name: string;
  reply_to: string;
  has_password: boolean;
  logo_url: string;
  brand_color: string;
  footer_text: string;
  email_paused: boolean;
  event_paused: Record<string, boolean>;
};

type Tpl = {
  event_type: NotificationEvent;
  subject: string;
  body_md: string;
  is_active: boolean;
  cta_label: string;
  customised: boolean;
};

const EVENT_LABELS: Record<NotificationEvent, string> = {
  account_creation: "Account creation",
  asset_assignment: "Course assignment",
  asset_unassignment: "Course unassignment",
  asset_completion: "Course completion",
  asset_reminder: "Course reminder",
  asset_update: "Course / path updated",
  path_assignment: "Path assignment",
  path_unassignment: "Path unassignment",
  path_completion: "Path completion",
  custom_broadcast: "Custom broadcast",
  password_reset: "Password reset code",
};

export type WorkspaceBranding = {
  name: string;
  logo_url: string;
  brand_color: string;
  brand_font: string;
  custom_domain: string;
  login_hero_image_url: string;
  login_hero_title: string;
  login_hero_subtitle: string;
};

export function SettingsClient({
  orgSlug,
  settings,
  templates,
  orgName,
  workspace,
}: {
  orgSlug: string;
  settings: Settings;
  templates: Tpl[];
  orgName: string;
  workspace: WorkspaceBranding;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<
    "workspace" | "smtp" | "branding" | "templates"
  >("workspace");

  type SettingsTab = "workspace" | "smtp" | "branding" | "templates";
  const settingsTabs: Tab<SettingsTab>[] = [
    { key: "workspace", label: "Workspace", icon: <SettingsIcon className="w-4 h-4" /> },
    { key: "smtp", label: "SMTP", icon: <Mail className="w-4 h-4" /> },
    { key: "branding", label: "Email branding & pause", icon: <Palette className="w-4 h-4" /> },
    { key: "templates", label: "Templates", icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div>
      <TabStrip<SettingsTab>
        tabs={settingsTabs}
        active={tab}
        onChange={(k) => setTab(k)}
      />

      {tab === "workspace" && (
        <WorkspaceForm
          orgSlug={orgSlug}
          initial={workspace}
          onSaved={() => router.refresh()}
        />
      )}
      {tab === "smtp" && (
        <SmtpForm orgSlug={orgSlug} initial={settings} onSaved={() => router.refresh()} />
      )}
      {tab === "branding" && (
        <BrandingPauseForm
          orgSlug={orgSlug}
          initial={settings}
          onSaved={() => router.refresh()}
        />
      )}
      {tab === "templates" && (
        <TemplatesEditor
          orgSlug={orgSlug}
          orgName={orgName}
          initial={templates}
          settings={settings}
          onSaved={() => router.refresh()}
        />
      )}
    </div>
  );
}

/* ---------- SMTP ---------- */

function SmtpForm({
  orgSlug,
  initial,
  onSaved,
}: {
  orgSlug: string;
  initial: Settings;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ ...initial, smtp_password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const payload = {
      orgSlug,
      smtp_host: form.smtp_host,
      smtp_port: form.smtp_port,
      smtp_user: form.smtp_user,
      smtp_password: form.smtp_password,
      smtp_secure: form.smtp_secure,
      from_email: form.from_email,
      from_name: form.from_name,
      reply_to: form.reply_to,
    };
    const res = await fetch("/api/notifications/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(j.error ?? "Save failed");
      return;
    }
    setSaved(true);
    setForm((f) => ({ ...f, smtp_password: "" }));
    onSaved();
  }

  return (
    <form
      onSubmit={submit}
      className="border border-line rounded-lg bg-paper p-6 space-y-4"
    >
      <h2 className="serif text-2xl">SMTP server</h2>
      <p className="text-xs text-muted -mt-2">
        587 STARTTLS, 465 SSL, 25 unencrypted. Auth via app password recommended.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Host">
          <input
            type="text"
            placeholder="smtp.example.com"
            value={form.smtp_host}
            onChange={(e) => setForm({ ...form, smtp_host: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Port">
          <input
            type="number"
            value={form.smtp_port}
            onChange={(e) =>
              setForm({ ...form, smtp_port: parseInt(e.target.value, 10) || 0 })
            }
            className="input"
          />
        </Field>
        <Field label="Username">
          <input
            type="text"
            value={form.smtp_user}
            onChange={(e) => setForm({ ...form, smtp_user: e.target.value })}
            className="input"
          />
        </Field>
        <Field
          label={
            form.has_password
              ? "Password (leave blank to keep existing)"
              : "Password"
          }
        >
          <input
            type="password"
            value={form.smtp_password}
            placeholder={form.has_password ? "••••••" : ""}
            onChange={(e) =>
              setForm({ ...form, smtp_password: e.target.value })
            }
            className="input"
          />
        </Field>
        <Field label="From email">
          <input
            type="email"
            value={form.from_email}
            onChange={(e) => setForm({ ...form, from_email: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="From name">
          <input
            type="text"
            value={form.from_name}
            onChange={(e) => setForm({ ...form, from_name: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Reply-to">
          <input
            type="email"
            value={form.reply_to}
            onChange={(e) => setForm({ ...form, reply_to: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="TLS / SSL">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.smtp_secure}
              onChange={(e) =>
                setForm({ ...form, smtp_secure: e.target.checked })
              }
            />
            <span>Enable for port 465; keep on for STARTTLS</span>
          </label>
        </Field>
      </div>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-900 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}
      {saved && (
        <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-lg p-3 text-sm">
          Saved.
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="px-5 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save SMTP"}
        </button>
      </div>

      <style jsx>{`
        :global(.input) {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid var(--color-line);
          border-radius: 0.5rem;
          background: var(--color-canvas);
          outline: none;
          font-size: 0.875rem;
        }
      `}</style>
    </form>
  );
}

/* ---------- Branding + Pause ---------- */

const PAUSE_EVENTS: NotificationEvent[] = [
  "account_creation",
  "asset_assignment",
  "asset_unassignment",
  "asset_completion",
  "asset_reminder",
  "asset_update",
  "path_assignment",
  "path_unassignment",
  "path_completion",
];

function BrandingPauseForm({
  orgSlug,
  initial,
  onSaved,
}: {
  orgSlug: string;
  initial: Settings;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    logo_url: initial.logo_url,
    brand_color: initial.brand_color,
    footer_text: initial.footer_text,
    email_paused: initial.email_paused,
    event_paused: { ...initial.event_paused },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/notifications/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, ...form }),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(j.error ?? "Save failed");
      return;
    }
    setSaved(true);
    onSaved();
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <section
        className={`border rounded-lg p-5 ${
          form.email_paused
            ? "border-red-300 bg-red-50"
            : "border-line bg-paper"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="serif text-2xl">Master pause</h2>
            <p className="text-xs text-muted">
              When on, all automatic emails are skipped. Admin-triggered
              broadcasts still send.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.email_paused}
              onChange={(e) =>
                setForm({ ...form, email_paused: e.target.checked })
              }
            />
            <span className="font-medium">
              {form.email_paused ? "Paused" : "Live"}
            </span>
          </label>
        </div>
      </section>

      <section className="border border-line rounded-lg bg-paper p-5">
        <h2 className="serif text-2xl mb-3">Pause specific events</h2>
        <p className="text-xs text-muted mb-3">
          Useful when you don't want to disable everything — just specific
          trigger types (e.g., silence reminders during a holiday).
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          {PAUSE_EVENTS.map((ev) => (
            <label
              key={ev}
              className="flex items-center justify-between gap-2 px-3 py-2 border border-line rounded-lg"
            >
              <span>{EVENT_LABELS[ev]}</span>
              <input
                type="checkbox"
                checked={!form.event_paused[ev]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    event_paused: {
                      ...form.event_paused,
                      [ev]: !e.target.checked,
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted mt-2">
          Checked = active, unchecked = paused.
        </p>
      </section>

      <section className="border border-line rounded-lg bg-paper p-5 space-y-3">
        <h2 className="serif text-2xl">Branding</h2>
        <p className="text-xs text-muted -mt-1">
          Applied to the polished HTML shell wrapped around every email.
        </p>
        <Field label="Logo URL">
          <input
            type="url"
            value={form.logo_url}
            onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
            placeholder="https://yourdomain.com/logo.png"
            className="input"
          />
        </Field>
        <div className="flex items-end gap-3">
          <Field label="Brand color">
            <input
              type="text"
              value={form.brand_color}
              onChange={(e) =>
                setForm({ ...form, brand_color: e.target.value })
              }
              placeholder="#3a5a40"
              className="input font-mono"
            />
          </Field>
          <div
            className="w-12 h-10 rounded-lg border border-line"
            style={{ background: form.brand_color || "#1a1816" }}
          />
        </div>
        <Field label="Footer text">
          <textarea
            value={form.footer_text}
            onChange={(e) =>
              setForm({ ...form, footer_text: e.target.value })
            }
            rows={2}
            placeholder="© 2026 Your Company. 123 Main St. Unsubscribe."
            className="input"
          />
        </Field>
      </section>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-900 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}
      {saved && (
        <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-lg p-3 text-sm">
          Saved.
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="px-5 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      <style jsx>{`
        :global(.input) {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid var(--color-line);
          border-radius: 0.5rem;
          background: var(--color-canvas);
          outline: none;
          font-size: 0.875rem;
        }
      `}</style>
    </form>
  );
}

/* ---------- Templates editor ---------- */

function TemplatesEditor({
  orgSlug,
  orgName,
  initial,
  settings,
  onSaved,
}: {
  orgSlug: string;
  orgName: string;
  initial: Tpl[];
  settings: Settings;
  onSaved: () => void;
}) {
  const [active, setActive] = useState<NotificationEvent>(initial[0].event_type);
  const [templates, setTemplates] = useState<Tpl[]>(initial);
  const [busy, setBusy] = useState(false);
  const [savedFor, setSavedFor] = useState<NotificationEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tpl = templates.find((t) => t.event_type === active)!;

  function update(patch: Partial<Tpl>) {
    setTemplates((prev) =>
      prev.map((t) => (t.event_type === active ? { ...t, ...patch } : t))
    );
    setSavedFor(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSavedFor(null);
    const res = await fetch("/api/notifications/templates", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        event_type: tpl.event_type,
        subject: tpl.subject,
        body_md: tpl.body_md,
        is_active: tpl.is_active,
        cta_label: tpl.cta_label,
      }),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(j.error ?? "Save failed");
      return;
    }
    setSavedFor(tpl.event_type);
    onSaved();
  }

  const sampleCtx = useMemo(
    () => ({
      learner_name: "Jane Doe",
      learner_email: "jane@example.com",
      course_name: "Workplace Safety 101",
      path_name: "Onboarding Path",
      username: "jane@example.com",
      login_id: "jane@example.com",
      password: "TempPass-1234",
      org_name: orgName,
      direct_link: "https://lms.example.com/launch/course-123",
      portal_url: "https://lms.example.com",
      due_date: "Due Apr 30, 2026.",
      score: "Final score: 92%.",
    }),
    [orgName]
  );
  const previewSubject = substitute(tpl.subject, sampleCtx);
  const previewBodyHtml = mdToHtml(substitute(tpl.body_md, sampleCtx));
  const previewCtaLabel = tpl.cta_label
    ? substitute(tpl.cta_label, sampleCtx)
    : "";

  return (
    <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
      <aside className="border border-line rounded-lg bg-paper p-2 h-fit">
        <ul className="text-sm">
          {templates.map((t) => (
            <li key={t.event_type}>
              <button
                type="button"
                onClick={() => setActive(t.event_type)}
                className={`w-full text-left px-3 py-2 rounded-md ${
                  active === t.event_type
                    ? "bg-canvas font-medium"
                    : "hover:bg-canvas"
                }`}
              >
                {EVENT_LABELS[t.event_type]}
                {t.customised && (
                  <span className="ml-1 text-[10px] text-emerald-700">●</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="space-y-4">
        <div className="border border-line rounded-lg bg-paper p-5 space-y-3">
          <Field label="Subject">
            <input
              type="text"
              value={tpl.subject}
              onChange={(e) => update({ subject: e.target.value })}
              className="input"
            />
          </Field>
          <Field label="Body (Markdown)">
            <textarea
              value={tpl.body_md}
              onChange={(e) => update({ body_md: e.target.value })}
              rows={12}
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="CTA button label (optional)">
            <input
              type="text"
              value={tpl.cta_label}
              onChange={(e) => update({ cta_label: e.target.value })}
              placeholder="e.g. Continue, Sign in, Open course"
              className="input"
            />
          </Field>
          <p className="text-[11px] text-muted">
            The CTA button links to {`{Direct_Link}`} when the trigger provides
            one, otherwise {`{Portal_URL}`}. Leave blank to omit the button.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={tpl.is_active}
                onChange={(e) => update({ is_active: e.target.checked })}
              />
              <span>Active</span>
            </label>
            <span className="text-muted">Placeholders:</span>
            <span className="font-mono text-[10px] text-muted">
              {KNOWN_TOKENS.map((t) => `{${t}}`).join("  ")}
            </span>
          </div>
          {error && (
            <div className="border border-red-200 bg-red-50 text-red-900 rounded-lg p-3 text-sm">
              {error}
            </div>
          )}
          {savedFor === tpl.event_type && (
            <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-lg p-3 text-sm">
              Saved.
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="px-5 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save template"}
            </button>
          </div>
        </div>

        <div className="border border-line rounded-lg bg-paper p-5">
          <div className="text-xs uppercase tracking-wide text-muted mb-2">
            Live preview (rendered through the branded shell)
          </div>
          <div className="text-xs text-muted">Subject</div>
          <div className="font-medium mb-3">{previewSubject}</div>
          <div className="rounded-lg overflow-hidden border border-line">
            <BrandedPreview
              orgName={orgName}
              bodyHtml={previewBodyHtml}
              logoUrl={settings.logo_url}
              brandColor={settings.brand_color}
              footerText={settings.footer_text}
              ctaLabel={previewCtaLabel}
              ctaUrl={previewCtaLabel ? sampleCtx.direct_link : ""}
            />
          </div>
        </div>
      </div>

      <style jsx>{`
        :global(.input) {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid var(--color-line);
          border-radius: 0.5rem;
          background: var(--color-canvas);
          outline: none;
          font-size: 0.875rem;
        }
      `}</style>
    </div>
  );
}

/* ---------- Preview component (small, inline reproduction of layout.ts) ---------- */

function BrandedPreview({
  orgName,
  bodyHtml,
  logoUrl,
  brandColor,
  footerText,
  ctaLabel,
  ctaUrl,
}: {
  orgName: string;
  bodyHtml: string;
  logoUrl: string;
  brandColor: string;
  footerText: string;
  ctaLabel: string;
  ctaUrl: string;
}) {
  const brand = brandColor || "#1a1816";
  const brandTextColor = readableText(brand);
  return (
    <div style={{ background: "#f3eee6", padding: "16px" }}>
      <div
        style={{
          maxWidth: 600,
          margin: "0 auto",
          background: "#ffffff",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div
          style={{ padding: "20px 24px", borderBottom: "1px solid #e8e3dc" }}
        >
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={orgName}
              style={{ maxHeight: 40, maxWidth: 180, display: "block" }}
            />
          ) : (
            <div
              style={{
                fontFamily: "Georgia, serif",
                fontSize: 22,
                color: "#1a1816",
              }}
            >
              {orgName}
            </div>
          )}
        </div>
        <div
          style={{
            padding: "20px 24px 8px",
            fontSize: 14,
            lineHeight: 1.55,
            color: "#1a1816",
          }}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
        {ctaLabel && ctaUrl && (
          <div style={{ padding: "8px 24px 20px" }}>
            <a
              href={ctaUrl}
              style={{
                display: "inline-block",
                padding: "10px 20px",
                background: brand,
                color: brandTextColor,
                textDecoration: "none",
                borderRadius: 6,
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              {ctaLabel} →
            </a>
          </div>
        )}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #e8e3dc",
            background: "#faf8f4",
            fontSize: 11,
            color: "#6b6661",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {footerText || `Sent by ${orgName}`}
        </div>
      </div>
    </div>
  );
}

function readableText(hex: string): string {
  const m = hex.replace("#", "").match(/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return "#ffffff";
  const v = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#1a1816" : "#ffffff";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-muted mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}


/* ---------- Workspace branding (company name + logo + brand color + font + domain) ---------- */

/**
 * Approved brand-font choices for tenant white-labeling. "inter" is
 * the platform default (matches the global Inter applied at the root
 * layout). The other four are curated alternatives covering modern,
 * corporate, neutral, and academic looks.
 */
const FONT_OPTIONS: Array<{
  value: string;
  label: string;
  description: string;
  sample: string;
}> = [
  {
    value: "inter",
    label: "Inter",
    description: "System default — neutral, highly readable",
    sample: "The quick brown fox jumps over",
  },
  {
    value: "poppins",
    label: "Poppins",
    description: "Modern & friendly geometric sans",
    sample: "The quick brown fox jumps over",
  },
  {
    value: "jakarta",
    label: "Plus Jakarta Sans",
    description: "Premium, corporate feel",
    sample: "The quick brown fox jumps over",
  },
  {
    value: "roboto",
    label: "Roboto",
    description: "Clean & standard, familiar on Android",
    sample: "The quick brown fox jumps over",
  },
  {
    value: "merriweather",
    label: "Merriweather",
    description: "Editorial serif — academic / classic",
    sample: "The quick brown fox jumps over",
  },
];

function WorkspaceForm({
  orgSlug,
  initial,
  onSaved,
}: {
  orgSlug: string;
  initial: WorkspaceBranding;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<WorkspaceBranding>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Gate render to client-only so form-fill browser extensions (LastPass,
  // 1Password, Chrome autofill) can't inject `fdprocessedid` between SSR
  // and hydrate. Skeleton is shown for ~1 frame, no UX impact.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/org/branding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        name: form.name,
        logo_url: form.logo_url,
        brand_color: form.brand_color,
        brand_font: form.brand_font,
        custom_domain: form.custom_domain,
        login_hero_image_url: form.login_hero_image_url,
        login_hero_title: form.login_hero_title,
        login_hero_subtitle: form.login_hero_subtitle,
      }),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(j.error ?? "Save failed");
      return;
    }
    setSaved(true);
    onSaved();
  }

  if (!mounted) {
    // Lightweight skeleton so the layout doesn't shift when the real
    // form mounts on the next frame.
    return (
      <div className="space-y-6">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="border border-line rounded-2xl bg-paper p-6 h-40 animate-pulse"
          />
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <section className="border border-line rounded-2xl bg-paper p-6 space-y-4">
        <div>
          <h2 className="serif text-2xl">Identity</h2>
          <p className="text-xs text-muted mt-0.5">
            Visible across the learner experience, on emails, and in the
            browser tab.
          </p>
        </div>

        <Field label="Company name">
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="ws-input"
          />
        </Field>

        <Field label="Brand logo">
          <ThumbnailPicker
            orgSlug={orgSlug}
            kind="logo"
            value={form.logo_url || null}
            onChange={(url) => setForm({ ...form, logo_url: url ?? "" })}
          />
          <p className="text-xs text-muted mt-2">
            Replaces the default book icon in the top nav, sidebar, login
            page, and email shell. Square or wide logos both work; PNG with a
            transparent background recommended.
          </p>
        </Field>
      </section>

      <section className="border border-line rounded-2xl bg-paper p-6 space-y-4">
        <div>
          <h2 className="serif text-2xl">Look & feel</h2>
          <p className="text-xs text-muted mt-0.5">
            Brand color is used for buttons, links, progress bars, and the
            active-state accent. Font sets the default body family.
          </p>
        </div>

        <div className="flex items-end gap-3">
          <Field label="Brand color (hex)">
            <input
              type="text"
              value={form.brand_color}
              onChange={(e) =>
                setForm({ ...form, brand_color: e.target.value })
              }
              placeholder="#4f46e5"
              className="ws-input font-mono"
            />
          </Field>
          <div
            className="w-12 h-10 rounded-lg border border-line"
            style={{ background: form.brand_color || "#4f46e5" }}
            aria-hidden
          />
        </div>

        <Field label="Brand font">
          <select
            value={form.brand_font}
            onChange={(e) => setForm({ ...form, brand_font: e.target.value })}
            className="ws-input"
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} — {f.description}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted mt-1.5">
            Applies only to this workspace. Choose the typeface that best fits your brand.
          </p>
        </Field>

        {/* Live preview */}
        <div
          className="mt-2 border border-line rounded-lg bg-canvas p-4"
          style={{
            fontFamily: fontStackFor(form.brand_font),
          }}
        >
          <div className="text-[10px] uppercase tracking-wide text-muted mb-2">
            Preview
          </div>
          <div className="text-2xl font-semibold mb-1">{form.name}</div>
          <div className="text-sm text-muted mb-3">
            The quick brown fox jumps over the lazy dog.
          </div>
          <button
            type="button"
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white shadow-sm"
            style={{ background: form.brand_color || "#4f46e5" }}
          >
            Primary action
          </button>
        </div>
      </section>

      <section className="border border-line rounded-2xl bg-paper p-6 space-y-4">
        <div>
          <h2 className="serif text-2xl">Login page</h2>
          <p className="text-xs text-muted mt-0.5">
            Customise the left-panel hero that learners see when they sign in
            via your branded URL <code>/{orgSlug}/login</code>.
          </p>
        </div>

        <Field label="Hero background image">
          <ThumbnailPicker
            orgSlug={orgSlug}
            kind="logo"
            value={form.login_hero_image_url || null}
            onChange={(url) =>
              setForm({ ...form, login_hero_image_url: url ?? "" })
            }
          />
          <p className="text-xs text-muted mt-2">
            Wide images work best (e.g. 1600&times;1200). Sits behind a dark
            gradient so light or dark photos both look fine.
          </p>
        </Field>

        <Field label="Hero headline">
          <input
            type="text"
            value={form.login_hero_title}
            onChange={(e) =>
              setForm({ ...form, login_hero_title: e.target.value })
            }
            placeholder="Build the skills your team needs to ship faster."
            className="ws-input"
          />
        </Field>

        <Field label="Hero subtitle">
          <textarea
            value={form.login_hero_subtitle}
            onChange={(e) =>
              setForm({ ...form, login_hero_subtitle: e.target.value })
            }
            placeholder="Assign courses, track completions, and keep learners on the path."
            rows={3}
            className="ws-input resize-none"
          />
        </Field>

        {/* Preview */}
        <div className="border border-line rounded-lg overflow-hidden h-48 relative bg-slate-900">
          {form.login_hero_image_url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={form.login_hero_image_url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-br from-slate-900/85 via-slate-900/70 to-indigo-900/70" />
          <div className="relative z-10 h-full flex flex-col justify-center p-5 text-white">
            <div className="text-lg font-bold leading-tight mb-1 max-w-md">
              {form.login_hero_title ||
                "Build the skills your team needs to ship faster."}
            </div>
            <div className="text-xs opacity-80 max-w-md">
              {form.login_hero_subtitle ||
                "Assign courses, track completions, and keep learners on the path."}
            </div>
          </div>
        </div>
      </section>

      <section className="border border-line rounded-2xl bg-paper p-6 space-y-4">
        <div>
          <h2 className="serif text-2xl">Custom domain</h2>
          <p className="text-xs text-muted mt-0.5">
            Serve the learner experience from your own domain (e.g.
            <code className="ml-1">learn.acme.com</code>).
          </p>
        </div>

        <Field label="Custom domain">
          <input
            type="text"
            value={form.custom_domain}
            onChange={(e) =>
              setForm({ ...form, custom_domain: e.target.value })
            }
            placeholder="learn.your-company.com"
            className="ws-input"
          />
        </Field>

        <div className="border border-line rounded-lg bg-canvas/40 p-4 text-xs leading-relaxed">
          <div className="font-semibold text-ink mb-2">
            Setup steps (one-time, takes ~10 minutes)
          </div>
          <ol className="list-decimal pl-5 space-y-1 text-muted">
            <li>
              Save the domain above. The system will start expecting traffic
              on that hostname.
            </li>
            <li>
              In your DNS provider, add a <strong>CNAME</strong> record from{" "}
              <code>{form.custom_domain || "learn.your-company.com"}</code> to
              your platform host (e.g. <code>cname.vercel-dns.com</code> for
              Vercel, your load balancer for self-hosted).
            </li>
            <li>
              Add the domain to your hosting&apos;s &ldquo;Domains&rdquo;
              dashboard so SSL is provisioned automatically.
            </li>
            <li>
              Once DNS propagates (5–60 min), learners can sign in at your
              custom URL — the app routes them to this workspace
              automatically.
            </li>
          </ol>
          <div className="mt-3 text-amber-700">
            Custom domain routing depends on your deployment. Vercel, Render,
            and most managed hosts handle it via their domains dashboard. For
            self-hosted, point your reverse proxy at the app and pass the
            host header through.
          </div>
        </div>
      </section>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl px-4 py-3 text-sm">
          {error}
        </div>
      )}
      {saved && (
        <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-xl px-4 py-3 text-sm">
          Saved. Reload the page to see the new branding propagate.
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="px-5 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save workspace settings"}
        </button>
      </div>

      <style jsx>{`
        :global(.ws-input) {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid var(--color-line);
          border-radius: 0.5rem;
          background: var(--color-canvas);
          outline: none;
          font-size: 0.875rem;
        }
        :global(.ws-input:focus) {
          border-color: var(--color-ink);
        }
      `}</style>
    </form>
  );
}

function fontStackFor(name: string): string {
  // Mirror the server-side layouts so the live preview in Settings
  // matches what the real org page will render.
  switch (name) {
    case "inter":
      return "var(--font-inter), Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "poppins":
      return "var(--font-poppins), Poppins, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "jakarta":
      return "var(--font-jakarta), 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "roboto":
      return "var(--font-roboto), Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "merriweather":
      return "var(--font-merriweather), Merriweather, Georgia, 'Times New Roman', serif";
    case "system":
      return "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "serif":
      return "var(--font-merriweather), Merriweather, Georgia, serif";
    case "mono":
      return "var(--font-geist-mono), ui-monospace, monospace";
    default:
      return "var(--font-inter), Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  }
}
