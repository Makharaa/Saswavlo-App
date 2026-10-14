import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listRouteCities } from "@/lib/repository";
import { logOperationError } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin" && !user.canUseRoutes) {
    return NextResponse.json(
      { error: "მარშრუტებზე წვდომა ადმინისტრატორის მიერ შეზღუდულია." },
      { status: 403 }
    );
  }

  const publishedOnly = user.role !== "admin" || new URL(request.url).searchParams.get("published") === "1";

  try {
    const cities = await listRouteCities(publishedOnly);
    return NextResponse.json({ cities }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logOperationError("route-cities", error);
    return NextResponse.json({ error: "ქალაქების ჩატვირთვა ვერ მოხერხდა." }, { status: 500 });
  }
}
