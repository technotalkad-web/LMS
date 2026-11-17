import { redirect } from "next/navigation";
import { requirePlatformOwner } from "@/lib/auth/require-platform-owner";

export default async function SuperHome() {
  await requirePlatformOwner();
  redirect("/super/organizations");
}
