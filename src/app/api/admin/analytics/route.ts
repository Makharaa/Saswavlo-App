import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAdminAnalytics } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return NextResponse.json(await getAdminAnalytics(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "ანალიტიკის ჩატვირთვა ვერ მოხერხდა." },
      { status: 500 }
    );
  }
}
