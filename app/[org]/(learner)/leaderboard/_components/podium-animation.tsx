"use client";

import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";

/**
 * Decorative animation overlay for the podium (0061 podium_style.animation_url).
 *
 * Two modes by file type:
 *  - .json / .lottie → Lottie: the player (lottie_light, SVG renderer) is
 *    lazy-loaded in its own chunk ONLY when a Lottie file is configured, so
 *    orgs that don't use this pay zero JS. The animation JSON is fetched
 *    client-side (the file lives in the org's own public storage bucket).
 *  - anything else (.svg / .gif / .webp) → a plain <img>, which never
 *    executes SVG scripts — no JS at all.
 *
 * Fail-soft by design: reduced-motion users get nothing, and any load/parse
 * error renders nothing (the CSS confetti and gradient are independent
 * layers, so the podium always looks finished without this).
 */
export function PodiumAnimation({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const isLottie = /\.(json|lottie)(\?|#|$)/i.test(url);

  useEffect(() => {
    if (!isLottie || !ref.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cancelled = false;
    let anim: AnimationItem | undefined;
    (async () => {
      try {
        const [{ default: lottie }, res] = await Promise.all([
          import("lottie-web/build/player/lottie_light"),
          fetch(url),
        ]);
        if (cancelled || !res.ok || !ref.current) return;
        const data = (await res.json()) as object;
        if (cancelled || !ref.current) return;
        anim = lottie.loadAnimation({
          container: ref.current,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: data,
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [url, isLottie]);

  if (failed) return null;
  if (!isLottie) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        aria-hidden
        onError={() => setFailed(true)}
        className="absolute inset-0 w-full h-full object-cover pointer-events-none opacity-70"
      />
    );
  }
  return (
    <div
      ref={ref}
      aria-hidden
      className="absolute inset-0 pointer-events-none opacity-80 overflow-hidden [&_svg]:!w-full [&_svg]:!h-full [&_svg]:object-cover"
    />
  );
}
