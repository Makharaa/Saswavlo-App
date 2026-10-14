import { logOperationError } from "@/lib/logger";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validWaypointCoordinateIndices } from "@/utils/route-editor";
import {
  deleteRoute,
  getRoute,
  RouteVersionConflictError,
  saveRoute,
} from "@/lib/repository";
import { getCurrentUser } from "@/lib/auth";
import { checkRouteReadQuota } from "@/lib/api-rate-limit";
import { normalizeSpeedZones, validateRoute } from "@/utils/route-engine";
import type { ExamRoute } from "@/types/domain";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const coordinateSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

const checkpointSchema = z.object({
  id: z.number().optional(),
  routeId: z.number().optional(),
  orderIndex: z.number().int().nonnegative(),
  lng: z.number().finite().min(-180).max(180),
  lat: z.number().finite().min(-90).max(90),
  type: z.enum(["straight", "left", "right", "stop", "speed", "warning"]),
  title: z.string().trim().max(500),
  voice: z.string().trim().max(500),
  ttsVoice: z.enum(["ka-GE-EkaNeural", "ka-GE-GiorgiNeural"]),
  speedLimit: z.number().int().min(5).max(130).nullable(),
  triggerMeters: z.number().int().min(10).max(1000),
  routeCoordinateIndex: z.number().int().nonnegative().nullable().optional(),
  evaluation: z.object({ instructionOnly: z.boolean().optional(), stopSeconds: z.number().min(1).max(10).optional(), stopRadiusMeters: z.number().min(5).max(25).optional(), departureMeters: z.number().min(5).max(40).optional() }).optional(),
});

const speedZoneSchema = z.object({
  id: z.string().min(1).max(80),
  startCoordinateIndex: z.number().int().nonnegative().optional(),
  endCoordinateIndex: z.number().int().nonnegative().optional(),
  // Legacy percentage fields are accepted only so old route-version snapshots
  // can still be restored; new clients no longer use percentages.
  startPercent: z.number().finite().min(0).max(100).optional(),
  endPercent: z.number().finite().min(0).max(100).optional(),
  speedLimit: z.number().int().min(5).max(130),
  label: z.string().max(120),
}).refine(
  (zone) =>
    (zone.startCoordinateIndex != null && zone.endCoordinateIndex != null) ||
    (zone.startPercent != null && zone.endPercent != null),
  { message: "სიჩქარის ზონის დასაწყისი და დასასრული აუცილებელია." }
);

const routeSchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(180),
  city: z.string().trim().min(1).max(120),
  description: z.string().max(2000),
  isPublished: z.boolean(),
  fieldTestedAt: z.string().datetime().nullable().optional(),
  waypoints: z.array(coordinateSchema).max(500),
  waypointCoordinateIndices: z.array(z.number().int().nonnegative()).max(500).optional(),
  coordinates: z.array(coordinateSchema).max(20_000),
  speedZones: z.array(speedZoneSchema).max(100),
  checkpoints: z.array(checkpointSchema).max(300),
}).superRefine((input, ctx) => {
  if (input.waypointCoordinateIndices && !validWaypointCoordinateIndices(input)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["waypointCoordinateIndices"], message: "საყრდენების ინდექსები გზას არ ემთხვევა." });
  }
});

