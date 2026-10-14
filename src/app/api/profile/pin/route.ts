import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, verifyPassword } from "@/lib/auth";
import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import { clearPinFailures, clearTrustedDeviceCookie, hashPin, trustCurrentDevice, weakPin } from "@/lib/pin-auth";
import { writeAuditLog } from "@/lib/audit";

export const dynamic = "force-dynamic";
const requestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  pin: z.string().regex(/^[0-9]{4}$/).optional(),
});

function reply(payload: object, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(",")[0].trim().toLowerCase();
    return Boolean(host) && new URL(origin).host.toLowerCase() === host;
  } catch { return false; }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return reply({ error: "ავტორიზაცია აუცილებელია." }, 401);
  await ensureDatabase();
  const result = await pool.query("SELECT pin_hash FROM app_users WHERE id=$1", [user.id]);
  return reply({ enabled: user.role === "driver" && Boolean(result.rows[0]?.pin_hash), supported: user.role === "driver" });
}

async function change(request: Request, remove: boolean) {
  const user = await getCurrentUser();
  if (!user) return reply({ error: "ავტორიზაცია აუცილებელია." }, 401);
  if (user.role !== "driver") return reply({ error: "ადმინისტრატორისთვის პაროლით შესვლა სავალდებულოა." }, 403);
  if (!sameOrigin(request)) return reply({ error: "მოთხოვნის წყარო დაუშვებელია." }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return reply({ error: "მონაცემების ფორმატი არასწორია." }, 415);
  let data: unknown;
  try { data = await request.json(); } catch { return reply({ error: "მონაცემები ვერ წავიკითხეთ." }, 400); }
  const parsed = requestSchema.safeParse(data);
  if (!parsed.success || (!remove && !parsed.data.pin)) return reply({ error: "საჭიროა მოქმედი პაროლი და ოთხნიშნა PIN." }, 400);
  if (!remove && weakPin(parsed.data.pin!)) return reply({ error: "ეს PIN ზედმეტად მარტივია. აირჩიე სხვა ოთხი ციფრი." }, 400);
  await ensureDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const account = await client.query("SELECT password_hash,is_active FROM app_users WHERE id=$1 FOR UPDATE", [user.id]);
    if (!account.rows[0]?.is_active || !(await verifyPassword(parsed.data.currentPassword, String(account.rows[0].password_hash)))) {
      await client.query("ROLLBACK");
      return reply({ error: "მოქმედი პაროლი არასწორია." }, 401);
    }
    const newHash = remove ? null : await hashPin(parsed.data.pin!);
    await client.query("UPDATE app_users SET pin_hash=$1,updated_at=NOW() WHERE id=$2", [newHash, user.id]);
    await client.query("DELETE FROM trusted_login_devices WHERE user_id=$1", [user.id]);
    await client.query("DELETE FROM pin_login_attempts WHERE user_id=$1", [user.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("PIN settings update failed", error);
    return reply({ error: "PIN ვერ შეიცვალა. სცადე მოგვიანებით." }, 500);
  } finally { client.release(); }

  if (remove) await clearTrustedDeviceCookie();
  else await trustCurrentDevice(user.id);
  await clearPinFailures(user.id);
  try {
    await writeAuditLog({ actorUserId: user.id, action: remove ? "profile.pin_disabled" : "profile.pin_set",
      entityType: "user", entityId: String(user.id), summary: remove ? "PIN გათიშულია." : "PIN განახლდა." });
  } catch { /* Security change already committed. */ }
  return reply({ success: true, enabled: !remove });
}

export async function POST(request: Request) { return change(request, false); }
export async function DELETE(request: Request) { return change(request, true); }
