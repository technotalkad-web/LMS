/**
 * Storage backends (Supabase Storage in particular) reject certain characters
 * in object keys — `{`, `}`, spaces, commas, `=`, and others. Storyline 360
 * generates filenames like `foo{Width=1260, Height=720}Light.png` for mobile
 * assets, which would fail the upload.
 *
 * `sanitizeStorageKey` replaces every character outside a safe alphanumeric
 * set with `__HH__` (lowercase hex of its char code). The transform is
 * deterministic and easily reversed — both the upload pipeline and the
 * content-serving route apply it to the same input path, so the iframe can
 * reference the original course-relative path and we still find the file
 * in storage.
 *
 * Safe set: A-Z a-z 0-9 . _ - /
 */
export function sanitizeStorageKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._\-/]/g, (ch) => {
    const code = ch.charCodeAt(0).toString(16).toLowerCase();
    return `__${code}__`;
  });
}
