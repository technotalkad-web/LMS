/**
 * In-page checks run after a navigation settles: a lightweight accessibility
 * pass, a navigation-timing capture, and an error-boundary detector. These run
 * entirely in the page via evaluate() so there's no extra runtime dependency
 * (deliberately no axe-core add during the stabilisation phase).
 */

import type { Page } from "@playwright/test";

export interface A11yResult {
  imagesNoAlt: number;
  controlsNoName: number;
  inputsNoLabel: number;
  duplicateIds: number;
  hasLang: boolean;
  hasTitle: boolean;
  hasH1: boolean;
  samples: string[]; // a few offending outerHTML snippets for the report
}

export interface PerfResult {
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  domNodes: number;
}

export interface ErrorSurface {
  /** True if the page is showing an app error boundary / framework error page. */
  isErrorPage: boolean;
  marker?: string;
}

export async function runA11y(page: Page): Promise<A11yResult> {
  return page.evaluate(() => {
    const samples: string[] = [];
    const snip = (el: Element) => {
      if (samples.length < 8) samples.push(el.outerHTML.slice(0, 160));
    };

    const imgs = Array.from(document.querySelectorAll("img"));
    const imagesNoAlt = imgs.filter((el) => {
      const bad = !el.hasAttribute("alt");
      if (bad) snip(el);
      return bad;
    }).length;

    // Buttons / links with no discernible accessible name.
    const controls = Array.from(
      document.querySelectorAll("button, a[href], [role=button]")
    );
    const controlsNoName = controls.filter((el) => {
      const txt = (el.textContent || "").trim();
      const aria =
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        el.getAttribute("title");
      const img = el.querySelector("img[alt]");
      const bad = !txt && !aria && !img;
      if (bad) snip(el);
      return bad;
    }).length;

    // Form fields with no label association.
    const fields = Array.from(
      document.querySelectorAll("input, select, textarea")
    ).filter((el) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return type !== "hidden" && type !== "submit" && type !== "button";
    });
    const inputsNoLabel = fields.filter((el) => {
      const id = el.getAttribute("id");
      const hasFor = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const aria =
        el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      const wrapped = el.closest("label");
      const placeholder = el.getAttribute("placeholder");
      const bad = !hasFor && !aria && !wrapped && !placeholder;
      if (bad) snip(el);
      return bad;
    }).length;

    // Duplicate ids (a real source of label/aria breakage).
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) dup.add(id);
      seen.add(id);
    }

    return {
      imagesNoAlt,
      controlsNoName,
      inputsNoLabel,
      duplicateIds: dup.size,
      hasLang: !!document.documentElement.getAttribute("lang"),
      hasTitle: !!document.title && document.title.trim().length > 0,
      hasH1: !!document.querySelector("h1"),
      samples,
    };
  });
}

export async function runPerf(page: Page): Promise<PerfResult> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation"
    )[0] as PerformanceNavigationTiming | undefined;
    const domNodes = document.getElementsByTagName("*").length;
    if (!nav) {
      return { ttfbMs: null, domContentLoadedMs: null, loadMs: null, domNodes };
    }
    return {
      ttfbMs: Math.round(nav.responseStart - nav.requestStart),
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      loadMs: Math.round(nav.loadEventEnd - nav.startTime),
      domNodes,
    };
  });
}

export async function detectErrorSurface(page: Page): Promise<ErrorSurface> {
  return page.evaluate(() => {
    const body = (document.body?.innerText || "").slice(0, 4000);
    const markers = [
      "Application error: a client-side exception",
      "Application error: a server-side exception",
      "This page could not be found",
      "Internal Server Error",
      "something went wrong",
      "Unhandled Runtime Error",
      "500: Internal",
      "404: This page",
    ];
    for (const m of markers) {
      if (body.toLowerCase().includes(m.toLowerCase())) {
        return { isErrorPage: true, marker: m };
      }
    }
    return { isErrorPage: false };
  });
}
