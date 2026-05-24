"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, User, LifeBuoy, BookOpen } from "lucide-react";

export function MobileBottomNav({
  orgSlug,
  brandColor = "#4f46e5",
}: {
  orgSlug: string;
  brandColor?: string;
}) {
  const pathname = usePathname();
  const isActive = (suffix: string) =>
    pathname?.startsWith(`/${orgSlug}${suffix}`) ?? false;

  const items = [
    {
      href: `/${orgSlug}/dashboard`,
      icon: Home,
      label: "Home",
      active: isActive("/dashboard"),
    },
    {
      href: `/${orgSlug}/courses`,
      icon: BookOpen,
      label: "Courses",
      active: pathname?.includes(`/${orgSlug}/courses`) ?? false,
    },
    {
      href: `/${orgSlug}/profile`,
      icon: User,
      label: "Profile",
      active: isActive("/profile"),
    },
    {
      href: `/${orgSlug}/support`,
      icon: LifeBuoy,
      label: "Help",
      active: isActive("/support"),
    },
  ];

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-line bg-paper backdrop-blur-md">
      <div className="flex justify-around px-2 py-2">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors ${
                item.active ? "" : "text-muted hover:text-ink"
              }`}
              style={item.active ? { color: brandColor } : undefined}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
