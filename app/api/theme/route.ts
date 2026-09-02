import { NextResponse } from "next/server";
import {
  LEARNER_THEME_COOKIE,
  isLearnerTheme,
} from "@/lib/theme/learner-themes";

/**
 *   POST /api/theme
 *   body: { theme?: "light" | "dark", lms?: LearnerThemeId }
 *
 * Stores theme preferences in long-lived cookies so the next SSR render can
 * paint the right theme before any client JS runs:
 *  - `theme` → <html data-theme> (light/dark; used by the admin ThemePill)
 *  - `lms`   → the learner-view theme (one of the six learner themes,
 *              stamped as data-lms-theme on the learner shell)
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    theme?: string;
    lms?: string;
  };
  const res = NextResponse.json({ ok: true });
  const cookieOpts = {
    httpOnly: false,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };
  if (typeof body.theme === "string") {
    const theme = body.theme === "dark" ? "dark" : "light";
    res.cookies.set("theme", theme, cookieOpts);
  }
  if (isLearnerTheme(body.lms)) {
    res.cookies.set(LEARNER_THEME_COOKIE, body.lms, cookieOpts);
  }
  return res;
}