function routeId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin" && !user.canUseRoutes) {
    return NextResponse.json(
      { error: "მარშრუტებზე წვდომა ადმინისტრატორის მიერ შეზღუდულია.", code: "ROUTE_ACCESS_DISABLED" },
      { status: 403 }
    );
  }

  try {
    const params = await context.params;
    const id = routeId(params.id);
    if (!id) return NextResponse.json({ error: "Invalid route" }, { status: 400 });

    const route = await getRoute(id);
    if (!route) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!route.isPublished && user.role !== "admin") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (user.role !== "admin" && !(await checkRouteReadQuota(user.id, "detail"))) {
      return NextResponse.json({ error: "ხშირი მოთხოვნებია. ცოტა ხანში სცადეთ." },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
    }
    return NextResponse.json(route, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logOperationError("routes.[id]", error);
    return NextResponse.json({ error: "მარშრუტი ვერ ჩაიტვირთა." }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const params = await context.params;
    const id = routeId(params.id);
    if (!id) return NextResponse.json({ error: "Invalid route" }, { status: 400 });

    const input = routeSchema.parse(await request.json());
    const draft = {
      name: input.name,
      city: input.city,
      description: input.description,
      isPublished: input.isPublished,
      fieldTestedAt: input.fieldTestedAt ?? null,
      waypoints: input.waypoints,
      waypointCoordinateIndices: input.waypointCoordinateIndices,
      coordinates: input.coordinates,
      speedZones: normalizeSpeedZones(input.speedZones, input.coordinates),
      checkpoints: input.checkpoints.map((checkpoint, index) => ({
        ...checkpoint,
        orderIndex: index,
      })),
    };

    if (draft.isPublished) {
      const issues = validateRoute({
        ...draft,
        id,
        version: input.expectedVersion,
      } as ExamRoute);
      const errors = issues.filter((issue) => issue.level === "error");
      if (errors.length) {
        return NextResponse.json(
          {
            error: "მარშრუტს გამოქვეყნებამდე გასასწორებელი შეცდომები აქვს.",
            code: "ROUTE_VALIDATION_FAILED",
            issues: errors,
          },
          { status: 422 }
        );
      }
    }

    const saved = await saveRoute(id, draft, user.id, input.expectedVersion);
    if (saved) {
      await writeAuditLog({
        actorUserId: user.id,
        action: saved.isPublished !== Boolean(input.isPublished) ? "route.updated" : "route.updated",
        entityType: "route",
        entityId: id,
        summary: `შეინახა მარშრუტი: ${saved.name}`,
        metadata: {
          version: saved.version,
          published: saved.isPublished,
          checkpoints: saved.checkpoints.length,
          speedZones: saved.speedZones.length,
        },
      });
    }
    return NextResponse.json(saved);
  } catch (error) {
    if (error instanceof RouteVersionConflictError) {
      return NextResponse.json(
        {
          error: "მარშრუტი სხვა ჩანართში ან სხვა ადმინისტრატორმა უკვე შეცვალა.",
          code: "ROUTE_VERSION_CONFLICT",
          currentVersion: error.currentVersion,
        },
        { status: 409 }
      );
    }

    logOperationError("routes.[id]", error);
    return NextResponse.json(
      { error: "მარშრუტის შენახვა ვერ მოხერხდა." },
      { status: 400 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const params = await context.params;
    const id = routeId(params.id);
    if (!id) return NextResponse.json({ error: "Invalid route" }, { status: 400 });

    const url = new URL(request.url);
    const rawExpectedVersion = url.searchParams.get("expectedVersion");
    const expectedVersion = Number(rawExpectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      return NextResponse.json(
        { error: "მარშრუტის მიმდინარე ვერსია აუცილებელია." },
        { status: 400 }
      );
    }

    const beforeDelete = await getRoute(id);
    const deleted = await deleteRoute(id, expectedVersion);
    if (!deleted) {
      return NextResponse.json({ error: "მარშრუტი ვერ მოიძებნა." }, { status: 404 });
    }

    await writeAuditLog({
      actorUserId: user.id,
      action: "route.deleted",
      entityType: "route",
      entityId: id,
      summary: `წაიშალა მარშრუტი: ${beforeDelete?.name || `#${id}`}`,
      metadata: { version: expectedVersion },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RouteVersionConflictError) {
      return NextResponse.json(
        {
          error: "მარშრუტი შენს გახსნის შემდეგ შეიცვალა. წაშლამდე განაახლე მისი ვერსია.",
          code: "ROUTE_VERSION_CONFLICT",
          currentVersion: error.currentVersion,
        },
        { status: 409 }
      );
    }

    logOperationError("routes.[id]", error);
    return NextResponse.json({ error: "მარშრუტის წაშლა ვერ მოხერხდა." }, { status: 500 });
  }
}
