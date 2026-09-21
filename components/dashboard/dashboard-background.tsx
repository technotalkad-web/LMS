"use client";

import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";
import type { BackgroundFit, BackgroundKind } from "@/lib/theme/dashboard-background";

/**
 * Decorative dashboard background (0074).
 *
 * Renders as a fixed, full-viewport layer that never takes pointer events
 * and is hidden from assistive tech. The dashboard root is `isolate`, and
 * this layer sits at z-index -1 INSIDE that stacking context, so it paints
 * above the page canvas but below every card, button, tab and text of the
 * dashboard — nothing can be covered or blocked. The app nav/header and
 * bottom bar live outside the root and stay above it as before.
 *
 * Images/SVG/GIF are plain <img> (an <img> never runs SVG scripts). Lottie
 * is lazy-loaded only when a Lottie theme is live and the user hasn't asked
 * for reduced motion, so the normal dashboard pays zero extra JS.
 * Everything fails soft: any load error renders nothing.
 */
export function DashboardBackground({
  url,
  kind,
  fit,
  opacity,
}: {
  url: string;
  kind: BackgroundKind;
  fit: BackgroundFit;
  opacity: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const isLottie = kind === "lottie";

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
          rendererSettings: {
            preserveAspectRatio: fit === "contain" ? "xMidYMid meet" : "xMidYMid slice",
          },
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [url, isLottie, fit]);

  if (failed) return null;

  const layer = "pointer-events-none fixed inset-0 -z-10 overflow-hidden select-none";

  if (isLottie) {
    return (
      <div
        ref={ref}
        aria-hidden
        data-dashboard-background="lottie"
        className={`${layer} [&_svg]:!w-full [&_svg]:!h-full`}
        style={{ opacity }}
      />
    );
  }

  if (fit === "tile") {
    return (
      <div
        aria-hidden
        data-dashboard-background="tile"
        className={layer}
        style={{ opacity, backgroundImage: `url("${url}")`, backgroundRepeat: "repeat" }}
      />
    );
  }

  return (
    <div aria-hidden data-dashboard-background={kind} className={layer} style={{ opacity }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        decoding="async"
        fetchPriority="low"
        onError={() => setFailed(true)}
        className={`w-full h-full ${fit === "contain" ? "object-contain" : "object-cover"}`}
      />
    </div>
  );
}
