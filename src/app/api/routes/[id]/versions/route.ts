import { logOperationError } from "@/lib/logger";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  getRouteVersions,
  restoreRouteVersion,
  RouteVersionConflictError,
} from "@/lib/repository";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const restoreSchema = z.object({
  version: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
});

function validId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = await context.params;
  const id = validId(params.id);
  if (!id) return NextResponse.json({ error: "Invalid route" }, { status: 400 });

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") || 20);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(50, Math.floor(requestedLimit)))
    : 20;
  return NextResponse.json(await getRouteVersions(id, limit));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const params = await context.params;
    const id = validId(params.id);
    if (!id) return NextResponse.json({ error: "Invalid route" }, { status: 400 });

    const input = restoreSchema.parse(await request.json());
    const restored = await restoreRouteVersion(
      id,
      input.version,
      input.expectedVersion,
      user.id
    );

    if (!restored) {
      return NextResponse.json({ error: "ვერსია ვერ მოიძებნა." }, { status: 404 });
    }

    await writeAuditLog({
      actorUserId: user.id,
      action: "route.version_restored",
      entityType: "route",
      entityId: id,
      summary: `აღდგა მარშრუტის v${input.version} ვერსია`,
      metadata: { restoredVersion: input.version, newVersion: restored.version },
    });

    return NextResponse.json(restored);
  } catch (error) {
    if (error instanceof RouteVersionConflictError) {
      return NextResponse.json(
        {
          error: "მარშრუტი უკვე შეიცვალა. განაახლე გვერდი და თავიდან სცადე.",
          code: "ROUTE_VERSION_CONFLICT",
          currentVersion: error.currentVersion,
        },
        { status: 409 }
      );
    }

    logOperationError("routes.[id].versions", error);
    return NextResponse.json({ error: "ვერსიის აღდგენა ვერ მოხერხდა." }, { status: 400 });
  }
}
