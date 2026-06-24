/**
 * Helpers for scripted journeys. A "step" asserts an expected outcome; on
 * failure it records a `journey` finding (with screenshot) and soft-fails so
 * the run continues and the report stays the single source of truth.
 */

import { expect, Page, Locator } from "@playwright/test";
import { record } from "./findings";
import type { BotRole } from "./types";

export interface StepCtx {
  page: Page;
  role: BotRole;
  area: string;
  /** Human reproduction lead-in, e.g. "Sign in as admin, open Users". */
  repro: string[];
}

/** Assert a locator is visible; record a finding if not. */
export async function expectVisible(
  ctx: StepCtx,
  locator: Locator,
  what: string,
  severity: "high" | "medium" = "medium"
): Promise<boolean> {
  try {
    await expect(locator).toBeVisible({ timeout: 10_000 });
    return true;
  } catch {
    await record({
      severity,
      category: "journey",
      title: `${what} not found (${ctx.area})`,
      detail: `Expected "${what}" to be visible for ${ctx.role} but it never appeared.`,
      role: ctx.role,
      url: ctx.page.url(),
      area: ctx.area,
      repro: [...ctx.repro, `Expect: ${what}`],
      page: ctx.page,
    });
    expect.soft(false, `${what} (${ctx.area})`).toBeTruthy();
    return false;
  }
}

/** Generic boolean assertion that records a finding on failure. */
export async function expectThat(
  ctx: StepCtx,
  condition: boolean,
  what: string,
  severity: "critical" | "high" | "medium" = "medium"
): Promise<void> {
  if (condition) return;
  await record({
    severity,
    category: "journey",
    title: `${what} (${ctx.area})`,
    detail: `Assertion failed for ${ctx.role}: ${what}.`,
    role: ctx.role,
    url: ctx.page.url(),
    area: ctx.area,
    repro: [...ctx.repro, `Expect: ${what}`],
    page: ctx.page,
  });
  expect.soft(condition, `${what} (${ctx.area})`).toBeTruthy();
}
