"use client";

import {
  HEX_RE,
  LEARNER_THEMES,
  type ThemeTokens,
} from "@/lib/theme/learner-themes";

/**
 * Settings → Workspace → "Learner theme".
 *
 * Admin-only, org-wide: pick one of the six home-financing presets (built
 * from the Ambak brand palette) or design a custom palette. The selection is
 * saved with the workspace form via /api/org/branding and applied to every
 * learner in the org — learners cannot change it.
 */

/** The untouched product look ("" selection) — mirrors :root in globals.css. */
const DEFAULT_LOOK: ThemeTokens = {
  canvas: "#faf8f4",
  paper: "#ffffff",
  ink: "#1a1816",
  muted: "#6b6661",
  line: "#e8e3dc",
  accent: "#3a5a40",
};

/** Starter palette when an admin first opens the custom builder — brand purple. */
const CUSTOM_STARTER: Record<string, string> = {
  name: "Our theme",
  canvas: "#f8f7fb",
  paper: "#ffffff",
  ink: "#221c3a",
  muted: "#6b6486",
  line: "#e6e2f0",
  accent: "#473391",
};

const TOKEN_FIELDS: { key: keyof ThemeTokens; label: string; help: string }[] = [
  { key: "canvas", label: "Background", help: "Page background" },
  { key: "paper", label: "Cards", help: "Card / panel surfaces" },
  { key: "ink", label: "Text", help: "Headings & body text" },
  { key: "muted", label: "Secondary text", help: "Captions & hints" },
  { key: "line", label: "Borders", help: "Dividers & outlines" },
  { key: "accent", label: "Accent", help: "Highlights & focus" },
];

function MiniPreview({ t }: { t: ThemeTokens }) {
  return (
    <div
      aria-hidden
      className="rounded-lg border p-2.5"
      style={{ background: t.canvas, borderColor: t.line }}
    >
      <div
        className="rounded-md p-2 shadow-sm border"
        style={{ background: t.paper, borderColor: t.line }}
      >
        <div className="h-2 w-16 rounded" style={{ background: t.ink }} />
        <div
          className="h-1.5 w-24 rounded mt-1.5"
          style={{ background: t.muted, opacity: 0.65 }}
        />
        <div className="mt-2 flex items-center gap-1.5">
          <div className="h-4 w-12 rounded-full" style={{ background: t.accent }} />
          <div className="h-1.5 flex-1 rounded" style={{ background: t.line }} />
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  selected,
  onSelect,
  tokens,
  emoji,
  name,
  tagline,
}: {
  selected: boolean;
  onSelect: () => void;
  tokens: ThemeTokens;
  emoji: string;
  name: string;
  tagline: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`text-left rounded-xl border p-3 transition hover:shadow-md ${
        selected
          ? "border-accent ring-2 ring-accent"
          : "border-line hover:border-ink/30"
      }`}
    >
      <MiniPreview t={tokens} />
      <div className="mt-2 text-sm font-medium">
        {emoji} {name}
      </div>
      <div className="text-[11px] text-muted leading-snug mt-0.5">{tagline}</div>
    </button>
  );
}

export function LearnerThemeSection({
  value,
  custom,
  onChange,
}: {
  /** Current selection: preset id, "custom", or "" for the default look. */
  value: string;
  custom: Record<string, string> | null;
  onChange: (patch: {
    learner_theme: string;
    learner_theme_custom: Record<string, string> | null;
  }) => void;
}) {
  const customPalette = { ...CUSTOM_STARTER, ...(custom ?? {}) };
  const customTokens: ThemeTokens = {
    canvas: customPalette.canvas,
    paper: customPalette.paper,
    ink: customPalette.ink,
    muted: customPalette.muted,
    line: customPalette.line,
    accent: customPalette.accent,
  };

  const setCustomField = (key: string, v: string) =>
    onChange({
      learner_theme: "custom",
      learner_theme_custom: { ...customPalette, [key]: v },
    });

  return (
    <section className="border border-line rounded-2xl bg-paper p-6 space-y-4">
      <div>
        <h2 className="serif text-2xl">Learner theme</h2>
        <p className="text-xs text-muted mt-0.5">
          Sets the look of the entire learner view for everyone in this
          workspace — learners can&apos;t change it. Presets are built from
          the brand palette and themed around the home-financing journey, or
          design your own below.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <ThemeCard
          selected={!value}
          onSelect={() =>
            onChange({ learner_theme: "", learner_theme_custom: custom })
          }
          tokens={DEFAULT_LOOK}
          emoji="✨"
          name="Default"
          tagline="The standard product look."
        />
        {LEARNER_THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            selected={value === t.id}
            onSelect={() =>
              onChange({ learner_theme: t.id, learner_theme_custom: custom })
            }
            tokens={t.tokens}
            emoji={t.emoji}
            name={t.name}
            tagline={t.tagline}
          />
        ))}
        <ThemeCard
          selected={value === "custom"}
          onSelect={() =>
            onChange({
              learner_theme: "custom",
              learner_theme_custom: customPalette,
            })
          }
          tokens={customTokens}
          emoji="🎨"
          name="Custom"
          tagline="Design your own palette."
        />
      </div>

      {value === "custom" && (
        <div className="border border-line rounded-xl bg-canvas p-4 space-y-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="grow max-w-xs">
              <label className="block text-xs font-medium text-muted mb-1">
                Theme name
              </label>
              <input
                type="text"
                value={customPalette.name ?? ""}
                onChange={(e) => setCustomField("name", e.target.value)}
                maxLength={60}
                className="ws-input"
              />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {TOKEN_FIELDS.map((f) => {
              const v = customPalette[f.key] ?? "";
              const valid = HEX_RE.test(v);
              return (
                <div key={f.key}>
                  <label className="block text-xs font-medium text-muted mb-1">
                    {f.label}
                    <span className="font-normal"> — {f.help}</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={valid ? v : "#ffffff"}
                      onChange={(e) => setCustomField(f.key, e.target.value)}
                      className="h-9 w-10 rounded border border-line bg-paper p-0.5 cursor-pointer"
                      aria-label={`${f.label} color`}
                    />
                    <input
                      type="text"
                      value={v}
                      onChange={(e) => setCustomField(f.key, e.target.value)}
                      placeholder="#473391"
                      className={`ws-input font-mono ${
                        valid ? "" : "border-red-400"
                      }`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted mb-1.5">
              Live preview
            </div>
            <div className="max-w-sm">
              <MiniPreview t={customTokens} />
            </div>
          </div>
          <p className="text-[11px] text-muted">
            Tip: brand palette — purples #473391 · #6E55B8 · #9578E0 ·
            #E6C4FF, blues #0059B3 · #0078C3, teals #00ADB7 · #2AC3A9. Keep
            text dark on light backgrounds (or light on dark) so everything
            stays readable.
          </p>
        </div>
      )}
    </section>
  );
}
