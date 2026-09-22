"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ThumbnailPicker } from "../../_components/thumbnail-picker";
import { SUPPORTED_LANGUAGES, languageDisplay } from "@/lib/i18n/languages";
import {
  ValidationReportPanel,
  rejectValidation,
  type ValidationResult,
} from "../_components/validation-gate";
import {
  directUpload,
  unzipPackage,
  validateUnzipped,
  type UnzippedPackage,
  type UploadProgress,
} from "../_components/direct-upload";
import { UploadProgressBar } from "../_components/upload-progress";

type UploadState =
  | { kind: "idle" }
  | { kind: "validating"; filename: string }
  | { kind: "report"; file: File; pkg: UnzippedPackage; result: ValidationResult; uploading: boolean }
  | { kind: "uploading"; filename: string; progress: UploadProgress }
  | {
      kind: "success";
      courseId: string;
      title: string;
      manifestType: string;
      language: string | null;
    }
  | { kind: "error"; message: string };

export default function CourseUploadPage() {
  const params = useParams<{ org: string }>();
  const orgSlug = params.org;
  const search = useSearchParams();
  const targetCourseId = search.get("courseId");
  const router = useRouter();
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [aborter, setAborter] = useState<AbortController | null>(null);
  const [notifyUpdate, setNotifyUpdate] = useState(true);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbDisplay, setThumbDisplay] = useState<{
    fit: "cover" | "contain";
    posX: number;
    posY: number;
  }>({ fit: "cover", posX: 50, posY: 50 });

  // Language mapping. New course: the package's language (default English)
  // + optional label. New version: which existing language package this zip
  // replaces, or "add as a new language" to create another variant.
  const [language, setLanguage] = useState<string>("en");
  const [displayName, setDisplayName] = useState("");
  const [packages, setPackages] = useState<PackageRow[] | null>(null);
  // "" = new language (uses the language select); otherwise a package id.
  const [targetPackageId, setTargetPackageId] = useState<string>("");
  useEffect(() => {
    if (!targetCourseId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(
        `/api/courses/${targetCourseId}/packages?orgSlug=${encodeURIComponent(orgSlug)}`
      );
      const j = (await res.json().catch(() => ({}))) as { packages?: PackageRow[] };
      if (cancelled) return;
      const rows = res.ok && Array.isArray(j.packages) ? j.packages : [];
      setPackages(rows);
      // Default to the unlabeled legacy package if there is one, else the
      // first (usually only) language package.
      const def = rows.find((r) => r.language === null) ?? rows[0];
      if (def) setTargetPackageId(def.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [targetCourseId, orgSlug]);
  const existingLanguages = new Set(
    (packages ?? []).map((p) => p.language).filter((l): l is string => !!l)
  );

  // Phase 1: validate the package and show the quality report.
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File)) {
      setState({ kind: "error", message: "Please choose a .zip file" });
      return;
    }
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setState({ kind: "error", message: "File must be a .zip" });
      return;
    }

    setState({ kind: "validating", filename: file.name });
    // The browser unzips the package; the validator gets manifest, launch
    // file and text files plus a descriptor of everything else — media never
    // travels through the server.
    let pkg: UnzippedPackage;
    try {
      pkg = await unzipPackage(file);
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Could not open the zip" });
      return;
    }
    const v = await validateUnzipped(pkg, orgSlug);
    if (!v.ok) {
      setState({ kind: "error", message: v.error });
      return;
    }
    setState({ kind: "report", file, pkg, result: v.result, uploading: false });
  }

  // Phase 2: Accept & Upload — files go straight from the browser to storage;
  // the server only prepares the version and publishes it after every file
  // has arrived.
  async function acceptAndUpload(fields: { validation_id: string; acknowledge: boolean }) {
    if (state.kind !== "report") return;
    const { file, pkg } = state;
    setState({ ...state, uploading: true });
    const controller = new AbortController();
    setAborter(controller);

    try {
      const json = await directUpload({
        pkg,
        signal: controller.signal,
        validationId: fields.validation_id,
        acknowledge: fields.acknowledge,
        target: {
          orgSlug,
          courseId: targetCourseId ?? undefined,
          packageId: targetCourseId && targetPackageId ? targetPackageId : undefined,
          language: targetCourseId && targetPackageId ? null : language,
          displayName: displayName.trim() || null,
          notifyUpdate: !!targetCourseId && notifyUpdate,
          thumbnail: thumbnailUrl
            ? { url: thumbnailUrl, fit: thumbDisplay.fit, posX: thumbDisplay.posX, posY: thumbDisplay.posY }
            : null,
        },
        onProgress: (progress) => setState({ kind: "uploading", filename: file.name, progress }),
      });
      setState({
        kind: "success",
        courseId: json.courseId,
        title: json.manifest?.title ?? "Untitled",
        manifestType: json.manifest?.type ?? "unknown",
        language: targetCourseId && targetPackageId
          ? ((packages ?? []).find((p) => p.id === targetPackageId)?.language ?? null)
          : language,
      });
    } catch (err) {
      const cancelled = (err as { name?: string })?.name === "AbortError";
      setState({
        kind: "error",
        message: cancelled ? "Upload cancelled. Nothing was published." : err instanceof Error ? err.message : "Upload failed",
      });
    } finally {
      setAborter(null);
    }
  }

  async function rejectPackage() {
    if (state.kind !== "report") return;
    await rejectValidation(state.result.validation_id, orgSlug);
    setState({ kind: "idle" });
  }

  const isNewVersion = !!targetCourseId;

  return (
    <div className="max-w-2xl">
      <Link
        href={
          targetCourseId
            ? `/${orgSlug}/library/${targetCourseId}`
            : `/${orgSlug}/library`
        }
        className="text-muted text-sm hover:text-ink transition-colors"
      >
        ← {targetCourseId ? "Back to course" : "Courses"}
      </Link>
      <h1 className="serif text-5xl mt-2 mb-2">
        {isNewVersion ? "Upload new version" : "Upload course"}
      </h1>
      <p className="text-muted mb-10">
        {isNewVersion ? (
          <>
            Replacing the package for{" "}
            <span className="text-ink">this course</span>
            . Previous attempts stay intact; learners launch the new version
            from now on.
          </>
        ) : (
          <>
            SCORM 1.2 (imsmanifest.xml), cmi5 (cmi5.xml) and standalone xAPI
            (tincan.xml) packages are supported.
          </>
        )}
      </p>

      {state.kind === "uploading" ? (
        <UploadProgressBar progress={state.progress} fileName={state.filename} onCancel={aborter ? () => aborter.abort() : undefined} />
      ) : state.kind === "report" ? (
        <ValidationReportPanel
          fileName={state.file.name}
          result={state.result}
          busy={state.uploading}
          onAccept={acceptAndUpload}
          onReject={rejectPackage}
        />
      ) : state.kind === "success" ? (
        <div className="border border-line rounded-lg bg-paper p-8">
          <h2 className="serif text-3xl mb-2">
            {isNewVersion ? "New version published" : "Uploaded"}
          </h2>
          <p className="text-muted text-sm mb-6">
            <span className="text-ink">{state.title}</span> — detected as{" "}
            <span className="text-ink">{state.manifestType}</span>
            {state.language ? (
              <>
                , language{" "}
                <span className="text-ink">
                  {languageDisplay(state.language, "english")}
                </span>
              </>
            ) : null}
            .
            {isNewVersion && notifyUpdate && (
              <>
                {" "}
                Update notifications have been queued for assigned learners.
              </>
            )}
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() =>
                router.push(
                  isNewVersion
                    ? `/${orgSlug}/library/${targetCourseId}`
                    : `/${orgSlug}/library`
                )
              }
              className="px-4 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 text-sm"
            >
              {isNewVersion ? "Back to course" : "Back to courses"}
            </button>
            <button
              type="button"
              onClick={() => setState({ kind: "idle" })}
              className="px-4 py-2 border border-line rounded-lg font-medium hover:border-ink text-sm"
            >
              Upload another
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="border border-line rounded-lg bg-paper p-8 space-y-6"
        >
          <div>
            <label className="block text-sm font-medium mb-2" htmlFor="file">
              Course package (.zip)
            </label>
            <input
              type="file"
              id="file"
              name="file"
              accept=".zip,application/zip"
              required
              disabled={state.kind === "validating"}
              className="block w-full text-sm file:mr-4 file:px-4 file:py-2 file:rounded-md file:border file:border-line file:bg-canvas file:text-ink file:font-medium hover:file:border-ink"
            />
            <p className="text-xs text-muted mt-2">
              Title and launch URL will be read from the manifest inside the
              zip.
            </p>
          </div>

          {isNewVersion ? (
            <div>
              <label className="block text-sm font-medium mb-2" htmlFor="target-package">
                Which language does this package replace?
              </label>
              <select
                id="target-package"
                value={targetPackageId}
                onChange={(e) => setTargetPackageId(e.target.value)}
                disabled={packages === null}
                className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
              >
                {(packages ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {packageOptionLabel(p)}
                  </option>
                ))}
                <option value="">+ Add as a new language…</option>
              </select>
              {targetPackageId === "" && (
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <LanguageSelect
                    value={language}
                    onChange={setLanguage}
                    disabledCodes={existingLanguages}
                  />
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={80}
                    placeholder="Display label (optional)"
                    className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
                  />
                </div>
              )}
              <p className="text-xs text-muted mt-2">
                {targetPackageId === ""
                  ? "Creates another language variant of this course. Learners choose their language at launch."
                  : "Becomes that language's current version. Earlier versions, attempts and reports are preserved."}
              </p>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium mb-2" htmlFor="package-language">
                Package language
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <LanguageSelect id="package-language" value={language} onChange={setLanguage} />
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={80}
                  placeholder="Display label (optional)"
                  className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
                />
              </div>
              <p className="text-xs text-muted mt-2">
                The language of the content inside this zip. Other languages
                of the same module are added later from the course page
                (Languages → Add language) or via Upload new version → &quot;Add
                as a new language&quot;.
              </p>
            </div>
          )}

          {isNewVersion && (
            <label className="flex items-start gap-3 px-3 py-3 border border-line rounded-lg bg-canvas text-sm">
              <input
                type="checkbox"
                checked={notifyUpdate}
                onChange={(e) => setNotifyUpdate(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  Send update notification email to affected learners
                </span>
                <span className="block text-xs text-muted mt-0.5">
                  Reaches every learner currently assigned to this course (via
                  direct, team, or org-wide assignment). Previously completed
                  work stays completed; only newly added content needs to be
                  redone.
                </span>
              </span>
            </label>
          )}

          <div>
            <label className="block text-sm font-medium mb-2">
              Thumbnail (optional)
            </label>
            <ThumbnailPicker
              orgSlug={orgSlug}
              value={thumbnailUrl}
              onChange={setThumbnailUrl}
              display={thumbDisplay}
              onDisplayChange={setThumbDisplay}
            />
            <p className="text-xs text-muted mt-2">
              Shown on the dashboard, library, and course detail. JPEG or PNG,
              16:9 recommended.
            </p>
          </div>

          <button
            type="submit"
            disabled={state.kind === "validating"}
            className="w-full px-4 py-3 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {state.kind === "validating"
              ? `Validating ${state.filename}…`
              : "Validate package"}
          </button>
          <p className="text-xs text-muted -mt-3">
            The package is checked for tracking, completion, score, and resume
            support before anything is published — you review the report, then
            accept or reject.
          </p>

          {state.kind === "error" && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
        </form>
      )}
    </div>
  );
}

type PackageRow = {
  id: string;
  language: string | null;
  display_name: string | null;
  is_active: boolean;
};

function packageOptionLabel(p: PackageRow): string {
  if (p.language === null) return "Unlabeled (legacy) package";
  const base = `${languageDisplay(p.language, "english")} (${languageDisplay(p.language, "native")})`;
  const label = p.display_name ? `${base} — ${p.display_name}` : base;
  return p.is_active ? label : `${label} · hidden from learners`;
}

function LanguageSelect({
  id,
  value,
  onChange,
  disabledCodes,
}: {
  id?: string;
  value: string;
  onChange: (code: string) => void;
  /** Languages the course already has (can't be added twice). */
  disabledCodes?: Set<string>;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
    >
      {SUPPORTED_LANGUAGES.map((l) => {
        const taken = disabledCodes?.has(l.code) ?? false;
        return (
          <option key={l.code} value={l.code} disabled={taken}>
            {l.english} ({l.native}){taken ? " — already on this course" : ""}
          </option>
        );
      })}
    </select>
  );
}
