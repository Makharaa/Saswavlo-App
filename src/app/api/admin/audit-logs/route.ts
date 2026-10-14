import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { listAuditLogs } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const entitySchema = z.enum(["route", "user", "session", "system"]);

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const limitValue = Number(url.searchParams.get("limit") || 200);
    const rawEntity = url.searchParams.get("entityType");
    const entityType = rawEntity ? entitySchema.parse(rawEntity) : undefined;

    const logs = await listAuditLogs({
      limit: Number.isFinite(limitValue) ? limitValue : 200,
      action: url.searchParams.get("action") || undefined,
      entityType,
      query: url.searchParams.get("query") || undefined,
    });

    return NextResponse.json(logs, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "აუდიტის ისტორია ვერ ჩაიტვირთა." },
      { status: 400 }
    );
  }
}
