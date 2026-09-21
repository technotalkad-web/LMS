import { XMLParser } from "fast-xml-parser";
import type { ParsedManifest } from "./types";

/**
 * Parse a tincan.xml descriptor (standalone xAPI / "Tin Can" packages, as
 * exported by Articulate Storyline/Rise, Captivate, iSpring, Lectora and the
 * in-house KIVO engine in "LMS-provided xAPI" mode).
 *
 *   <tincan xmlns="http://projecttincan.com/tincan.xsd">
 *     <activities>
 *       <activity id="http://example.com/course/abc" type="http://adlnet.gov/expapi/activities/course">
 *         <name>Course Title</name>
 *         <description lang="en-US">…</description>
 *         <launch lang="en-US">index_lms.html</launch>
 *       </activity>
 *     </activities>
 *   </tincan>
 *
 * Unlike cmi5 there is no fetch handshake, no moveOn and no masteryScore:
 * the LMS hands the package `endpoint`, `auth`, `actor`, `activity_id` and
 * `registration` on the launch URL and the package talks to the LRS
 * directly. Completion is decided by completed / passed / failed statements
 * about the launched activity (see lib/xapi/process-statement.ts).
 */
export function parseTincanManifest(xml: string): ParsedManifest {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    isArray: (name) => name === "activity" || name === "launch",
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const tincan = (doc.tincan ?? {}) as Record<string, unknown>;
  const activities = (tincan.activities ?? {}) as Record<string, unknown>;
  const list = (activities.activity ?? []) as Array<Record<string, unknown>>;
  if (list.length === 0) {
    throw new Error("tincan.xml has no <activity> entries");
  }

  // The launchable activity: prefer one with a <launch>, else the first.
  const activity = list.find((a) => a.launch !== undefined) ?? list[0];
  const launchUrl = readText(firstOf(activity.launch));
  if (!launchUrl) {
    throw new Error("tincan.xml <activity> has no <launch> element");
  }

  const activityId = String(activity["@_id"] ?? "").trim();
  if (!activityId) {
    throw new Error("tincan.xml <activity> has no id attribute");
  }

  const title = readText(activity.name);
  const description = readText(activity.description);

  return {
    type: "xapi",
    title: title ?? "Untitled course",
    description,
    launchUrl,
    raw: {
      activityId,
      activityType: activity["@_type"],
      // Mirrors the cmi5 shape so shared code (launch params, statement
      // scoping) reads one field for both standards.
      courseId: activityId,
      activityCount: list.length,
    },
  };
}

function firstOf(node: unknown): unknown {
  return Array.isArray(node) ? node[0] : node;
}

function readText(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string" || typeof node === "number") {
    const s = String(node).trim();
    return s.length > 0 ? s : undefined;
  }
  if (Array.isArray(node)) return readText(node[0]);
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return readText((node as Record<string, unknown>)["#text"]);
  }
  return undefined;
}
