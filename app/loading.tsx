"use client";

import { usePathname } from "next/navigation";
import { FullScreenLoader } from "@/components/ui/brand-loader";
import { LaunchFrameLoader } from "@/components/ui/launch-frame-loader";

/**
 * Root loading boundary — the BLOCKING branded loader. It shows for app-level
 * waits only: the first load of any page, sign-in / session hand-off (/login,
 * /[org]/login, /select-org, /auth/finish, /change-password, /invitations).
 * Every in-app route group ((learner), (admin), super) has its own skeleton
 * boundary below this one, so in-app navigation never bubbles up here.
 *
 * One exception: a hard load (deep link, refresh) of a module launch URL —
 * the learner runtime must never sit behind a full-screen loader, so that
 * case shows the runtime's own frame with a small indicator instead.
 */
export default function RootLoading() {
  const pathname = usePathname();
  if (/\/courses\/[^/]+\/launch(\/|$)/.test(pathname ?? "")) return <LaunchFrameLoader />;
  return <FullScreenLoader />;
}
