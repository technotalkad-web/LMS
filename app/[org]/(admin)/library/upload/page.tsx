"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ThumbnailPicker } from "../../_components/thumbnail-picker";

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string }
  | { kind: "success"; courseId: string; title: string; manifestType: string }
  | { kind: "error"; message: string };

export default function CourseUploadPage() {
  const params = useParams<{ org: string }>();
  const orgSlug = params.org;
  const search = useSearchParams();
  const targetCourseId = search.get("courseId");
  const router = useRouter();
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [notifyUpdate, setNotifyUpdate] = useState(true);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

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

    setState({ kind: "uploading", filename: file.name });
    form.set("orgSlug", orgSlug);
    if (targetCourseId) {
      form.set("courseId", targetCourseId);
      if (notifyUpdate) form.set("notify_update", "1");
    }
    if (thumbnailUrl) form.set("thumbnail_url", thumbnailUrl);

    try {
      const res = await fetch("/api/courses/upload", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!res.ok) {
        setState({
          kind: "error",
          message: json.error ?? "Upload failed",
        });
        return;
      }
      setState({
        kind: "success",
        courseId: json.courseId,
        title: json.manifest?.title ?? "Untitled",
        manifestType: json.manifest?.type ?? "unknown",
      });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
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
            SCORM 1.2 (imsmanifest.xml) and cmi5 (cmi5.xml) packages are
            supported.
          </>
        )}
      </p>

      {state.kind === "success" ? (
        <div className="border border-line rounded-lg bg-paper p-8">
          <h2 className="serif text-3xl mb-2">
            {isNewVersion ? "New version published" : "Uploaded"}
          </h2>
          <p className="text-muted text-sm mb-6">
            <span className="text-ink">{state.title}</span> — detected as{" "}
            <span className="text-ink">{state.manifestType}</span>.
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
              disabled={state.kind === "uploading"}
              className="block w-full text-sm file:mr-4 file:px-4 file:py-2 file:rounded-md file:border file:border-line file:bg-canvas file:text-ink file:font-medium hover:file:border-ink"
            />
            <p className="text-xs text-muted mt-2">
              Title and launch URL will be read from the manifest inside the
              zip.
            </p>
          </div>

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
            />
            <p className="text-xs text-muted mt-2">
              Shown on the dashboard, library, and course detail. JPEG or PNG,
              16:9 recommended.
            </p>
          </div>

          <button
            type="submit"
            disabled={state.kind === "uploading"}
            className="w-full px-4 py-3 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {state.kind === "uploading"
              ? `Uploading ${state.filename}…`
              : isNewVersion
                ? "Publish new version"
                : "Upload"}
          </button>

          {state.kind === "error" && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
        </form>
      )}
    </div>
  );
}
