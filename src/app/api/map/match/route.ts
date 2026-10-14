import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { logOperationError } from "@/lib/logger";
import { parseRoadTraceMatch, validRoadMatchFixes } from "@/utils/road-trace-match";
import type { RoadMatchFix } from "@/utils/road-trace-match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const input = await request.json().catch(() => null);
  if (!validRoadMatchFixes(input?.samples) || (input.hints != null &&
      (!Array.isArray(input.hints) || input.hints.length !== input.samples.length ||
       input.hints.some((h: unknown) => h != null && (typeof h !== "string" || h.length > 1024))))) {
    return NextResponse.json({ error: "GPS ჩანაწერის წერტილები არასწორია." }, { status: 400 });
  }
  const samples: RoadMatchFix[] = input.samples;
  const params = new URLSearchParams({ steps: "true", geometries: "geojson", overview: "full", gaps: "split", tidy: "false",
    timestamps: samples.map(s => Math.floor(s.timestamp / 1000)).join(";"),
    radiuses: samples.map(s => Math.max(5, Math.min(25, s.accuracy ?? 5))).join(";") });
  if (input.hints) params.set("hints", input.hints.map((h: string | null) => h ?? "").join(";"));
  const base = process.env.ROUTING_BASE_URL?.replace(/\/+$/, "") || "https://router.project-osrm.org";
  const coordinates = samples.map(s => `${s.lng},${s.lat}`).join(";");
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, 8_000);
  try {
    const response = await fetch(`${base}/match/v1/driving/${coordinates}?${params}`, {
      signal: controller.signal, cache: "no-store", headers: { "User-Agent": "DriveExam/R35" },
    });
    const body = await response.json();
    if (!response.ok || body?.code !== "Ok") {
      return NextResponse.json({ error: "გზის განშტოება ჯერ ვერ დადასტურდა — GPS ჩანაწერი შენარჩუნებულია." }, { status: 422 });
    }
    return NextResponse.json(parseRoadTraceMatch(body, samples), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (controller.signal.aborted) return NextResponse.json({ error: "გზაზე მიბმის პასუხი დაგვიანდა — GPS ჩანაწერი შენარჩუნებულია." }, { status: 504 });
    logOperationError("map.match", error);
    return NextResponse.json({ error: "გზაზე მიბმა დროებით მიუწვდომელია — GPS ჩანაწერი შენარჩუნებულია." }, { status: 502 });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
