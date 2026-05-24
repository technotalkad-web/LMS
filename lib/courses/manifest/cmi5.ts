import { XMLParser } from "fast-xml-parser";
import type { ParsedManifest } from "./types";

/**
 * Parse a cmi5.xml course structure document.
 *
 * cmi5 structure (simplified — the full spec supports nested <block> trees):
 *   <courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
 *     <course id="urn:uuid:...">
 *       <title><langstring lang="en">Course Title</langstring></title>
 *       <description><langstring lang="en">...</langstring></description>
 *     </course>
 *     <au id="urn:uuid:..." moveOn="Passed" masteryScore="0.8">
 *       <title><langstring lang="en">AU Title</langstring></title>
 *       <url>index.html</url>
 *     </au>
 *   </courseStructure>
 */
export function parseCmi5Manifest(xml: string): ParsedManifest {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    isArray: (name) => name === "au" || name === "block" || name === "langstring",
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const cs = (doc.courseStructure ?? {}) as Record<string, unknown>;
  const course = (cs.course ?? {}) as Record<string, unknown>;

  const title = readLangString(course.title);
  const description = readLangString(course.description);

  // Find the first AU (Assignable Unit) — depth-first through <block> children.
  const firstAu = findFirstAu(cs);
  if (!firstAu) {
    throw new Error("cmi5 manifest has no <au> entries");
  }

  const launchUrl = String(firstAu.url ?? "").trim();
  if (!launchUrl) throw new Error("cmi5 <au> has no <url>");

  const masteryAttr = firstAu["@_masteryScore"];
  let masteryScore: number | undefined;
  if (masteryAttr !== undefined) {
    const n = typeof masteryAttr === "number" ? masteryAttr : parseFloat(String(masteryAttr));
    if (!Number.isNaN(n)) masteryScore = n;
  }

  return {
    type: "cmi5",
    title: title ?? "Untitled course",
    description,
    launchUrl,
    masteryScore,
    raw: {
      courseId: course["@_id"],
      auId: firstAu["@_id"],
      moveOn: firstAu["@_moveOn"],
      auTitle: readLangString(firstAu.title),
    },
  };
}

function readLangString(node: unknown): string | undefined {
  if (!node) return undefined;
  if (typeof node === "string") return node;
  const obj = node as Record<string, unknown>;
  const ls = obj.langstring;
  if (Array.isArray(ls) && ls.length > 0) {
    const first = ls[0];
    if (typeof first === "string") return first;
    if (typeof first === "object" && first && "#text" in first) {
      return String((first as Record<string, unknown>)["#text"]);
    }
  }
  if (typeof ls === "string") return ls;
  return undefined;
}

function findFirstAu(node: Record<string, unknown>): Record<string, unknown> | null {
  const aus = (node.au ?? []) as Array<Record<string, unknown>>;
  if (aus.length > 0) return aus[0];
  const blocks = (node.block ?? []) as Array<Record<string, unknown>>;
  for (const block of blocks) {
    const found = findFirstAu(block);
    if (found) return found;
  }
  return null;
}
