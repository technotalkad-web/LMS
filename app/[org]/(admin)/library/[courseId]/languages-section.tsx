"use client";


import { useConfirm } from "@/components/ui/confirm";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { SUPPORTED_LANGUAGES, languageDisplay } from "@/lib/i18n/languages";

export type LanguagePackage = {
  id: string;
  language: string | null;
  display_name: string | null;
  is_active: boolean;
  current_version_id: string | null;
};

/**
 * Admin Languages section on /library/[courseId].
 *
 * Shows the matrix of language packages for a course + "Add language"
 * upload dialog + per-package PATCH (rename / activate-deactivate /
 * promote NULL-language to a real code) and DELETE actions.
 *
 * Closes #158 Phase 1c (UI half).
 */
export function LanguagesSection({
  orgSlug,
  courseId,
  packages: initialPackages,
}: {
  orgSlug: string;
  courseId: string;
  packages: LanguagePackage[];
}) {
  const router = useRouter();
  const [packages, setPackages] = useState(initialPackages);
  const [showAdd, setShowAdd] = useState(false);
  const [replaceFor, setReplaceFor] = useState<LanguagePackage | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasNullDefault = packages.some((p) => p.language === null);

  async function toggleActive(pkg: LanguagePackage) {
    setBusyId(pkg.id);
    setError(null);
    const res = await fetch(
      `/api/courses/${courseId}/packages/${pkg.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, is_active: !pkg.is_active }),
      }
    );
    setBusyId(null);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Failed to update");
      return;
    }
    setPackages((ps) =>
      ps.map((p) =>
        p.id === pkg.id ? { ...p, is_active: !pkg.is_active } : p
      )
    );
  }

  async function promoteNull(pkg: LanguagePackage, language: string) {
    setBusyId(pkg.id);
    setError(null);
    const res = await fetch(
      `/api/courses/${courseId}/packages/${pkg.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, language }),
      }
    );
    setBusyId(null);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Failed to label package");
      return;
    }
    setPackages((ps) =>
      ps.map((p) => (p.id === pkg.id ? { ...p, language } : p))
    );
  }

  async function deletePackage(pkg: LanguagePackage) {
    if (
      !await confirm(
        `Delete the "${languageDisplay(pkg.language, "english")}" package? This is irreversible. If learners have attempted it, the delete will be refused — deactivate instead.`
      )
    ) {
      return;
    }
    setBusyId(pkg.id);
    setError(null);
    const res = await fetch(
      `/api/courses/${courseId}/packages/${pkg.id}?orgSlug=${encodeURIComponent(orgSlug)}`,
      { method: "DELETE" }
    );
    setBusyId(null);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Delete failed");
      return;
    }
    setPackages((ps) => ps.filter((p) => p.id !== pkg.id));
  }

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="serif text-2xl">Languages</h2>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="text-xs px-3 py-1.5 border border-line rounded hover:border-ink transition-colors"
        >
          + Add language
        </button>
      </div>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl px-4 py-2 text-sm mb-3">
          {error}
        </div>
      )}

      <div className="border border-line rounded-2xl bg-paper overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Language</th>
              <th className="text-left px-4 py-2 font-medium">Display label</th>
              <th className="text-left px-4 py-2 font-medium">Active</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {packages.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  No language packages yet. Click + Add language to upload one.
                </td>
              </tr>
            )}
            {packages.map((p) => (
              <tr key={p.id} className="hover:bg-canvas/40">
                <td className="px-4 py-3">
                  {p.language === null ? (
                    <div>
                      <div className="font-medium text-muted">Unlabeled (legacy)</div>
                      <div className="text-xs text-muted mt-0.5">
                        Promote to:{" "}
                        <select
                          className="text-xs bg-canvas border border-line rounded px-2 py-0.5"
                          onChange={(e) =>
                            e.target.value && promoteNull(p, e.target.value)
                          }
                          defaultValue=""
                          disabled={busyId === p.id}
                        >
                          <option value="">Choose…</option>
                          {SUPPORTED_LANGUAGES.map((l) => (
                            <option key={l.code} value={l.code}>
                              {l.english} ({l.native})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="font-medium">
                        {languageDisplay(p.language, "native")}
                      </div>
                      <div className="text-xs text-muted mt-0.5">
                        {languageDisplay(p.language, "english")} · {p.language}
                      </div>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {p.display_name ?? <span className="text-muted">(default)</span>}
                </td>
                <td className="px-4 py-3">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={p.is_active}
                      onChange={() => toggleActive(p)}
                      disabled={busyId === p.id}
                    />
                    <span className="text-xs">
                      {p.is_active ? "Active" : "Hidden from learners"}
                    </span>
                  </label>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => setReplaceFor(p)}
                    disabled={busyId === p.id}
                    className="text-xs text-ink hover:underline disabled:opacity-40 mr-3"
                  >
                    Replace content
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePackage(p)}
                    disabled={busyId === p.id}
                    className="text-xs text-red-700 hover:underline disabled:opacity-40"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted mt-2">
        To update a language&apos;s module, click{" "}
        <span className="text-ink">Replace content</span> on its row and upload a
        new SCORM/cmi5 zip. It becomes that language&apos;s current version;
        earlier versions, attempts and reporting are preserved.
      </p>

      {showAdd && (
        <AddLanguageDialog
          orgSlug={orgSlug}
          courseId={courseId}
          existingLanguages={new Set(
            packages.filter((p) => p.language).map((p) => p.language as string)
          )}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            router.refresh();
          }}
        />
      )}

      {!hasNullDefault && packages.length === 0 && (
        <p className="text-xs text-muted mt-2">
          (No NULL-language default package on this course. Use the existing
          upload page first.)
        </p>
      )}

      {replaceFor && (
        <ReplacePackageDialog
          orgSlug={orgSlug}
          courseId={courseId}
          pkg={replaceFor}
          onClose={() => setReplaceFor(null)}
          onReplaced={() => {
            setReplaceFor(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function ReplacePackageDialog({
  orgSlug,
  courseId,
  pkg,
  onClose,
  onReplaced,
}: {
  orgSlug: string;
  courseId: string;
  pkg: LanguagePackage;
  onClose: () => void;
  onReplaced: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"grandfather" | "force_restart">("grandfather");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label =
    pkg.language === null
      ? "Unlabeled (legacy)"
      : `${languageDisplay(pkg.language, "english")} (${pkg.language})`;

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("orgSlug", orgSlug);
    fd.append("file", file);
    fd.append("mode", mode);
    const res = await fetch(
      `/api/courses/${courseId}/packages/${pkg.id}/versions`,
      { method: "POST", body: fd }
    );
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Upload failed");
      return;
    }
    onReplaced();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-paper border border-line rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="serif text-2xl">Replace module content</h3>
          <p className="text-xs text-muted mt-1">
            Upload a new SCORM/cmi5 zip for the{" "}
            <span className="text-ink">{label}</span> package. It becomes the
            current version; earlier versions and learner records are kept.
          </p>
        </div>

        <input
          type="file"
          accept=".zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm"
          disabled={busy}
        />

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-ink mb-1">
            In-progress learners
          </legend>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="version-mode"
              className="mt-0.5"
              checked={mode === "grandfather"}
              onChange={() => setMode("grandfather")}
              disabled={busy}
            />
            <span className="text-xs">
              <span className="font-medium text-ink">Grandfather in-progress learners</span>{" "}
              <span className="text-muted">(default)</span>
              <span className="block text-muted">
                Active attempts keep their bookmark on the current version; only
                new attempts get the new version.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="version-mode"
              className="mt-0.5"
              checked={mode === "force_restart"}
              onChange={() => setMode("force_restart")}
              disabled={busy}
            />
            <span className="text-xs">
              <span className="font-medium text-ink">Force restart on new version</span>
              <span className="block text-muted">
                Active attempts are silently reset; every learner starts the new
                version from 0% on their next launch.
              </span>
            </span>
          </label>
        </fieldset>

        {error && (
          <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 border border-line rounded-lg text-sm hover:border-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!file || busy}
            className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Upload new version"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddLanguageDialog({
  orgSlug,
  courseId,
  existingLanguages,
  onClose,
  onAdded,
}: {
  orgSlug: string;
  courseId: string;
  existingLanguages: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [language, setLanguage] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("Pick a SCORM/cmi5 zip first.");
      return;
    }
    if (!language) {
      setError("Pick the language for this package.");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("orgSlug", orgSlug);
    fd.append("language", language);
    if (displayName.trim()) fd.append("display_name", displayName.trim());

    setBusy(true);
    const res = await fetch(`/api/courses/${courseId}/packages`, {
      method: "POST",
      body: fd,
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    onAdded();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-paper border border-line rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4"
      >
        <h3 className="serif text-2xl">Add a language</h3>
        <p className="text-sm text-muted">
          Upload a SCORM 1.2 or cmi5 zip in this language. Same course shell,
          new language variant.
        </p>

        <div>
          <label className="block text-xs uppercase tracking-wide text-muted mb-1">
            Language
          </label>
          <select
            className="w-full border border-line rounded-lg px-3 py-2 bg-canvas"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={busy}
            required
          >
            <option value="">Choose…</option>
            {SUPPORTED_LANGUAGES.filter(
              (l) => !existingLanguages.has(l.code)
            ).map((l) => (
              <option key={l.code} value={l.code}>
                {l.english} ({l.native})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wide text-muted mb-1">
            Display label (optional)
          </label>
          <input
            type="text"
            className="w-full border border-line rounded-lg px-3 py-2 bg-canvas"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Leave blank to use native name"
            disabled={busy}
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wide text-muted mb-1">
            SCORM / cmi5 zip
          </label>
          <input
            type="file"
            accept=".zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
            required
            className="block w-full text-sm"
          />
        </div>

        {error && (
          <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 border border-line rounded-lg text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </div>
  );
}
