# 0025. Self-host the app's fonts in `app/fonts/` so builds never fetch Google Fonts

Status: Accepted (owner, 2026-11-14): "I approve keeping the font files within the codebase so builds do not depend on Google Fonts." The owner approved decision 1. Decisions 2 to 5 are how the executor carried it out on branch `chore/self-host-fonts`; they are reviewed in its pull request and are not separate owner decisions. Code and documentation only: no migration, no API, schema, role or permission change.
Date: 2026-11-14
Deciders: owner (decision 1); executor (decisions 2 to 5)

## Context

- **The dependency.** `app/layout.tsx` loaded the six app fonts through `next/font/google`: Inter (the platform default), the four brand fonts a tenant can pick (Poppins, Plus Jakarta Sans, Roboto, Merriweather) and Geist Mono. Every `next build` downloaded their CSS and files from fonts.googleapis.com and fonts.gstatic.com, and a bad answer from Google failed the whole build. The lifecycle nightly hit this three times on 2026-11-12 and 13 and now retries its build once for that reason (owner, 2026-11-13). Every build path had the dependency: the pull request e2e job (`scripts/e2e-in-runner.sh`), the lifecycle nightly, `cf:build` for the Workers staging and production deployments, and the Cloud Run `Dockerfile`.
- **More than latin.** `subsets: ["latin"]` chose only which files were preloaded. The CSS that `next/font/google` kept also declared a face for every other subset Google serves for the family, each limited by `unicode-range`: 83 `url()` faces over 46 files. A browser downloads one only for a character in its range. Inter draws the rupee sign (U+20B9) from latin-ext, and Poppins draws Hindi from devanagari.

## Decision

1. **Keep the font files in the repository (owner).** `app/fonts/<family>/` holds the 46 woff2 files `next/font/google` served on 2026-11-14 (Next 15.5.29), checked byte for byte against fonts.gstatic.com, about 1.07 MB in all. Every subset is kept, not only latin, so pages look as they did. Each family folder carries its `OFL.txt` from the google/fonts repository. `app/fonts/README.md` lists each file's subset, weight, size, sha256 and source URL, and says how to refresh them. `.gitattributes` marks the woff2 files binary. `app/fonts/` is a new folder under `app/`; ARCHITECTURE.md §2 records it.
2. **One `next/font/local` call per Google subset: 34 calls.** A call's `declarations` apply to every file in that call, so one call cannot give each file its own `unicode-range`. Each call therefore declares the family name, its subset's range and, for Roboto and Merriweather, `font-stretch: 100%`, as Google's CSS did. Each family keeps Google's subset order, because where two ranges overlap the face defined last wins. Only the latin call preloads and sets the family's CSS variable, as `subsets: ["latin"]` did. `next/font` needs every option written as a literal, so the calls repeat their options instead of sharing constants.
3. **The fallback metrics are next/font/google's.** `app/fonts/fallbacks.css` holds the six fallback faces (`Inter Fallback` and so on) with the values `next/font/google` generated, value for value. Every call sets `adjustFontFallback: false`, and the latin call names the fallback face in `fallback`. `next/font/local` would compute different numbers from the files (Merriweather `size-adjust` 117.59% against 122.09%), and with them a different layout shift while a font loads.
4. **This design relies on `next/font` keeping a declared family name.** All 34 calls declare one of six family names, and the faces must stay under those names. Next 15.5.29 keeps them: its postcss plugin (`next/dist/build/webpack/loaders/next-font-loader/postcss-next-font.js`) writes the declared name as it is (``formatFamily = (family) => `'${family}'` ``), and the built CSS has the 83 faces under exactly Inter, Poppins, Plus Jakarta Sans, Roboto, Merriweather and Geist Mono. Next 14.2.0 did not. Its published plugin returns ``'__${family.replace(/ /g, "_")}_${fontFamilyHash}'``, and the review of this branch traced `fontFamilyHash` to each call's own CSS, so every call had a family name of its own. The 15.5.29 plugin's header comment still says it hashes the name. This is therefore current behaviour, not a documented contract. If per-call names came back, only the latin faces would sit under the name the CSS variable points at, and the other 68 faces (83 less the 15 in the six latin calls) would stop applying with no error: the rupee sign in Inter and Hindi in Poppins would fall back to another font. The same review read the webpack path of Next 16.0.0 as matching 15.5.29. Turbopack has not been checked.
5. **Guards.**
   - `tests/unit/self-hosted-fonts.test.ts`, in the `unit` job on every push, checks the following:
     - no git-tracked code file outside `tests/` imports `next/font/google`;
     - every font file matches the README's size and sha256 and is used by the layout;
     - in each call, the `unicode-range` is Google's range for the subset its files are named for;
     - the family is its folder's, at the README's weights, with style normal, `display: "swap"`, `adjustFontFallback: false`, and `font-stretch` where Google set it;
     - only the latin call preloads, sets the variable and names the fallback face;
     - each family keeps Google's subset order;
     - `fallbacks.css` is pinned value for value: six local fonts and 24 metrics;
     - every family folder carries its licence;
     - the post-build check expects as many faces per family as the layout declares, and it fails on built CSS whose families were renamed per call.
   - `scripts/check-built-fonts.mjs` runs in `scripts/e2e-in-runner.sh` right after the build, so in the pull request e2e job of every pull request, a Next upgrade included. It fails unless the built CSS has the 83 `url()` faces under exactly the six family names, with the expected count for each family, plus the six fallback faces and the six CSS variables. It prints counts and family names only. It is not a `postbuild` hook. A hook would also gate the `cf:build` production deployments and the Docker build, and that is the owner's call.

