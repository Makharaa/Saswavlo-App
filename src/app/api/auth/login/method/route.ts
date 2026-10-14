import { NextResponse } from "next/server";
import { z } from "zod";
import { checkLoginRateLimit } from "@/lib/login-security";
import { findUserForLogin } from "@/lib/users";
import { isTrustedDevice } from "@/lib/pin-auth";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().trim().email().max(220) });
const headers = { "Cache-Control": "no-store" };

/**
 * Never reveal whether an email belongs to an account or whether an unknown
 * device's owner has configured a PIN. The only special case is a browser
 * presenting the matching, server-validated trusted-device cookie.
 */
export async function POST(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "მოთხოვნა დაბლოკილია." }, { status: 403, headers });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "შეამოწმე ელფოსტა." }, { status: 400, headers });
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "შეამოწმე ელფოსტა." }, { status: 400, headers });
  }

  try {
    const email = parsed.data.email.toLowerCase();
    const limit = await checkLoginRateLimit(email);
    if (limit.blocked) {
      return NextResponse.json({ error: "ძალიან ბევრი მცდელობაა. მოგვიანებით სცადე." }, {
        status: 429,
        headers: { ...headers, "Retry-After": String(limit.retryAfterSeconds) },
      });
    }

    const account = await findUserForLogin(email);
    const allowedPin = account?.role === "driver" && account.is_active && Boolean(account.pin_hash)
      && await isTrustedDevice(Number(account.id));

    return NextResponse.json({ method: allowedPin ? "pin" : "password" }, { headers });
  } catch (error) {
    console.error("Login method selection failed:", error);
    return NextResponse.json({ error: "შესვლის შემოწმება ვერ შესრულდა. სცადე თავიდან." }, {
      status: 500, headers,
    });
  }
}
