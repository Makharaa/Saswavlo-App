import { NextResponse } from "next/server";
import { z } from "zod";
import {
  beginUserSession,
  ensureBootstrapAdmin,
  extractClientIp,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  recordLoginFailure,
} from "@/lib/login-security";
import { findUserForLogin } from "@/lib/users";
import { writeAuditLog } from "@/lib/audit";
import { clearPinFailures, isTrustedDevice, pinAttemptsBlocked, recordPinFailure, trustCurrentDevice, validPin, verifyPin } from "@/lib/pin-auth";

const schema = z.object({
  email: z.string().trim().email().max(220),
  method: z.enum(["password", "pin"]).default("password"),
  password: z.string().max(200).optional(),
  pin: z.string().max(4).optional(),
});

const DUMMY_PASSWORD_HASH =
  "scrypt$ZHJpdmVleGFtLWR1bW15LXNhbHQtMjAyNg$hbwYkJC6ThS1fEeProZGT2B-RE2JyAl-wqIvTgN-u4j7LqKPngzkjM9waswj1C4NCS9SXIUuSk7j5Vp6ia2Zeg";

function invalidCredentials() {
  return NextResponse.json(
    { error: "ელფოსტა ან პაროლი არასწორია." },
    { status: 401 }
  );
}

export async function POST(request: Request) {
  // Browsers send this header; deny cross-site login submissions, which can
  // otherwise set an unsuspecting person's browser to another user's session.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "მოთხოვნა სხვა საიტიდან დაიბლოკა." }, { status: 403 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "მოთხოვნის მონაცემები ვერ წაიკითხა." },
      { status: 400 }
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "შეამოწმე შესვლის მონაცემები." },
      { status: 400 }
    );
  }

  try {
    await ensureBootstrapAdmin();

    const input = parsed.data;
    const email = input.email.toLowerCase();
    const limit = await checkLoginRateLimit(email);

    if (limit.blocked) {
      return NextResponse.json(
        {
          error: "ძალიან ბევრი წარუმატებელი მცდელობაა. ცოტა ხანში თავიდან სცადე.",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSeconds) },
        }
      );
    }

    const row = await findUserForLogin(email);
    const pinEnabled = row?.role === "driver" && Boolean(row.pin_hash);
    const pinOnly = input.method === "pin";

    if (pinOnly) {
      // A 4-digit PIN is never sufficient from an unregistered device.
      const trusted = row?.is_active && pinEnabled && await isTrustedDevice(Number(row.id));
      if (!trusted || !validPin(input.pin)) {
        await recordLoginFailure(email);
        return invalidCredentials();
      }
    } else {
      if (!input.password) return invalidCredentials();
      const hash = row ? String(row.password_hash) : DUMMY_PASSWORD_HASH;
      const valid = await verifyPassword(input.password, hash);
      if (!row || !row.is_active || !valid) {
        const failed = await recordLoginFailure(email);
        if (failed.blocked) {
          return NextResponse.json({
            error: "ძალიან ბევრი წარუმატებელი მცდელობაა. 10 წუთში თავიდან სცადე.",
            retryAfterSeconds: failed.retryAfterSeconds,
          }, { status: 429, headers: { "Retry-After": String(failed.retryAfterSeconds) } });
        }
        return invalidCredentials();
      }
      // Administrators always use their password; their elevated account does
      // not support 4-digit PIN-only login.
      if (pinEnabled && !(await isTrustedDevice(Number(row.id))) && !input.pin) {
        return NextResponse.json({ error: "ახალ მოწყობილობაზე PIN-იც საჭიროა.", code: "PIN_REQUIRED" },
          { status: 428, headers: { "Cache-Control": "no-store" } });
      }
    }

    if (pinEnabled && (pinOnly || !(await isTrustedDevice(Number(row.id))))) {
      const blocked = await pinAttemptsBlocked(Number(row.id));
      if (blocked.blocked) {
        return NextResponse.json({ error: "PIN დროებით დაიბლოკა. მოგვიანებით სცადე.", retryAfterSeconds: blocked.retryAfterSeconds },
          { status: 429, headers: { "Retry-After": String(blocked.retryAfterSeconds) } });
      }
      if (!validPin(input.pin) || !(await verifyPin(input.pin, String(row.pin_hash)))) {
        const failed = await recordPinFailure(Number(row.id));
        return NextResponse.json({ error: failed.blocked ? "PIN დროებით დაიბლოკა." : "PIN არასწორია." },
          { status: failed.blocked ? 429 : 401 });
      }
      await clearPinFailures(Number(row.id));
    }

    await clearLoginFailures(email);

    const user = {
      id: Number(row.id),
      name: String(row.name),
      email: String(row.email),
      role: row.role,
      isActive: Boolean(row.is_active),
      canUseRoutes:
        row.can_use_routes == null ? true : Boolean(row.can_use_routes),
    };

    let session;
    try {
      session = await beginUserSession(
        user.id,
        extractClientIp(request)
      );
    } catch (sessionError) {
      console.error("Login session initialization failed:", sessionError);
      return NextResponse.json(
        {
          error: "სესიის შექმნა ვერ მოხერხდა. სერვერის ლოგში მიზეზი დაფიქსირდა.",
          code: "SESSION_INIT_FAILED",
        },
        { status: 500 }
      );
    }

    await setSessionCookie(user, session.sessionId);
    // A new device is trusted only after both the password and registered PIN
    // have been verified. Single-row storage invalidates any previous device.
    if (pinEnabled && !pinOnly && !(await isTrustedDevice(user.id))) {
      await trustCurrentDevice(user.id);
    }

    try {
      await writeAuditLog({
        actorUserId: user.id,
        action: session.replacedOtherSession ? "auth.session_replaced" : "auth.login",
        entityType: "user",
        entityId: user.id,
        summary: session.replacedOtherSession
          ? "ახალი შესვლის შედეგად წინა სესია დასრულდა."
          : "მომხმარებელი წარმატებით შევიდა სისტემაში.",
        metadata: { sessionReplaced: session.replacedOtherSession, method: pinOnly ? "pin" : "password" },
      });
    } catch (error) {
      // Login is already committed; audit downtime must not lock out users.
      console.error("Login audit log failed:", error);
    }

    return NextResponse.json({
      user,
      replacedOtherSession: session.replacedOtherSession,
    });
  } catch (error) {
    console.error("Login failed unexpectedly:", error);
    return NextResponse.json(
      { error: "ავტორიზაციის სერვერული შეცდომა. სცადე თავიდან." },
      { status: 500 }
    );
  }
}
