"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";

export type PopupData = {
  id: string;
  title: string;
  body: string | null;
  media_landscape_url: string | null;
  media_portrait_url: string | null;
  cta_label: string | null;
  cta_href: string | null;
  duration_seconds: number;
};

/**
 * Full-screen learning announcement (0068). Product rules:
 *  - NEVER over an open course — suppressed on launch/content routes
 *    (learning is never interrupted).
 *  - Auto-closes after duration_seconds (hard-capped 30 by the API), with an
 *    always-visible × and Escape.
 *  - 16:9 creative on landscape screens, 9:16 on portrait (whichever exists
 *    is used when only one was uploaded).
 *  - Telemetry: shown on mount, dismissed/clicked on exit — powering the
 *    once/daily frequency rules and admin analytics.
 */
export function PopupAnnouncement({
  orgSlug,
  popup,
}: {
  orgSlug: string;
  popup: PopupData;
}) {
  const pathname = usePathname();
  const inCourse = /\/courses\/[^/]+\/(launch|content)/.test(pathname ?? "");
  const [open, setOpen] = useState(true);
  const closedRef = useRef(false);

  const report = (event: "shown" | "dismissed" | "clicked") => {
    try {
      void fetch("/api/announcements/impression", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, announcement_id: popup.id, event }),
        keepalive: true,
      });
    } catch {
      /* telemetry is best-effort */
    }
  };

  const close = (reason: "dismissed" | "clicked") => {
    if (closedRef.current) return;
    closedRef.current = true;
    report(reason);
    setOpen(false);
  };

  useEffect(() => {
    if (inCourse) return;
    report("shown");
    const timer = setTimeout(
      () => close("dismissed"),
      Math.min(30, Math.max(3, popup.duration_seconds)) * 1000
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close("dismissed");
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open || inCourse) return null;

  const landscape = popup.media_landscape_url;
  const portrait = popup.media_portrait_url;
  const ctaExternal = popup.cta_href?.startsWith("http");
  const duration = Math.min(30, Math.max(3, popup.duration_seconds));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={popup.title}
      className="fixed inset-0 z-[100] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close("dismissed");
      }}
    >
      <div className="relative w-full max-w-3xl portrait:max-w-sm">
        <button
          type="button"
          onClick={() => close("dismissed")}
          aria-label="Close announcement"
          autoFocus
          className="absolute -top-3 -right-3 z-10 h-9 w-9 rounded-full bg-white text-slate-900 shadow-lg flex items-center justify-center hover:scale-105 transition"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="rounded-2xl overflow-hidden shadow-2xl bg-slate-900">
          {(landscape || portrait) && (
            <>
              {landscape && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={landscape}
                  alt=""
                  className={`w-full object-cover ${portrait ? "portrait:hidden" : ""} aspect-video`}
                />
              )}
              {portrait && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={portrait}
                  alt=""
                  className={`w-full object-cover ${landscape ? "landscape:hidden" : ""} aspect-[9/16] max-h-[70vh]`}
                />
              )}
            </>
          )}
          <div className="p-4 sm:p-5 text-white">
            <h2 className="text-lg sm:text-xl font-bold leading-tight">{popup.title}</h2>
            {popup.body && (
              <p className="text-sm text-white/80 mt-1 whitespace-pre-wrap">{popup.body}</p>
            )}
            {popup.cta_href &&
              (ctaExternal ? (
                <a
                  href={popup.cta_href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => close("clicked")}
                  className="mt-3 inline-flex items-center justify-center px-5 py-2.5 bg-white text-slate-900 rounded-xl text-sm font-bold hover:bg-white/90"
                >
                  {popup.cta_label || "Open"} →
                </a>
              ) : (
                <Link
                  href={popup.cta_href}
                  onClick={() => close("clicked")}
                  className="mt-3 inline-flex items-center justify-center px-5 py-2.5 bg-white text-slate-900 rounded-xl text-sm font-bold hover:bg-white/90"
                >
                  {popup.cta_label || "Open"} →
                </Link>
              ))}
          </div>
          {/* Auto-close progress (pure CSS; hidden for reduced motion) */}
          <div
            aria-hidden
            className="h-1 bg-white/70 origin-left motion-reduce:hidden"
            style={{ animation: `popup-drain ${duration}s linear forwards` }}
          />
        </div>
        <style>{`@keyframes popup-drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }`}</style>
      </div>
    </div>
  );
}
