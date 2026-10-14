import { NextResponse } from "next/server";
import { getCurrentSessionState } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await getCurrentSessionState();

  if (!state.user) {
    const code =
      state.reason === "session_replaced"
        ? "SESSION_REPLACED"
        : state.reason === "account_disabled"
          ? "ACCOUNT_DISABLED"
          : "UNAUTHORIZED";

    return NextResponse.json(
      { error: "Unauthorized", code },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { user: state.user },
    { headers: { "Cache-Control": "no-store" } }
  );
}
