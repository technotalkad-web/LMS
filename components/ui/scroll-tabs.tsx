"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Horizontal tab strip that behaves on phones: scrolls sideways without a
 * scrollbar, keeps the active tab in view on mount, and shows a soft fade on
 * whichever edge still has tabs hidden behind it so a cut-off label reads as
 * "swipe for more" rather than "broken".
 *
 * Mark the active tab with `aria-current="page"` or `data-active="true"`.
 */
export function ScrollTabs({
  children,
  className = "",
  innerClassName = "",
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setEdges({
        left: el.scrollLeft > 4,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
      });
    };
    const active = el.querySelector<HTMLElement>(
      '[aria-current="page"], [data-active="true"]'
    );
    if (active) {
      const r = active.getBoundingClientRect();
      const c = el.getBoundingClientRect();
      if (r.left < c.left || r.right > c.right) {
        el.scrollLeft += r.left - c.left - (c.width - r.width) / 2;
      }
    }
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div className={`relative ${className}`}>
      <div ref={ref} className={`overflow-x-auto scrollbar-hide ${innerClassName}`}>
        {children}
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-paper to-transparent transition-opacity ${
          edges.left ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-paper to-transparent transition-opacity ${
          edges.right ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}
