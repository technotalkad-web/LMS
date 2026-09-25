"use client";

import { useEffect, useRef, useState } from "react";
import { BrandLoader } from "@/components/ui/brand-loader";

/**
 * Tracks whether the module iframe has loaded. The iframe is server-rendered
 * and starts loading before React hydrates, so its `load` event can fire
 * before `onLoad` is attached — on mount we therefore also inspect the
 * (same-origin) document, and a timeout guarantees the indicator can never
 * outlive a module that loaded some other way.
 */
export function useModuleFrame() {
  const ref = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const doc = ref.current?.contentDocument;
      if (doc && doc.readyState === "complete" && doc.location.href !== "about:blank") setLoaded(true);
    } catch {
      /* cross-origin content: rely on onLoad / the timeout */
    }
    const t = window.setTimeout(() => setLoaded(true), 8000);
    return () => window.clearTimeout(t);
  }, []);
  return { ref, loaded, onLoad: () => setLoaded(true) };
}

/**
 * Learner-runtime loading helpers. Rules: the module is never covered by a
 * full-screen loader and the learner is never interrupted.
 *
 *  - <ModuleFrameLoader/>: a small indicator that sits in the (still blank)
 *    iframe area until the package's launch document has loaded, then fades
 *    away. pointer-events: none — it can never block the module.
 *  - useNextModulePreload(): once the current module is up and the browser
 *    is idle, warms the NEXT module's launch file in the background (browser
 *    HTTP cache + Cloudflare edge cache), so the following step opens fast.
 *    Only content files are touched — never a launch page, which would mint
 *    an attempt. Failures are silent; each URL is warmed once per session.
 */
export function ModuleFrameLoader({ loaded }: { loaded: boolean }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => setGone(true), 250);
    return () => window.clearTimeout(t);
  }, [loaded]);
  if (gone) return null;
  return (
    <div
      aria-hidden={loaded}
      className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white pointer-events-none transition-opacity duration-200 ${loaded ? "opacity-0" : "opacity-100"}`}
    >
      <BrandLoader size="md" label="Loading module" />
      <p className="text-xs text-gray-500">Loading module…</p>
    </div>
  );
}

const SESSION_KEY = "lms:preloaded";

export function useNextModulePreload(urls: string[], ready: boolean) {
  useEffect(() => {
    if (!ready || urls.length === 0) return;
    if (typeof navigator !== "undefined") {
      const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      if (conn?.saveData) return;
    }
    let cancelled = false;
    const run = async () => {
      let done: string[] = [];
      try {
        done = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "[]") as string[];
      } catch {
        done = [];
      }
      for (const url of urls) {
        if (cancelled || done.includes(url)) continue;
        try {
          const res = await fetch(url, {
            credentials: "same-origin",
            cache: "force-cache",
            // Low priority: the current module's own requests always win.
            ...({ priority: "low" } as RequestInit),
          });
          // Read to completion so the response is committed to the cache.
          if (res.ok) await res.arrayBuffer();
          done.push(url);
          try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(done.slice(-50)));
          } catch {
            /* ignore */
          }
        } catch {
          /* silent — preloading is best effort */
        }
      }
    };
    // Wait for the current module to settle before spending bandwidth.
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    const timer = window.setTimeout(() => {
      if (w.requestIdleCallback) idleId = w.requestIdleCallback(() => void run(), { timeout: 8000 });
      else void run();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (idleId !== null && w.cancelIdleCallback) w.cancelIdleCallback(idleId);
    };
  }, [urls, ready]);
}
