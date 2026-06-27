"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Admin sidebar nav link with an active state. Previously these were plain
 * links with no indication of the current page. Active = accent-tinted pill +
 * accent text + aria-current (keyboard/screen-reader affordance). Works in both
 * the desktop vertical sidebar and the mobile horizontal scroller.
 */
export function NavItem({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "shrink-0 md:block px-3 py-2 rounded-md transition-colors whitespace-nowrap",
        active
          ? "bg-accent/10 text-accent font-semibold"
          : "text-muted hover:bg-canvas hover:text-ink",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}
