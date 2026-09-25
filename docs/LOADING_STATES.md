# Loading states — the Ambak loader and where it appears

Asset: `public/brand/ambak-loader.json` (Lottie, 512×512, 30 fps, 5 s loop)
and `public/brand/ambak-loader-logo.png` (the logo extracted from it, used as
the instant CSS poster). Component: `components/ui/brand-loader.tsx`.

## The three loaders

| Component | Looks like | Use for | Never for |
| --- | --- | --- | --- |
| `FullScreenLoader` | full-viewport branded loader, fades in after 150 ms | first app load, sign-in / session hand-off, redirects (`/`, `/login`, `/[org]/login`, `/select-org`, `/auth/finish`, `/invitations`, `/change-password`) | anything inside the app shell or the learner runtime |
| `BrandLoader size="sm" \| "md"` | small inline animation | data-fetching states next to a skeleton; the iframe warm-up inside a module | covering content |
| `InlineSpinner` | tiny ring in the current text colour | buttons while a request is in flight | — |

`BrandLoader` paints a CSS poster (logo + spinning ring) immediately, then
lazy-loads the Lottie player (`lottie_light`, its own chunk) and the animation
JSON once per session and swaps it in. Reduced-motion users keep the static
poster. Any load failure keeps the poster. It is responsive: `size="screen"`
uses `clamp(120px, 32vw, 200px)`.

## Route boundaries (`loading.tsx`)

- `app/loading.tsx` → `FullScreenLoader`. It only ever shows for the root-level
  routes above, because every in-app group has its own boundary below it and
  React always picks the nearest one:
  - `app/[org]/(learner)/loading.tsx`, `app/[org]/(admin)/loading.tsx`,
    `app/(super-owner)/super/loading.tsx` → skeleton + small brand indicator.
  - Bespoke skeletons: dashboard, courses, course detail, journey, learning
    path, leaderboard, library, library course, learning paths, reports,
    users, analytics.
  - `courses/[courseId]/launch/loading.tsx` → the runtime's dark frame with a
    small "Opening module…" indicator in the content area. Not an overlay.

Adding a page? If it fetches data, add a `loading.tsx` next to it using the
primitives in `components/ui/skeleton.tsx` (`PageSkeleton`, `LoadingRow`,
`CardGridSkeleton`, `TableSkeleton`…). Never render `FullScreenLoader` from a
page inside `[org]`.

## Learner runtime (SCORM / cmi5 / xAPI)

- No full-screen loader, ever. While the package's launch document loads, a
  small indicator sits in the still-blank iframe area (`ModuleFrameLoader`,
  `pointer-events: none`) and fades out on the iframe `load` event.
- **Background preload of the next module.** The launch page works out the
  next module (journey: the next day that has a course; learning path: the
  next step) and passes its content launch file to the runtime. Four seconds
  after the current module has loaded, when the browser is idle (and not on a
  data-saver connection), the runtime fetches that file with low priority so
  it lands in the browser HTTP cache and the Cloudflare edge cache. Only
  content files are fetched — never a launch page, which would create an
  attempt. Each URL is warmed once per session. Everything is best-effort and
  silent.

## Sign-in flows

`/login`, `/[org]/login` (password, magic link, Google, SSO), invitation
acceptance: the submit button shows `InlineSpinner` while the request runs;
once the browser is about to navigate, `FullScreenLoader` with a message
("Signing you in…") covers the hand-off until the workspace renders.
`/auth/finish` shows the brand loader while it completes the session.
