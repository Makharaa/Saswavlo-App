import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getRoute,
  getRouteVersionSnapshot,
  findDrivingSessionId,
  listDrivingSessions,
  listDrivingSessionsPage,
  listDrivingSessionFilterOptions,
  saveDrivingSession,
} from "@/lib/repository";
import { getCurrentUser } from "@/lib/auth";
import { readHistoryOptions } from "@/lib/history-page-query";
import { logOperationError } from "@/lib/logger";
import { normalizeDrivingSession } from "@/utils/session-normalizer";
import { sessionSchema } from "@/utils/session-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "ანგარიშში შესვლა საჭიროა." }, { status: 401 });

  try {
    const url = new URL(request.url);
    const mineOnly = url.searchParams.get("scope") === "mine";
    const ownerId = user.role === "admin" && !mineOnly ? undefined : user.id;
    const view = url.searchParams.get("view");
    if (view === "filters") {
      return NextResponse.json(await listDrivingSessionFilterOptions(ownerId), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (view === "page") {
      const options = readHistoryOptions(url.searchParams, user.role === "admin" && !mineOnly);
      const { size, page, ...filters } = options;
      return NextResponse.json(await listDrivingSessionsPage(filters, size, page, ownerId), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const requestedLimit = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
      : 50;
    const requestedOffset = Number(url.searchParams.get("offset") || 0);
    const offset = Number.isFinite(requestedOffset)
      ? Math.max(0, Math.min(1_000_000, Math.floor(requestedOffset)))
      : 0;
    return NextResponse.json(await listDrivingSessions(limit, ownerId, offset), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    logOperationError("sessions.list", error);
    return NextResponse.json(
      { error: "სესიების ჩატვირთვა ვერ მოხერხდა." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role !== "admin" && !user.canUseRoutes) {
    return NextResponse.json(
      { error: "მარშრუტებზე წვდომა ადმინისტრატორის მიერ შეზღუდულია.", code: "ROUTE_ACCESS_DISABLED" },
      { status: 403 }
    );
  }

  try {
    const payload = await request.text();
    if (payload.length > 12_000_000) return NextResponse.json({ error: "სესიის ჩანაწერი ზედმეტად დიდია." }, { status: 413 });
    const body = sessionSchema.parse(JSON.parse(payload));

    const existing = await findDrivingSessionId(user.id, body.clientSessionId);
    if (existing != null) return NextResponse.json({ id: existing, duplicate: true }, { status: 200 });

    if (body.routeId == null && user.role !== "admin") return NextResponse.json({ error: "შედეგი დამატებულ მარშრუტს უნდა უკავშირდებოდეს." }, { status: 422 });
    if (body.routeId != null) {
      const route = await getRoute(body.routeId);
      if (!route) {
        return NextResponse.json(
          { error: "მარშრუტი ვერ მოიძებნა." },
          { status: 404 }
        );
      }
      if (body.routeVersion != null && body.routeVersion > route.version) {
        return NextResponse.json({ error: "მარშრუტის ვერსია არასწორია." }, { status: 400 });
      }
      const routeVersion = body.routeVersion ?? route.version;
      const snapshot = await getRouteVersionSnapshot(body.routeId, routeVersion);
      if (!snapshot) {
        return NextResponse.json(
          { error: "სესიის მარშრუტის ვერსია ვერ მოიძებნა." },
          { status: 409 }
        );
      }
      if (user.role !== "admin" && !snapshot.isPublished) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const saved = await saveDrivingSession(
        normalizeDrivingSession({ ...body, routeVersion }, snapshot),
        user.id
      );
      return NextResponse.json(saved, { status: 201 });
    }

    const saved = await saveDrivingSession(normalizeDrivingSession(body), user.id);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "სესიის მონაცემები არასწორია." }, { status: 400 });
    logOperationError("sessions.save", error);
    return NextResponse.json(
      { error: "სესიის შენახვა ვერ მოხერხდა." },
      { status: 500 }
    );
  }
}
