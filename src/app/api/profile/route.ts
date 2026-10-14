import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import {
  clearSessionCookie,
  getCurrentUser,
  hashPassword,
  verifyPassword,
} from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";

export const dynamic = "force-dynamic";

const emailUpdate = z.object({
  action: z.literal("email"),
  email: z.string().trim().email().max(220),
  currentPassword: z.string().min(1).max(200),
});
const passwordUpdate = z.object({
  action: z.literal("password"),
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});
const schema = z.discriminatedUnion("action", [emailUpdate, passwordUpdate]);

function json(data: object, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "სესია ამოიწურა. ხელახლა შედით სისტემაში." }, 401);

  // Only requests originating from our website may use the session cookie to
  // change account credentials. SameSite cookies also remain enabled.
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const actual = new URL(origin).host.toLowerCase();
      const allowed = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(",")[0].trim().toLowerCase();
      if (!allowed || actual !== allowed) return json({ error: "მოთხოვნა დაუშვებელი წყაროდანაა." }, 403);
    } catch {
      return json({ error: "მოთხოვნის წყარო არასწორია." }, 403);
    }
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "მონაცემების ფორმატი არასწორია." }, 415);
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "მონაცემები ვერ წავიკითხეთ." }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return json({ error: "შეამოწმეთ ელფოსტა და პაროლის სიგრძე (მინიმუმ 10 სიმბოლო)." }, 400);

  const input = parsed.data;
  await ensureDatabase();
  const client = await pool.connect();
  let changed = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT email,password_hash,is_active FROM app_users WHERE id=$1 FOR UPDATE`,
      [user.id]
    );
    const account = result.rows[0];
    if (!account?.is_active) {
      await client.query("ROLLBACK");
      return json({ error: "ანგარიში მიუწვდომელია." }, 403);
    }
    if (!(await verifyPassword(input.currentPassword, String(account.password_hash)))) {
      await client.query("ROLLBACK");
      return json({ error: "მოქმედი პაროლი არასწორია." }, 400);
    }

    if (input.action === "email") {
      const email = input.email.trim().toLowerCase();
      if (email === String(account.email).toLowerCase()) {
        await client.query("ROLLBACK");
        return json({ error: "ახალი ელფოსტა უკვე მითითებულია." }, 400);
      }
      await client.query(
        `UPDATE app_users SET email=$1,updated_at=NOW() WHERE id=$2`,
        [email, user.id]
      );
    } else {
      if (input.currentPassword === input.newPassword) {
        await client.query("ROLLBACK");
        return json({ error: "ახალი პაროლი ძველისგან განსხვავებული უნდა იყოს." }, 400);
      }
      const hash = await hashPassword(input.newPassword);
      // Rotate rather than clear the session id: legacy cookies without sid
      // must also become invalid after a credential change.
      const revokedSessionMarker = randomBytes(32).toString("base64url");
      await client.query(
        `UPDATE app_users SET password_hash=$1,active_session_id=$2,
          active_session_ip_hash=NULL,active_session_started_at=NULL,
          updated_at=NOW() WHERE id=$3`,
        [hash, revokedSessionMarker, user.id]
      );
      await client.query("DELETE FROM trusted_login_devices WHERE user_id=$1", [user.id]);
    }
    await client.query("COMMIT");
    committed = true;
    changed = true;
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") {
      return json({ error: "ეს ელფოსტა უკვე სხვა ანგარიშზე გამოიყენება." }, 409);
    }
    console.error("Profile update failed", error);
    return json({ error: "ცვლილება ვერ შეინახა. სცადეთ ხელახლა." }, 500);
  } finally {
    client.release();
  }

  if (changed) {
    try {
      await writeAuditLog({
        actorUserId: user.id,
        action: input.action === "email" ? "profile.email_changed" : "profile.password_changed",
        entityType: "user",
        entityId: String(user.id),
        summary: input.action === "email" ? "მომხმარებელმა შეცვალა ელფოსტა" : "მომხმარებელმა შეცვალა პაროლი",
        metadata: { fields: [input.action] },
      });
    } catch (error) {
      console.error("Profile audit logging failed", error);
    }
  }

  if (input.action === "password") {
    await clearSessionCookie();
    return json({ success: true, relogin: true, message: "პაროლი შეიცვალა. უსაფრთხოების მიზნით ხელახლა შედით." });
  }
  return json({ success: true, email: input.email.trim().toLowerCase(), message: "ელფოსტა წარმატებით შეიცვალა." });
}
