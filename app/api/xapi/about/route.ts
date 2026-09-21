import { NextResponse } from "next/server";

/**
 *   GET /api/xapi/about
 *
 * xAPI "About" resource. TinCan.js-based players (Storyline, Rise, Captivate,
 * iSpring exports launched from tincan.xml) probe this before their first
 * statement to negotiate the API version; a 404 makes some of them refuse to
 * start tracking. Public by spec — it discloses nothing about learners.
 */
export function GET() {
  return NextResponse.json(
    { version: ["1.0.3", "1.0.2", "1.0.1", "1.0.0"] },
    { headers: { "X-Experience-API-Version": "1.0.3" } }
  );
}
