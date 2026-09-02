import { NextResponse } from "next/server";

/**
 *   POST /api/theme
 *   body: { theme: "light" | "dark" }
 *
 * Stores the user's theme preference in a long-lived cookie so the next
 * SSR render can set <html data-theme> before any client JS runs.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { theme?: string };
  const theme = body.theme === "dark" ? "dark" : "light";
  const res = NextResponse.json({ theme });
  res.cookies.set("theme", theme, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
