import { logOperationError } from "@/lib/logger";
import { NextResponse } from "next/server";
import { getDrivingSession } from "@/lib/repository";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await context.params;
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return NextResponse.json({ error: "Invalid session" }, { status: 400 });
    }
    const session = await getDrivingSession(sessionId);
    if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (user.role !== "admin" && session.userId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(session);
  } catch (error) {
    logOperationError("sessions.[id]", error);
    return NextResponse.json({ error: "Session could not be loaded" }, { status: 500 });
  }
}
