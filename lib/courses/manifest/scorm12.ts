import { XMLParser } from "fast-xml-parser";
import type { ParsedManifest } from "./types";

/**
 * Parse a SCORM 1.2 imsmanifest.xml string into our normalized manifest shape.
 *
 * SCORM 1.2 manifest structure (simplified):
 *   <manifest>
 *     <organizations default="ORG-ID">
 *       <organization identifier="ORG-ID">
 *         <title>Course Title</title>
 *         <item identifier="..." identifierref="RES-ID">
 *           <title>...</title>
 *           <adlcp:masteryscore>80</adlcp:masteryscore>
 *         </item>
 *       </organization>
 *     </organizations>
 *     <resources>
 *       <resource identifier="RES-ID" href="index.html" ... />
 *     </resources>
 *   </manifest>
 */
export function parseScorm12Manifest(xml: string): ParsedManifest {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    isArray: (name) => name === "item" || name === "resource" || name === "organization",
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const manifest = (doc.manifest ?? {}) as Record<string, unknown>;
  const orgsNode = (manifest.organizations ?? {}) as Record<string, unknown>;
  const defaultOrgId = (orgsNode["@_default"] as string | undefined) ?? "";
  const orgs = (orgsNode.organization ?? []) as Array<Record<string, unknown>>;

  const org =
    orgs.find((o) => (o["@_identifier"] as string) === defaultOrgId) ?? orgs[0];
  if (!org) throw new Error("SCORM manifest has no <organization>");

  const title = (org.title as string) ?? "Untitled course";

  // Find first <item> with an identifierref (SCO entry point).
  const items = (org.item ?? []) as Array<Record<string, unknown>>;
  const firstSco = findFirstScoItem(items);
  if (!firstSco) throw new Error("SCORM manifest has no <item identifierref=...>");

  const resourceId = firstSco["@_identifierref"] as string;
  const resources = ((manifest.resources as Record<string, unknown>)?.resource ??
    []) as Array<Record<string, unknown>>;
  const resource = resources.find(
    (r) => (r["@_identifier"] as string) === resourceId
  );
  if (!resource) {
    throw new Error(`SCORM manifest references missing resource ${resourceId}`);
  }
  const launchUrl = resource["@_href"] as string | undefined;
  if (!launchUrl) {
    throw new Error(`SCORM resource ${resourceId} has no href`);
  }

  // <adlcp:masteryscore>80</adlcp:masteryscore> — sometimes 0-100, sometimes 0-1.
  const rawMastery = firstSco.masteryscore as number | string | undefined;
  let masteryScore: number | undefined;
  if (rawMastery !== undefined) {
    const n = typeof rawMastery === "number" ? rawMastery : parseFloat(rawMastery);
    if (!Number.isNaN(n)) masteryScore = n > 1 ? n / 100 : n;
  }

  return {
    type: "scorm12",
    title: String(title).trim(),
    launchUrl: String(launchUrl).trim(),
    masteryScore,
    raw: {
      organizationId: org["@_identifier"],
      itemTitle: firstSco.title,
      resourceId,
    },
  };
}

function findFirstScoItem(
  items: Array<Record<string, unknown>>
): Record<string, unknown> | null {
  for (const item of items) {
    if (item["@_identifierref"]) return item;
    const children = (item.item ?? []) as Array<Record<string, unknown>>;
    const nested = findFirstScoItem(children);
    if (nested) return nested;
  }
  return null;
}
