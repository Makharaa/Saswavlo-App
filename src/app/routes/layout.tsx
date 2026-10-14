import type { ReactNode } from "react";
import { requireRouteAccess } from "@/lib/auth";

export default async function RoutesLayout({ children }: { children: ReactNode }) {
  await requireRouteAccess();
  return children;
}
