import type { ReactNode } from "react";
import { requireRouteAccess } from "@/lib/auth";

export default async function DriveLayout({ children }: { children: ReactNode }) {
  await requireRouteAccess();
  return children;
}
