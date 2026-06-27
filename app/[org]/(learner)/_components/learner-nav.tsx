"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Learner top-nav (desktop) with an active state — previously plain links with
 * no current-page indication. Matches the admin sidebar treatment (accent pill
 * + aria-current) for a consistent navigation language across roles.
 */
export function LearnerTopNav({ orgSlug }: { orgSlug: string }) {
  const pathname = usePathname();
  const items = [
    { href: `/${orgSlug}/dashboard`, label: "Dashboard" },
    { href: `/${orgSlug}/courses`, label: "Courses" },
    { href: `/${orgSlug}/support`, label: "Help & Support" },
  ];
  return (
    <nav className="hidden md:flex items-center gap-1 text-sm">
      {items.map((it) => {
        const active =
          pathname === it.href || pathname.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={[
              "px-3 py-2 rounded-lg transition-colors",
              active
                ? "bg-accent/10 text-accent font-semibold"
                : "text-muted hover:text-ink hover:bg-canvas",
            ].join(" ")}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
