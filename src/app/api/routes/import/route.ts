import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";
import { logOperationError } from "@/lib/logger";
import { importBundledRoute } from "@/lib/route-imports";
import { importCityRoute } from "@/lib/city-route-imports";
import { isCityRouteSource } from "@/lib/city-route-catalog";

import { BUNDLED_ROUTE_SOURCES, type BundledRouteSource } from "@/lib/route-import-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const importSchema = z.object({ source: z.string().trim().min(1).max(180) }).strict();

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let input: z.infer<typeof importSchema>;
  try {
    input = importSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "აირჩიე ხელმისაწვდომი მარშრუტი." }, { status: 400 });
  }

  const bundled = (BUNDLED_ROUTE_SOURCES as readonly string[]).includes(input.source);
  const cityRoute = isCityRouteSource(input.source);
  if (!bundled && !cityRoute) {
    return NextResponse.json({ error: "აირჩიე ხელმისაწვდომი მარშრუტი." }, { status: 400 });
  }

  try {
    const result = bundled
      ? await importBundledRoute(input.source as BundledRouteSource, user.id)
      : await importCityRoute(input.source, user.id);
    if (!result.reused) {
      try {
        await writeAuditLog({
          actorUserId: user.id,
          action: "route.imported",
          entityType: "route",
          entityId: result.route.id,
          summary: `შემოტანილია მარშრუტი: ${result.route.name}`,
          metadata: { source: input.source, city: result.route.city, published: false },
        });
      } catch (error) {
        // The route transaction has committed; audit failure must not tell
        // the client its successful import failed.
        logOperationError("route-import-audit", error);
      }
    }
    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    logOperationError("route-import", error);
    return NextResponse.json({ error: "მარშრუტის შემოტანა ვერ მოხერხდა. სცადე ხელახლა." }, { status: 500 });
  }
}
