import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import maplibrePackage from "maplibre-gl/package.json";
import { logOperationError } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let workerSource: Promise<string> | null = null;

function loadWorkerSource() {
  workerSource ??= readFile(
    join(process.cwd(), "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"),
    "utf8"
  ).catch((error) => {
    workerSource = null;
    throw error;
  });
  return workerSource;
}

/** Public upstream library code; no account or route data is exposed. */
export async function GET(request: Request) {
  const requestedVersion = new URL(request.url).searchParams.get("v");
  if (requestedVersion && requestedVersion !== maplibrePackage.version) {
    return NextResponse.json(
      { error: "რუკის ვერსია შეიცვალა. განაახლე გვერდი." },
      { status: 409, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    return new NextResponse(await loadWorkerSource(), {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": requestedVersion
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  } catch (error) {
    logOperationError("map.worker", error);
    return NextResponse.json(
      { error: "რუკის Worker ფაილი ვერ ჩაიტვირთა." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
