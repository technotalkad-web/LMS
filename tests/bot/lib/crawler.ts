/**
 * Autonomous link crawler — Layer 1 of the bot.
 *
 * Given an authenticated page and a role, it BFS-walks every in-app link
 * reachable from the role's entry points (bounded by depth + page cap, scoped
 * to the role's path prefixes), and on each page runs the full signal suite:
 * uncaught exceptions, console/hydration errors, failed network calls, error
 * boundaries, accessibility, and navigation performance. Each defect becomes a
 * Finding with a screenshot (for high-severity) and reproduction steps.
 *
 * It deliberately does NOT submit forms or follow mutating/export/sign-out
 * links — discovery via GET navigation only. Form and write coverage lives in
 * the scripted journeys so it stays intentional and non-destructive.
 */

import type { Page } from "@playwright/test";
import { crawl as crawlCfg, thresholds } from "../bot.config";
import { record, recordStat, fingerprint } from "./findings";
import { attachMonitor } from "./monitor";
import { detectErrorSurface, runA11y, runPerf, type ErrorSurface } from "./checks";
import type { BotRole } from "./types";

interface CrawlOpts {
  page: Page;
  baseURL: string;
  role: BotRole;
  /** Absolute paths (org already substituted) to start from. */
  entryRoutes: string[];
  /** Allowed path prefixes; links outside are not followed. */
  scopePrefixes: string[];
}

function areaOf(pathname: string): string {
  // "/qa-bot-xx/library/123" -> "library"; "/super/plans" -> "super/plans"
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "super") return parts.slice(0, 2).join("/");
  return parts[1] ?? parts[0] ?? "/";
}