## Limits

- **webpack only.** `npm run build` and `npm run dev` use webpack. Under Turbopack, both the family naming of decision 4 and where the check looks for the built CSS are unverified. Before a move to Turbopack or any Next upgrade:
  - `node scripts/check-built-fonts.mjs` must pass on that build;
  - a page's fonts must be compared before and after (the faces, their ranges and the files they load).
- **A snapshot.** The files are Google Fonts as of 2026-11-14: Inter v20, Poppins v24, Plus Jakarta Sans v12, Roboto v51, Merriweather v33 and Geist Mono v6. Google's later fixes arrive only when someone refreshes the files, which the README's "Changing the set" describes.
- **Where the check runs.** The post-build check runs in the pull request e2e job only, not on the deployment builds. A deployment builds a commit that has been through that job.
- **A leftover retry.** `scripts/lifecycle-nightly.sh` still retries a build that failed fetching Google Fonts (owner, 2026-11-13). No build fetches them now, so the retry never matches. It is left in place; removing it is a separate change.

## Alternatives considered

- **Keep `next/font/google` and retry the build.** The build would still depend on Google, and a retry does not help when Google stays unreachable for longer than the retry window.
- **Keep only the latin files.** These are smaller, but the rupee sign in Inter and Hindi in Poppins would change font, a visible change on learner pages.
- **One `next/font/local` call per family with all of its files.** A call's `declarations` apply to every file in that call. The files of one weight could not each have their own range, so they would claim the same characters and the browser would use one file for all text.
- **Plain `@font-face` rules in a CSS file, with the files under `public/`.** This does not depend on `next/font`'s naming, but it gives no preload tags, and the file names carry no content hash, so a changed file cannot be cached safely under the same name. It stays the way out if a Next upgrade breaks decision 4.

## Decisions requested from the owner

1. Keep the font files within the codebase so builds do not depend on Google Fonts. Recommended: yes. Decided (owner, 2026-11-14): "I approve keeping the font files within the codebase so builds do not depend on Google Fonts."

Not asked: whether to also run `scripts/check-built-fonts.mjs` on the deployment builds (a `postbuild` hook in `package.json`). It is available on request.

## Verification

- `unit` job on every push: `tests/unit/self-hosted-fonts.test.ts`.
- Pull request e2e job: `scripts/check-built-fonts.mjs` after the build.
- By hand on 2026-11-14, Next 15.5.29, webpack:
  - **Same CSS.** The self-hosted build's CSS was compared with the last `next/font/google` build. It has the same six variables, the same 83 faces (family, weight, style, stretch, display, `unicode-range`, file sha256) in the same order for each family and weight, and the same six fallback faces.
  - **Google blocked.** In a build with fonts.googleapis.com and fonts.gstatic.com blocked in every build process, the build succeeded and no request was attempted.
  - **The check.** `check-built-fonts.mjs` passes on that build. It fails on a copy of its CSS with one Inter face renamed, and on a copy with every face renamed per call.
  - **Mutations.** On an exported copy of the branch, the unit test fails on each of 18 changes, run one at a time. They include the four that passed the earlier version of the test: the latin and latin-ext files of Inter swapped, a range widened, `display: "block"` and a fallback `size-adjust` changed. They also include a `next/font/google` import in `middleware.ts` and in `types/`.

## References

- `app/layout.tsx` (the 34 calls and the design comment), `app/fonts/README.md`, `app/fonts/fallbacks.css`, `tests/unit/self-hosted-fonts.test.ts`, `scripts/check-built-fonts.mjs`, `scripts/e2e-in-runner.sh`.
- ADR 0013 and ADR 0018: other build-level decisions recorded the same way, each with a safeguard that fails loud on a Next upgrade.
