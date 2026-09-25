import { BrandLoader } from "./brand-loader";

/**
 * Loading state for a module launch. Mirrors the runtime's dark frame with a
 * SMALL indicator in the content area — never a full-screen overlay — so a
 * launch reads as "the module is opening" and hands over to the real runtime
 * the moment it streams in. Used by the launch route's loading boundary and
 * by the root boundary when a hard load lands on a launch URL.
 */
export function LaunchFrameLoader() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <header className="flex items-center justify-between px-4 sm:px-5 py-2.5 bg-ink text-canvas border-b border-canvas/10">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <div className="h-8 w-24 rounded-lg border border-canvas/20 animate-pulse" />
          <div className="h-5 w-40 rounded bg-canvas/10 animate-pulse" />
        </div>
      </header>
      <div className="flex-1 bg-white flex flex-col items-center justify-center gap-3">
        <BrandLoader size="md" label="Opening module" />
        <p className="text-xs text-gray-500">Opening module…</p>
      </div>
    </div>
  );
}
