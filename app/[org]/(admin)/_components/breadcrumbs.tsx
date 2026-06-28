"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Admin breadcrumb trail. Purely additive wayfinding for deep pages
 * (e.g. Users › New, Reports › Course). Renders nothing on top-level pages —
 * those already carry an AdminPageHeader title — so existing layouts are
 * unaffected. Segment labels are humanized; id-like segments become "Details".
 */
const LABELS: Record<string, string> = {
  users: "Users",
  new: "New",
  library: "Library",
  upload: "Upload",
  "learning-paths": "Learning paths",
  reports: "Reports",
  announcements: "Announcements",
  teams: "Teams",
  tickets: "Tickets",
  settings: "Settings",
  notifications: "Broadcast",
};

function looksLikeId(seg: string): boolean {
  return /^[0-9a-f]{8,}$/i.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg) || /^\d+$/.test(seg);
}

function labelFor(seg: string): string {
  if (LABELS[seg]) return LABELS[seg];
  if (looksLikeId(seg)) return "Details";
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  // segments[0] is the org slug. Only show crumbs on sub-pages (depth >= 2
  // beyond the org), since top-level pages already have a page header.
  if (segments.length <= 2) return null;

  const org = segments[0];
  const rest = segments.slice(1);

  const crumbs = rest.map((seg, i) => {
    const href = `/${org}/${rest.slice(0, i + 1).join("/")}`;
    return { label: labelFor(seg), href, last: i === rest.length - 1 };
  });

  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-xs text-muted">
      <ol className="flex items-center flex-wrap gap-1.5">
        {crumbs.map((c) => (
          <li key={c.href} className="flex items-center gap-1.5">
            {c.last ? (
              <span aria-current="page" className="text-ink font-medium">
                {c.label}
              </span>
            ) : (
              <Link href={c.href} className="hover:text-ink transition-colors">
                {c.label}
              </Link>
            )}
            {!c.last && <span aria-hidden className="text-line">/</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
