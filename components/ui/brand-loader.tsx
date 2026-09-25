"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AnimationItem } from "lottie-web";

/**
 * Full-page hand-off with the loader visible. Once `window.location` is
 * assigned Chromium stops committing React updates for the old document, so
 * the loader must be flushed to the DOM (and given a frame to paint) BEFORE
 * the navigation starts. `show` flips the state that renders FullScreenLoader.
 */
export function handOff(href: string, show: () => void) {
  flushSync(show);
  window.setTimeout(() => window.location.assign(href), 60);
}

/**
 * Ambak branded loader (Lottie: public/brand/ambak-loader.json).
 *
 * Rules (see docs/LOADING_STATES.md):
 *   - FullScreenLoader → only for BLOCKING loads: initial app load, sign-in /
 *     session hand-off, redirects. Never inside the learner runtime.
 *   - BrandLoader size "sm" | "md" → small, non-blocking indicators inside a
 *     page (data fetching, iframe warm-up). Pair with skeletons for pages.
 *   - InlineSpinner → buttons.
 *
 * Renders instantly: a CSS poster (logo PNG + spinning ring) paints before
 * any JS, then the Lottie player (lottie_light, own chunk) + animation JSON
 * (fetched once per session) replace it. Reduced-motion users keep the
 * static poster. Any failure keeps the poster too — nothing ever blanks.
 */
const ANIMATION_URL = "/brand/ambak-loader.json";
const POSTER_URL = "/brand/ambak-loader-logo.png";

let animationData: Promise<object> | null = null;
function loadAnimationData(): Promise<object> {
  animationData ??= fetch(ANIMATION_URL, { cache: "force-cache" }).then((r) => {
    if (!r.ok) throw new Error(`loader animation ${r.status}`);
    return r.json() as Promise<object>;
  });
  return animationData;
}

/** Warm the player chunk + animation JSON ahead of a hand-off (sign-in pages
 *  call this on mount) so the Lottie is ready the instant the loader shows. */
export function preloadBrandLoader() {
  void import("lottie-web/build/player/lottie_light").catch(() => {});
  void loadAnimationData().catch(() => {});
}
export function usePreloadBrandLoader() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    preloadBrandLoader();
  }, []);
}

type Size = "sm" | "md" | "lg" | "screen";
const PX: Record<Exclude<Size, "screen">, number> = { sm: 32, md: 60, lg: 132 };

export function BrandLoader({
  size = "md",
  label = "Loading",
  className = "",
  /** Show the white disc behind the artwork (needed on dark surfaces). */
  disc = true,
}: {
  size?: Size;
  label?: string;
  className?: string;
  disc?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cancelled = false;
    let anim: AnimationItem | undefined;
    (async () => {
      try {
        const [{ default: lottie }, data] = await Promise.all([
          import("lottie-web/build/player/lottie_light"),
          loadAnimationData(),
        ]);
        if (cancelled || !box.current) return;
        anim = lottie.loadAnimation({
          container: el,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: data,
          rendererSettings: { preserveAspectRatio: "xMidYMid meet", progressiveLoad: true },
        });
        setAnimated(true);
      } catch {
        /* poster stays */
      }
    })();
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, []);

  const dim =
    size === "screen" ? "clamp(120px, 32vw, 200px)" : `${PX[size]}px`;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
      style={{ width: dim, height: dim }}
    >
      {/* White disc: the artwork is dark-on-transparent and the ring track is
          light grey — both assume a light surface. */}
      {disc && (
        <div
          aria-hidden
          className="absolute rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
          style={{ inset: "12%" }}
        />
      )}
      {/* CSS poster — visible until the Lottie has mounted (and forever under
          reduced motion or if the player fails to load). */}
      <div
        aria-hidden
        className={`absolute inset-0 transition-opacity duration-200 ${animated ? "opacity-0" : "opacity-100"}`}
      >
        <div
          className="absolute rounded-full border-[#e2e8f0]"
          style={{ inset: "17%", borderWidth: "max(2px, 1.6%)" }}
        />
        <div
          className="absolute rounded-full border-transparent border-t-[#5850be] animate-spin"
          style={{ inset: "17%", borderWidth: "max(2px, 1.6%)", animationDuration: "1.5s" }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={POSTER_URL}
          alt=""
          decoding="async"
          className="absolute"
          style={{ inset: "37%", width: "26%", height: "26%" }}
        />
      </div>
      <div ref={box} aria-hidden className="absolute inset-0 [&_svg]:!w-full [&_svg]:!h-full" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * Blocking overlay for app-level waits (initial load, sign-in, redirects).
 * Appears after a short delay so sub-200 ms transitions never flash it.
 */
export function FullScreenLoader({
  message,
  delayed = true,
}: {
  message?: string;
  delayed?: boolean;
}) {
  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-canvas ${delayed ? "lms-loader-appear" : ""}`}
      aria-busy="true"
    >
      <BrandLoader size="screen" label={message ?? "Loading"} />
      {message && <p className="text-sm text-muted px-6 text-center">{message}</p>}
    </div>
  );
}

/** Tiny ring in the current text colour — for buttons. */
export function InlineSpinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin ${className}`}
    />
  );
}
