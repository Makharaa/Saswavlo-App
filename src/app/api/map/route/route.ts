import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { haversineMeters, routeLengthMeters } from "@/utils/geo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const coordinateSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

const schema = z.object({
  waypoints: z.array(coordinateSchema).min(2).max(80),
  radiuses: z.array(z.number().finite().min(1).max(12)).optional(),
  bearings: z.array(z.object({
    bearing: z.number().finite().min(0).max(360),
    tolerance: z.number().finite().min(0).max(180),
  }).nullable()).optional(),
  hints: z.array(z.string().max(1024).nullable()).optional(),
}).superRefine((input, ctx) => {
  for (const key of ["radiuses", "bearings", "hints"] as const) {
    if (input[key] && input[key].length !== input.waypoints.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "One option is required per waypoint" });
    }
  }
});

function routingBase() {
  return (
    process.env.ROUTING_BASE_URL?.replace(/\/+$/, "") ||
    "https://router.project-osrm.org"
  );
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "საყრდენი წერტილები არასწორია." },
      { status: 400 }
    );
  }

  const coords = input.waypoints
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(";");
  const params = new URLSearchParams({
    overview: "full", geometries: "geojson", steps: "false", continue_straight: "true",
    radiuses: (input.radiuses ?? input.waypoints.map(() => 3)).join(";"),
  });
  // Bearings describe a known road tangent, not a turn instruction. A chord
  // between sparse anchors can point at another carriageway at a left turn.
  if (input.bearings) params.set("bearings", input.bearings.map((b) => b ? `${Math.round(b.bearing) % 360},${b.tolerance}` : "").join(";"));
  if (input.hints) params.set("hints", input.hints.map((hint) => hint ?? "").join(";"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(
      `${routingBase()}/route/v1/driving/${coords}?${params.toString()}`,
      {
        cache: "no-store",
        signal: controller.signal,
        headers: { "User-Agent": "DriveExam/16" },
      }
    );

    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      if (failure?.code === "NoRoute" || failure?.code === "NoSegment") {
        return NextResponse.json(
          { error: "არჩეულ წერტილებს შორის გზა ვერ შეერთდა. გადაამოწმე მონიშვნები, მოძრაობის მიმართულება და მოხვევის დასაშვებობა." },
          { status: 422 }
        );
      }
      return NextResponse.json(
        { error: "Routing სერვერმა მარშრუტი ვერ ააგო." },
        { status: 502 }
      );
    }

    const body = await response.json();
    const matchedWaypoints = body?.waypoints;
    if (body?.code !== "Ok" || !Array.isArray(matchedWaypoints) || matchedWaypoints.length !== input.waypoints.length) {
      return NextResponse.json(
        { error: "რუკამ საყრდენი წერტილები ვერ დაამთხვია. გადაამოწმე მონიშვნები." },
        { status: 502 }
      );
    }
    const misplacedAnchor = matchedWaypoints.some((waypoint: { location?: unknown }, i: number) => {
      const location = coordinateSchema.safeParse(waypoint?.location);
      if (!location.success) return true;
      return haversineMeters(
        { lng: input.waypoints[i][0], lat: input.waypoints[i][1] },
        { lng: location.data[0], lat: location.data[1] }
      ) > (input.radiuses?.[i] ?? 3);
    });
    if (misplacedAnchor) {
      return NextResponse.json(
        { error: "საყრდენი წერტილი ახლომდებარე სხვა გზას ემთხვევა. მონიშნე უფრო ზუსტად." },
        { status: 422 }
      );
    }
    const geometry = body?.routes?.[0]?.geometry?.coordinates;

    if (!Array.isArray(geometry) || geometry.length < 2 || geometry.length > 20_000) {
      return NextResponse.json(
        { error: "Routing სერვერმა არასწორი geometry დააბრუნა." },
        { status: 502 }
      );
    }

    const parsedGeometry = z.array(coordinateSchema).safeParse(geometry);
    if (!parsedGeometry.success) {
      return NextResponse.json(
        { error: "მარშრუტის geometry ვერ დამუშავდა." },
        { status: 502 }
      );
    }
    const coordinates = parsedGeometry.data;

    return NextResponse.json({
      coordinates,
      distanceMeters: routeLengthMeters(coordinates),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        { error: "Routing სერვერმა დროულად არ უპასუხა." },
        { status: 504 }
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "გზაზე მარშრუტის აგება დროებით ვერ შესრულდა." },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