function inScope(pathname: string, scope: string[]): boolean {
  return scope.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

function isDenied(href: string): boolean {
  const lower = href.toLowerCase();
  if (crawlCfg.denySubstrings.some((s) => lower.includes(s))) return true;
  if (crawlCfg.denyExtensions.some((e) => lower.endsWith(e))) return true;
  return false;
}

export async function crawl(opts: CrawlOpts): Promise<void> {
  const { page, baseURL, role, entryRoutes, scopePrefixes } = opts;
  const { signals, reset } = attachMonitor(page, baseURL);
  const origin = new URL(baseURL).origin;

  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number; from: string }> = entryRoutes.map(
    (p) => ({ path: p, depth: 0, from: "(entry)" })
  );

  while (queue.length && visited.size < crawlCfg.maxPagesPerRole) {
    const { path: target, depth, from } = queue.shift()!;
    let pathname: string;
    try {
      pathname = new URL(target, origin).pathname;
    } catch {
      continue;
    }
    if (visited.has(pathname)) continue;
    visited.add(pathname);

    const area = areaOf(pathname);
    reset();

    // --- navigate ---
    let status: number | null = null;
    let loadMs: number | null = null;
    const t0 = Date.now();
    let navOk = true;
    try {
      const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      status = resp?.status() ?? null;
    } catch (e) {
      navOk = false;
      await record({
        severity: "high",
        category: "broken-link",
        title: `Navigation failed: ${pathname}`,
        detail: `goto() threw: ${(e as Error).message}`,
        role,
        url: target,
        area,
        repro: [`Sign in as ${role}`, `Navigate to ${target} (linked from ${from})`],
        page,
      });
    }
    // Let client render / data settle.
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await page.waitForTimeout(crawlCfg.settleMs);
    loadMs = Date.now() - t0;

    const finalUrl = page.url();
    recordStat({ role, url: pathname, status, loadMs, ok: navOk && (status ?? 200) < 400 });

    if (!navOk) continue;

    // --- document-level HTTP status ---
    if (status && status >= 500) {
      await record({
        severity: "critical",
        category: "server-error",
        title: `${status} server error rendering ${pathname}`,
        detail: `The page document returned HTTP ${status}.`,
        role,
        url: finalUrl,
        area,
        repro: [`Sign in as ${role}`, `Open ${target}`, `Observe HTTP ${status}`],
        meta: { status },
        page,
      });
    } else if (status === 404) {
      await record({
        severity: "high",
        category: "broken-link",
        title: `404 on ${pathname}`,
        detail: `Expected this route to be reachable for ${role}, got 404.`,
        role,
        url: finalUrl,
        area,
        repro: [`Sign in as ${role}`, `Open ${target}`, `Observe 404`],
        meta: { status },
        page,
      });
    }

    // --- error boundary / framework error page ---
    const errSurface = await detectErrorSurface(page).catch(
      (): ErrorSurface => ({ isErrorPage: false })
    );
    if (errSurface.isErrorPage) {
      const isServer = /server-side|Internal Server/i.test(errSurface.marker ?? "");
      await record({
        severity: isServer ? "critical" : "high",
        category: isServer ? "server-error" : "page-exception",
        title: `Error page shown at ${pathname}`,
        detail: `Detected error surface: "${errSurface.marker}".`,
        role,
        url: finalUrl,
        area,
        repro: [`Sign in as ${role}`, `Open ${target}`, `Observe error screen`],
        meta: { marker: errSurface.marker },
        page,
      });
    }

    // --- uncaught page exceptions ---
    for (const msg of dedupe(signals.pageErrors)) {
      await record({
        severity: "critical",
        category: "page-exception",
        title: `Uncaught exception on ${pathname}`,
        detail: msg,
        role,
        url: finalUrl,
        area,
        repro: [`Sign in as ${role}`, `Open ${target}`, `Open devtools console`],
        logs: signals.pageErrors.slice(0, 5),
        fingerprint: fingerprint(["page-exception", area, firstLine(msg)]),
        page,
      });
    }

    // --- hydration ---
    for (const msg of dedupe(signals.hydrationErrors)) {
      await record({
        severity: "high",
        category: "hydration",
        title: `React hydration/runtime error on ${pathname}`,
        detail: msg,
        role,
        url: finalUrl,
        area,
        repro: [`Sign in as ${role}`, `Open ${target}`, `Watch console during load`],
        fingerprint: fingerprint(["hydration", area, firstLine(msg)]),
        page,
      });
    }

    // --- console errors (excluding the hydration ones already raised) ---
    const plainConsole = dedupe(
      signals.consoleErrors.filter((c) => !signals.hydrationErrors.includes(c))
    );
    for (const msg of plainConsole) {
      await record({
        severity: "medium",
        category: "console-error",
        title: `Console error on ${pathname}`,
        detail: msg,
        role,
        url: finalUrl,
        area,
        repro: [`Sign in as ${role}`, `Open ${target}`, `Read console`],
        fingerprint: fingerprint(["console-error", area, firstLine(msg)]),
      });
    }

    // --- failed network requests ---
    for (const f of dedupeNet(signals.netFailures)) {
      let severity: "critical" | "medium" | "low" | "info" = "medium";
      if (f.status >= 500) severity = "critical";
      else if (f.status === 404) severity = "medium";
      else if (f.status === 401 || f.status === 403) severity = "info"; // may be intentional RBAC
      await record({
        severity,
        category: f.status >= 500 ? "server-error" : "network",
        title: `${f.method} ${f.status} ${shortPath(f.url)}`,
        detail: `A ${f.resourceType} request made by ${pathname} returned HTTP ${f.status}.`,
        role,
        url: finalUrl,
        area,
        repro: [`Sign in as ${role}`, `Open ${target}`, `Watch network for ${f.method} ${shortPath(f.url)}`],
        meta: { status: f.status, request: f.url, method: f.method },
        fingerprint: fingerprint(["network", f.method, shortPath(f.url), String(f.status)]),
      });
    }

    // --- performance ---
    const perf = await runPerf(page).catch(() => null);
    if (perf) {
      if (perf.loadMs != null && perf.loadMs >= thresholds.loadMsHigh) {
        await record({
          severity: "medium",
          category: "performance",
          title: `Slow page load (${perf.loadMs} ms) on ${pathname}`,
          detail: `load=${perf.loadMs}ms ttfb=${perf.ttfbMs}ms domNodes=${perf.domNodes} (threshold ${thresholds.loadMsHigh}ms).`,
          role,
          url: finalUrl,
          area,
          repro: [`Sign in as ${role}`, `Open ${target}`, `Measure load time`],
          meta: { ...perf },
          fingerprint: fingerprint(["performance", area]),
        });
      } else if (
        (perf.loadMs != null && perf.loadMs >= thresholds.loadMsWarn) ||
        (perf.ttfbMs != null && perf.ttfbMs >= thresholds.ttfbMsWarn) ||
        perf.domNodes >= thresholds.domNodesWarn
      ) {
        await record({
          severity: "low",
          category: "performance",
          title: `Performance warning on ${pathname}`,
          detail: `load=${perf.loadMs}ms ttfb=${perf.ttfbMs}ms domNodes=${perf.domNodes}.`,
          role,
          url: finalUrl,
          area,
          repro: [`Sign in as ${role}`, `Open ${target}`],
          meta: { ...perf },
          fingerprint: fingerprint(["performance", area]),
        });
      }
    }

    // --- accessibility ---
    const a11y = await runA11y(page).catch(() => null);
    if (a11y) {
      const issues: string[] = [];
      if (!a11y.hasLang) issues.push("missing <html lang>");
      if (!a11y.hasTitle) issues.push("missing/empty <title>");
      if (!a11y.hasH1) issues.push("no <h1> landmark");
      if (a11y.imagesNoAlt >= thresholds.imagesNoAltWarn)
        issues.push(`${a11y.imagesNoAlt} image(s) without alt`);
      if (a11y.controlsNoName >= thresholds.controlsNoNameWarn)
        issues.push(`${a11y.controlsNoName} button/link(s) without accessible name`);
      if (a11y.inputsNoLabel >= thresholds.inputsNoLabelWarn)
        issues.push(`${a11y.inputsNoLabel} form field(s) without a label`);
      if (a11y.duplicateIds > 0) issues.push(`${a11y.duplicateIds} duplicate id(s)`);
      if (issues.length) {
        await record({
          severity: "low",
          category: "accessibility",
          title: `Accessibility issues on ${pathname}`,
          detail: issues.join("; "),
          role,
          url: finalUrl,
          area,
          repro: [`Sign in as ${role}`, `Open ${target}`, `Run an a11y audit`],
          logs: a11y.samples,
          meta: { ...a11y, samples: undefined },
          fingerprint: fingerprint(["accessibility", area]),
        });
      }
    }

    // --- discover more links ---
    if (depth < crawlCfg.maxDepth) {
      const hrefs = await page
        .$$eval("a[href]", (els) => els.map((e) => (e as HTMLAnchorElement).href))
        .catch(() => [] as string[]);
      for (const href of hrefs) {
        let next: URL;
        try {
          next = new URL(href);
        } catch {
          continue;
        }
        if (next.origin !== origin) continue;
        if (isDenied(next.pathname + next.search)) continue;
        if (!inScope(next.pathname, scopePrefixes)) continue;
        if (visited.has(next.pathname)) continue;
        if (queue.some((q) => q.path === next.pathname + next.search)) continue;
        queue.push({ path: next.pathname + next.search, depth: depth + 1, from: pathname });
      }
    }
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
function dedupeNet<T extends { url: string; status: number; method: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of arr) {
    const k = `${f.method} ${shortPath(f.url)} ${f.status}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}
function shortPath(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}
function firstLine(s: string): string {
  return s.split("\n")[0].slice(0, 200);
}
