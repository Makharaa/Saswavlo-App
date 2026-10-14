import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  lng: z.number().finite().min(-180).max(180),
  lat: z.number().finite().min(-90).max(90),
  heading: z.number().finite().min(0).max(360).optional(),
  radiusMeters: z.number().finite().min(5).max(60).optional(),
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
    return NextResponse.json({ error: "კოორდინატი არასწორია." }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const base = `${routingBase()}/nearest/v1/driving/${input.lng},${input.lat}`;
    const radius = Math.round(input.radiusMeters ?? 24);

    async function requestNearest(withBearing: boolean) {
      const params = new URLSearchParams({
        number: "1",
        radiuses: String(radius),
      });

      if (withBearing && input.heading != null) {
        params.set("bearings", `${Math.round(input.heading)},65`);
      }

      return fetch(`${base}?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: { "User-Agent": "DriveExam/29" },
      });
    }

    let response = await requestNearest(input.heading != null);

    // Near a sharp turn/roundabout a strict heading may briefly find no edge.
    // Retry locally without bearing, still inside the same small search radius.
    if (!response.ok && input.heading != null) {
      response = await requestNearest(false);
    }

    if (!response.ok) {
      return NextResponse.json(
        { error: "Routing სერვერმა ახლომდებარე გზა ვერ იპოვა." },
        { status: 502 }
      );
    }

    const body = await response.json();
    const waypoint = body?.waypoints?.[0];
    const lng = Number(waypoint?.location?.[0]);
    const lat = Number(waypoint?.location?.[1]);
    const distance = Number(waypoint?.distance);

    if (body?.code !== "Ok" || !Number.isFinite(lng) || !Number.isFinite(lat) ||
      Math.abs(lng) > 180 || Math.abs(lat) > 90 || !Number.isFinite(distance) || distance < 0 || distance > radius) {
      return NextResponse.json(
        { error: "Routing სერვერმა არასწორი წერტილი დააბრუნა." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      coordinate: [lng, lat],
      distance,
      hint: typeof waypoint?.hint === "string" ? waypoint.hint : undefined,
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
      { error: "გზაზე მიბმა დროებით ვერ შესრულდა." },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
