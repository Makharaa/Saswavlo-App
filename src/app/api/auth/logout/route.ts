import { NextResponse } from "next/server";
import {
  clearSessionCookie,
  invalidateCurrentSession,
} from "@/lib/auth";

export async function POST() {
  try {
    await invalidateCurrentSession();
  } catch (error) {
    console.error("Session invalidation during logout failed:", error);
  }

  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
