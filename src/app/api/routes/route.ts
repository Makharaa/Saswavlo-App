import { logOperationError } from "@/lib/logger";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createRoute, listRoutes } from "@/lib/repository";
import { getCurrentUser } from "@/lib/auth";
import { checkRouteReadQuota } from "@/lib/api-rate-limit";
import { normalizeSpeedZones, validateRoute } from "@/utils/route-engine";
import { downsampleCoordinates } from "@/utils/geo";
import { validWaypointCoordinateIndices } from "@/utils/route-editor";
import type { ExamRoute, RouteDraft } from "@/types/domain";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const coordinateSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

const checkpointSchema = z.object({
  orderIndex: z.number().int().nonnegative().optional(),
  lng: z.number().finite().min(-180).max(180),
  lat: z.number().finite().min(-90).max(90),
  type: z.enum(["straight", "left", "right", "stop", "speed", "warning"]),
  title: z.string().max(500),
  voice: z.string().max(500),
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

const createSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  isPublished: z.boolean().optional(),
  fieldTestedAt: z.string().datetime().nullable().optional(),
  waypoints: z.array(coordinateSchema).max(500).optional(),
  waypointCoordinateIndices: z.array(z.number().int().nonnegative()).max(500).optional(),
  coordinates: z.array(coordinateSchema).max(20_000).optional(),
  speedZones: z.array(speedZoneSchema).max(100).optional(),
  checkpoints: z.array(checkpointSchema).max(300).optional(),
}).superRefine((input, ctx) => {
  if (input.waypointCoordinateIndices && !validWaypointCoordinateIndices({
    waypoints: input.waypoints ?? [], coordinates: input.coordinates ?? [],
    waypointCoordinateIndices: input.waypointCoordinateIndices,
  })) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["waypointCoordinateIndices"], message: "საყრდენების ინდექსები გზას არ ემთხვევა." });
});

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin" && !user.canUseRoutes) {
    return NextResponse.json(
      { error: "მარშრუტებზე წვდომა ადმინისტრატორის მიერ შეზღუდულია.", code: "ROUTE_ACCESS_DISABLED" },
      { status: 403 }
    );
  }

  try {
    const url = new URL(request.url);
    // Drivers can never bypass published-only filtering by changing the URL.
    const publishedOnly =
      user.role !== "admin" || url.searchParams.get("published") === "1";
    const city = url.searchParams.get("city")?.trim() || undefined;

    if (user.role !== "admin" && !(await checkRouteReadQuota(user.id, "list"))) {
      return NextResponse.json({ error: "ხშირი მოთხოვნებია. ცოტა ხანში სცადეთ." },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
    }
    const routes = await listRoutes({ publishedOnly, city });
    // Catalog browsing must not leak every published route's complete geometry.
    const result = user.role === "admin" ? routes : routes.map((route) => ({
      id: route.id, name: route.name, city: route.city,
      description: route.description, version: route.version,
      isPublished: route.isPublished, checkpointCount: route.checkpoints.length,
    }));
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logOperationError("routes", error);
    return NextResponse.json(
      { error: "მარშრუტების ჩატვირთვა ვერ მოხერხდა." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const input = createSchema.parse(await request.json());
    const draft: RouteDraft = {
      name: input.name || "გორი • ახალი მარშრუტი",
      city: input.city || "გორი",
      description: input.description || "",
      isPublished: Boolean(input.isPublished),
      fieldTestedAt: input.fieldTestedAt ?? null,
      waypoints:
        input.waypoints ||
        (input.coordinates ? downsampleCoordinates(input.coordinates, 500) : []),
      coordinates: input.coordinates || [],
      waypointCoordinateIndices: input.waypointCoordinateIndices,
      speedZones: normalizeSpeedZones(
        input.speedZones || [],
        input.coordinates || []
      ),
      checkpoints: (input.checkpoints || []).map((checkpoint, index) => ({
        ...checkpoint,
        orderIndex: index,
      })),
    };

    if (draft.isPublished) {
      const issues = validateRoute({
        ...draft,
        version: 1,
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

    const created = await createRoute(draft, user.id);
    if (created?.id) {
      await writeAuditLog({
        actorUserId: user.id,
        action: "route.created",
        entityType: "route",
        entityId: created.id,
        summary: `შეიქმნა მარშრუტი: ${created.name}`,
        metadata: { city: created.city, published: created.isPublished },
      });
    }
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    logOperationError("routes", error);
    return NextResponse.json(
      { error: "მარშრუტის შექმნა ვერ მოხერხდა." },
      { status: 400 }
    );
  }
}
